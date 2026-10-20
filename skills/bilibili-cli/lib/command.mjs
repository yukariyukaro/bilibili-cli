import { Command } from 'commander'
import { commands, envelope, CliError } from './contract.mjs'
import { createApplication } from './application.mjs'

const flag = (key) => '--' + key.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())
const emit = (value, json) => process.stdout.write(JSON.stringify(value, null, json ? 0 : 2) + '\n')

export async function jsonl(app) {
  let pending = Buffer.alloc(0)
  let oversized = false
  let first = true
  let status = 0
  const line = async (buffer) => {
    let request
    try {
      if (oversized) throw new CliError('VALIDATION', 'JSONL 单行超过 65536 字节', 2)
      let text = buffer.toString('utf8').replace(/\r$/, '')
      if (first) text = text.replace(/^\uFEFF/, '')
      first = false
      if (!text.trim()) return
      try { request = JSON.parse(text) } catch { throw new CliError('VALIDATION', 'JSONL 不是合法 JSON', 2) }
      if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.command !== 'string' || Object.keys(request).some((key) => !['id', 'command', 'args'].includes(key))) throw new CliError('VALIDATION', 'JSONL 请求需要 command、args 和可选 id', 2)
      if (request.id !== undefined && typeof request.id !== 'string' && !Number.isSafeInteger(request.id)) throw new CliError('VALIDATION', 'id 必须是字符串或安全整数', 2)
      emit(envelope(request.command, await app.execute(request.command, request.args === undefined ? {} : request.args), null, request.id), true)
    } catch (error) {
      status = Math.max(status, error.exitCode || 1)
      emit(envelope(typeof request?.command === 'string' ? request.command : null, null, error, typeof request?.id === 'string' || Number.isSafeInteger(request?.id) ? request.id : undefined), true)
    }
  }
  for await (const chunk of process.stdin) {
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

export async function main(argv = process.argv.slice(2)) {
  const app = createApplication()
  let active = null
  const program = new Command().name('bilibili').description('独立 B 站 CLI；旧平铺命令不兼容').version('1.0.0').option('--json', '输出版本化 JSON').option('--jsonl', '从 stdin 逐行执行完整分组命令')
  const nodes = new Map([['', program]])
  for (const definition of commands) {
    const parts = definition.name.split(' ')
    let parent = program
    for (let index = 0; index < parts.length; index++) {
      const path = parts.slice(0, index + 1).join(' ')
      if (!nodes.has(path)) nodes.set(path, parent.command(parts[index]))
      parent = nodes.get(path)
    }
    parent.description(definition.description)
    for (const [key, field] of Object.entries(definition.fields)) parent.option(`${flag(key)}${field.type === 'boolean' ? '' : ' <value>'}`, field.description)
    parent.action(async (options) => {
      active = definition.name
      const result = await app.execute(definition.name, options, true)
      emit(envelope(definition.name, result), program.opts().json)
    })
  }
  program.action(async () => {
    if (program.opts().jsonl) await jsonl(app)
    else program.outputHelp()
  })
  for (const node of nodes.values()) {
    if (node !== program && !node._actionHandler) node.action(() => { throw new CliError('USAGE', '请选择完整子命令', 2) })
    node.exitOverride()
    node.configureOutput({ writeErr: () => {} })
  }
  const signals = ['SIGINT', 'SIGTERM']
  const stop = (signal) => { app.close(); process.exit(signal === 'SIGINT' ? 130 : 143) }
  const handlers = signals.map((signal) => [signal, () => stop(signal)])
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    if (argv.includes('--jsonl') && argv.some((arg) => !['--jsonl', '--json'].includes(arg))) throw new CliError('USAGE', '--jsonl 不能与子命令混用', 2)
    await program.parseAsync(argv, { from: 'user' })
  } catch (error) {
    if (['commander.helpDisplayed', 'commander.version'].includes(error.code) || error.exitCode === 0) return
    const normalized = error.code?.startsWith('commander.') ? new CliError('USAGE', error.message, 2) : error
    if (argv.includes('--json')) emit(envelope(active, null, normalized), true)
    else process.stderr.write(envelope(null, null, normalized).error.message + '\n')
    process.exitCode = normalized.exitCode || 1
  } finally {
    app.close()
    for (const [signal, handler] of handlers) process.off(signal, handler)
  }
}
