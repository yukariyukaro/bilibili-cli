import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'
import { basename, dirname, resolve, sep } from 'node:path'

import {
  errorCode,
  errorMessage,
  hasOwn,
  isIntegerString,
  isNonEmptyString,
  isPlainObject,
  isPositiveIntegerString,
  isSafeNonNegativeInteger,
  isSafePositiveInteger,
} from './guards.mjs'
import { comparePendingEntries } from './orders.mjs'
import type {
  BaselineOrder,
  BridgeState,
  Conversation,
  Order,
  PendingEntry,
  SeenEntry,
} from './types.mjs'

// 本模块负责进程生命周期的持久化不变量：读取失败必须显式报错、写入必须原子替换、
// 同一 statePath 只允许一个实例存活。state v1 在 adapter 规范化之前做严格结构校验：
// 合法 JSON 但字段不完整/版本未知时 fail closed，不能静默过滤后重建 baseline。

export const MAX_SEEN = 2000

export class StateStoreError extends Error {
  readonly code: string

  constructor(code: string, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'StateStoreError'
    this.code = code
  }
}

function fail(code: string, message: string, cause?: unknown): StateStoreError {
  return new StateStoreError(code, message, cause)
}

function corrupt(message: string): StateStoreError {
  return fail('STATE_CORRUPT', message)
}

function emptyState(): BridgeState {
  return { version: 1, conversations: {}, pending: [], seen: [] }
}

function objectAt(value: unknown, where: string): Record<string, unknown> {
  if (!isPlainObject(value)) throw corrupt(where + ' 必须是对象')
  return value
}

function validateOrder(value: unknown, where: string): Order {
  const record = objectAt(value, where)
  for (const field of ['seqno', 'timestamp', 'key', 'empty']) {
    if (!hasOwn(record, field)) throw corrupt(where + ' 缺少字段 ' + field)
  }
  const seqno = record.seqno
  if (seqno !== null) {
    if (!isIntegerString(seqno)) throw corrupt(where + '.seqno 必须是整数字符串或 null')
  }
  const timestamp = record.timestamp
  if (timestamp !== null) {
    if (!isSafeNonNegativeInteger(timestamp)) throw corrupt(where + '.timestamp 必须是非负安全整数或 null')
  }
  const key = record.key
  if (key !== null) {
    if (!isNonEmptyString(key)) throw corrupt(where + '.key 必须是非空字符串或 null')
  }
  const empty = record.empty
  if (typeof empty !== 'boolean') throw corrupt(where + '.empty 必须是布尔值')
  if (seqno === null && timestamp === null && key === null && empty !== true) {
    throw corrupt(where + ' 没有可比较的游标却没有标记 empty=true')
  }
  return { seqno, timestamp, key, empty }
}

function validateBaseline(value: unknown, where: string): BaselineOrder {
  const record = objectAt(value, where)
  const order = validateOrder(record, where)
  if (hasOwn(record, 'at') && record.at !== null && typeof record.at !== 'string') {
    throw corrupt(where + '.at 必须是字符串或 null')
  }
  return { ...order, at: typeof record.at === 'string' ? record.at : null }
}

function validateConversation(value: unknown, uid: string): Conversation {
  if (!isPositiveIntegerString(uid)) throw corrupt('conversations[' + uid + '] 的 uid 必须是正安全整数字符串')
  const record = objectAt(value, 'conversations[' + uid + ']')
  if (!hasOwn(record, 'baseline') || !hasOwn(record, 'cursor')) {
    throw corrupt('conversations[' + uid + '] 必须同时包含 baseline 与 cursor 字段')
  }
  const baseline = record.baseline === null ? null : validateBaseline(record.baseline, 'conversations[' + uid + '].baseline')
  const cursor = record.cursor === null ? null : validateOrder(record.cursor, 'conversations[' + uid + '].cursor')
  if (baseline === null && cursor === null) {
    throw corrupt('conversations[' + uid + '] 既无 baseline 也无 cursor，adapter 会静默丢弃')
  }
  return { baseline, cursor }
}

function validateSeenEntry(value: unknown, index: number): SeenEntry {
  if (typeof value === 'string') {
    if (!value) throw corrupt('seen[' + index + '] 不能是空字符串')
    return { id: value, at: null }
  }
  const record = objectAt(value, 'seen[' + index + ']')
  const id = record.id
  if (!isNonEmptyString(id)) throw corrupt('seen[' + index + '].id 必须是非空字符串')
  if (hasOwn(record, 'at') && record.at !== null && typeof record.at !== 'string') {
    throw corrupt('seen[' + index + '].at 必须是字符串或 null')
  }
  return { id, at: typeof record.at === 'string' ? record.at : null }
}

function validatePendingEntry(value: unknown, index: number): PendingEntry {
  const where = 'pending[' + index + ']'
  const record = objectAt(value, where)
  for (const field of ['id', 'uid', 'name', 'content', 'seqno', 'timestamp', 'key', 'skipReason', 'created_at']) {
    if (!hasOwn(record, field)) throw corrupt(where + ' 缺少字段 ' + field)
  }
  const id = record.id
  if (!isNonEmptyString(id)) throw corrupt(where + '.id 必须是非空字符串')
  const uid = record.uid
  if (!isPositiveIntegerString(uid)) throw corrupt(where + '.uid 必须是正安全整数字符串')
  const name = record.name
  if (typeof name !== 'string') throw corrupt(where + '.name 必须是字符串')
  const content = record.content
  if (typeof content !== 'string') throw corrupt(where + '.content 必须是字符串')
  const seqno = record.seqno
  if (seqno !== null) {
    if (!isIntegerString(seqno)) throw corrupt(where + '.seqno 必须是整数字符串或 null')
  }
  const timestamp = record.timestamp
  if (timestamp !== null) {
    if (!isSafeNonNegativeInteger(timestamp)) throw corrupt(where + '.timestamp 必须是非负安全整数或 null')
  }
  const key = record.key
  if (key !== null) {
    if (!isNonEmptyString(key)) throw corrupt(where + '.key 必须是非空字符串或 null')
  }
  const skipReason = record.skipReason
  if (skipReason !== null) {
    if (!isNonEmptyString(skipReason)) throw corrupt(where + '.skipReason 必须是非空字符串或 null')
  }
  const createdAt = record.created_at
  if (createdAt !== null && typeof createdAt !== 'string') {
    throw corrupt(where + '.created_at 必须是字符串或 null')
  }
  return {
    id,
    uid,
    name,
    content,
    seqno: seqno === null ? null : BigInt(seqno).toString(),
    timestamp,
    key,
    skipReason,
    created_at: typeof createdAt === 'string' ? createdAt : null,
  }
}

/**
 * state v1 严格校验。合法 JSON 但结构不完整也 fail closed，避免把无效
 * pending/seen/conversation 静默过滤后重新 baseline 并丢事件。
 * 兼容旧 demo 的 { seen: [...] }；使用 v1 字段时必须显式 version:1。
 */
export function validateStateShape(value: unknown): asserts value is Record<string, unknown> {
  const record = objectAt(value, 'state')
  const hasVersion = hasOwn(record, 'version')
  const hasConversations = hasOwn(record, 'conversations')
  const hasPending = hasOwn(record, 'pending')
  if (hasVersion && record.version !== 1) throw corrupt('state.version 仅支持 1')
  if ((hasConversations || hasPending) && record.version !== 1) {
    throw corrupt('state 使用 v1 字段时必须显式 version:1')
  }
  if (hasConversations) {
    const conversations = objectAt(record.conversations, 'state.conversations')
    for (const [uid, conversation] of Object.entries(conversations)) validateConversation(conversation, uid)
  }
  if (hasPending) {
    if (!Array.isArray(record.pending)) throw corrupt('state.pending 必须是数组')
    for (let index = 0; index < record.pending.length; index += 1) {
      validatePendingEntry(record.pending[index], index)
    }
  }
  if (hasOwn(record, 'seen')) {
    if (!Array.isArray(record.seen)) throw corrupt('state.seen 必须是数组')
    for (let index = 0; index < record.seen.length; index += 1) validateSeenEntry(record.seen[index], index)
  }
}

/**
 * 单一 state 规范化入口：严格校验后重建已知字段，排序 pending、去重 seen、
 * 截断 seen；旧 { seen } 结构也会升级为 v1。未知顶层字段不保留。
 * 非对象输入（null/array/标量）一律 fail closed；缺失文件由 StateStore.load
 * 单独用 emptyState() 处理，不在这里吞掉。
 */
export function normalizeState(input: unknown): BridgeState {
  validateStateShape(input)
  const state = emptyState()

  if (isPlainObject(input.conversations)) {
    for (const [uid, raw] of Object.entries(input.conversations)) {
      state.conversations[uid] = validateConversation(raw, uid)
    }
  }

  if (Array.isArray(input.pending)) {
    const ids = new Set<string>()
    for (const raw of input.pending) {
      const entry = validatePendingEntry(raw, state.pending.length)
      if (ids.has(entry.id)) continue
      ids.add(entry.id)
      state.pending.push(entry)
    }
    state.pending.sort(comparePendingEntries)
  }

  if (Array.isArray(input.seen)) {
    const ids = new Set<string>()
    for (const raw of input.seen) {
      const parsed: SeenEntry = validateSeenEntry(raw, state.seen.length)
      if (ids.has(parsed.id)) continue
      ids.add(parsed.id)
      state.seen.push(parsed)
    }
    state.seen = state.seen.slice(-MAX_SEEN)
  }

  return state
}

export class StateStore {
  readonly path: string
  state: BridgeState | null = null
  existed = false
  private queue: Promise<void> = Promise.resolve()

  constructor(statePath: string) {
    this.path = resolve(statePath)
  }

  async load(): Promise<BridgeState> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        this.existed = false
        this.state = emptyState()
        return this.state
      }
      throw fail('STATE_UNREADABLE', '无法读取 state 文件 ' + this.path + '：' + errorMessage(error), error)
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      throw fail('STATE_CORRUPT', 'state 文件不是合法 JSON：' + this.path, error)
    }

    try {
      // load 必须严格：null/array 等非对象 state 不能被 normalizeState 当成空状态吞掉。
      validateStateShape(parsed)
      const normalized = normalizeState(parsed)
      this.existed = true
      this.state = normalized
      return normalized
    } catch (error) {
      const code = errorCode(error) ?? 'STATE_CORRUPT'
      throw fail(code, 'state 文件结构无效：' + this.path + '：' + errorMessage(error), error)
    }
  }

  /**
   * 串行原子保存：同目录临时文件 + fsync + rename，失败不触碰原文件。
   * 返回的 promise 在写入完成后 resolve；多次调用按顺序落盘。
   */
  save(next: unknown): Promise<void> {
    let normalized: BridgeState
    let body: string
    try {
      // 保存同样 fail closed：不能把 null/array 静默规范化为空 state 覆盖原文件。
      validateStateShape(next)
      normalized = normalizeState(next)
      body = JSON.stringify(normalized) + '\n'
    } catch (error) {
      return Promise.reject(
        error instanceof StateStoreError ? error : fail('STATE_INVALID', errorMessage(error), error),
      )
    }
    this.queue = this.queue.catch(() => undefined).then(() => this.writeAtomic(body, normalized))
    return this.queue
  }

  private async writeAtomic(body: string, state: BridgeState): Promise<void> {
    const dir = dirname(this.path)
    const temp = dir + sep + '.' + basename(this.path) + '.' + process.pid + '.' + randomUUID() + '.tmp'
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      await mkdir(dir, { recursive: true })
      handle = await open(temp, 'wx', 0o600)
      await handle.writeFile(body, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await rename(temp, this.path)
      this.state = state
      this.existed = true
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await unlink(temp).catch(() => undefined)
      throw fail('STATE_WRITE', '无法原子保存 state 文件 ' + this.path + '：' + errorMessage(error), error)
    }
  }
}

export function createStateStore(statePath: string): StateStore {
  return new StateStore(statePath)
}

export interface InstanceLockInfo {
  pid: number
  host: string
  startedAt: string
  token: string
}

export function isProcessAlive(pid: number): boolean {
  if (!isSafePositiveInteger(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM 表示进程存在但无权限探测，必须按存活处理，不能回收别人的锁。
    return errorCode(error) === 'EPERM'
  }
}

function parseLockInfo(parsed: unknown, lockPath: string): InstanceLockInfo | null {
  if (!isPlainObject(parsed)) {
    throw fail('LOCK_UNREADABLE', '锁文件结构无效，拒绝自动回收：' + lockPath)
  }
  if (
    !isSafePositiveInteger(parsed.pid) ||
    !isNonEmptyString(parsed.token) ||
    !isNonEmptyString(parsed.host) ||
    typeof parsed.startedAt !== 'string'
  ) {
    throw fail('LOCK_UNREADABLE', '锁文件结构无效，拒绝自动回收：' + lockPath)
  }
  return { pid: parsed.pid, host: parsed.host, startedAt: parsed.startedAt, token: parsed.token }
}

/** 读取并严格校验锁；ENOENT 返回 null，损坏/结构不符 fail closed。 */
export async function readInstanceLock(lockPath: string): Promise<InstanceLockInfo | null> {
  let text: string
  try {
    text = await readFile(lockPath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw fail('LOCK_UNREADABLE', '无法读取锁文件 ' + lockPath + '：' + errorMessage(error), error)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // wx 刚创建、内容尚未写完时也会走到这里：必须 fail closed，不能把并发实例的锁删掉。
    throw fail('LOCK_UNREADABLE', '锁文件不是合法 JSON，拒绝自动回收：' + lockPath, error)
  }
  return parseLockInfo(parsed, lockPath)
}

export class InstanceLock {
  readonly path: string
  readonly info: InstanceLockInfo
  private released = false

  constructor(lockPath: string, info: InstanceLockInfo) {
    this.path = lockPath
    this.info = info
  }

  async release(): Promise<void> {
    if (this.released) return
    this.released = true
    let current: InstanceLockInfo | null
    try {
      current = await readInstanceLock(this.path)
    } catch (error) {
      throw fail('LOCK_RELEASE', '无法确认锁归属，保留锁文件以免误删：' + this.path + '：' + errorMessage(error), error)
    }
    if (!current) return
    if (current.pid !== this.info.pid || current.token !== this.info.token) return
    try {
      await unlink(this.path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw fail('LOCK_RELEASE', '无法删除锁文件 ' + this.path + '：' + errorMessage(error), error)
      }
    }
  }
}

export interface AcquireLockOptions {
  logger?: (message: string) => void
}

/**
 * 同 statePath 单实例锁。
 *
 * 所有 acquire 都先拿一个短时 recovery guard（.lock.guard，wx 原子创建），再在
 * guard 内完成“读锁 -> stale 判断 -> 删除 -> 新建”。这样两个并发恢复者不可能
 * 各自读到旧 token 后交替删除对方新建的锁。正常新建锁仍是 wx；guard 只串行化
 * 恢复/创建临界区。
 *
 * - 锁存在且 pid 存活（同主机）或锁属于当前 pid => ALREADY_RUNNING，不回收。
 * - pid 已退出（同主机）=> stale，持 guard 重读 token/pid 后回收并重试。
 * - 锁内容损坏 / 跨主机 / 无法判断 => fail closed，不自动删除。
 * - guard 损坏、跨主机或 stale（上次恢复中崩溃）=> LOCK_RECOVERY，必须人工确认，
 *   不在 TOCTOU 下自动回收 guard。
 */
export async function acquireInstanceLock(
  statePath: string,
  { logger = () => undefined }: AcquireLockOptions = {},
): Promise<InstanceLock> {
  const target = resolve(statePath)
  const lockPath = target + '.lock'
  const guardPath = lockPath + '.guard'
  try {
    await mkdir(dirname(lockPath), { recursive: true })
  } catch (error) {
    throw fail('LOCK_CREATE', '无法创建锁目录：' + dirname(lockPath) + '：' + errorMessage(error), error)
  }
  const info: InstanceLockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    token: randomUUID(),
  }

  await acquireRecoveryGuard(guardPath, info, logger)
  let acquired: InstanceLock
  try {
    acquired = await createLockUnderGuard(lockPath, target, info, logger)
  } finally {
    await releaseRecoveryGuard(guardPath, info, logger)
  }
  return acquired
}

const GUARD_RETRIES = 5
const GUARD_WAIT_MS = 30

async function acquireRecoveryGuard(
  guardPath: string,
  info: InstanceLockInfo,
  logger: (message: string) => void,
): Promise<void> {
  for (let attempt = 0; attempt < GUARD_RETRIES; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let created = false
    try {
      handle = await open(guardPath, 'wx', 0o600)
      created = true
      await handle.writeFile(JSON.stringify(info) + '\n', 'utf8')
      await handle.close()
      handle = null
      created = false
      return
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      if (created) await unlink(guardPath).catch(() => undefined)
      if (errorCode(error) !== 'EEXIST') {
        throw fail('LOCK_CREATE', '无法创建 recovery guard ' + guardPath + '：' + errorMessage(error), error)
      }
    }

    let existing: InstanceLockInfo | null
    try {
      existing = await readInstanceLock(guardPath)
    } catch (error) {
      throw fail(
        'LOCK_RECOVERY',
        'recovery guard 损坏，拒绝自动处理：' + guardPath + '；' + errorMessage(error),
        error,
      )
    }
    if (!existing) continue
    if (existing.host !== info.host) {
      throw fail('LOCK_RECOVERY', 'recovery guard 属于其他主机：' + guardPath + '（host=' + existing.host + '）')
    }
    if (existing.pid === process.pid) {
      throw fail('ALREADY_RUNNING', '当前进程已有 bridge 正在初始化 ' + guardPath)
    }
    if (isProcessAlive(existing.pid)) {
      logger('等待其他实例释放 recovery guard ' + guardPath)
      await new Promise<void>((resolveWait) => setTimeout(resolveWait, GUARD_WAIT_MS))
      continue
    }
    // 上次恢复中崩溃留下的 guard：自动回收无法避免 TOCTOU，必须 fail closed。
    throw fail(
      'LOCK_RECOVERY',
      '发现 stale recovery guard，拒绝自动回收以免误删新实例锁：' + guardPath + '（pid=' + String(existing.pid) + '）',
    )
  }
  throw fail('LOCK_BUSY', '多次重试后仍无法获取 recovery guard ' + guardPath)
}

async function releaseRecoveryGuard(
  guardPath: string,
  info: InstanceLockInfo,
  logger: (message: string) => void,
): Promise<void> {
  let current: InstanceLockInfo | null
  try {
    current = await readInstanceLock(guardPath)
  } catch (error) {
    logger('无法确认 recovery guard 归属，保留文件：' + guardPath + '：' + errorMessage(error))
    return
  }
  if (!current || current.pid !== info.pid || current.token !== info.token) return
  try {
    await unlink(guardPath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      logger('无法删除 recovery guard ' + guardPath + '：' + errorMessage(error))
    }
  }
}

async function createLockUnderGuard(
  lockPath: string,
  target: string,
  info: InstanceLockInfo,
  logger: (message: string) => void,
): Promise<InstanceLock> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let created = false
    try {
      handle = await open(lockPath, 'wx', 0o600)
      created = true
      await handle.writeFile(JSON.stringify(info) + '\n', 'utf8')
      await handle.close()
      handle = null
      created = false
      return new InstanceLock(lockPath, info)
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      // wx 创建成功后写入/关闭失败时，文件仍属于本进程；必须清掉，避免留下永久损坏锁。
      if (created) await unlink(lockPath).catch(() => undefined)
      if (errorCode(error) !== 'EEXIST') {
        throw fail('LOCK_CREATE', '无法创建锁文件 ' + lockPath + '：' + errorMessage(error), error)
      }
    }

    const existing = await readInstanceLock(lockPath)
    if (!existing) continue

    if (existing.host !== info.host) {
      throw fail('ALREADY_RUNNING', '另一个 bridge 实例占用了 ' + target + '（host=' + existing.host + '）')
    }
    // 同 pid 不视为 stale：否则同一进程内并发调用 runBridge 会互相删锁。
    if (existing.pid === process.pid) {
      throw fail('ALREADY_RUNNING', '当前进程已有 bridge 实例占用了 ' + target)
    }
    if (isProcessAlive(existing.pid)) {
      throw fail('ALREADY_RUNNING', '另一个 bridge 实例占用了 ' + target + '（pid=' + String(existing.pid) + '）')
    }

    // 持 guard 重读，确认仍是同一 stale 锁后删除。正常 acquire 也走 guard，
    // 因此不会出现“删除别人刚建的新锁”的交错。
    const again = await readInstanceLock(lockPath)
    if (!again || again.pid !== existing.pid || again.token !== existing.token) continue
    logger('回收 stale 锁 ' + lockPath + ' (pid=' + String(existing.pid) + ')')
    try {
      await unlink(lockPath)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw fail('LOCK_STALE', '无法回收 stale 锁 ' + lockPath + '：' + errorMessage(error), error)
      }
    }
  }
  throw fail('LOCK_BUSY', '多次重试后仍无法获取 ' + lockPath + ' 锁')
}