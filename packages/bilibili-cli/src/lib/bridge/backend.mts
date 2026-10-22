import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'

import { errorMessage, isPlainObject, isSafePositiveInteger } from './guards.mjs'
import { parseJsonLossless } from './json.mjs'
import type { BridgeLogger } from './types.mjs'

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
    command = 'bilibili',
    args = ['--jsonl'],
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
    // Windows npm 的 PATH 入口是 .cmd；只交给 shell 固定的启动命令，业务参数始终走 stdin。
    const windowsShim = process.platform === 'win32' && /^(bilibili|.*\.cmd)$/i.test(this.command)
    if (windowsShim && /[\r\n"&|<>^%!]/.test(this.command)) {
      throw failure('CLI_COMMAND', 'unsafe CLI command path')
    }
    // Windows shim 走 cmd.exe，只允许产品固定的 --jsonl；故障测试用 node 直接 spawn，不经过 shell。
    if (windowsShim && (this.args.length !== 1 || this.args[0] !== '--jsonl')) {
      throw failure('CLI_COMMAND', 'Windows CLI shim only supports the fixed --jsonl argument')
    }
    const child = windowsShim
      ? spawn(
          this.env.ComSpec || process.env.ComSpec || 'cmd.exe',
          ['/d', '/s', '/c', (this.command === 'bilibili' ? 'bilibili' : '"' + this.command + '"') + ' ' + this.args.join(' ')],
          { env: this.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        )
      : spawn(this.command, this.args, {
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