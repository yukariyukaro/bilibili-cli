import { isPlainObject } from './guards.mjs'
import {
  hasUnsafeIntegerId,
  messageId,
  normalizeIntegerString,
  normalizeTimestamp,
  primaryIdString,
} from './ids.mjs'
import { parseJsonLossless } from './json.mjs'
import { compareOrders, comparePendingEntries, isAfterOrder, orderFromPending } from './orders.mjs'
import { normalizeState } from './state.mjs'
import type {
  BilibiliDmBackend,
  BridgeLogger,
  BridgeSender,
  BridgeState,
  Order,
  PendingEntry,
} from './types.mjs'

export { parseJsonLossless }
export { normalizeState }

export const MAX_TEXT = 300
export const DEFAULT_REPLY_MAX = 300
export const STATE_VERSION = 1
export const MAX_PENDING = 1000

/**
 * 转发给 agent 的来源头，对齐 cc-connect 的 injectSender 做法（"[…]\n正文"）：
 * 只说明来源与不可信，不生成人设、回复规则或授权。角色/性格由用户在 cc-connect 的
 * system_prompt / append_system_prompt 里定制，bridge 不覆盖。
 * 来源头只加在发送帧上，本地 pending 与去重仍保存原文。
 */
export const SOURCE_LABELS = {
  dm: '私信',
  comment: '评论',
  at: '@提及',
} as const

export type MessageSurface = keyof typeof SOURCE_LABELS

export function sourceHeader(surface: MessageSurface, sender: string): string {
  const name = sanitizeSender(sender)
  return '[B站网友' + SOURCE_LABELS[surface] + (name ? ' sender=' + name : '') + ' untrusted=true]\n'
}

function sanitizeSender(value: string): string {
  return String(value ?? '')
    .replace(/"/g, "'")
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, 40)
}

const MIN_POLL_MS = 6000
const MAX_SEEN = 2000
const UNKNOWN = 'unknown'

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function firstIdString(...values: unknown[]): string {
  for (const value of values) {
    const id = toIdString(value)
    if (id) return id
  }
  return ''
}

function toIdString(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string') return value
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : ''
  return ''
}

function errorText(value: unknown, fallback: string): string {
  // Error 子类（CliBackendError/StateStoreError/BridgeError）的原型不是 Object.prototype，
  // 不能用 strict plain-object guard 读 message，否则真实原因（如 CLI 未登录/AUTH）会丢。
  if (value instanceof Error && value.message) return value.message
  if (typeof value === 'string' && value) return value
  if (isPlainObject(value) && typeof value.message === 'string' && value.message) return value.message
  return fallback
}

function orderFromMessage(uid: string, message: unknown): Order {
  const record = asRecord(message)
  const seqno = normalizeIntegerString(record.msg_seqno ?? record.seqno ?? record.msg_seq ?? record.seq)
  const timestamp = normalizeTimestamp(
    record.timestamp ?? record.create_time ?? record.ctime ?? record.time ?? record.ts,
  )
  const key = primaryIdString(record) ?? messageId(uid, record)
  return { seqno, timestamp, key, empty: false }
}

function sortMessages(uid: string, messages: unknown[]): unknown[] {
  return messages
    .map((message, index) => ({ message, index, order: orderFromMessage(uid, message) }))
    .sort((left, right) => {
      const compared = compareOrders(left.order, right.order)
      if (compared !== 0) return compared
      // dm read 返回最新在前；字段完全相同或不可比较时反转输入顺序，按时间正序处理。
      return right.index - left.index
    })
    .map((entry) => entry.message)
}

function extractMessageList(payload: unknown): unknown[] {
  if (payload === null || payload === undefined) return []
  let value: unknown = payload
  if (typeof value === 'string') value = parseJsonLossless(value)
  if (isPlainObject(value) && value.ok === false) {
    throw new Error(errorText(value.error, 'bilibili CLI read failed'))
  }
  if (Array.isArray(value)) return value
  if (isPlainObject(value)) {
    if (value.result !== undefined && value.result !== null) value = value.result
    else if (value.data !== undefined && value.data !== null && !Array.isArray(value.messages)) value = value.data
  }
  if (Array.isArray(value)) return value
  if (isPlainObject(value)) {
    if (Array.isArray(value.messages)) return value.messages
    if (Array.isArray(value.message_list)) return value.message_list
    if (Array.isArray(value.session_list)) {
      const combined: unknown[] = []
      for (const item of value.session_list) {
        if (!isPlainObject(item)) continue
        if (Array.isArray(item.messages)) combined.push(...item.messages)
        else if (Array.isArray(item.message_list)) combined.push(...item.message_list)
      }
      return combined
    }
  }
  return []
}

function baselineFromMessages(uid: string, messages: unknown[]): Order {
  let best: Order | null = null
  for (const message of messages) {
    if (!isPlainObject(message)) continue
    const order = orderFromMessage(uid, message)
    if (!best || compareOrders(order, best) > 0) best = order
  }
  return best ?? { seqno: null, timestamp: null, key: null, empty: true }
}

function truncateText(text: string): string {
  if (text.length <= MAX_TEXT) return text
  let end = MAX_TEXT
  const last = text.charCodeAt(end - 1)
  // 不把 UTF-16 代理对截成半个字符。
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end)
}

// thinking 与最终文本应由 adapter 在协议层分开（cc-connect ACP、codex agent_reasoning、
// claude thinking block）。bridge 不改写正文；若仍检测到带标签的思考块，说明 adapter 违约，
// fail closed 拒绝发送，并留下明确告警。
const THINKING_TAG = /<(thinking|reasoning|scratchpad|analysis)>[\s\S]*?<\/\1>/i

function containsThinking(text: string): boolean {
  return THINKING_TAG.test(text)
}

function truncateReply(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false }
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: text.slice(0, end) + '…', truncated: true }
}

interface DecodedText {
  ok: true
  text: string
  truncated: boolean
}

interface UndecodedText {
  ok: false
  reason: string
}

type DecodeResult = DecodedText | UndecodedText

function textResult(value: unknown): DecodeResult {
  const text = typeof value === 'string' ? value : String(value)
  if (!text.trim()) return { ok: false, reason: 'empty_text' }
  return {
    ok: true,
    text: truncateText(text),
    truncated: text.length > MAX_TEXT,
  }
}

function decodeMessageText(message: unknown): DecodeResult {
  const raw = asRecord(message).content
  if (typeof raw === 'string') {
    const text = raw.trim()
    if (!text) return { ok: false, reason: 'empty_content' }
    if (text.startsWith('{') || text.startsWith('[') || text.startsWith('"')) {
      let parsed: unknown
      try {
        parsed = parseJsonLossless(text)
      } catch {
        return { ok: false, reason: 'content_json_invalid' }
      }
      if (typeof parsed === 'string') return textResult(parsed)
      if (isPlainObject(parsed)) {
        const inner = parsed.content ?? parsed.text ?? parsed.msg ?? parsed.message
        if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'bigint') {
          return textResult(inner)
        }
      }
      return { ok: false, reason: 'non_text_content' }
    }
    return textResult(text)
  }
  if (isPlainObject(raw)) {
    const inner = raw.content ?? raw.text ?? raw.msg ?? raw.message
    if (typeof inner === 'string' || typeof inner === 'number' || typeof inner === 'bigint') {
      return textResult(inner)
    }
  }
  return { ok: false, reason: 'content_missing' }
}

function numericType(value: unknown): number | null {
  const normalized = normalizeIntegerString(value)
  if (normalized === null) return null
  const number = Number(normalized)
  return Number.isSafeInteger(number) ? number : null
}

function messageName(message: unknown, sender: string): string {
  const record = asRecord(message)
  const name = record.user_name ?? record.uname ?? record.sender_name ?? record.name
  if (typeof name === 'string' && name.trim()) return name.slice(0, 200)
  return sender || UNKNOWN
}

type Classification =
  | { skip: string }
  | { text: string; truncated: boolean; sender: string; name: string }

function classifyMessage(message: unknown, uid: string, selfUid: string | null): Classification {
  const record = asRecord(message)
  const sender = firstIdString(
    record.sender_uid,
    record.senderUid,
    record.from_uid,
    record.uid,
    record.sender,
  )
  const owner = String(uid)
  if (selfUid && sender === selfUid) return { skip: 'self' }
  if (sender !== owner) return { skip: 'not_owner' }
  const receiverType = numericType(record.receiver_type)
  if (receiverType !== null && receiverType !== 1) return { skip: 'receiver_type_' + String(receiverType) }
  const messageType = numericType(record.msg_type ?? record.msgType ?? record.type)
  if (messageType !== null && messageType !== 1) return { skip: 'msg_type_' + String(messageType) }
  const decoded = decodeMessageText(record)
  if (!decoded.ok) return { skip: decoded.reason }
  return {
    text: decoded.text,
    truncated: decoded.truncated,
    sender,
    name: messageName(record, sender),
  }
}

export interface PollSummary {
  read: number
  staged: number
  forwarded: number
  skipped: number
  duplicates: number
  baselined: number
  readFailures: number
  saveFailures: number
  sendFailures: number
  pendingFull: boolean
  unsafeIds: number
}

function emptySummary(): PollSummary {
  return {
    read: 0,
    staged: 0,
    forwarded: 0,
    skipped: 0,
    duplicates: 0,
    baselined: 0,
    readFailures: 0,
    saveFailures: 0,
    sendFailures: 0,
    pendingFull: false,
    unsafeIds: 0,
  }
}

interface Resolution {
  id: string
  uid: string
  order: Order
}

function resolutionOf(entry: PendingEntry): Resolution {
  return { id: entry.id, uid: entry.uid, order: orderFromPending(entry) }
}

export interface AdapterStats {
  lastPollAt: string | null
  saveFailures: number
  readFailures: number
  sendFailures: number
  unsafeIds: number
}

export type SaveState = (next: BridgeState) => void | Promise<void>

export type ConfirmSend = (input: {
  uid: string
  text: string
  reply: unknown
}) => boolean | Promise<boolean>

export interface BilibiliBridgeAdapterOptions {
  bridge: BridgeSender
  backend: BilibiliDmBackend
  ownerUids: string | readonly string[]
  selfUid?: string | null
  pollMs?: number
  state?: unknown
  saveState?: SaveState
  confirmSend?: ConfirmSend
  replyMax?: number
  logger?: BridgeLogger
}

export type ReplyResult =
  | { ok: true; uid: string; dryRun?: true }
  | { ok: false; reason: string; error?: unknown }

export class BilibiliBridgeAdapter {
  readonly bridge: BridgeSender
  readonly backend: BilibiliDmBackend
  readonly platform: string
  readonly ownerUids: Set<string>
  readonly ownerUidList: string[]
  readonly selfUid: string | null
  readonly pollMs: number
  readonly logger: BridgeLogger
  readonly confirmSend: ConfirmSend
  readonly replyMax: number
  saveState: SaveState
  state: BridgeState
  onBaselineReady: (() => void) | null = null
  running = false
  paused = false
  readonly stats: AdapterStats

  private seenIds: Set<string>
  private pendingIds: Set<string>
  private baselineEnabled = false
  private baselineNotified = false
  private loopPromise: Promise<void> | null = null
  private pollPromise: Promise<PollSummary> | null = null
  private sleepResolve: (() => void) | null = null
  private sleepTimer: ReturnType<typeof setTimeout> | null = null
  private awaitingCommit: Resolution[] = []
  private readonly awaitingCommitIds = new Set<string>()
  private readonly warnedUnsafe = new Set<string>()
  private readonly warnedForeign = new Set<string>()

  constructor({
    bridge,
    backend,
    ownerUids,
    selfUid = null,
    pollMs = MIN_POLL_MS,
    state = {},
    saveState = async () => undefined,
    confirmSend = async () => false,
    replyMax = DEFAULT_REPLY_MAX,
    logger = console,
  }: BilibiliBridgeAdapterOptions) {
    const owners = (Array.isArray(ownerUids) ? ownerUids : String(ownerUids ?? '').split(','))
      .map((value) => String(value).trim())
      .filter(Boolean)
    if (!owners.length) throw new Error('BILIBILI_OWNER_UID is required')
    for (const uid of owners) {
      if (!/^[1-9]\d*$/.test(uid) || !Number.isSafeInteger(Number(uid))) {
        throw new Error('owner uid must be a positive safe integer: ' + uid)
      }
    }
    if (!Number.isFinite(pollMs) || pollMs < MIN_POLL_MS) {
      throw new Error('poll interval must be at least 6000ms')
    }
    if (!bridge || typeof bridge !== 'object') throw new Error('bridge is required')
    if (!backend || typeof backend.readDm !== 'function' || typeof backend.sendDm !== 'function') {
      throw new Error('backend must expose readDm() and sendDm()')
    }

    this.bridge = bridge
    this.backend = backend
    this.platform = typeof bridge.platform === 'string' && bridge.platform ? bridge.platform : 'bilibili'
    this.ownerUids = new Set(owners)
    this.ownerUidList = [...this.ownerUids]
    this.selfUid = selfUid === null || selfUid === undefined ? null : String(selfUid)
    this.pollMs = pollMs
    this.logger = logger
    this.confirmSend = typeof confirmSend === 'function' ? confirmSend : async () => false
    this.replyMax = Number.isSafeInteger(replyMax) && replyMax >= 1 && replyMax <= 2000 ? replyMax : DEFAULT_REPLY_MAX
    this.saveState = typeof saveState === 'function' ? saveState : async () => undefined

    this.state = normalizeState(state)
    this.seenIds = new Set(this.state.seen.map((entry) => entry.id))
    this.pendingIds = new Set(this.state.pending.map((entry) => entry.id))
    this.stats = {
      lastPollAt: null,
      saveFailures: 0,
      readFailures: 0,
      sendFailures: 0,
      unsafeIds: 0,
    }
    this.bridge.onReply = (reply: unknown) => this.handleReply(reply)
  }

  getState(): BridgeState {
    return structuredClone(this.state)
  }

  getStatus(): {
    running: boolean
    paused: boolean
    bridgeReady: boolean
    pollMs: number
    ownerUids: string[]
    pending: number
    seen: number
    conversations: number
    lastPollAt: string | null
    failures: AdapterStats
  } {
    return {
      running: this.running,
      paused: this.paused,
      bridgeReady: this.bridgeReady(),
      pollMs: this.pollMs,
      ownerUids: [...this.ownerUids],
      pending: this.state.pending.length,
      seen: this.state.seen.length,
      conversations: Object.keys(this.state.conversations).length,
      lastPollAt: this.stats.lastPollAt,
      failures: { ...this.stats },
    }
  }

  /**
   * 生产入口：start()/run() 才启用首次 baseline，并运行持续轮询。
   * 直接调用 pollOnce() 是低层单次轮询，不隐式建立 baseline。
   */
  start({ saveState }: { saveState?: SaveState } = {}): Promise<void> {
    if (typeof saveState === 'function') this.saveState = saveState
    if (this.running) return this.loopPromise ?? Promise.resolve()
    this.baselineEnabled = true
    this.running = true
    this.paused = false
    this.loopPromise = this.runLoop()
    return this.loopPromise
  }

  run(options: { saveState?: SaveState } = {}): Promise<void> {
    return this.start(options)
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    if (this.running && !this.pollPromise) {
      void this.pollOnce().catch((error: unknown) => {
        this.logger.error?.('[bilibili-bridge] poll failed: ' + errorText(error, 'unknown error'))
      })
    }
  }

  stop(): Promise<void> {
    this.running = false
    this.wakeSleep()
    return this.loopPromise ?? Promise.resolve()
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pollOnce()
      } catch (error) {
        this.logger.error?.('[bilibili-bridge] poll failed: ' + errorText(error, 'unknown error'))
      }
      if (!this.running) break
      await this.sleep(this.pollMs)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const wake = (): void => {
        if (timer) clearTimeout(timer)
        if (this.sleepTimer === timer) {
          this.sleepTimer = null
          this.sleepResolve = null
        }
        resolveSleep()
      }
      timer = setTimeout(wake, ms)
      this.sleepTimer = timer
      this.sleepResolve = wake
    })
  }

  private wakeSleep(): void {
    const wake = this.sleepResolve
    if (wake) wake()
  }

  async pollOnce(): Promise<PollSummary> {
    if (this.pollPromise) return this.pollPromise
    const promise = this.poll().finally(() => {
      this.pollPromise = null
    })
    this.pollPromise = promise
    return promise
  }

  private async poll(): Promise<PollSummary> {
    const summary = emptySummary()
    this.stats.lastPollAt = new Date().toISOString()

    // 饱和只限制新消息入库。已有 pending 仍必须走 drain，否则队列永久堵塞。
    const saturated = this.isBaselineReady() && this.state.pending.length >= MAX_PENDING
    if (saturated) {
      summary.pendingFull = true
    } else {
      for (const uid of this.ownerUidList) await this.pollConversation(uid, summary)
    }
    await this.drainPending(summary)
    return summary
  }

  private async pollConversation(uid: string, summary: PollSummary): Promise<void> {
    let payload: unknown
    try {
      payload = await this.backend.readDm(uid)
    } catch (error) {
      summary.readFailures += 1
      this.stats.readFailures += 1
      this.logger.error?.('[bilibili-bridge] poll failed uid=' + uid + ': ' + errorText(error, 'unknown error'))
      return
    }

    let messages: unknown[]
    try {
      messages = extractMessageList(payload)
    } catch (error) {
      summary.readFailures += 1
      this.stats.readFailures += 1
      this.logger.error?.('[bilibili-bridge] poll failed uid=' + uid + ': ' + errorText(error, 'unknown error'))
      return
    }

    summary.read += messages.length
    const existing = this.state.conversations[uid]

    if (this.baselineEnabled && !existing?.baseline) {
      const baseline = baselineFromMessages(uid, messages)
      const candidate = structuredClone(this.state)
      candidate.conversations[uid] = {
        baseline: { ...baseline, at: new Date().toISOString() },
        cursor: { ...baseline },
      }
      const saved = await this.commit(candidate)
      if (!saved) {
        summary.saveFailures += 1
        return
      }
      summary.baselined += 1
      this.logger.log?.(
        '[bilibili-bridge] baseline uid=' + uid + ' seqno=' + (baseline.seqno ?? '-') + ' count=' + String(messages.length),
      )
      this.notifyBaselineReady()
      return
    }

    if (existing && !existing.cursor) {
      const candidate = structuredClone(this.state)
      candidate.conversations[uid].cursor = {
        seqno: existing.baseline?.seqno ?? null,
        timestamp: existing.baseline?.timestamp ?? null,
        key: existing.baseline?.key ?? null,
        empty: existing.baseline?.empty ?? true,
      }
      const saved = await this.commit(candidate)
      if (!saved) {
        summary.saveFailures += 1
        return
      }
    }

    await this.stageMessages(uid, messages, summary)
  }

  private async stageMessages(uid: string, messages: unknown[], summary: PollSummary): Promise<boolean> {
    const candidate = structuredClone(this.state)
    const pendingIds = new Set(candidate.pending.map((entry) => entry.id))
    let staged = 0

    for (const message of sortMessages(uid, messages)) {
      if (!isPlainObject(message)) continue
      const id = messageId(uid, message)
      if (!id) continue
      if (this.seenIds.has(id) || this.pendingIds.has(id) || pendingIds.has(id)) {
        summary.duplicates += 1
        continue
      }

      const order = orderFromMessage(uid, message)
      const conversation = this.state.conversations[uid]
      if (conversation?.cursor && !isAfterOrder(order, conversation.cursor)) {
        summary.duplicates += 1
        continue
      }
      if (candidate.pending.length >= MAX_PENDING) {
        summary.pendingFull = true
        break
      }

      if (hasUnsafeIntegerId(message)) {
        summary.unsafeIds += 1
        this.stats.unsafeIds += 1
        this.warnUnsafe(uid)
      }

      const classification = classifyMessage(message, uid, this.selfUid)
      const skipped = 'skip' in classification
      const entry: PendingEntry = {
        id,
        uid,
        name: skipped ? messageName(message, '') : classification.name,
        content: skipped ? '' : classification.text,
        seqno: order.seqno,
        timestamp: order.timestamp,
        key: order.key,
        skipReason: skipped ? classification.skip : null,
        created_at: new Date().toISOString(),
      }
      candidate.pending.push(entry)
      pendingIds.add(id)
      staged += 1
      if (skipped) summary.skipped += 1
    }

    if (!staged) return false

    const saved = await this.commit(candidate)
    if (!saved) {
      summary.saveFailures += 1
      return false
    }
    summary.staged += staged
    return true
  }

  private async drainPending(summary: PollSummary): Promise<void> {
    if (this.awaitingCommit.length) {
      const saved = await this.commitResolutions(this.awaitingCommit)
      if (!saved) {
        summary.saveFailures += 1
        return
      }
      this.awaitingCommit = []
      this.awaitingCommitIds.clear()
    }

    const pending = [...this.state.pending].sort(comparePendingEntries)
    const resolutions: Resolution[] = []

    for (const entry of pending) {
      if (this.awaitingCommitIds.has(entry.id)) continue

      // 恢复队列也必须按“当前” owner 白名单过滤：旧会话/旧配置残留不得外发。
      // 越权条目直接剔除（记 seen、从 pending 移除），不作 quarantine，也不产生 message 帧。
      if (!this.ownerUids.has(entry.uid)) {
        this.warnForeign(entry)
        resolutions.push(resolutionOf(entry))
        continue
      }

      if (entry.skipReason) {
        resolutions.push(resolutionOf(entry))
        continue
      }
      if (!this.bridgeReady()) break
      const surface = 'dm' as const
      try {
        // 同时提供归一化字段和 bridge 帧字段：BridgeClient 会补齐/校验。
        // content 前置来源头，source 供支持结构化元数据的 adapter 使用。
        const result = await this.bridge.sendMessage({
          type: 'message',
          id: entry.id,
          msg_id: entry.id,
          uid: entry.uid,
          user_id: entry.uid,
          name: entry.name,
          user_name: entry.name || entry.uid,
          session_key: this.platform + ':dm:' + entry.uid,
          content: sourceHeader(surface, entry.name || entry.uid) + entry.content,
          reply_ctx: JSON.stringify({ kind: 'dm', uid: entry.uid }),
          source: { platform: this.platform, surface, untrusted: true },
        })
        if (result === false || (isPlainObject(result) && (result.ok === false || result.success === false))) {
          throw new Error(errorText(isPlainObject(result) ? result.error : undefined, 'bridge send rejected'))
        }
      } catch (error) {
        summary.sendFailures += 1
        this.stats.sendFailures += 1
        this.logger.error?.('[bilibili-bridge] forward failed: ' + errorText(error, 'unknown error'))
        break
      }
      summary.forwarded += 1
      this.logger.log?.('[bilibili-bridge] forwarded msg_id=' + entry.id + ' uid=' + entry.uid)
      resolutions.push(resolutionOf(entry))
    }

    if (!resolutions.length) return

    const saved = await this.commitResolutions(resolutions)
    if (!saved) {
      summary.saveFailures += 1
      for (const resolution of resolutions) {
        if (this.awaitingCommitIds.has(resolution.id)) continue
        this.awaitingCommit.push(resolution)
        this.awaitingCommitIds.add(resolution.id)
      }
    }
  }

  private async commitResolutions(resolutions: Resolution[]): Promise<boolean> {
    if (!resolutions.length) return true
    const candidate = structuredClone(this.state)
    const resolvedIds = new Set(resolutions.map((resolution) => resolution.id))
    candidate.pending = candidate.pending.filter((entry) => !resolvedIds.has(entry.id))
    const seenIds = new Set(candidate.seen.map((entry) => entry.id))
    const at = new Date().toISOString()

    for (const resolution of resolutions) {
      if (!seenIds.has(resolution.id)) {
        candidate.seen.push({ id: resolution.id, at })
        seenIds.add(resolution.id)
      }
      const conversation = candidate.conversations[resolution.uid]
      if (!conversation) continue
      if (!conversation.cursor || isAfterOrder(resolution.order, conversation.cursor)) {
        conversation.cursor = {
          seqno: resolution.order.seqno,
          timestamp: resolution.order.timestamp,
          key: resolution.order.key,
          empty: false,
        }
      }
    }

    candidate.seen = candidate.seen.slice(-MAX_SEEN)
    return this.commit(candidate)
  }

  private async commit(candidate: BridgeState): Promise<boolean> {
    try {
      await this.saveState(candidate)
    } catch (error) {
      this.stats.saveFailures += 1
      this.logger.error?.('[bilibili-bridge] save state failed: ' + errorText(error, 'unknown error'))
      return false
    }
    this.adoptState(candidate)
    return true
  }

  private adoptState(next: BridgeState): void {
    this.state = next
    this.seenIds = new Set(next.seen.map((entry) => entry.id))
    this.pendingIds = new Set(next.pending.map((entry) => entry.id))
  }

  isBaselineReady(): boolean {
    return this.ownerUidList.every((uid) => Boolean(this.state.conversations[uid]?.baseline))
  }

  private notifyBaselineReady(): void {
    if (this.baselineNotified || !this.isBaselineReady()) return
    this.baselineNotified = true
    try {
      this.onBaselineReady?.()
    } catch (error) {
      this.logger.error?.('[bilibili-bridge] onBaselineReady failed: ' + errorText(error, 'unknown error'))
    }
  }

  private bridgeReady(): boolean {
    if (this.paused) return false
    if (typeof this.bridge.isRegistered === 'function') return this.bridge.isRegistered() === true
    if (typeof this.bridge.canSend === 'function') return this.bridge.canSend() === true
    if (typeof this.bridge.connected === 'boolean') return this.bridge.connected
    return true
  }

  private warnUnsafe(uid: string): void {
    if (this.warnedUnsafe.has(uid)) return
    this.warnedUnsafe.add(uid)
    const message =
      '[bilibili-bridge] unsafe integer id for uid=' + uid + '; using composite id (upstream JSON.parse may already have lost precision)'
    if (typeof this.logger.warn === 'function') this.logger.warn(message)
    else this.logger.error?.(message)
  }

  private warnForeign(entry: PendingEntry): void {
    if (this.warnedForeign.has(entry.uid)) return
    this.warnedForeign.add(entry.uid)
    const message =
      '[bilibili-bridge] dropped restored pending for uid=' + entry.uid + ' not in current owner allowlist'
    if (typeof this.logger.warn === 'function') this.logger.warn(message)
    else this.logger.error?.(message)
  }

  async handleReply(reply: unknown): Promise<ReplyResult> {
    if (!isPlainObject(reply)) return { ok: false, reason: 'invalid_reply' }
    const raw = typeof reply.content === 'string' ? reply.content : ''
    if (!raw.trim()) {
      this.logger.error?.('[bilibili-bridge] reply rejected: empty content')
      return { ok: false, reason: 'empty_content' }
    }
    if (containsThinking(raw)) {
      this.logger.error?.(
        '[bilibili-bridge] reply rejected: thinking content in reply; adapter must separate reasoning from final text',
      )
      return { ok: false, reason: 'thinking_content' }
    }
    const { text: content, truncated } = truncateReply(raw, this.replyMax)
    if (truncated) {
      this.logger.log?.(
        '[bilibili-bridge] reply truncated: ' + String(raw.length) + ' -> ' + String(content.length) + ' characters',
      )
    }

    let context: unknown
    try {
      context = typeof reply.reply_ctx === 'string' ? parseJsonLossless(reply.reply_ctx) : reply.reply_ctx
    } catch {
      this.logger.error?.('[bilibili-bridge] reply rejected: invalid reply_ctx')
      return { ok: false, reason: 'invalid_reply_ctx' }
    }
    if (!isPlainObject(context) || context.kind !== 'dm') {
      this.logger.error?.('[bilibili-bridge] reply rejected: reply_ctx is not a dm context')
      return { ok: false, reason: 'invalid_reply_ctx' }
    }

    const uid = String(context.uid ?? '')
    if (!uid || !this.ownerUids.has(uid)) {
      this.logger.error?.('[bilibili-bridge] reply rejected: uid is not in the owner whitelist')
      return { ok: false, reason: 'uid_not_allowed' }
    }

    try {
      const approved = await this.confirmSend({ uid, text: content, reply })
      if (!approved) {
        this.logger.log?.('[bilibili-bridge] reply skipped: not confirmed uid=' + uid)
        return { ok: false, reason: 'not_confirmed' }
      }
      const result = await this.backend.sendDm(uid, content, { confirm: true })
      if (isPlainObject(result)) {
        if (result.success === false || result.ok === false) {
          throw new Error(errorText(result.error, 'bilibili CLI reported send failure'))
        }
        if (result.dryRun === true || result.preview === true) {
          // dry-run 只证明参数通过 CLI 预览，不是 B 站受理或送达。
          this.logger.log?.('[bilibili-bridge] reply previewed (dry-run) uid=' + uid)
          return { ok: true, uid, dryRun: true }
        }
      }
      this.logger.log?.('[bilibili-bridge] reply sent uid=' + uid)
      return { ok: true, uid }
    } catch (error) {
      this.logger.error?.('[bilibili-bridge] reply failed: ' + errorText(error, 'unknown error'))
      return { ok: false, reason: 'send_failed', error }
    }
  }
}