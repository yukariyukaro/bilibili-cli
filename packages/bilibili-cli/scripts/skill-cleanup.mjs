#!/usr/bin/env node
/**
 * 维护者工具：清理未受安装器管理的历史 bilibili-cli Skill 副本。
 *
 * 这个动作不属于 B 站内容 CLI 的公开命令，因此不随 npm 包发布；只在本仓库
 * 构建后由维护者显式运行：
 *   node packages/bilibili-cli/scripts/skill-cleanup.mjs --path <ABS> [--confirm] --json
 *   node packages/bilibili-cli/scripts/skill-cleanup.mjs --jsonl
 *
 * 实现仍在 dist/lib/skill-cleanup.mjs；本脚本只做参数解析、信封与退出码，
 * 不改变 preview/确认/回滚语义，也不自动执行官方 remove。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const entry = join(here, '..', 'dist', 'lib', 'skill-cleanup.mjs')
if (!existsSync(entry)) {
  process.stderr.write('缺少 dist/lib/skill-cleanup.mjs；请先在 packages/bilibili-cli 运行 npm run compile\n')
  process.exit(1)
}
const { cleanupLegacySkill } = await import(pathToFileURL(entry).href)

const USAGE = '用法：node scripts/skill-cleanup.mjs --path <绝对路径> [--confirm] --json，或 --jsonl'

function parse(argv) {
  const options = { path: '', confirm: false, json: false, jsonl: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--path') {
      const value = argv[++index]
      if (value === undefined || value.startsWith('--')) throw usage('--path 缺少值')
      options.path = value
    } else if (arg === '--confirm') options.confirm = true
    else if (arg === '--json') options.json = true
    else if (arg === '--jsonl') options.jsonl = true
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE + '\n')
      process.exit(0)
    } else throw usage('未知参数：' + arg)
  }
  if (options.jsonl) return options
  if (!options.path) throw usage('必须提供 --path')
  return options
}

function usage(message) {
  const error = new Error(message)
  error.code = 'USAGE'
  error.exitCode = 2
  return error
}

function envelope(command, result, error) {
  return {
    schemaVersion: 1,
    command,
    ok: !error,
    ...(error
      ? { error: { code: error.code || 'INTERNAL', message: error.message } }
      : { result }),
  }
}

function exitCodeOf(error) {
  return typeof error?.exitCode === 'number' && error.exitCode !== 0 ? error.exitCode : 1
}

async function runOne(args) {
  try {
    const result = await cleanupLegacySkill({ path: args.path, confirm: args.confirm })
    return { code: 0, row: envelope('skills cleanup', result, null) }
  } catch (error) {
    return { code: exitCodeOf(error), row: envelope('skills cleanup', null, error) }
  }
}

async function jsonl() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  let status = 0
  const rows = text.split(/\r?\n/)
  for (const line of rows) {
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      status = 2
      process.stdout.write(JSON.stringify(envelope(null, null, usage('JSONL 不是合法 JSON'))) + '\n')
      continue
    }
    const id = typeof request?.id === 'string' || Number.isSafeInteger(request?.id) ? request.id : undefined
    if (!request || request.command !== 'skills cleanup' || typeof request.args?.path !== 'string') {
      status = 2
      const result = envelope('skills cleanup', null, usage('JSONL 只接受 {"command":"skills cleanup","args":{"path":...}}'))
      if (id !== undefined) result.id = id
      process.stdout.write(JSON.stringify(result) + '\n')
      continue
    }
    const args = { path: request.args.path, confirm: request.args.confirm === true, json: true }
    const result = await runOne(args)
    status = Math.max(status, result.code)
    const row = id === undefined ? result.row : { ...result.row, id }
    process.stdout.write(JSON.stringify(row) + '\n')
  }
  process.exitCode = status
}

try {
  const options = parse(process.argv.slice(2))
  if (options.jsonl) await jsonl()
  else {
    const result = await runOne(options)
    if (options.json) process.stdout.write(JSON.stringify(result.row) + '\n')
    else if (result.row.ok) process.stdout.write(JSON.stringify(result.row.result, null, 2) + '\n')
    else process.stderr.write(result.row.error.message + '\n')
    process.exitCode = result.code
  }
} catch (error) {
  if (error?.code === 'USAGE') {
    process.stderr.write(error.message + '\n' + USAGE + '\n')
    process.exitCode = 2
  } else {
    process.stderr.write((error?.message || String(error)) + '\n')
    process.exitCode = 1
  }
}
