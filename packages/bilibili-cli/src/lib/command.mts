import { Command } from 'commander'
import { CliError, commands, envelope, errorCodeOf, validate } from './contract.mjs'
import { createApplication } from './application.mjs'
import { isRecord } from './cli-types.mjs'
import { VERSION } from './version.mjs'
import type { Application, BridgeRunArgs, CommandDefinition, ValidatedArgs } from './cli-types.mjs'

const flag = (key: string): string => '--' + key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
const emit = (value: unknown, json: boolean): void => { process.stdout.write(JSON.stringify(value, null, json ? 0 : 2) + '\n') }

function exitCodeOf(error: unknown): number {
  const code = error instanceof CliError ? error.exitCode : isRecord(error) ? error.exitCode : undefined
  return typeof code === 'number' && code !== 0 && !Number.isNaN(code) ? code : 1
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function requestId(value: unknown): string | number | undefined {
  if (typeof value === 'string') return value
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

/** 与 CLI 契约一致：中断使用 130/143；bridge 自行优雅停止返回 0 时由 CLI 补齐。 */
function signalExitCode(signal: 'SIGINT' | 'SIGTERM' | null): number | undefined {
  if (signal === 'SIGINT') return 130
  if (signal === 'SIGTERM') return 143
  return undefined
}

function hasRawOption(options: unknown, key: string): boolean {
  return isRecord(options) && Object.hasOwn(options, key)
}

/**
 * 只把用户显式提供的字段传给 bridge；contract 的 default（pollMs=6000）仍出现在 schema，
 * 但不能覆盖 BILIBILI_POLL_MS 的 env 回退——env 由 bridge main 读取并校验。
 */
function bridgeRunArgs(args: ValidatedArgs, options: unknown): BridgeRunArgs {
  const result: BridgeRunArgs = {}
  const statePath = args.statePath
  if (typeof statePath === 'string') result.statePath = statePath
  const ownerUids = args.ownerUids
  if (typeof ownerUids === 'string') result.ownerUids = ownerUids
  const url = args.url
  if (typeof url === 'string') result.url = url
  const pollMs = args.pollMs
  if (typeof pollMs === 'number' && hasRawOption(options, 'pollMs')) result.pollMs = pollMs
  return result
}

export async function jsonl(app: Application): Promise<void> {
  let pending = Buffer.alloc(0)
  let oversized = false
  let first = true
  let status = 0
  const input: AsyncIterable<Buffer> = process.stdin
  const line = async (buffer: Buffer): Promise<void> => {
    let command: string | null = null
    let id: string | number | undefined
    try {
      if (oversized) throw new CliError('VALIDATION', 'JSONL 单行超过 65536 字节', 2)
      let text = buffer.toString('utf8').replace(/\r$/, '')
      if (first) text = text.replace(/^\uFEFF/, '')
      first = false
      if (!text.trim()) return
      let request: unknown
      try { request = JSON.parse(text) } catch { throw new CliError('VALIDATION', 'JSONL 不是合法 JSON', 2) }
      if (isRecord(request) && typeof request.command === 'string') command = request.command
      if (isRecord(request)) id = requestId(request.id)
      if (!isRecord(request) || typeof request.command !== 'string' || Object.keys(request).some((key) => !['id', 'command', 'args'].includes(key))) throw new CliError('VALIDATION', 'JSONL 请求需要 command、args 和可选 id', 2)
      if (request.id !== undefined && typeof request.id !== 'string' && !(typeof request.id === 'number' && Number.isSafeInteger(request.id))) throw new CliError('VALIDATION', 'id 必须是字符串或安全整数', 2)
      emit(envelope(request.command, await app.execute(request.command, request.args === undefined ? {} : request.args), null, id), true)
    } catch (error: unknown) {
      status = Math.max(status, exitCodeOf(error))
      emit(envelope(command, null, error, id), true)
    }
  }
  for await (const chunk of input) {
    let start = 0
    for (let index = 0; index < chunk.length; index++) {
      if (chunk[index] !== 10) continue
      const part = chunk.subarray(start, index)
      if (pending.length + part.length > 65536) oversized = true
      await line(oversized ? Buffer.alloc(0) : Buffer.concat([pending, part]))
      pending = Buffer.alloc(0)
      oversized = false
      start = index + 1
    }
    const tail = chunk.subarray(start)
    if (pending.length + tail.length > 65536) oversized = true
    if (!oversized) pending = Buffer.concat([pending, tail])
  }
  if (pending.length || oversized) await line(pending)
  process.exitCode = status
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const app = createApplication()
  let active: CommandDefinition | null = null
  let streamSignal: 'SIGINT' | 'SIGTERM' | null = null
  let streamStarted = false
  const activeDefinition = (): CommandDefinition | null => active
  const program = new Command().name('bilibili').description('独立 B 站 CLI；旧平铺命令不兼容').version(VERSION).option('--json', '输出版本化 JSON').option('--jsonl', '从 stdin 逐行执行完整分组命令')
  const nodes = new Map<string, Command>([['', program]])
  for (const definition of commands) {
    const parts = definition.name.split(' ')
    let parent: Command = program
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join(' ')
      let node = nodes.get(path)
      if (node === undefined) {
        node = parent.command(parts[index])
        nodes.set(path, node)
      }
      parent = node
    }
    parent.description(definition.description)
    for (const [key, field] of Object.entries(definition.fields)) parent.option(`${flag(key)}${field.type === 'boolean' ? '' : ' <value>'}`, field.description)
    parent.action(async (options: unknown) => {
      active = definition
      if (definition.stream === true) {
        const args = bridgeRunArgs(validate(definition, options, true), options)
        const { runBridge } = await import('../lib/bridge/main.mjs')
        const earlySignal = signalExitCode(streamSignal)
        if (earlySignal !== undefined) {
          process.exitCode = earlySignal
          return
        }
        // 到这里同步进入 runBridge；它在 initialize 首个 await 前安装信号处理器，期间不会再让出事件循环。
        streamStarted = true
        const code = await runBridge(args)
        process.exitCode = code === 0 ? (signalExitCode(streamSignal) ?? 0) : code
        return
      }
      const result = await app.execute(definition.name, options, true)
      emit(envelope(definition.name, result), globalJson(program))
    })
  }
  program.action(async () => {
    if (globalJsonl(program)) await jsonl(app)
    else program.outputHelp()
  })
  const fullNames = new Set(commands.map((definition) => definition.name))
  for (const [path, node] of nodes) {
    if (path !== '' && !fullNames.has(path)) node.action(() => { throw new CliError('USAGE', '请选择完整子命令', 2) })
    node.exitOverride()
    node.configureOutput({ writeErr: () => {} })
  }
  const signals = ['SIGINT', 'SIGTERM'] as const
  const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (activeDefinition()?.stream === true) {
      if (streamSignal === null) streamSignal = signal
      return
    }
    app.close()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  }
  const handlers = signals.map((signal) => [signal, () => { stop(signal) }] as const)
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    if (argv.includes('--jsonl') && argv.some((arg) => !['--jsonl', '--json'].includes(arg))) throw new CliError('USAGE', '--jsonl 不能与子命令混用', 2)
    await program.parseAsync([...argv], { from: 'user' })
  } catch (error: unknown) {
    const code = errorCodeOf(error)
    const rawExit = isRecord(error) && typeof error.exitCode === 'number' ? error.exitCode : undefined
    if (code === 'commander.helpDisplayed' || code === 'commander.version' || rawExit === 0) return
    const normalized: unknown = code.startsWith('commander.') ? new CliError('USAGE', messageOf(error), 2) : error
    if (activeDefinition()?.stream === true && streamStarted) {
      process.stderr.write(messageOf(normalized) + '\n')
      process.exitCode = exitCodeOf(normalized)
      return
    }
    if (globalJson(program)) emit(envelope(activeDefinition()?.name ?? null, null, normalized), true)
    else process.stderr.write(envelope(null, null, normalized).error?.message + '\n')
    process.exitCode = exitCodeOf(normalized)
  } finally {
    app.close()
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}

function globalJson(program: Command): boolean {
  return program.opts<Record<string, unknown>>().json === true
}

function globalJsonl(program: Command): boolean {
  return program.opts<Record<string, unknown>>().jsonl === true
}
