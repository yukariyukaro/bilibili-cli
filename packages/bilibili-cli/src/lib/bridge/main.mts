import { createInterface, type Interface } from 'node:readline'

import { BilibiliBridgeAdapter } from './adapter.mjs'
import { BilibiliCliBackend } from './backend.mjs'
import { BridgeClient } from './bridge.mjs'
import { checkStopRequest, clearOwnStopRequest } from './control-plane.mjs'
import { errorCode, errorMessage, isPlainObject, isPositiveIntegerString } from './guards.mjs'
import { acquireInstanceLock, createStateStore, type InstanceLock, type StateStore } from './state.mjs'
import { resolveBridgeStatePath } from './state-path.mjs'
import type { BilibiliDmBackend, BridgeLogger, BridgeState } from './types.mjs'

const DEFAULT_POLL_MS = 6000
const DEFAULT_URL = 'ws://127.0.0.1:9810/bridge/ws'
const MIN_POLL_MS = 6000
const MAX_TIMER_MS = 2147483647
const STOP_CHECK_INTERVAL_MS = 250

export interface BridgeRunArgs {
  statePath?: string
  ownerUids?: string
  url?: string
  pollMs?: number
}

export type LifecycleStage = 'config' | 'state' | 'lock' | 'adapter' | 'bridge' | 'runtime'

export class LifecycleError extends Error {
  readonly code: string
  readonly stage: LifecycleStage

  constructor(code: string, stage: LifecycleStage, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'LifecycleError'
    this.code = code
    this.stage = stage
  }
}

function toLifecycleError(error: unknown, fallbackStage: LifecycleStage = 'runtime'): LifecycleError {
  if (error instanceof LifecycleError) return error
  const code = errorCode(error) ?? 'RUNTIME'
  let stage = fallbackStage
  if (code === 'ALREADY_RUNNING' || code.startsWith('LOCK')) stage = 'lock'
  else if (code.startsWith('STATE')) stage = 'state'
  else if (code === 'CONFIG') stage = 'config'
  return new LifecycleError(code, stage, errorMessage(error), error)
}

function exitCodeFor(error: LifecycleError): number {
  if (error.stage === 'config' || error.stage === 'state' || error.stage === 'lock') return 2
  if (/^(CONFIG|STATE_|LOCK_|ALREADY_RUNNING)/.test(error.code)) return 2
  return 1
}

// CLI 契约：130/143 表示被 SIGINT/SIGTERM 中断；其余信号按 128+signal 约定。
function exitCodeForSignal(signal: NodeJS.Signals): number {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 2,
    SIGTERM: 15,
    SIGHUP: 1,
    SIGBREAK: 21,
  }
  const number = numbers[signal]
  return number === undefined ? 1 : 128 + number
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const unref: unknown = timer.unref
    if (typeof unref === 'function') unref.call(timer)
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  return new Promise<T>((resolveTime, rejectTime) => {
    timer = setTimeout(() => rejectTime(new Error(label + ' 超时')), ms)
    unrefTimer(timer)
    promise.then(
      (value) => {
        if (timer) clearTimeout(timer)
        resolveTime(value)
      },
      (error: unknown) => {
        if (timer) clearTimeout(timer)
        rejectTime(error)
      },
    )
  })
}

interface BridgeConfig {
  token: string
  ownerUids: string[]
  pollMs: number
  url: string
  statePath: string
  cliCommand: string
}

function configError(message: string, cause?: unknown): LifecycleError {
  return new LifecycleError('CONFIG', 'config', message, cause)
}

function readConfig(args: BridgeRunArgs): BridgeConfig {
  const token = process.env.CC_CONNECT_BRIDGE_TOKEN
  if (typeof token !== 'string' || token.length === 0) {
    throw configError('缺少 CC_CONNECT_BRIDGE_TOKEN')
  }

  if (args.ownerUids !== undefined && typeof args.ownerUids !== 'string') {
    throw configError('ownerUids 必须是逗号分隔的字符串')
  }
  const ownerRaw = typeof args.ownerUids === 'string' ? args.ownerUids : process.env.BILIBILI_OWNER_UID ?? ''
  const ownerUids = ownerRaw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!ownerUids.length) throw configError('缺少 BILIBILI_OWNER_UID')
  const invalidOwner = ownerUids.find((uid) => !isPositiveIntegerString(uid))
  if (invalidOwner !== undefined) {
    throw configError('BILIBILI_OWNER_UID 必须是正安全整数：' + invalidOwner)
  }

  if (args.pollMs !== undefined && typeof args.pollMs !== 'number') {
    throw configError('pollMs 必须是整数')
  }
  const pollRaw = args.pollMs ?? process.env.BILIBILI_POLL_MS ?? DEFAULT_POLL_MS
  const pollMs = typeof pollRaw === 'number' ? pollRaw : Number(pollRaw)
  if (!Number.isSafeInteger(pollMs) || pollMs < MIN_POLL_MS || pollMs > MAX_TIMER_MS) {
    throw configError('BILIBILI_POLL_MS 必须是不小于 6000 且不大于 2147483647 的整数')
  }

  if (args.url !== undefined && typeof args.url !== 'string') throw configError('url 必须是字符串')
  const url = args.url ?? process.env.CC_CONNECT_BRIDGE_URL ?? DEFAULT_URL
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch (error) {
    throw configError('CC_CONNECT_BRIDGE_URL 不是合法 URL', error)
  }
  if (parsedUrl.protocol !== 'ws:' && parsedUrl.protocol !== 'wss:') {
    throw configError('CC_CONNECT_BRIDGE_URL 必须是 ws:// 或 wss://')
  }

  if (args.statePath !== undefined && (typeof args.statePath !== 'string' || !args.statePath.trim())) {
    throw configError('statePath 必须是非空字符串')
  }
  const statePath = resolveBridgeStatePath(args.statePath)


  return {
    token,
    ownerUids,
    pollMs,
    url,
    statePath,
    cliCommand: process.env.BILIBILI_CLI_COMMAND || 'bilibili',
  }
}

interface GateWaiter {
  resolve: () => void
  reject: (error: Error) => void
}

class PollGate {
  private online = false
  private stopped = false
  private readonly waiters = new Set<GateWaiter>()

  setOnline(value: boolean): void {
    this.online = Boolean(value)
    if (!this.online) return
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter.resolve()
    }
  }

  stop(): void {
    this.stopped = true
    for (const waiter of [...this.waiters]) {
      this.waiters.delete(waiter)
      waiter.reject(abortError())
    }
  }

  async read<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) throw abortError()
    if (!this.online) {
      await new Promise<void>((resolveWait, rejectWait) => {
        this.waiters.add({ resolve: resolveWait, reject: rejectWait })
      })
    }
    if (this.stopped) throw abortError()
    return fn()
  }
}

function abortError(): Error & { code: string } {
  return Object.assign(new Error('bridge 已停止，等待中的轮询不再执行'), { code: 'POLL_ABORTED' })
}

class GatedBackend implements BilibiliDmBackend {
  constructor(
    private readonly backend: BilibiliDmBackend,
    private readonly gate: PollGate,
  ) {}

  readDm(uid: string): Promise<unknown> {
    return this.gate.read(() => this.backend.readDm(uid))
  }

  sendDm(uid: string, text: string, options?: { confirm?: boolean }): Promise<unknown> {
    return this.backend.sendDm(uid, text, options)
  }
}

interface RegisteredEvent {
  type: 'registered'
  pid: number
  statePath: string
  transportRegistered: true
}

interface ReadyEvent {
  type: 'ready'
  pid: number
  statePath: string
  registered: true
  baselineReady: true
}

interface ErrorEvent {
  type: 'error'
  stage: LifecycleStage
  code: string
  message: string
  fatal: true
}

interface StoppedEvent {
  type: 'stopped'
  reason: string
  signal?: string
  code: number
}

type LifecycleEvent = RegisteredEvent | ReadyEvent | ErrorEvent | StoppedEvent

interface SignalHandler {
  signal: NodeJS.Signals
  handler: () => void
}

export class BridgeRuntime {
  private readonly args: BridgeRunArgs
  private readonly stopped: Promise<void>
  private resolveStop: (() => void) | null = null

  private config: BridgeConfig | null = null
  private stateStore: StateStore | null = null
  private state: BridgeState | null = null
  private instanceLock: InstanceLock | null = null
  private backend: BilibiliCliBackend | null = null
  private bridge: BridgeClient | null = null
  private adapter: BilibiliBridgeAdapter | null = null
  private gate: PollGate | null = null
  private connector: Promise<void> | null = null
  private pollerPromise: Promise<void> | null = null

  private pollerStarted = false
  private transportOnline = false
  private registeredEmitted = false
  private readyEmitted = false
  private stopping = false
  private startupPhase = true
  private fatalError: LifecycleError | null = null
  private stopRequest: { reason: string; signal?: NodeJS.Signals } | null = null
  private shutdownPromise: Promise<number> | null = null
  private exitCode = 0

  private stdin: Interface | null = null
  private stdinErrorHandler: ((error: Error) => void) | null = null
  private stdoutErrorHandler: (() => void) | null = null
  private readonly signalHandlers: SignalHandler[] = []
  private stopCheckTimer: ReturnType<typeof setInterval> | null = null
  private checkingStop = false
  private cleanupFailed = false

  private readonly diagnostics: BridgeLogger = {
    log: (message: string) => this.writeStderr(message),
    info: (message: string) => this.writeStderr(message),
    warn: (message: string) => this.writeStderr(message),
    error: (message: string) => this.writeStderr(message),
    debug: (message: string) => this.writeStderr(message),
  }

  constructor(args: BridgeRunArgs = {}) {
    this.args = args
    this.stopped = new Promise<void>((resolveStop) => {
      this.resolveStop = resolveStop
    })
  }

  async run(): Promise<number> {
    try {
      await this.initialize()
      await this.stopped
    } catch (error) {
      this.fatal(toLifecycleError(error))
    }

    if (!this.shutdownPromise) this.shutdownPromise = this.shutdown()
    try {
      this.exitCode = await this.shutdownPromise
    } catch (error) {
      this.exitCode = 1
      this.log('shutdown 失败: ' + errorMessage(error))
    }
    return this.exitCode
  }

  private async initialize(): Promise<void> {
    this.installInputHandlers()
    const config = readConfig(this.args)
    this.config = config

    const store = createStateStore(config.statePath)
    this.stateStore = store
    this.state = await store.load()
    this.instanceLock = await acquireInstanceLock(config.statePath, { logger: (message) => this.log(message) })

    this.gate = new PollGate()
    this.backend = new BilibiliCliBackend({
      command: config.cliCommand,
      env: process.env,
      logger: this.diagnostics,
    })
    this.bridge = new BridgeClient({ url: config.url, token: config.token, logger: this.diagnostics })
    this.adapter = new BilibiliBridgeAdapter({
      bridge: this.bridge,
      backend: new GatedBackend(this.backend, this.gate),
      ownerUids: config.ownerUids,
      pollMs: config.pollMs,
      state: this.state,
      saveState: (next) => this.saveAdapterState(next),
      // 默认入口没有逐次人工确认交互：保持 confirm=false，绝不自动真发。
      confirmSend: async () => false,
      logger: this.diagnostics,
    })
    this.adapter.onBaselineReady = () => {
      void this.maybeEmitReady(this.adapter?.state ?? this.stateStore?.state ?? null)
    }

    this.startStopWatcher()
    this.connector = this.bridge.runForever({
      onConnected: async () => this.onConnected(),
      onDisconnected: async () => this.onDisconnected(),
      logger: this.diagnostics,
    })
    void this.connector.catch((error: unknown) => {
      if (!this.stopping) this.fatal(toLifecycleError(error, 'bridge'))
    })
    this.startupPhase = false
    this.log('启动完成，等待 register_ack')
  }

  private installInputHandlers(): void {
    const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    this.stdin = stdin
    this.stdinErrorHandler = (error: Error) => this.log('stdin 读取失败: ' + errorMessage(error))
    stdin.on('line', (line) => this.handleStdinLine(line))
    stdin.on('error', this.stdinErrorHandler)

    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']
    if (process.platform === 'win32') signals.push('SIGBREAK')
    for (const signal of signals) {
      const handler = (): void => this.requestStop('signal', signal)
      process.once(signal, handler)
      this.signalHandlers.push({ signal, handler })
    }

    this.stdoutErrorHandler = () => undefined
    process.stdout.on('error', this.stdoutErrorHandler)
  }

  private cleanupInputHandlers(): void {
    const stdin = this.stdin
    if (stdin) {
      if (this.stdinErrorHandler) {
        try {
          stdin.off('error', this.stdinErrorHandler)
        } catch {
          // already detached
        }
        this.stdinErrorHandler = null
      }
      try {
        stdin.close()
      } catch (error) {
        this.markShutdownFailure('stdin close', error)
      }
      this.stdin = null
    }
    // createInterface.close() 不保证暂停底层 stdin；CLI 进程需要能自行退出。
    try {
      process.stdin.pause()
    } catch (error) {
      this.markShutdownFailure('stdin pause', error)
    }
    for (const { signal, handler } of this.signalHandlers) process.off(signal, handler)
    this.signalHandlers.length = 0
    if (this.stdoutErrorHandler) {
      process.stdout.off('error', this.stdoutErrorHandler)
      this.stdoutErrorHandler = null
    }
  }

  private markShutdownFailure(label: string, error: unknown): void {
    this.cleanupFailed = true
    const message = label + ': ' + errorMessage(error)
    this.log('清理失败: ' + message)
    if (!this.fatalError) {
      this.fatalError = new LifecycleError('SHUTDOWN_FAILED', 'runtime', message, error)
    }
  }

  private handleStdinLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let command: unknown
    try {
      command = JSON.parse(trimmed)
    } catch {
      this.log('忽略无法解析的 stdin 指令')
      return
    }
    if (isPlainObject(command) && command.type === 'stop') {
      this.log('收到 stdin stop')
      this.requestStop('stdin')
      return
    }
    this.log('忽略未知 stdin 指令')
  }

  private requestStop(reason: string, signal?: NodeJS.Signals): void {
    if (this.stopRequest) return
    this.stopRequest = signal === undefined ? { reason } : { reason, signal }
    this.log('请求停止: ' + reason)
    const resolveStop = this.resolveStop
    this.resolveStop = null
    resolveStop?.()
  }

  private fatal(error: unknown): void {
    if (this.fatalError) return
    this.fatalError = toLifecycleError(error)
    this.log('致命错误: ' + this.fatalError.message)
    this.requestStop('fatal')
  }

  private writeStderr(message: string): void {
    const text = String(message)
    process.stderr.write(text.endsWith('\n') ? text : text + '\n')
  }

  private log(message: string): void {
    this.writeStderr('[bilibili-bridge] ' + message)
  }

  private async emit(event: LifecycleEvent): Promise<void> {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      try {
        process.stdout.write(JSON.stringify(event) + '\n', (error) => {
          if (error) rejectWrite(error)
          else resolveWrite()
        })
      } catch (error) {
        rejectWrite(error)
      }
    })
  }

  private async emitRegistered(): Promise<void> {
    if (this.registeredEmitted || this.stopping || !this.config) return
    this.registeredEmitted = true
    try {
      await this.emit({
        type: 'registered',
        pid: process.pid,
        statePath: this.config.statePath,
        transportRegistered: true,
      })
    } catch (error) {
      this.log('无法写出 registered 事件: ' + errorMessage(error))
    }
  }

  private hasBaseline(state: BridgeState | null): boolean {
    if (!state || !this.config?.ownerUids.length) return false
    return this.config.ownerUids.every((uid) => {
      const conversation = state.conversations[uid]
      return Boolean(conversation && conversation.baseline !== null && conversation.baseline !== undefined)
    })
  }

  private baselineReady(candidate: BridgeState | null = null): boolean {
    if (!this.adapter) return false
    try {
      if (this.adapter.isBaselineReady() === true) return true
    } catch (error) {
      // adapter 状态损坏/不一致时 fail closed，不能用持久化/candidate 补出 ready。
      this.log('baseline 就绪检查失败: ' + errorMessage(error))
      return false
    }
    // commit 先 saveState 再 adopt；候选 state 可能比 adapter.state 更新。
    return this.hasBaseline(candidate ?? this.adapter.state ?? this.stateStore?.state ?? null)
  }

  private async maybeEmitReady(state: BridgeState | null): Promise<void> {
    if (!this.registeredEmitted || !this.pollerStarted || !this.transportOnline || this.readyEmitted || this.stopping) {
      return
    }
    if (!this.baselineReady(state)) return
    this.readyEmitted = true
    if (!this.config) return
    try {
      await this.emit({
        type: 'ready',
        pid: process.pid,
        statePath: this.config.statePath,
        registered: true,
        baselineReady: true,
      })
    } catch (error) {
      this.log('无法写出 ready 事件: ' + errorMessage(error))
    }
  }

  private async saveAdapterState(next: BridgeState): Promise<void> {
    if (!this.stateStore) throw new Error('state store is not ready')
    await this.stateStore.save(next)
    await this.maybeEmitReady(next)
  }

  private trackPollerResult(result: Promise<void>): void {
    this.pollerPromise = result
    void result.catch((error: unknown) => {
      if (!this.stopping) this.fatal(toLifecycleError(error, 'adapter'))
    })
  }

  private startPoller(): void {
    if (this.pollerStarted || !this.adapter) return
    this.pollerStarted = true
    this.log('poller started')
    try {
      this.trackPollerResult(this.adapter.start())
    } catch (error) {
      this.fatal(toLifecycleError(error, 'adapter'))
    }
  }

  private resumePoller(): void {
    if (!this.pollerStarted || !this.adapter) return
    try {
      this.adapter.resume()
    } catch (error) {
      this.fatal(toLifecycleError(error, 'adapter'))
      return
    }
    this.log('poller resumed')
  }

  private pausePoller(): void {
    if (!this.pollerStarted || !this.adapter) return
    try {
      this.adapter.pause()
    } catch (error) {
      this.log('poller pause failed: ' + errorMessage(error))
    }
    if (!this.stopping) this.log('poller paused')
  }

  private async onConnected(): Promise<void> {
    if (this.stopping) return
    this.transportOnline = true
    this.gate?.setOnline(true)
    try {
      if (!this.pollerStarted) {
        this.startPoller()
        await this.emitRegistered()
        await this.maybeEmitReady(this.adapter?.state ?? this.stateStore?.state ?? null)
      } else {
        this.resumePoller()
        await this.maybeEmitReady(this.adapter?.state ?? this.stateStore?.state ?? null)
      }
    } catch (error) {
      this.fatal(toLifecycleError(error, 'adapter'))
    }
  }

  private onDisconnected(): void {
    const wasOnline = this.transportOnline
    this.transportOnline = false
    this.gate?.setOnline(false)
    if (this.stopping) return
    if (wasOnline && this.pollerStarted) this.pausePoller()
  }

  private startStopWatcher(): void {
    if (this.stopCheckTimer) return
    const timer = setInterval(() => {
      void this.pollStopRequest()
    }, STOP_CHECK_INTERVAL_MS)
    unrefTimer(timer)
    this.stopCheckTimer = timer
  }

  private clearStopWatcher(): void {
    if (this.stopCheckTimer) clearInterval(this.stopCheckTimer)
    this.stopCheckTimer = null
  }

  private async pollStopRequest(): Promise<void> {
    if (this.checkingStop || this.stopping) return
    this.checkingStop = true
    try {
      const config = this.config
      const lock = this.instanceLock
      if (!config || !lock) return
      const matched = await checkStopRequest(config.statePath, lock.info.token, lock.info.pid)
      if (matched) {
        this.log('收到 statePath.stop 控制请求')
        this.requestStop('control')
      }
    } catch (error) {
      // 损坏/并发半写标记只记录固定描述，不输出路径或 token，继续等待 stdin/signal/fatal。
      const code = errorCode(error)
      this.log('检查 stop 请求失败' + (code === undefined ? '' : '（' + code + '）') + '，保留标记并继续')
    } finally {
      this.checkingStop = false
    }
  }

  private async shutdown(): Promise<number> {
    this.stopping = true
    this.clearStopWatcher()

    const config = this.config
    const lock = this.instanceLock
    if (config && lock) {
      try {
        await clearOwnStopRequest(config.statePath, lock.info.token, lock.info.pid)
      } catch {
        // 只清理自己的标记，失败保留。
      }
    }

    this.gate?.stop()
    try {
      this.adapter?.pause()
    } catch (error) {
      this.markShutdownFailure('adapter pause', error)
    }
    this.cleanupInputHandlers()

    try {
      this.bridge?.close()
    } catch (error) {
      this.markShutdownFailure('bridge close', error)
    }
    if (this.connector) {
      try {
        await withTimeout(this.connector, 3000, 'connector stop')
      } catch (error) {
        this.markShutdownFailure('connector stop', error)
      }
    }

    if (this.backend) {
      const backend = this.backend
      try {
        await withTimeout(backend.close(), 5000, 'backend close')
      } catch (error) {
        this.markShutdownFailure('backend close', error)
      }
    }
    if (this.adapter) {
      const adapter = this.adapter
      try {
        await withTimeout(adapter.stop(), 3000, 'adapter stop')
      } catch (error) {
        this.markShutdownFailure('adapter stop', error)
      }
    }
    if (this.pollerPromise) {
      try {
        await withTimeout(this.pollerPromise, 3000, 'poller stop')
      } catch (error) {
        this.markShutdownFailure('poller stop', error)
      }
    }

    // 任何清理失败/超时都保留锁：进程可能仍持有 CLI/连接资源，不能放新实例并发。
    // 进程退出后锁的 pid 会变 stale，下一次启动按既有 stale 恢复处理。
    if (this.instanceLock) {
      const instanceLock = this.instanceLock
      if (this.cleanupFailed) {
        this.log('清理未完成，保留锁文件 ' + instanceLock.path)
      } else {
        try {
          await withTimeout(instanceLock.release(), 2000, 'lock release')
        } catch (error) {
          this.markShutdownFailure('lock release', error)
        }
      }
    }

    // 清理失败必须是非零返回；不能把 close 超时掩盖成 0。锁内 fatal 阶段仍保留区分。
    const request = this.stopRequest
    let code = this.cleanupFailed ? 1 : this.fatalError ? exitCodeFor(this.fatalError) : 0
    if (!this.cleanupFailed && !this.fatalError && request?.reason === 'signal' && request.signal !== undefined) {
      code = exitCodeForSignal(request.signal)
    }
    if (this.fatalError) {
      try {
        await this.emit({
          type: 'error',
          stage: this.fatalError.stage,
          code: this.fatalError.code,
          message: this.fatalError.message,
          fatal: true,
        })
      } catch (error) {
        this.log('无法写出 error 事件: ' + errorMessage(error))
      }
    }
    if (!this.startupPhase) {
      try {
        await this.emit({
          type: 'stopped',
          reason: request?.reason ?? 'unknown',
          ...(request?.signal === undefined ? {} : { signal: request.signal }),
          code,
        })
      } catch (error) {
        this.log('无法写出 stopped 事件: ' + errorMessage(error))
      }
    }

    await this.flushStdout()
    return code
  }

  private async flushStdout(): Promise<void> {
    await new Promise<void>((resolveFlush) => {
      let done = false
      const finish = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolveFlush()
      }
      const timer = setTimeout(finish, 1000)
      unrefTimer(timer)
      try {
        process.stdout.write('', () => finish())
      } catch {
        finish()
      }
    })
  }
}

/** CLI 在此 lazy import 并调用；不在这里顶层自启动，也不调用 process.exit。 */
export async function runBridge(args: BridgeRunArgs = {}): Promise<number> {
  const runtime = new BridgeRuntime(args)
  return runtime.run()
}