import { appendFileSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { createInterface, type Interface } from 'node:readline'

import { BilibiliBridgeAdapter, DEFAULT_REPLY_MAX, MAX_TEXT } from './adapter.mjs'
import { BilibiliCliBackend } from './backend.mjs'
import { BridgeClient } from './bridge.mjs'
import { checkStopRequest, clearOwnStopRequest } from './control-plane.mjs'
import { errorCode, errorMessage, isPlainObject, isPositiveIntegerString } from './guards.mjs'
import { acquireInstanceLock, createStateStore, type InstanceLock, type StateStore } from './state.mjs'
import { resolveBridgeStatePath } from './state-path.mjs'
import { ConsoleError, buildScrollTask, defaultConsoleConfig, readConsoleConfig, type CommentWatchConfig, type ConsoleConfig } from './web-config.mjs'
import { createConsoleServer } from './web-server.mjs'
import { ConsoleSupervisor, type ConsoleStatus } from './web-supervisor.mjs'
import type { BilibiliDmBackend, BridgeLogger, BridgeState } from './types.mjs'

const DEFAULT_POLL_MS = 6000
const DEFAULT_URL = 'ws://127.0.0.1:9810/bridge/ws'
const MIN_POLL_MS = 6000
const MAX_TIMER_MS = 2147483647
const STOP_CHECK_INTERVAL_MS = 250

export interface BridgeRunArgs {
  statePath?: string
  configPath?: string
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
  maxPolls: number
  maxReplies: number
  replyPolicy: 'off' | 'owner' | 'draft'
  replyMax: number
  url: string
  statePath: string
  commentPolicy: 'off' | 'owner' | 'draft'
  commentMaxReplies: number
  commentWatchEnabled: boolean
  commentWatch: CommentWatchConfig
  scroll: { source: 'hot' | 'search'; keywords: string; numVideos: number; commentsPerVideo: number; preferTags: string; avoidTags: string; style: string }
}

function configError(message: string, cause?: unknown): LifecycleError {
  return new LifecycleError('CONFIG', 'config', message, cause)
}

async function readConfig(args: BridgeRunArgs): Promise<BridgeConfig> {
  let consoleConfig: ConsoleConfig | undefined
  if (args.configPath !== undefined) {
    if (typeof args.configPath !== 'string' || !args.configPath.trim()) throw configError('configPath 必须是非空字符串')
    try {
      consoleConfig = await readConsoleConfig(args.configPath)
    } catch (error) {
      throw configError('无法读取控制台配置', error)
    }
  }

  const token = process.env.CC_CONNECT_BRIDGE_TOKEN
  if (typeof token !== 'string' || token.length === 0) {
    throw configError('缺少 CC_CONNECT_BRIDGE_TOKEN')
  }

  if (args.ownerUids !== undefined && typeof args.ownerUids !== 'string') {
    throw configError('ownerUids 必须是逗号分隔的字符串')
  }
  const configuredOwners = consoleConfig?.connection?.ownerUids
  const ownerRaw = typeof args.ownerUids === 'string'
    ? args.ownerUids
    : process.env.BILIBILI_OWNER_UID !== undefined
      ? process.env.BILIBILI_OWNER_UID
      : Array.isArray(configuredOwners)
        ? configuredOwners.join(',')
        : ''
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
  const configuredPoll = consoleConfig?.connection?.pollMs
  const pollRaw = args.pollMs ?? (process.env.BILIBILI_POLL_MS !== undefined
    ? process.env.BILIBILI_POLL_MS
    : configuredPoll ?? DEFAULT_POLL_MS)
  const pollMs = typeof pollRaw === 'number' ? pollRaw : Number(pollRaw)
  if (!Number.isSafeInteger(pollMs) || pollMs < MIN_POLL_MS || pollMs > MAX_TIMER_MS) {
    throw configError('BILIBILI_POLL_MS 必须是不小于 6000 且不大于 2147483647 的整数')
  }

  const readLimit = (value: unknown, label: string): number => {
    if (value === undefined) return 0
    const parsed = typeof value === 'number' ? value : Number(value)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw configError(label + ' 必须是不小于 0 的整数')
    return parsed
  }
  const maxPolls = readLimit(
    process.env.BILIBILI_BRIDGE_MAX_POLLS !== undefined
      ? process.env.BILIBILI_BRIDGE_MAX_POLLS
      : consoleConfig?.connection?.maxPolls,
    'maxPolls',
  )
  const maxReplies = readLimit(
    process.env.BILIBILI_BRIDGE_MAX_REPLIES !== undefined
      ? process.env.BILIBILI_BRIDGE_MAX_REPLIES
      : consoleConfig?.reply?.maxReplies,
    'maxReplies',
  )

  if (args.url !== undefined && typeof args.url !== 'string') throw configError('url 必须是字符串')
  const url = args.url ?? (process.env.CC_CONNECT_BRIDGE_URL !== undefined
    ? process.env.CC_CONNECT_BRIDGE_URL
    : consoleConfig?.connection?.url ?? DEFAULT_URL)
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

  const configuredPolicy = consoleConfig?.reply?.policy
  const replyPolicyRaw = process.env.BILIBILI_BRIDGE_REPLY_POLICY ?? configuredPolicy ?? 'owner'
  if (!['off', 'owner', 'draft'].includes(replyPolicyRaw)) {
    throw configError('BILIBILI_BRIDGE_REPLY_POLICY 只接受 off / owner / draft')
  }
  const replyMaxRaw = process.env.BILIBILI_BRIDGE_REPLY_MAX ?? consoleConfig?.reply?.maxLength
  const replyMax = replyMaxRaw === undefined ? DEFAULT_REPLY_MAX : Number(replyMaxRaw)
  if (!Number.isSafeInteger(replyMax) || replyMax < 1 || replyMax > MAX_TEXT) {
    throw configError('BILIBILI_BRIDGE_REPLY_MAX 必须是 1–' + String(MAX_TEXT) + ' 的整数')
  }

  const commentPolicy = (consoleConfig?.reply?.commentPolicy ?? 'off') as BridgeConfig['commentPolicy']
  const commentWatch = consoleConfig?.reply?.commentWatch ?? defaultConsoleConfig().reply.commentWatch
  // off 时完全不轮询通知（省请求，也不会把通知交给 agent）；环境变量是应急总闸。
  const commentWatchDisabled = process.env.BILIBILI_BRIDGE_COMMENT_WATCH === 'off'
  const commentWatchEnabled = !commentWatchDisabled && commentPolicy !== 'off' && commentWatch.kinds.length > 0
  return {
    token,
    ownerUids,
    pollMs,
    maxPolls,
    maxReplies,
    commentPolicy,
    commentMaxReplies: Number.isSafeInteger(consoleConfig?.reply?.commentMaxReplies) ? Number(consoleConfig?.reply?.commentMaxReplies) : 0,
    commentWatchEnabled,
    commentWatch,
    scroll: {
      source: consoleConfig?.scroll?.source === 'search' ? 'search' : 'hot',
      keywords: String(consoleConfig?.scroll?.keywords ?? ''),
      numVideos: Number.isSafeInteger(consoleConfig?.scroll?.numVideos) ? Number(consoleConfig?.scroll?.numVideos) : 10,
      commentsPerVideo: Number.isSafeInteger(consoleConfig?.scroll?.commentsPerVideo) ? Number(consoleConfig?.scroll?.commentsPerVideo) : 20,
      preferTags: String(consoleConfig?.scroll?.preferTags ?? ''),
      avoidTags: String(consoleConfig?.scroll?.avoidTags ?? ''),
      style: String(consoleConfig?.reply?.style ?? ''),
    },
    replyPolicy: replyPolicyRaw as BridgeConfig['replyPolicy'],
    replyMax,
    url,
    statePath,
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

export class GatedBackend implements BilibiliDmBackend {
  // 可选能力必须“内层真有才暴露”：adapter 用 typeof 探测能力，
  // 在这里无条件实现会让缺能力的场景变成运行期报错，而不是清晰的能力缺失。
  readonly videoHot?: BilibiliDmBackend['videoHot']
  readonly videoSearch?: BilibiliDmBackend['videoSearch']
  readonly videoInfo?: BilibiliDmBackend['videoInfo']
  readonly comments?: BilibiliDmBackend['comments']
  readonly postComment?: BilibiliDmBackend['postComment']
  readonly inboxAt?: BilibiliDmBackend['inboxAt']
  readonly inboxReply?: BilibiliDmBackend['inboxReply']

  constructor(
    private readonly backend: BilibiliDmBackend,
    private readonly gate: PollGate,
  ) {
    if (typeof backend.videoHot === 'function') this.videoHot = (num) => backend.videoHot!(num)
    if (typeof backend.videoSearch === 'function') this.videoSearch = (keyword, num) => backend.videoSearch!(keyword, num)
    if (typeof backend.videoInfo === 'function') this.videoInfo = (bvid) => backend.videoInfo!(bvid)
    if (typeof backend.comments === 'function') this.comments = (bvid, num) => backend.comments!(bvid, num)
    if (typeof backend.postComment === 'function') this.postComment = (target, text, options) => backend.postComment!(target, text, options)
    if (typeof backend.inboxAt === 'function') this.inboxAt = (cursor) => backend.inboxAt!(cursor)
    if (typeof backend.inboxReply === 'function') this.inboxReply = (cursor) => backend.inboxReply!(cursor)
  }

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

interface TaskSentEvent { type: 'task_sent'; id: string }

interface ScrollDoneEvent {
  type: 'scroll_done'
  videos: number
  offered: number
  readFailures: number
  sendFailures: number
}

interface RuntimeStatusEvent {
  type: 'status'
  registered: boolean
  ready: boolean
  paused: boolean
  polls: number
  replies: number
}

interface StoppedEvent {
  type: 'stopped'
  reason: string
  signal?: string
  code: number
}

type LifecycleEvent = RegisteredEvent | ReadyEvent | RuntimeStatusEvent | TaskSentEvent | ScrollDoneEvent | ErrorEvent | StoppedEvent

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
  private userPaused = false
  private statusTimer: ReturnType<typeof setInterval> | null = null
  private consoleServer: Awaited<ReturnType<typeof createConsoleServer>> | null = null
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
    const config = await readConfig(this.args)
    this.config = config

    const store = createStateStore(config.statePath)
    this.stateStore = store
    this.state = await store.load()
    this.instanceLock = await acquireInstanceLock(config.statePath, { logger: (message) => this.log(message) })

    const replyPolicy = config.replyPolicy
    const replyMax = config.replyMax

    this.gate = new PollGate()
    this.backend = new BilibiliCliBackend({
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
      // 回复策略：off=一律不发；draft=只出草稿等主人审；owner=白名单主人直回（数量不限）。
      // 非白名单对端在 adapter 入口即被拒绝；真实发送还受 CLI writesEnabled 与 dry-run 约束。
      confirmSend: async ({ uid, text }) => {
        if (replyPolicy === 'off') return false
        if (replyPolicy === 'draft') {
          // 草稿只落本地文件供主人审阅，不投递到 B 站；状态目录已含消息正文，需同样保护。
          // 文件名跟随 state 文件，避免同目录多实例共用一个草稿日志；新建文件强制 0600。
          const draftPath = join(dirname(config.statePath), basename(config.statePath) + '.drafts.jsonl')
          try {
            mkdirSync(dirname(draftPath), { recursive: true })
            appendFileSync(
              draftPath,
              JSON.stringify({ at: new Date().toISOString(), uid: String(uid), text: String(text ?? '') }) + '\n',
              { encoding: 'utf8', mode: 0o600 },
            )
            this.log('[bilibili-bridge] reply draft recorded (not sent) uid=' + String(uid) + ' path=' + draftPath)
          } catch (error) {
            this.log('[bilibili-bridge] reply draft record failed: ' + errorMessage(error))
          }
          return false
        }
        return config.ownerUids.includes(String(uid))
      },
      replyMax,
      maxPolls: config.maxPolls,
      maxReplies: config.maxReplies,
      commentMaxReplies: config.commentMaxReplies,
      commentWatchEnabled: config.commentWatchEnabled,
      commentWatch: config.commentWatch,
      scroll: config.scroll,
      // 评论写入与私信同权：off 一律拒绝，draft 只出草稿不投递，owner 需逐次确认回调放行。
      confirmComment: async ({ bvid, rpid, root, text }) => {
        if (config.commentPolicy === 'off') return false
        if (config.commentPolicy === 'draft') {
          const draftPath = join(dirname(config.statePath), basename(config.statePath) + '.comment-drafts.jsonl')
          try {
            mkdirSync(dirname(draftPath), { recursive: true })
            // 草稿必须带准确目标，否则主人无法判断它会落到哪条评论。
            const record = {
              at: new Date().toISOString(),
              bvid,
              rpid: rpid ?? null,
              root: root ?? null,
              text: String(text ?? ''),
            }
            appendFileSync(draftPath, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 })
          } catch { /* 草稿失败不改变策略 */ }
          return false
        }
        // 真实写入开关由 CLI 的 comment create 校验；这里只做策略层放行。
        return true
      },
      logger: this.diagnostics,
    })
    this.adapter.onBaselineReady = () => {
      void this.maybeEmitReady(this.adapter?.state ?? this.stateStore?.state ?? null)
    }

    this.startStopWatcher()
    if (this.args.configPath) {
      this.statusTimer = setInterval(() => { void this.emitStatus() }, 2000)
      unrefTimer(this.statusTimer)
    }
    this.connector = this.bridge.runForever({
      onConnected: async () => this.onConnected(),
      onDisconnected: async () => this.onDisconnected(),
      logger: this.diagnostics,
    })
    void this.connector.catch((error: unknown) => {
      if (!this.stopping) this.fatal(toLifecycleError(error, 'bridge'))
    })
    this.startupPhase = false
    await this.startConsole()
    this.log('启动完成，等待 register_ack')
  }

  private installInputHandlers(): void {
    const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false })
    this.stdin = stdin
    this.stdinErrorHandler = (error: Error) => this.log('stdin 读取失败: ' + errorMessage(error))
    stdin.on('line', (line) => this.handleStdinLine(line))
    stdin.on('close', () => { if (this.args.configPath) this.requestStop('stdin_eof') })
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
    if (!isPlainObject(command)) return
    if (command.type === 'stop') {
      this.log('收到 stdin stop')
      this.requestStop('stdin')
      return
    }
    if (!this.args.configPath) { this.log('忽略未知 stdin 指令'); return }
    if (command.type === 'control' && (command.action === 'pause' || command.action === 'resume')) {
      this.userPaused = command.action === 'pause'
      if (this.userPaused) this.pausePoller()
      else if (this.transportOnline) this.resumePoller()
      void this.emitStatus()
      return
    }
    if (command.type === 'status') { void this.emitStatus(); return }
    if (command.type === 'task') { void this.handleTask(command); return }
    if (command.type === 'scroll') { void this.handleScroll(command); return }
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

  /** 控制台随 bridge 启动；失败（例如端口占用）只记日志，不影响私信监听。 */
  private async startConsole(): Promise<void> {
    if (process.env.BILIBILI_CONSOLE_DISABLE === '1') return
    const statePath = this.config?.statePath
    if (!statePath) return
    const portRaw = process.env.BILIBILI_CONSOLE_PORT
    const port = portRaw === undefined ? 9820 : Number(portRaw)
    if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
      this.log('控制台端口无效，跳过启动')
      return
    }
    try {
      const configPath = this.args.configPath ?? join(dirname(statePath), 'console.json')
      const supervisor = new ConsoleSupervisor(configPath, statePath, process.env, {
        status: () => this.consoleStatus(),
        control: (action: string) => this.consoleControl(action),
      })
      this.consoleServer = await createConsoleServer({ port, configPath, statePath }, process.env, supervisor)
      process.stdout.write(JSON.stringify({
        type: 'console_ready',
        url: this.consoleServer.origin + '/#token=' + encodeURIComponent(this.consoleServer.token),
        configPath,
        pid: process.pid,
      }) + '\n')
    } catch (error) {
      this.log('控制台未启动（不影响 bridge）：' + errorMessage(error))
    }
  }

  private consoleStatus(): ConsoleStatus {
    const status = this.adapter?.getStatus()
    const phase = this.stopping
      ? 'stopping'
      : this.transportOnline
        ? (this.baselineReady() ? 'ready' : 'registered')
        : 'connecting'
    return {
      running: !this.stopping,
      phase,
      paused: this.userPaused || status?.paused === true,
      registered: this.bridge?.isRegistered() === true,
      ready: this.baselineReady(),
      pid: process.pid,
      polls: status?.polls ?? 0,
      replies: status?.replies ?? 0,
      lastRunAt: null,
    }
  }

  private async consoleControl(action: string): Promise<void> {
    if (action === 'pause') {
      this.userPaused = true
      this.pausePoller()
      return
    }
    if (action === 'resume') {
      this.userPaused = false
      this.resumePoller(true)
      return
    }
    if (action === 'run-now') {
      // 进程内触发同样要带控制台配置的任务指令与会话标识；没有 --config-path 时按无配置执行。
      let task: { prompt: string; sessionKey: string } | undefined
      if (this.args.configPath) {
        try {
          const consoleConfig = await readConsoleConfig(this.args.configPath)
          task = { prompt: buildScrollTask(consoleConfig), sessionKey: consoleConfig.agent.sessionKey }
        } catch {
          this.log('无法读取控制台配置，本次刷视频不带任务指令')
        }
      }
      await this.handleScroll(task)
      return
    }
    if (action === 'stop') {
      this.requestStop('console')
      return
    }
    if (action === 'start') {
      // bridge 已在运行；重复 start 是显式 no-op，避免控制台把自身停掉再拉起。
      return
    }
    throw new ConsoleError('ACTION', '未知控制动作', 400)
  }

  private async emitStatus(): Promise<void> {
    if (!this.args.configPath || this.stopping || !this.config) return
    const status = this.adapter?.getStatus()
    try {
      await this.emit({
        type: 'status',
        registered: this.bridge?.isRegistered() === true,
        ready: this.baselineReady(),
        paused: this.userPaused || status?.paused === true,
        polls: status?.polls ?? 0,
        replies: status?.replies ?? 0,
      })
    } catch { this.log('无法写出 status 事件') }
  }

  private async handleScroll(command?: Record<string, unknown>): Promise<void> {
    if (!this.adapter) return
    if (!this.bridge?.isRegistered()) {
      this.log('bridge 未注册，拒绝刷视频循环')
      return
    }
    // 控制台/进程内都只把「任务指令」当偏好文本转交 agent，不构成写授权。
    const prompt = typeof command?.prompt === 'string' && command.prompt.trim() ? command.prompt : undefined
    const sessionKey = typeof command?.sessionKey === 'string' && /^[a-zA-Z0-9:_-]{1,160}$/u.test(command.sessionKey)
      ? command.sessionKey
      : undefined
    try {
      const summary = await this.adapter.runScrollCycle({ prompt, sessionKey })
      this.log('刷视频循环完成 videos=' + String(summary.videos) + ' offered=' + String(summary.offered))
      await this.emit({ type: 'scroll_done', ...summary })
    } catch (error) {
      this.log('刷视频循环失败：' + errorMessage(error))
    }
  }

  private async handleTask(command: Record<string, unknown>): Promise<void> {
    const id = command.id
    const sessionKey = command.sessionKey
    const uid = command.uid
    const prompt = command.prompt
    if (typeof id !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/u.test(id) ||
        typeof sessionKey !== 'string' || !/^[a-zA-Z0-9:_-]{1,160}$/u.test(sessionKey) ||
        typeof uid !== 'string' || !isPositiveIntegerString(uid) ||
        typeof prompt !== 'string' || !prompt.trim() || prompt.length > 16000) {
      this.log('拒绝无效的本地任务指令')
      return
    }
    if (!this.config?.ownerUids.includes(uid)) {
      this.log('拒绝主人白名单以外的本地任务')
      return
    }
    if (!this.bridge?.isRegistered()) {
      this.log('bridge 未注册，拒绝派发本地任务')
      return
    }
    try {
      this.bridge.sendMessage({
        id, uid, name: '主人', content: prompt, session_key: sessionKey,
        reply_ctx: { kind: 'task', uid, task_id: id },
      })
      await this.emit({ type: 'task_sent', id })
    } catch (error) {
      // 发送结果不确定时不自动重试，不把远端异常或任务正文输出到日志。
      this.log('本地任务派发失败或结果未知；未自动重试（' + (errorCode(error) ?? 'unknown') + '）')
    }
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

  private resumePoller(resetPollLimit = true): void {
    if (!this.pollerStarted || !this.adapter) return
    if (this.userPaused) return
    try {
      this.adapter.resume({ resetPollLimit })
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
        if (this.userPaused) this.adapter?.pause()
        this.startPoller()
        await this.emitRegistered()
        await this.maybeEmitReady(this.adapter?.state ?? this.stateStore?.state ?? null)
      } else {
        if (!this.userPaused) this.resumePoller(false)
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
    if (this.statusTimer) clearInterval(this.statusTimer)
    this.statusTimer = null

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
    if (this.consoleServer) {
      const consoleServer = this.consoleServer
      this.consoleServer = null
      try {
        await withTimeout(consoleServer.close(), 3000, 'console close')
      } catch (error) {
        this.log('控制台关闭失败：' + errorMessage(error))
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