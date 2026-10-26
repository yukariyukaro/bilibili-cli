import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { ConsoleError, buildScrollTask, type ConsoleConfig } from './web-config.mjs'
import { isPlainObject } from './guards.mjs'

export interface ConsoleEvent { at: string; level: string; message: string }
export interface ConsoleStatus {
  running: boolean; phase: string; paused: boolean; registered: boolean; ready: boolean
  pid?: number; polls: number; replies: number; lastRunAt: string | null
}

/** Owns only the child it started. It never kills an unrelated PID. */
/** 进程内挂载：控制台由 bridge 自己托管时，状态与控制直接委托给运行中的实例。 */
export interface ConsoleAttach {
  status: () => ConsoleStatus
  control: (action: string) => Promise<void>
}

export class ConsoleSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null
  private pendingTask: Record<string, unknown> | null = null
  private activeConfig: ConsoleConfig | null = null
  private state: ConsoleStatus = { running: false, phase: 'stopped', paused: false, registered: false, ready: false, polls: 0, replies: 0, lastRunAt: null }
  private readonly log: ConsoleEvent[] = []
  private exitPromise: Promise<void> | null = null
  private taskTimer: ReturnType<typeof setTimeout> | null = null
  constructor(
    private readonly configPath: string,
    private readonly statePath: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly attach: ConsoleAttach | null = null,
  ) {}

  status(): ConsoleStatus { return this.attach ? this.attach.status() : { ...this.state } }
  events(): ConsoleEvent[] { return this.log.map(item => ({ ...item })) }
  event(level: string, message: string): void {
    this.log.push({ at: new Date().toISOString(), level, message })
    if (this.log.length > 100) this.log.shift()
  }

  async control(action: string, config: ConsoleConfig): Promise<void> {
    if (this.attach) { await this.attach.control(action); return }
    if (action === 'start') { this.start(config); return }
    if (action === 'stop') { await this.stop(); return }
    if (action === 'run-now') {
      if (!config.scroll.enabled) throw new ConsoleError('DISABLED', '请先启用刷视频并保存配置', 409)
      if (this.pendingTask) throw new ConsoleError('BUSY', '已有任务等待 bridge 注册；请勿重复启动', 409)
      if (!this.child) this.start(config)
      if (this.activeConfig && JSON.stringify(config) !== JSON.stringify(this.activeConfig)) throw new ConsoleError('RESTART_REQUIRED', '配置已修改；请先停止并重新启动 bridge', 409)
      const uid = config.notification.ownerUid || config.connection.ownerUids[0]
      if (!uid) throw new ConsoleError('CONFIG', '至少配置一个主人 UID')
      // 本地刷视频循环：由 bridge 自己拉视频与评论，agent 只负责出评论正文。
      // prompt / sessionKey 必须随帧下发，子进程会把它们编进交给 agent 的那一帧；
      // 之前写成 agentPrompt 且子进程不读，导致控制台的「任务指令」「会话标识」完全是死字段。
      this.pendingTask = {
        type: 'scroll',
        id: 'daily-' + randomUUID(),
        uid,
        prompt: buildScrollTask(config),
        sessionKey: config.agent.sessionKey,
      }
      this.event('info', '每日任务已排队，等待 bridge 注册后交给 Agent')
      this.taskTimer = setTimeout(() => { this.pendingTask = null; this.taskTimer = null; this.event('error', '任务等待注册超时，未自动重试') }, 60000)
      this.flushTask()
      return
    }
    if (action !== 'pause' && action !== 'resume') throw new ConsoleError('ACTION', '未知控制动作')
    if (!this.child) throw new ConsoleError('NOT_RUNNING', 'bridge 尚未启动', 409)
    this.send({ type: 'control', action })
    // The actual pause flag comes back from the child's status event.
    this.event('info', action === 'pause' ? '已请求暂停轮询' : '已请求恢复轮询')
  }

  private start(config: ConsoleConfig): void {
    if (this.child) throw new ConsoleError('ALREADY_RUNNING', '本控制台管理的 bridge 已在运行', 409)
    if (!this.env.CC_CONNECT_BRIDGE_TOKEN?.trim()) throw new ConsoleError('TOKEN_REQUIRED', '服务环境缺少 CC_CONNECT_BRIDGE_TOKEN；设置后重新启动控制台', 409)
    if (!config.connection.ownerUids.length) throw new ConsoleError('CONFIG', '至少配置一个主人 UID')
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../cli/bili.mjs', import.meta.url)), 'bridge', 'run', '--config-path', this.configPath, '--state-path', this.statePath], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false })
    this.child = child
    this.activeConfig = structuredClone(config)
    this.state = { ...this.state, running: true, phase: 'starting', paused: false, registered: false, ready: false, pid: child.pid, polls: 0, replies: 0 }
    this.event('info', '启动 bridge；连接成功不代表 B 站登录已验证')
    const lines = createInterface({ input: child.stdout })
    lines.on('line', line => this.consume(line))
    // Do not persist stderr: third-party errors can contain URLs, text or credentials.
    child.stderr.on('data', () => {})
    child.stdin.on('error', () => this.event('error', 'bridge 控制管道已关闭'))
    child.on('error', () => this.event('error', 'bridge 子进程无法启动'))
    this.exitPromise = new Promise(resolve => child.once('close', code => {
      lines.close()
      this.child = null
      this.activeConfig = null
      if (this.taskTimer) clearTimeout(this.taskTimer)
      this.taskTimer = null
      if (this.pendingTask) this.event('error', 'bridge 已退出；排队任务未投递且不会自动重试')
      this.pendingTask = null
      this.state = { ...this.state, running: false, phase: 'stopped', registered: false, ready: false, paused: false, pid: undefined }
      this.event(code === 0 ? 'info' : 'error', 'bridge 已退出，退出码 ' + String(code))
      resolve()
    }))
  }

  private consume(line: string): void {
    if (line.length > 65536) return
    let frame: unknown
    try { frame = JSON.parse(line) } catch { return }
    if (!isPlainObject(frame)) return
    if (frame.type === 'registered') { this.state.registered = true; this.state.phase = 'registered'; this.event('info', 'bridge 已注册'); this.flushTask() }
    else if (frame.type === 'ready') { this.state.registered = true; this.state.ready = frame.baselineReady === true; this.state.phase = this.state.ready ? 'ready' : 'registered'; this.event('info', '私信基线已就绪') }
    else if (frame.type === 'status') {
      if (typeof frame.registered === 'boolean') this.state.registered = frame.registered
      if (typeof frame.paused === 'boolean') this.state.paused = frame.paused
      if (typeof frame.ready === 'boolean') this.state.ready = frame.ready
      if (typeof frame.polls === 'number' && Number.isSafeInteger(frame.polls)) this.state.polls = frame.polls
      if (typeof frame.replies === 'number' && Number.isSafeInteger(frame.replies)) this.state.replies = frame.replies
      this.state.phase = this.state.paused ? 'paused' : this.state.ready ? 'ready' : this.state.registered ? 'registered' : 'connecting'
      this.flushTask()
    } else if (frame.type === 'error') this.event('error', 'bridge 报告错误（详情请查看终端；未自动重试写入）')
    else if (frame.type === 'task_sent') { this.state.lastRunAt = new Date().toISOString(); this.event('info', '每日任务已交给 Agent；此状态不代表任务执行完成') }
    else if (frame.type === 'scroll_done') { this.state.lastRunAt = new Date().toISOString(); this.event('info', '本地刷视频一轮结束：视频 ' + String(frame.videos ?? 0) + ' 个，已交给 agent ' + String(frame.offered ?? 0) + ' 条；不代表评论已发布') }
    else if (frame.type === 'stopped') this.state.phase = 'stopping'
  }

  private flushTask(): void {
    if (!this.pendingTask || !this.state.registered || this.state.paused) return
    const task = this.pendingTask
    this.pendingTask = null // Unknown delivery is never retried automatically.
    if (this.taskTimer) clearTimeout(this.taskTimer)
    this.taskTimer = null
    try { this.send({ ...task }) }
    catch { this.event('error', '任务派发结果未知；已放弃本次投递且不会自动重试') }
  }

  private send(frame: Record<string, unknown>): void {
    if (!this.child?.stdin.writable) throw new ConsoleError('PIPE', 'bridge 控制管道不可写', 409)
    this.child.stdin.write(JSON.stringify(frame) + '\n')
  }

  async stop(): Promise<void> {
    // 进程内模式下生命周期归 bridge 自己所有，控制台关闭不得反向停掉监听。
    if (this.attach) return
    if (!this.child) return
    this.state.phase = 'stopping'
    this.child.stdin.end()
    const exit = this.exitPromise
    // Existing bridge runtime treats parent stdin EOF as a graceful stop request.
    if (exit) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try { await Promise.race([exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ConsoleError('STOP_TIMEOUT', 'bridge 停止超时；请检查原终端', 504)), 10000) })]) }
      finally { if (timer) clearTimeout(timer) }
    }
  }
}
