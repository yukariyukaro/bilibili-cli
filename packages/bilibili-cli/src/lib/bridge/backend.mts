import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

import { errorMessage, isPlainObject, isSafePositiveInteger } from './guards.mjs'
import { parseJsonLossless } from './json.mjs'
import type { BridgeLogger, NotifyCursorInput } from './types.mjs'

function failure(code: string, message: string): CliBackendError {
  return new CliBackendError(code, message)
}

export class CliBackendError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'CliBackendError'
    this.code = code
  }
}

function extractMessages(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isPlainObject(value)) {
    if (Array.isArray(value.messages)) return value.messages
    if (Array.isArray(value.message_list)) return value.message_list
  }
  throw failure('CLI_PROTOCOL', 'dm read 未返回 messages 数组')
}

/**
 * bridge 默认复用当前安装的 CLI 自身（node + 包内入口），不再依赖 PATH 上
 * 是否恰好有一个同名命令；安装形态变化不会让 bridge 失效。
 */
const CLI_ENTRY = fileURLToPath(new URL('../../cli/bili.mjs', import.meta.url))
export const DEFAULT_CLI_COMMAND = process.execPath
export const DEFAULT_CLI_ARGS = [CLI_ENTRY, '--jsonl']

export interface BilibiliCliBackendOptions {
  command?: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  logger?: BridgeLogger
  requestTimeoutMs?: number
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const unref: unknown = timer.unref
    if (typeof unref === 'function') unref.call(timer)
  }
}

// 此层只负责真实 CLI 的有限 JSONL 请求；不提供模拟 B 站后端。
export class BilibiliCliBackend {
  readonly command: string
  readonly args: string[]
  readonly env: NodeJS.ProcessEnv
  readonly logger: BridgeLogger
  readonly requestTimeoutMs: number

  private child: ChildProcessWithoutNullStreams | null = null
  private childFinished: Promise<number | null> | null = null
  private starting: Promise<void> | null = null
  private closing: Promise<void> | null = null
  private readonly pending = new Map<string, PendingRequest>()
  private sequence = 0
  private closed = false

  constructor({
    command = DEFAULT_CLI_COMMAND,
    args = DEFAULT_CLI_ARGS,
    env = process.env,
    logger = console,
    requestTimeoutMs = 30000,
  }: BilibiliCliBackendOptions = {}) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('invalid CLI request timeout')
    if (!command) throw new Error('CLI command is required')
    this.command = command
    this.args = [...args]
    this.env = env
    this.logger = logger
    this.requestTimeoutMs = requestTimeoutMs
  }

  async start(): Promise<void> {
    if (this.closed) throw failure('CLI_CLOSED', 'bilibili CLI transport is closed')
    if (this.starting) return this.starting
    if (this.child) return
    const start = this.startProcess()
    this.starting = start
    try {
      await start
    } finally {
      this.starting = null
    }
  }

  private async startProcess(): Promise<void> {
    // 默认命令是当前的 node 可执行文件 + 包内 CLI 入口；不存在 shell 拼接，
    // 也不需要 Windows .cmd shim。
    const child = spawn(this.command, this.args, {
      env: this.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.child = child
    this.childFinished = new Promise<number | null>((resolveFinished) => {
      child.once('close', (code) => resolveFinished(code))
    })

    const lines = createInterface({ input: child.stdout })
    lines.on('line', (line) => this.handleLine(line))

    // 不把第三方 stderr 原文写入 bridge 日志，避免凭证或私信内容意外进入日志。
    child.stderr.on('data', () => undefined)
    child.stdin.on('error', () => {
      this.rejectAll(failure('CLI_PIPE', 'bilibili CLI stdin closed; write outcome may be unknown'))
    })
    child.on('error', () => {
      this.rejectAll(failure('CLI_START', 'bilibili CLI could not start'))
    })
    child.once('close', (code) => {
      lines.close()
      if (this.child === child) this.child = null
      this.rejectAll(failure('CLI_EXIT', 'bilibili CLI exited (' + String(code) + '); write outcome may be unknown'))
    })

    await new Promise<void>((resolveSpawn, rejectSpawn) => {
      child.once('spawn', () => resolveSpawn())
      child.once('error', () => rejectSpawn(failure('CLI_START', 'bilibili CLI could not start')))
    })
  }

  private handleLine(line: string): void {
    let response: unknown
    try {
      response = parseJsonLossless(line)
    } catch {
      this.rejectAll(failure('CLI_PROTOCOL', 'bilibili CLI emitted invalid JSONL'))
      void this.close()
      return
    }
    if (!isPlainObject(response)) {
      this.rejectAll(failure('CLI_PROTOCOL', 'bilibili CLI response is not an object'))
      void this.close()
      return
    }

    const rawId = response.id
    const id = typeof rawId === 'string' ? rawId : isSafePositiveInteger(rawId) ? String(rawId) : null
    if (id === null) return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    clearTimeout(pending.timer)

    if (response.ok === true) {
      pending.resolve(response.result)
      return
    }
    if (response.ok === false) {
      const error = isPlainObject(response.error) ? response.error : {}
      const code = typeof error.code === 'string' && error.code ? error.code : 'CLI_FAILED'
      const message = typeof error.message === 'string' && error.message ? error.message : 'bilibili CLI failed'
      pending.reject(failure(code, message))
      return
    }
    pending.reject(failure('CLI_PROTOCOL', 'bilibili CLI response has no boolean ok'))
    void this.close()
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  async call(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.start()
    const child = this.child
    if (!child || this.closed) throw failure('CLI_CLOSED', 'bilibili CLI transport is closed')
    const id = 'bridge-' + String(++this.sequence)
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        // 不重试：CLI 请求可能已经执行，尤其写入结果必须视为未知。
        const error = failure('CLI_TIMEOUT', 'bilibili CLI request timed out; write outcome may be unknown; not retried')
        this.rejectAll(error)
        void this.close()
      }, this.requestTimeoutMs)
      unrefTimer(timer)
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer })
      try {
        child.stdin.write(JSON.stringify({ id, command, args }) + '\n')
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        rejectRequest(failure('CLI_PIPE', 'bilibili CLI stdin write failed: ' + errorMessage(error)))
      }
    })
  }

  cliUid(uid: string | number): number {
    const text = String(uid)
    if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text))) {
      throw failure('VALIDATION', 'uid 必须是正安全整数')
    }
    return Number(text)
  }

  async readDm(uid: string | number): Promise<unknown[]> {
    return extractMessages(await this.call('dm read', { uid: this.cliUid(uid) }))
  }

  async sendDm(uid: string | number, text: string, { confirm = false }: { confirm?: boolean } = {}): Promise<unknown> {
    const numericUid = this.cliUid(uid)
    if (this.env.BILIBILI_BRIDGE_DRY_RUN !== 'false') {
      return this.call('dm send', { uid: numericUid, text, dryRun: true })
    }
    if (confirm !== true) throw failure('CONFIRM_REQUIRED', '真实发送需要逐次人工确认')
    const result = await this.call('dm send', { uid: numericUid, text, confirm: true })
    if (!isPlainObject(result) || result.audited !== true) {
      throw failure('WRITE_OUTCOME_UNKNOWN', 'CLI 未返回审计成功；写入状态未知，不得重试')
    }
    return result
  }

  /** 刷视频：只读热门列表；CLI 负责参数校验与分页字段。 */
  async videoHot(num: number): Promise<unknown> {
    return this.call('video hot', { num })
  }

  async videoSearch(keyword: string, num: number): Promise<unknown> {
    return this.call('video search', { keyword, num })
  }

  async comments(bvid: string, num: number): Promise<unknown[]> {
    const result = await this.call('comment list', { bvid, num })
    if (!isPlainObject(result) || !Array.isArray(result.comments)) {
      throw failure('CLI_PROTOCOL', 'comment list 未返回 comments 数组')
    }
    return result.comments
  }

  /**
   * 通知游标可能超出安全整数：CLI 契约只接受安全整数，这时退化为「不带 id」，
   * 由时间游标与本地 seen 去重兜底；宁可多扫一页，也不静默跳过通知。
   */
  private notifyCursorArgs(cursor: NotifyCursorInput): Record<string, unknown> {
    const id = cursor.id === null ? 0 : Number(cursor.id)
    if (!Number.isSafeInteger(id) || id < 0) return { cursorId: 0, cursorTime: cursor.time ?? 0 }
    return { cursorId: id, cursorTime: cursor.time ?? 0 }
  }

  async inboxAt(cursor: NotifyCursorInput): Promise<unknown> {
    return this.call('inbox', { kind: 'at', ...this.notifyCursorArgs(cursor) })
  }

  async inboxReply(cursor: NotifyCursorInput): Promise<unknown> {
    return this.call('inbox', { kind: 'reply', ...this.notifyCursorArgs(cursor) })
  }

  /** 只读视频信息，用于「只回自己视频」的归属校验。 */
  async videoInfo(bvid: string): Promise<unknown> {
    return this.call('video info', { bvid })
  }

  /** 真实评论走 CLI 的写入审计；dry-run 只预览，未知结果不重试。 */
  async postComment(
    target: { bvid: string; rpid?: number; root?: number },
    text: string,
    { confirm = false }: { confirm?: boolean } = {},
  ): Promise<unknown> {
    const base: Record<string, unknown> = { bvid: target.bvid, text }
    if (target.rpid !== undefined) base.rpid = target.rpid
    if (target.root !== undefined) base.root = target.root
    if (this.env.BILIBILI_BRIDGE_DRY_RUN !== 'false') return this.call('comment create', { ...base, dryRun: true })
    if (confirm !== true) throw failure('CONFIRM_REQUIRED', '真实评论需要逐次确认')
    const result = await this.call('comment create', { ...base, confirm: true })
    if (!isPlainObject(result) || result.audited !== true) {
      throw failure('WRITE_OUTCOME_UNKNOWN', 'CLI 未返回审计成功；评论写入状态未知，不得重试')
    }
    return result
  }

  async close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.rejectAll(failure('CLI_CLOSED', 'bilibili CLI transport stopped; write outcome may be unknown'))
    const child = this.child
    if (!child) return
    const finished = this.childFinished
    this.closing = (async () => {
      child.stdin.end()
      const ended = await new Promise<boolean>((resolveEnded) => {
        let timer: ReturnType<typeof setTimeout> | null = null
        const settle = (value: boolean) => {
          if (timer) clearTimeout(timer)
          timer = null
          resolveEnded(value)
        }
        if (finished) void finished.then(() => settle(true))
        timer = setTimeout(() => settle(false), 1500)
        unrefTimer(timer)
      })
      if (!ended) {
        if (process.platform === 'win32') {
          await new Promise<void>((resolveKill) => {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
              stdio: 'ignore',
              windowsHide: true,
            })
            killer.once('error', () => resolveKill())
            killer.once('close', () => resolveKill())
          })
        } else {
          try {
            child.kill('SIGKILL')
          } catch {
            // already exited
          }
        }
        if (finished) await finished
      }
    })()
    return this.closing
  }
}