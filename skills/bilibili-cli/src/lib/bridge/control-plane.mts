import { open, readFile, unlink } from 'node:fs/promises'
import { hostname } from 'node:os'

import { errorCode, errorMessage, isNonEmptyString, isPlainObject, isSafePositiveInteger } from './guards.mjs'
import { isProcessAlive, readInstanceLock, type InstanceLockInfo } from './state.mjs'
import { lockPathFor, stopRequestPathFor } from './state-path.mjs'

export const STOP_WAIT_TIMEOUT_MS = 15000
const STOP_WAIT_POLL_MS = 100

export class BridgeControlError extends Error {
  readonly code: string
  readonly exitCode: number

  constructor(code: string, message: string, exitCode = 2) {
    super(message)
    this.name = 'BridgeControlError'
    this.code = code
    this.exitCode = exitCode
  }
}

export interface BridgeStatusResult {
  running: boolean
  pid?: number
  statePath: string
}

export interface BridgeStopResult {
  running: boolean
  stopped: boolean
  statePath: string
}

export interface StopRequest {
  pid: number
  token: string
  requestedAt: string
}

export interface StopWaitOptions {
  timeoutMs?: number
  pollMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

function lockForControl(statePath: string): Promise<InstanceLockInfo | null> {
  return readInstanceLock(lockPathFor(statePath)).catch((error: unknown) => {
    throw new BridgeControlError('LOCK_UNREADABLE', '无法读取 bridge 锁文件，拒绝推断运行状态：' + errorMessage(error))
  })
}

function parseStopRequest(value: unknown, path: string): StopRequest {
  if (!isPlainObject(value)) throw new BridgeControlError('STOP_REQUEST_CORRUPT', 'stop 请求不是对象：' + path)
  const pid = value.pid
  const token = value.token
  const requestedAt = value.requestedAt
  if (!isSafePositiveInteger(pid) || !isNonEmptyString(token) || typeof requestedAt !== 'string') {
    throw new BridgeControlError('STOP_REQUEST_CORRUPT', 'stop 请求结构无效：' + path)
  }
  return { pid, token, requestedAt }
}

export async function readStopRequest(statePath: string): Promise<StopRequest | null> {
  const path = stopRequestPathFor(statePath)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw new BridgeControlError('STOP_REQUEST_UNREADABLE', '无法读取 stop 请求：' + errorMessage(error))
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BridgeControlError('STOP_REQUEST_CORRUPT', 'stop 请求不是合法 JSON：' + path)
  }
  return parseStopRequest(parsed, path)
}

async function writeStopRequestAtomic(statePath: string, target: InstanceLockInfo): Promise<void> {
  const path = stopRequestPathFor(statePath)
  const request: StopRequest = {
    pid: target.pid,
    token: target.token,
    requestedAt: new Date().toISOString(),
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    let created = false
    try {
      handle = await open(path, 'wx', 0o600)
      created = true
      await handle.writeFile(JSON.stringify(request) + '\n', 'utf8')
      await handle.close()
      handle = null
      created = false
      return
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      if (created) await unlink(path).catch(() => undefined)
      if (errorCode(error) !== 'EEXIST') {
        throw new BridgeControlError('STOP_REQUEST_WRITE', '无法独占创建 stop 请求：' + errorMessage(error))
      }
    }

    const existing = await readStopRequest(statePath)
    if (!existing) continue
    if (existing.pid === target.pid && existing.token === target.token) return

    // 不同实例的旧标记：主循环只消费与当前 lock token 相同的标记，因此不会
    // 误停新实例。先重读 lock 确认目标 token 仍在，再替换该标记。
    const current = await lockForControl(statePath)
    if (!current || current.pid !== target.pid || current.token !== target.token) return
    try {
      await unlink(path)
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') {
        throw new BridgeControlError('STOP_REQUEST_WRITE', '无法替换旧 stop 请求：' + errorMessage(error))
      }
    }
  }
  throw new BridgeControlError('STOP_REQUEST_BUSY', '无法创建 stop 请求，请检查 ' + path)
}

/** 主循环调用：只消费与当前实例 pid + lock token 完全一致的标记。 */
export async function checkStopRequest(statePath: string, token: string, pid: number): Promise<boolean> {
  let request: StopRequest | null
  try {
    request = await readStopRequest(statePath)
  } catch {
    // 损坏/不可读 marker 只影响控制请求本身（control stop 会 fail closed）；
    // 主循环每 250ms 轮询，不能因此刷错误日志或退出。
    return false
  }
  if (!request) return false
  if (request.pid !== pid || request.token !== token) return false
  try {
    await unlink(stopRequestPathFor(statePath))
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
  return true
}

/** 退出清理：只删除属于当前实例的标记，不碰其他实例/损坏标记。 */
export async function clearOwnStopRequest(statePath: string, token: string, pid: number): Promise<void> {
  try {
    const request = await readStopRequest(statePath)
    if (!request || request.pid !== pid || request.token !== token) return
    await unlink(stopRequestPathFor(statePath))
  } catch {
    // 标记损坏或不可读时保留，绝不误删。
  }
}

/** status 只读 lock，不创建目录、不读取 state、不返回 token。 */
export async function inspectBridgeStatus(statePath: string): Promise<BridgeStatusResult> {
  const lock = await lockForControl(statePath)
  if (!lock) return { running: false, statePath }
  const running = lock.host === hostname() ? isProcessAlive(lock.pid) : true
  return running ? { running: true, pid: lock.pid, statePath } : { running: false, statePath }
}

interface LockProbe {
  kind: 'lock'
  lock: InstanceLockInfo
}

interface MissingProbe {
  kind: 'missing'
}

interface UnreadableProbe {
  kind: 'unreadable'
}

type Probe = LockProbe | MissingProbe | UnreadableProbe

async function probeLock(statePath: string): Promise<Probe> {
  try {
    const lock = await readInstanceLock(lockPathFor(statePath))
    return lock ? { kind: 'lock', lock } : { kind: 'missing' }
  } catch {
    // 释放/新建窗口可能读到半写文件；等待期间视为暂时不可判定，超时仍返回未停止。
    return { kind: 'unreadable' }
  }
}

function probeLooksAlive(lock: InstanceLockInfo): boolean {
  return lock.host === hostname() ? isProcessAlive(lock.pid) : true
}

async function waitForLockRelease(statePath: string, token: string, pid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const interval = Math.max(25, pollMs)
  while (Date.now() < deadline) {
    const probe = await probeLock(statePath)
    if (probe.kind === 'missing') return true
    if (probe.kind === 'lock') {
      const current = probe.lock
      if (current.token !== token || current.pid !== pid) return true
      if (!probeLooksAlive(current)) return true
    }
    await sleep(interval)
  }
  return false
}

/**
 * 只停当前持锁实例：从 lock 读取 pid/token，以 wx 独占创建 statePath.stop
 * （防竞态；创建后写入完成前 watcher 可能读到半写 JSON，忽略并下轮重试）。
 * 不发送信号、不 kill 任意 pid；等待目标 lock token 释放（默认 15s）。
 * 超时不会伪装成功：抛 STOP_TIMEOUT（exitCode 2），CLI envelope 应为 ok:false。
 */
export async function requestBridgeStop(
  statePath: string,
  { timeoutMs = STOP_WAIT_TIMEOUT_MS, pollMs = STOP_WAIT_POLL_MS }: StopWaitOptions = {},
): Promise<BridgeStopResult> {
  const target = await lockForControl(statePath)
  if (!target) return { running: false, stopped: true, statePath }
  if (!probeLooksAlive(target)) return { running: false, stopped: true, statePath }

  await writeStopRequestAtomic(statePath, target)
  const stopped = await waitForLockRelease(statePath, target.token, target.pid, Math.max(0, timeoutMs), pollMs)
  if (!stopped) {
    throw new BridgeControlError(
      'STOP_TIMEOUT',
      'bridge 未在 ' + String(timeoutMs) + 'ms 内释放锁，停止未完成',
      2,
    )
  }

  const probe = await probeLock(statePath)
  if (probe.kind === 'missing') return { running: false, stopped: true, statePath }
  if (probe.kind === 'unreadable') return { running: true, stopped: true, statePath }
  return { running: probeLooksAlive(probe.lock), stopped: true, statePath }
}