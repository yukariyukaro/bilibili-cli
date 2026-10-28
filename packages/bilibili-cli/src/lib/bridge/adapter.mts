import { commands } from '../contract.mjs'
import { isPlainObject } from './guards.mjs'
import {
  hasUnsafeIntegerId,
  messageId,
  normalizeIntegerString,
  normalizeTimestamp,
  primaryIdString,
} from './ids.mjs'
import { parseJsonLossless } from './json.mjs'
import { parseInbox } from './notifications.mjs'
import { compareOrders, comparePendingEntries, isAfterOrder, orderFromPending } from './orders.mjs'
import { normalizeState } from './state.mjs'
import type {
  BilibiliDmBackend,
  BridgeLogger,
  BridgeMessageInput,
  BridgeSender,
  BridgeState,
  NotifyCursor,
  NotifyItem,
  NotifyKind,
  Order,
  PendingEntry,
} from './types.mjs'

export { parseJsonLossless }
export { normalizeState }

export const MAX_TEXT = 300
export const DEFAULT_REPLY_MAX = 300

/**
 * 正文上限以命令契约为准，桥接侧不再另写一套数字。
 * 评论与私信的上限不同（当前 150 / 300）：按 300 截断评论会生成 CLI 校验层直接拒绝的请求。
 */
function contractTextMax(commandName: string, fallback: number): number {
  const definition = commands.find((item) => item.name === commandName) as
    | { fields?: Record<string, { maxLength?: number }> }
    | undefined
  const max = definition?.fields?.text?.maxLength
  return typeof max === 'number' && max >= 1 ? max : fallback
}

/** 评论正文上限（取自 comment create 契约）。 */
export const COMMENT_TEXT_MAX = contractTextMax('comment create', MAX_TEXT)
/** 私信正文上限（取自 dm send 契约）。 */
export const DM_TEXT_MAX = contractTextMax('dm send', MAX_TEXT)
export const STATE_VERSION = 2
export const MAX_PENDING = 1000
const MAX_VIDEO_CACHE = 200

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
  // 昵称是不可信输入：压平所有换行/控制字符，方括号转全角避免伪造/提前闭合来源头。
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］')
    .replace(/"/g, "'")
    .replace(/\s+/g, ' ')
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
// 只要出现思考类起始标签（可带属性、可未闭合）就视为 adapter 违约，fail closed。
const THINKING_TAG = /<(thinking|reasoning|scratchpad|analysis)(\s[^>]*)?>/i

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

/** 从 video info 响应里取 UP 主 UID；兼容 {result}/{data} 包装与顶层 mid。 */
function ownerUidOf(payload: unknown): string | null {
  let value: unknown = payload
  if (isPlainObject(value) && value.result !== undefined && value.result !== null) value = value.result
  const root = asRecord(value)
  const data = asRecord(root.data)
  const candidates = [asRecord(root.owner).mid, asRecord(data.owner).mid, root.mid, data.mid]
  for (const candidate of candidates) {
    const uid = toIdString(candidate)
    if (/^[1-9]\d*$/.test(uid)) return uid
  }
  return null
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
  polls: number
  replies: number
  comments: number
  notifications: number
  notificationSkipped: number
}

export type ConfirmComment = (input: {
  bvid: string
  rpid?: number
  root?: number
  text: string
  reply: unknown
}) => boolean | Promise<boolean>

export interface ScrollPrefs {
  source: 'hot' | 'search'
  keywords: string
  numVideos: number
  commentsPerVideo: number
  preferTags: string
  avoidTags: string
  style: string
}

/** 评论区通知通道的偏好；默认值在 adapter 构造时补齐并校验范围。 */
export interface CommentWatchPrefs {
  /** 订阅哪类通知；空数组视为关闭。 */
  kinds: NotifyKind[]
  /** 通知轮询间隔（毫秒），独立于私信轮询，避免打爆接口。 */
  pollMs: number
  /** 每轮最多处理多少条通知；剩下的留到下一轮，游标不越过未处理项。 */
  maxPerPoll: number
  /** 两次通知转发之间的最小间隔，0 表示不限。 */
  minGapMs: number
  /** 只处理最近 N 分钟的通知，0 表示不限；用于避免重启后补发历史。 */
  maxAgeMinutes: number
  /** 评论者白名单；空数组表示不限。 */
  allowUids: string[]
  /** 只回复自己视频下的评论（需要 video info 归属校验）。 */
  onlyOwnVideos: boolean
}

export interface ScrollSummary {
  videos: number
  offered: number
  readFailures: number
  sendFailures: number
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
  confirmComment?: ConfirmComment
  scroll?: Partial<ScrollPrefs>
  commentMaxReplies?: number
  replyMax?: number
  maxPolls?: number
  maxReplies?: number
  /** 评论通知通道是否轮询；由 commentPolicy 是否为 off 决定。 */
  commentWatchEnabled?: boolean
  commentWatch?: Partial<CommentWatchPrefs>
  logger?: BridgeLogger
}

export type ReplyResult =
  | { ok: true; uid: string; dryRun?: true }
  | { ok: true; bvid: string; dryRun?: true }
  | { ok: false; reason: string; error?: unknown }

interface ScrollVideo {
  bvid: string
  title: string
  tname: string
}

function asScrollVideo(value: unknown): ScrollVideo | null {
  if (!isPlainObject(value)) return null
  const bvid = typeof value.bvid === 'string' ? value.bvid : ''
  if (!/^BV[0-9A-Za-z]{10}$/u.test(bvid)) return null
  return {
    bvid,
    title: typeof value.title === 'string' ? value.title : '',
    tname: typeof value.tname === 'string' ? value.tname : '',
  }
}

function extractVideos(value: unknown): ScrollVideo[] {
  const list: unknown[] = Array.isArray(value)
    ? value
    : isPlainObject(value) && Array.isArray(value.videos)
      ? value.videos
      : []
  return list.map(asScrollVideo).filter((video): video is ScrollVideo => video !== null)
}

function avoidedBy(video: ScrollVideo, avoidTags: string): boolean {
  const tags = avoidTags.split(/[,，\s]+/u).filter(Boolean)
  if (!tags.length) return false
  const haystack = video.title + ' ' + video.tname
  return tags.some((tag) => haystack.includes(tag))
}

function asComment(value: unknown): { rpid: number; content: string } | null {
  if (!isPlainObject(value)) return null
  const rpid = typeof value.rpid === 'number' ? value.rpid : Number(value.rpid)
  if (!Number.isSafeInteger(rpid) || rpid < 1) return null
  const content = typeof value.content === 'string' ? value.content.slice(0, 240) : ''
  return { rpid, content }
}

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
  readonly maxPolls: number
  readonly maxReplies: number
  readonly commentMaxReplies: number
  readonly confirmComment: ConfirmComment
  readonly scroll: ScrollPrefs
  readonly commentWatch: CommentWatchPrefs
  readonly commentWatchEnabled: boolean
  polls = 0
  replies = 0
  comments = 0
  private lastNotifyPollAt = 0
  private lastCommentForwardAt = 0
  private readonly videoOwnerCache = new Map<string, string | null>()
  private readonly warnedMissingInbox = new Set<string>()
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
  private replyReservations = 0
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
    confirmComment = async () => false,
    scroll = {},
    commentMaxReplies = 0,
    replyMax = DEFAULT_REPLY_MAX,
    maxPolls = 0,
    maxReplies = 0,
    commentWatchEnabled = false,
    commentWatch = {},
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
    if (!Number.isSafeInteger(maxPolls) || maxPolls < 0 || !Number.isSafeInteger(maxReplies) || maxReplies < 0) throw new Error('poll and reply limits must be non-negative safe integers')
    this.maxPolls = maxPolls
    this.maxReplies = maxReplies
    this.logger = logger
    this.confirmSend = typeof confirmSend === 'function' ? confirmSend : async () => false
    this.confirmComment = typeof confirmComment === 'function' ? confirmComment : async () => false
    if (!Number.isSafeInteger(commentMaxReplies) || commentMaxReplies < 0) throw new Error('comment reply limit must be a non-negative safe integer')
    this.commentMaxReplies = commentMaxReplies
    this.scroll = {
      source: scroll.source === 'search' ? 'search' : 'hot',
      keywords: typeof scroll.keywords === 'string' ? scroll.keywords : '',
      numVideos: Number.isSafeInteger(scroll.numVideos) && (scroll.numVideos ?? 0) > 0 ? Number(scroll.numVideos) : 10,
      commentsPerVideo: Number.isSafeInteger(scroll.commentsPerVideo) && (scroll.commentsPerVideo ?? 0) > 0 ? Number(scroll.commentsPerVideo) : 20,
      preferTags: typeof scroll.preferTags === 'string' ? scroll.preferTags : '',
      avoidTags: typeof scroll.avoidTags === 'string' ? scroll.avoidTags : '',
      style: typeof scroll.style === 'string' ? scroll.style : '',
    }
    this.commentWatchEnabled = commentWatchEnabled === true
    const kindsRaw = Array.isArray(commentWatch.kinds) ? commentWatch.kinds : ['at', 'reply']
    const kinds = [...new Set(kindsRaw.filter((kind): kind is NotifyKind => kind === 'at' || kind === 'reply'))]
    this.commentWatch = {
      kinds,
      pollMs: Number.isSafeInteger(commentWatch.pollMs) && (commentWatch.pollMs ?? 0) >= MIN_POLL_MS
        ? Math.min(Number(commentWatch.pollMs), 2147483647)
        : 60000,
      maxPerPoll: Number.isSafeInteger(commentWatch.maxPerPoll) && (commentWatch.maxPerPoll ?? 0) >= 1
        ? Math.min(Number(commentWatch.maxPerPoll), 50)
        : 5,
      minGapMs: Number.isSafeInteger(commentWatch.minGapMs) && (commentWatch.minGapMs ?? -1) >= 0
        ? Math.min(Number(commentWatch.minGapMs), 3600000)
        : 30000,
      maxAgeMinutes: Number.isSafeInteger(commentWatch.maxAgeMinutes) && (commentWatch.maxAgeMinutes ?? -1) >= 0
        ? Math.min(Number(commentWatch.maxAgeMinutes), 10080)
        : 1440,
      allowUids: (Array.isArray(commentWatch.allowUids) ? commentWatch.allowUids : [])
        .map((uid) => String(uid).trim())
        .filter((uid) => /^[1-9]\d*$/.test(uid))
        .slice(0, 20),
      onlyOwnVideos: typeof commentWatch.onlyOwnVideos === 'boolean' ? commentWatch.onlyOwnVideos : true,
    }
    // CLI 契约里 dm send 正文上限就是 MAX_TEXT（300）；超过它会在 CLI 校验层被拒。
    this.replyMax = Number.isSafeInteger(replyMax) && replyMax >= 1
      ? Math.min(replyMax, MAX_TEXT)
      : DEFAULT_REPLY_MAX
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
      polls: 0,
      replies: 0,
      comments: 0,
      notifications: 0,
      notificationSkipped: 0,
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
    polls: number
    replies: number
    maxPolls: number
    maxReplies: number
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
      polls: this.polls,
      replies: this.replies,
      maxPolls: this.maxPolls,
      maxReplies: this.maxReplies,
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
    this.loopPromise = this.runLoop()
    return this.loopPromise
  }

  run(options: { saveState?: SaveState } = {}): Promise<void> {
    return this.start(options)
  }

  pause(): void {
    this.paused = true
  }

  resume({ resetPollLimit = true }: { resetPollLimit?: boolean } = {}): void {
    if (this.maxPolls > 0 && this.polls >= this.maxPolls) {
      if (!resetPollLimit) return
      this.polls = 0
      this.stats.polls = 0
    }
    this.paused = false
    this.wakeSleep()
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

  /** 显式单次轮询：不受自动轮询的暂停标志影响（暂停只约束后台循环）。 */
  async pollOnce(options: { force?: boolean } = {}): Promise<PollSummary> {
    if (this.pollPromise) return this.pollPromise
    const promise = this.poll(options.force === true).finally(() => {
      this.pollPromise = null
    })
    this.pollPromise = promise
    return promise
  }

  private async poll(force = false): Promise<PollSummary> {
    const summary = emptySummary()
    if ((this.paused && !force) || (this.maxPolls > 0 && this.polls >= this.maxPolls)) {
      if (this.maxPolls > 0 && this.polls >= this.maxPolls) {
        this.paused = true
        this.wakeSleep()
      }
      return summary
    }
    this.polls += 1
    this.stats.polls = this.polls
    this.stats.lastPollAt = new Date().toISOString()

    // 饱和只限制新消息入库。已有 pending 仍必须走 drain，否则队列永久堵塞。
    const saturated = this.isBaselineReady() && this.state.pending.length >= MAX_PENDING
    if (saturated) {
      summary.pendingFull = true
    } else {
      for (const uid of this.ownerUidList) await this.pollConversation(uid, summary)
      await this.pollNotifications()
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

  /**
   * 评论区通知轮询：独立节奏、只读、失败不重试。
   * backend 未提供能力时显式告警并跳过，不静默降级成“没有通知”。
   */
  private async pollNotifications(): Promise<void> {
    if (!this.commentWatchEnabled) return
    const kinds = this.commentWatch.kinds
    if (!kinds.length) return
    const now = Date.now()
    if (now - this.lastNotifyPollAt < this.commentWatch.pollMs) return
    this.lastNotifyPollAt = now
    for (const kind of kinds) {
      const reader = kind === 'at' ? this.backend.inboxAt : this.backend.inboxReply
      if (typeof reader !== 'function') {
        if (!this.warnedMissingInbox.has(kind)) {
          this.warnedMissingInbox.add(kind)
          this.logger.warn?.('[bilibili-bridge] backend 未提供 inbox ' + kind + ' 能力；该通知通道不轮询')
        }
        continue
      }
      const cursor = this.state.notifications[kind]
      let payload: unknown
      try {
        payload = await reader.call(this.backend, {
          id: cursor === null ? null : cursor.id,
          time: cursor === null ? null : cursor.time,
        })
      } catch (error) {
        this.stats.readFailures += 1
        this.logger.error?.('[bilibili-bridge] inbox ' + kind + ' failed: ' + errorText(error, 'unknown error'))
        continue
      }
      const parsed = parseInbox(kind, payload)
      if (parsed.unparsed > 0) {
        this.logger.warn?.(
          '[bilibili-bridge] inbox ' + kind + ' 有 ' + String(parsed.unparsed) + ' 条通知无法识别字段，已跳过',
        )
      }
      await this.stageNotifications(kind, parsed.items, parsed.cursor)
    }
  }

  /**
   * 排序 → 去重 → 过闸 → 入队。游标只推进到“确实处理过”的条目，
   * 因此 maxPerPoll 截断后剩下的通知下一轮还会出现。
   */
  private async stageNotifications(kind: NotifyKind, items: NotifyItem[], remote: NotifyCursor | null): Promise<void> {
    if (!items.length) {
      if (remote !== null) await this.commitNotifyCursor(kind, remote)
      return
    }
    const sorted = [...items].sort((left, right) => {
      const leftTime = left.time ?? 0
      const rightTime = right.time ?? 0
      if (leftTime !== rightTime) return leftTime - rightTime
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    })
    const candidate = structuredClone(this.state)
    const seenIds = new Set(candidate.seen.map((entry) => entry.id))
    const pendingIds = new Set(candidate.pending.map((entry) => entry.id))
    const at = new Date().toISOString()
    const markSeen = (id: string): void => {
      if (seenIds.has(id)) return
      seenIds.add(id)
      candidate.seen.push({ id, at })
    }
    // processed 用于推进游标；budget 只计“需要真正处理”的条目。
    // 已见过的通知不消耗每轮额度，否则重启后的第一轮会被历史条目挤满。
    let processed = 0
    let budget = 0
    let staged = 0
    for (const item of sorted) {
      if (budget >= this.commentWatch.maxPerPoll) break
      const notifyId = kind + ':' + item.id
      if (seenIds.has(notifyId)) {
        processed += 1
        continue
      }
      budget += 1
      processed += 1
      const reason = await this.notificationSkipReason(item)
      if (reason !== null) {
        this.stats.notificationSkipped += 1
        markSeen(notifyId)
        this.logger.log?.(
          '[bilibili-bridge] notification skipped id=' + item.id + ' kind=' + kind + ' reason=' + reason,
        )
        continue
      }
      const entry = this.pendingFromNotification(item)
      if (pendingIds.has(entry.id)) {
        markSeen(notifyId)
        continue
      }
      if (candidate.pending.length >= MAX_PENDING) {
        // 队列饱和：本条没有真正处理，游标不能越过它。
        processed -= 1
        break
      }
      candidate.pending.push(entry)
      pendingIds.add(entry.id)
      markSeen(notifyId)
      markSeen(entry.id)
      staged += 1
    }
    const nextCursor = this.nextNotifyCursor(this.state.notifications[kind], remote, processed, sorted.length)
    if (nextCursor !== null) candidate.notifications[kind] = nextCursor
    candidate.seen = candidate.seen.slice(-MAX_SEEN)
    if (!processed && nextCursor === null) return
    const saved = await this.commit(candidate)
    if (!saved) return
    if (staged > 0) {
      this.stats.notifications += staged
      this.logger.log?.(
        '[bilibili-bridge] notifications staged kind=' + kind + ' count=' + String(staged) +
        ' processed=' + String(processed),
      )
    }
  }

  /**
   * 整页处理完才采用上游 cursor（msgfeed 的 id 是游标 ID，不是条目 ID，不能拿条目 ID 顶替）；
   * 被 maxPerPoll 截断时保持原游标，下一轮靠 seen 去重继续处理同一页。
   */
  private nextNotifyCursor(
    current: NotifyCursor | null,
    remote: NotifyCursor | null,
    processed: number,
    total: number,
  ): NotifyCursor | null {
    if (processed >= total) return remote ?? current
    return current
  }

  private async commitNotifyCursor(kind: NotifyKind, cursor: NotifyCursor): Promise<void> {
    const candidate = structuredClone(this.state)
    candidate.notifications[kind] = cursor
    await this.commit(candidate)
  }

  /** 逐条判定是否值得占用一次回复机会；返回 null 表示可以入队。 */
  private async notificationSkipReason(item: NotifyItem): Promise<string | null> {
    if (!item.uid) return 'missing_uid'
    if (this.selfUid !== null && item.uid === this.selfUid) return 'self'
    if (item.target.type !== 'video') return 'unsupported_target:' + item.target.type
    if (item.target.bvid === null) return 'unresolved_bvid'
    if (item.target.rpid === null) return 'missing_rpid'
    if (!item.text) return 'empty_text'
    const { maxAgeMinutes, allowUids, onlyOwnVideos } = this.commentWatch
    if (maxAgeMinutes > 0 && item.time !== null) {
      const sentAt = item.time > 1e11 ? item.time : item.time * 1000
      if (Date.now() - sentAt > maxAgeMinutes * 60000) return 'stale'
    }
    if (allowUids.length && !allowUids.includes(item.uid)) return 'sender_not_allowed'
    if (this.commentMaxReplies > 0 && this.comments >= this.commentMaxReplies) return 'comment_limit'
    if (onlyOwnVideos) {
      const owner = await this.videoOwner(item.target.bvid)
      if (owner === null) return 'owner_unknown'
      if (!this.ownerUids.has(owner)) return 'foreign_video'
    }
    return null
  }

  /** 归属校验用的 video info；失败不缓存，下一轮重试。 */
  private async videoOwner(bvid: string): Promise<string | null> {
    if (this.videoOwnerCache.has(bvid)) return this.videoOwnerCache.get(bvid) ?? null
    const info = this.backend.videoInfo
    if (typeof info !== 'function') return null
    let owner: string | null
    try {
      owner = ownerUidOf(await info.call(this.backend, bvid))
    } catch (error) {
      this.logger.warn?.(
        '[bilibili-bridge] video info failed bvid=' + bvid + ' (' + errorText(error, 'unknown error') + ')',
      )
      return null
    }
    if (this.videoOwnerCache.size >= MAX_VIDEO_CACHE) {
      const oldest = this.videoOwnerCache.keys().next()
      if (!oldest.done) this.videoOwnerCache.delete(oldest.value)
    }
    this.videoOwnerCache.set(bvid, owner)
    return owner
  }

  private pendingFromNotification(item: NotifyItem): PendingEntry {
    const bvid = item.target.bvid as string
    const rpid = item.target.rpid as number
    const root = item.target.root ?? undefined
    const lines = [
      '视频：' + bvid + '（https://www.bilibili.com/video/' + bvid + '）',
      '通知：' + (item.kind === 'at' ? '@提及' : '评论回复'),
      '评论者：' + (item.name || item.uid) + '（uid ' + item.uid + '）',
    ]
    if (item.uri) lines.push('通知链接：' + item.uri)
    lines.push('', item.text, '', '回复正文即最终评论，会作为 rpid=' + String(rpid) + ' 的楼中楼发出' +
      (root === undefined ? '' : '（root=' + String(root) + '）') + '；不要附带解释。')
    return {
      id: 'cmt:' + bvid + ':' + String(rpid),
      uid: this.ownerUidList[0] ?? '',
      name: item.name || item.uid,
      content: lines.join('\n'),
      seqno: null,
      timestamp: item.time,
      key: item.id,
      skipReason: null,
      created_at: new Date().toISOString(),
      surface: 'comment',
      target: root === undefined ? { bvid, rpid } : { bvid, rpid, root },
    }
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
        surface: 'dm',
        target: null,
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

  /** 私信帧：来源头 + reply_ctx 指向对端 uid。 */
  private dmFrame(entry: PendingEntry, senderName: string): BridgeMessageInput {
    return {
      type: 'message',
      id: entry.id,
      msg_id: entry.id,
      uid: entry.uid,
      user_id: entry.uid,
      name: senderName,
      user_name: senderName,
      session_key: this.platform + ':dm:' + entry.uid,
      content: sourceHeader('dm', senderName) + entry.content,
      reply_ctx: JSON.stringify({ kind: 'dm', uid: entry.uid }),
      source: { platform: this.platform, surface: 'dm', untrusted: true },
    }
  }

  /** 评论通知帧：reply_ctx 必须带准确的 bvid/rpid（可选 root），否则 agent 会回到错误的评论。 */
  private commentFrame(entry: PendingEntry, senderName: string): BridgeMessageInput | null {
    const target = entry.target
    if (target === null) return null
    const replyContext: Record<string, unknown> = { kind: 'comment', bvid: target.bvid }
    if (target.rpid !== undefined) replyContext.rpid = target.rpid
    if (target.root !== undefined) replyContext.root = target.root
    return {
      type: 'message',
      id: entry.id,
      msg_id: entry.id,
      uid: entry.uid,
      user_id: entry.uid,
      name: senderName,
      user_name: senderName,
      session_key: this.platform + ':comment:' + target.bvid,
      content: sourceHeader('comment', senderName) + entry.content,
      reply_ctx: JSON.stringify(replyContext),
      source: { platform: this.platform, surface: 'comment', untrusted: true },
    }
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
      // 通知转发也要限速：未到最小间隔就停下，条目留在 pending 等下一轮。
      if (
        entry.surface === 'comment' &&
        this.commentWatch.minGapMs > 0 &&
        Date.now() - this.lastCommentForwardAt < this.commentWatch.minGapMs
      ) break
      // 同时提供归一化字段和 bridge 帧字段：BridgeClient 会补齐/校验。
      // content 前置来源头，source 供支持结构化元数据的 adapter 使用。
      // 昵称同时用于来源头和帧字段，必须用同一套清洗结果，避免下游从 name 绕过。
      const senderName = sanitizeSender(entry.name || entry.uid)
      const frame = entry.surface === 'comment'
        ? this.commentFrame(entry, senderName)
        : this.dmFrame(entry, senderName)
      if (frame === null) {
        // 目标缺失的评论条目直接剔除，避免永久堵塞队列；不产生帧。
        this.logger.warn?.('[bilibili-bridge] pending comment without target dropped id=' + entry.id)
        resolutions.push(resolutionOf(entry))
        continue
      }
      try {
        const result = await this.bridge.sendMessage(frame)
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
      if (entry.surface === 'comment') this.lastCommentForwardAt = Date.now()
      this.logger.log?.('[bilibili-bridge] forwarded msg_id=' + entry.id + ' uid=' + entry.uid + ' surface=' + entry.surface)
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

  /**
   * 刷一批视频，把「视频 + 目标评论」作为一帧交给 agent；帧里带 comment reply_ctx，
   * agent 的回复会落到该视频（或该条评论）上。只读阶段失败不影响已发出的帧。
   */
  async runScrollCycle(options: { prompt?: string; sessionKey?: string } = {}): Promise<ScrollSummary> {
    const summary: ScrollSummary = { videos: 0, offered: 0, readFailures: 0, sendFailures: 0 }
    // 控制台里配置的「任务指令」与「会话标识」必须真的进入交给 agent 的那一帧；
    // 否则 UI 上的配置只是死字段（此前 buildScrollTask 的结果被直接丢弃）。
    const taskPrompt = typeof options.prompt === 'string' && options.prompt.trim() ? options.prompt.trim() : ''
    const configuredSessionKey = typeof options.sessionKey === 'string' && options.sessionKey ? options.sessionKey : ''
    const backend = this.backend
    const prefs = this.scroll
    let raw: unknown
    try {
      if (prefs.source === 'search') {
        if (!backend.videoSearch) throw new Error('backend 未提供 videoSearch 能力')
        if (!prefs.keywords.trim()) throw new Error('搜索模式需要至少一个关键词')
        raw = await backend.videoSearch(prefs.keywords, prefs.numVideos)
      } else {
        if (!backend.videoHot) throw new Error('backend 未提供 videoHot 能力')
        raw = await backend.videoHot(prefs.numVideos)
      }
    } catch (error) {
      summary.readFailures += 1
      this.stats.readFailures += 1
      this.logger.error?.('[bilibili-bridge] scroll read failed: ' + errorText(error, 'unknown error'))
      return summary
    }

    const videos = extractVideos(raw).slice(0, prefs.numVideos)
    summary.videos = videos.length
    for (const video of videos) {
      if (!this.bridgeReady()) break
      if (avoidedBy(video, prefs.avoidTags)) continue
      let target: { bvid: string; rpid?: number; comment: string } = { bvid: video.bvid, comment: '' }
      if (backend.comments) {
        try {
          const comments = await backend.comments(video.bvid, prefs.commentsPerVideo)
          const first = comments.map(asComment).find((entry): entry is { rpid: number; content: string } => entry !== null)
          if (first) target = { bvid: video.bvid, rpid: first.rpid, comment: first.content }
        } catch (error) {
          summary.readFailures += 1
          this.stats.readFailures += 1
          this.logger.warn?.('[bilibili-bridge] comment read failed bvid=' + video.bvid + ' (' + errorText(error, 'unknown error') + ')')
          continue
        }
      }
      const lines = [
        sourceHeader('comment', video.title || video.bvid).trimEnd(),
        ...(taskPrompt ? [taskPrompt] : []),
        '视频：' + (video.title || video.bvid) + '（' + video.bvid + '）',
        target.rpid ? '待回复评论 rpid=' + String(target.rpid) + '：' + target.comment : '该视频暂无可回复评论',
        prefs.style ? '风格要求：' + prefs.style : '',
        '回复正文即最终评论；不要附带解释。',
      ].filter(Boolean)
      try {
        const result = await this.bridge.sendMessage({
          type: 'message',
          id: video.bvid + (target.rpid ? ':' + String(target.rpid) : ''),
          msg_id: video.bvid,
          uid: this.ownerUidList[0] ?? '',
          user_id: this.ownerUidList[0] ?? '',
          name: '本地刷视频',
          user_name: '本地刷视频',
          session_key: configuredSessionKey || (this.platform + ':comment:' + video.bvid),
          content: lines.join('\n'),
          reply_ctx: JSON.stringify(target.rpid === undefined
            ? { kind: 'comment', bvid: video.bvid }
            : { kind: 'comment', bvid: video.bvid, rpid: target.rpid }),
          source: { platform: this.platform, surface: 'comment', untrusted: true },
        })
        if (result === false || (isPlainObject(result) && (result.ok === false || result.success === false))) {
          throw new Error(errorText(isPlainObject(result) ? result.error : undefined, 'bridge send rejected'))
        }
      } catch (error) {
        summary.sendFailures += 1
        this.stats.sendFailures += 1
        this.logger.error?.('[bilibili-bridge] scroll offer failed bvid=' + video.bvid + ': ' + errorText(error, 'unknown error'))
        continue
      }
      summary.offered += 1
      this.logger.log?.('[bilibili-bridge] scroll offered bvid=' + video.bvid + (target.rpid ? ' rpid=' + String(target.rpid) : ''))
    }
    return summary
  }

  private async handleCommentReply(context: Record<string, unknown>, content: string): Promise<ReplyResult> {
    const bvid = String(context.bvid ?? '')
    if (!/^BV[0-9A-Za-z]{10}$/u.test(bvid)) {
      this.logger.error?.('[bilibili-bridge] comment reply rejected: invalid bvid')
      return { ok: false, reason: 'invalid_target' }
    }
    let rpid: number | undefined
    if (context.rpid !== undefined && context.rpid !== null) {
      const numeric = typeof context.rpid === 'number' ? context.rpid : Number(String(context.rpid))
      if (!Number.isSafeInteger(numeric) || numeric < 1) {
        this.logger.error?.('[bilibili-bridge] comment reply rejected: invalid rpid')
        return { ok: false, reason: 'invalid_target' }
      }
      rpid = numeric
    }
    let root: number | undefined
    if (context.root !== undefined && context.root !== null) {
      const numeric = typeof context.root === 'number' ? context.root : Number(String(context.root))
      if (!Number.isSafeInteger(numeric) || numeric < 1 || rpid === undefined) {
        // root 只对楼中楼有意义；没有 rpid 就等于回错位置，直接拒绝而不是退化成顶层评论。
        this.logger.error?.('[bilibili-bridge] comment reply rejected: invalid root')
        return { ok: false, reason: 'invalid_target' }
      }
      root = numeric
    }
    if (!this.backend.postComment) {
      this.logger.error?.('[bilibili-bridge] comment reply rejected: backend 未提供 postComment 能力')
      return { ok: false, reason: 'comment_unsupported' }
    }
    if (this.commentMaxReplies > 0 && this.comments >= this.commentMaxReplies) {
      this.logger.warn?.('[bilibili-bridge] comment reply limit reached; not sent')
      return { ok: false, reason: 'comment_limit' }
    }
    try {
      const approved = await this.confirmComment({ bvid, rpid, root, text: content, reply: {} })
      if (!approved) {
        this.logger.log?.('[bilibili-bridge] comment reply skipped: not confirmed bvid=' + bvid)
        return { ok: false, reason: 'not_confirmed' }
      }
      this.comments += 1
      this.stats.comments = this.comments
      const target = rpid === undefined
        ? { bvid }
        : root === undefined
          ? { bvid, rpid }
          : { bvid, rpid, root }
      const result = await this.backend.postComment(target, content, { confirm: true })
      if (isPlainObject(result) && (result.dryRun === true || result.dry_run === true || result.preview === true)) {
        this.logger.log?.('[bilibili-bridge] comment previewed (dry-run) bvid=' + bvid)
        return { ok: true, bvid, dryRun: true }
      }
      this.logger.log?.('[bilibili-bridge] comment sent bvid=' + bvid)
      return { ok: true, bvid }
    } catch (error) {
      this.stats.sendFailures += 1
      this.logger.error?.('[bilibili-bridge] comment reply failed: ' + errorText(error, 'unknown error'))
      return { ok: false, reason: 'send_failed', error }
    }
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
    let context: unknown
    try {
      context = typeof reply.reply_ctx === 'string' ? parseJsonLossless(reply.reply_ctx) : reply.reply_ctx
    } catch {
      this.logger.error?.('[bilibili-bridge] reply rejected: invalid reply_ctx')
      return { ok: false, reason: 'invalid_reply_ctx' }
    }
    if (!isPlainObject(context)) {
      this.logger.error?.('[bilibili-bridge] reply rejected: reply_ctx is not an object')
      return { ok: false, reason: 'invalid_reply_ctx' }
    }
    if (context.kind !== 'comment' && context.kind !== 'dm') {
      this.logger.error?.('[bilibili-bridge] reply rejected: reply_ctx is not a dm or comment context')
      return { ok: false, reason: 'invalid_reply_ctx' }
    }

    // 目标不同 → CLI 契约上限不同（comment create 150 / dm send 300）。
    // 先按目标取上限再截断，否则 151–300 字的评论回复会在 CLI 校验层被拒、根本发不出去。
    const cap = context.kind === 'comment'
      ? Math.min(this.replyMax, COMMENT_TEXT_MAX)
      : Math.min(this.replyMax, DM_TEXT_MAX)
    const { text: content, truncated } = truncateReply(raw, cap)
    if (truncated) {
      this.logger.log?.(
        '[bilibili-bridge] reply truncated: ' + String(raw.length) + ' -> ' + String(content.length) +
        ' characters (cap ' + String(cap) + ', kind ' + String(context.kind) + ')',
      )
    }
    if (context.kind === 'comment') return this.handleCommentReply(context, content)

    const uid = String(context.uid ?? '')
    if (!uid || !this.ownerUids.has(uid)) {
      this.logger.error?.('[bilibili-bridge] reply rejected: uid is not in the owner whitelist')
      return { ok: false, reason: 'uid_not_allowed' }
    }

    try {
      if (this.maxReplies > 0 && this.replies + this.replyReservations >= this.maxReplies) {
        this.logger.warn?.('[bilibili-bridge] reply limit reached; not sent')
        return { ok: false, reason: 'reply_limit' }
      }
      this.replyReservations += 1
      let approved: boolean
      try { approved = await this.confirmSend({ uid, text: content, reply }) }
      catch (error) { this.replyReservations -= 1; throw error }
      this.replyReservations -= 1
      if (!approved) {
        this.logger.log?.('[bilibili-bridge] reply skipped: not confirmed uid=' + uid)
        return { ok: false, reason: 'not_confirmed' }
      }
      this.replies += 1 // Reserve before dispatch; unknown outcomes are never retried.
      this.stats.replies = this.replies
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