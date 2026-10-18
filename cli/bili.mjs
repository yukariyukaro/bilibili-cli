#!/usr/bin/env node
import { existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command } from 'commander'
import { execa } from 'execa'
import { McpClient } from '../lib/mcp.mjs'
import { loginPoll, loginStart, renderQrPng, saveCredential } from '../lib/login.mjs'
import { ensureUv } from '../lib/uvfetch.mjs'
import { auditFile, configFile, credentialFile, ensurePortableFiles, readJson, stateDir, writeJson } from '../lib/portable.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const dir = stateDir()
const cfgPath = configFile(dir)
const defaults = { pythonPath: 'python', writesEnabled: false, mentionName: '' }
const cfg = { ...defaults, ...readJson(cfgPath) }
const program = new Command()
  .name('bili')
  .description('面向 coding agent 的 B 站 CLI')
  .version('0.1.5')
  .option('--json', '输出单个 JSON 对象')
  .allowUnknownOption(true)

const parsed = program.parseOptions(process.argv.slice(2))
const jsonMode = process.argv.includes('--json')
const args = [...parsed.operands, ...parsed.unknown].filter((x) => x !== '--json')

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(program.helpInformation())
  process.exit(0)
}

function output(value, oneLine = false) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, oneLine || jsonMode ? 0 : 2)
  process.stdout.write(text + '\n')
}

function fail(error, code = 1) {
  if (jsonMode) output({ ok: false, error: String(error?.message || error) })
  else process.stderr.write(String(error?.message || error) + '\n')
  process.exitCode = code
}

function pythonPath() {
  if (cfg.pythonPath && cfg.pythonPath !== 'python') return cfg.pythonPath
  const local = join(dir, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
  return existsSync(local) ? local : cfg.pythonPath
}

function env() {
  return { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
}

function client() {
  const script = ensurePortableFiles(dir)
  return new McpClient({ command: pythonPath(), args: [script], cwd: dir, env: env() })
}

async function call(name, params = {}) {
  const c = client()
  try { return await c.call(name, params) } finally { c.stop() }
}

function saveConfig(patch) {
  Object.assign(cfg, patch)
  writeJson(cfgPath, cfg)
  return cfg
}

function audit(action, detail) {
  appendFileSync(auditFile(dir), JSON.stringify({ at: new Date().toISOString(), action, ...detail }) + '\n', 'utf8')
}

async function setup() {
  const venv = join(dir, '.venv')
  const py = join(venv, process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python')
  const uv = await ensureUv({ dir: join(dir, 'bin'), log: (m) => { if (!jsonMode) process.stderr.write(m + '\n') } })
  const command = uv || cfg.pythonPath || 'python'
  const run = async (cmd, list) => {
    await execa(cmd, list, {
      cwd: dir,
      env: env(),
      stdio: jsonMode ? ['ignore', 'ignore', 'pipe'] : 'inherit',
      windowsHide: true,
      reject: true,
    })
  }
  if (!existsSync(py)) await run(command, uv ? ['venv', '--seed', venv] : ['-m', 'venv', venv])
  const req = join(root, 'vendor', 'bilibili-mcp', 'requirements.txt')
  if (uv) await run(uv, ['pip', 'install', '--python', py, '-r', req])
  else await run(py, ['-m', 'pip', 'install', '-r', req])
  saveConfig({ pythonPath: py })
  output({ ok: true, stateDir: dir, pythonPath: py, credential: credentialFile(dir) })
}

async function loginStartCommand() {
  const current = credentialFile(dir)
  if (existsSync(current)) return output({ ok: true, state: 'already_logged_in', file: current })
  const { key, url } = await loginStart()
  const png = await renderQrPng(pythonPath(), dir, url)
  output({ ok: true, state: 'qrcode_ready', key, url, png, next: '扫码后执行 bili login poll --key <key>' })
}

async function loginPollCommand(key) {
  if (!key) throw new Error('login poll 需要 --key KEY')
  const result = await loginPoll(key)
  if (result.state === 'ok') {
    const file = saveCredential(dir, result.credential)
    output({ ok: true, state: 'ok', file })
    return
  }
  output({ ok: result.state !== 'unknown', ...result })
}

async function writeReply() {
  const bvid = value('--bvid')
  const text = value('--text')
  const rpid = Number(value('--rpid') || 0)
  if (!args.includes('--confirm')) throw new Error('写操作默认关闭。预览内容后重新执行，并添加 --confirm。')
  if (cfg.writesEnabled !== true) throw new Error('写操作开关未开启。先执行 config --set writesEnabled=true，再使用 --confirm。')
  if (!bvid || !text) throw new Error('reply 需要 --bvid 和 --text')
  if (text.length > 150) throw new Error('评论正文不能超过 150 字')
  const result = await call('bili_reply', { bvid, text, rpid })
  audit('reply', { bvid, rpid, text: text.slice(0, 20), result })
  output({ ok: true, result, audited: true })
}

async function deleteComment({ bvid, rpid, confirm }) {
  if (confirm !== true) throw new Error('删除需要本次明确确认：CLI 添加 --confirm，JSONL 使用 confirm=true')
  if (cfg.writesEnabled !== true) throw new Error('写操作开关未开启')
  if (typeof bvid !== 'string' || !bvid.trim() || bvid.startsWith('--')) throw new Error('delete 需要 --bvid / bvid')
  if (!['string', 'number'].includes(typeof rpid) || !/^[1-9]\d*$/.test(String(rpid)) || !Number.isSafeInteger(Number(rpid))) throw new Error('delete 的 rpid 必须为安全范围内的正整数')
  const target = { bvid, rpid: Number(rpid) }
  audit('delete', { ...target, status: 'attempt' })
  let result
  try {
    result = await call('bili_delete', target)
    if (result?.success !== true || result?.ok === false || result?.error) throw new Error(String(result?.error || '删除未返回明确成功结果，状态未知'))
  } catch (error) {
    try { audit('delete', { ...target, status: 'failed', error: String(error?.message || error) }) }
    catch { throw new Error('删除失败或状态未知，且失败审计写入失败；请人工核对，不要自动重试') }
    throw error
  }
  try { audit('delete', { ...target, status: 'success', result }) }
  catch { throw new Error('删除接口已返回成功，但审计写入失败；请人工核对，不要自动重试') }
  return result
}

function value(name) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : ''
}

async function jsonl() {
  let text = ''
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) text += chunk
  const lines = text.split(/\r?\n/).filter(Boolean).map((line) => line.replace(/^\uFEFF/, ''))
  for (const line of lines) {
    try {
      const request = JSON.parse(line)
      const command = String(request.command || request.action || '')
      const params = request.args || request.params || {}
      let result
      if (command === 'whoami') result = await call('bili_check_credential')
      else if (command === 'search') result = await call('bili_search', params)
      else if (command === 'subtitle') result = await call('bili_subtitle', params)
      else if (command === 'comments') result = await call('bili_comments', params)
      else if (command === 'video-info') result = await call('bili_video_info', params)
      else if (command === 'hot') result = await call('bili_hot_videos', params)
      else if (command === 'reply') {
        if (params.confirm !== true) throw new Error('JSONL 写操作需要 confirm=true')
        if (cfg.writesEnabled !== true) throw new Error('写操作开关未开启')
        if (!params.bvid || !params.text) throw new Error('reply 需要 bvid 和 text')
        if (String(params.text).length > 150) throw new Error('评论正文不能超过 150 字')
        result = await call('bili_reply', { bvid: String(params.bvid), text: String(params.text), rpid: Number(params.rpid) || 0 })
        audit('reply', { bvid: String(params.bvid), rpid: Number(params.rpid) || 0, text: String(params.text).slice(0, 20), result })
      }
      else if (command === 'delete') result = await deleteComment(params)
      else throw new Error(`未知 JSONL 命令：${command}`)
      output({ ok: true, command, result, ...(command === 'delete' ? { audited: true } : {}) }, true)
    } catch (error) { output({ ok: false, error: String(error?.message || error) }, true) }
  }
}

async function main() {
  if (args[0] === 'agent') return jsonl()
  if (args[0] === 'setup') return setup()
  if (args[0] === 'login' && args[1] === 'start') return loginStartCommand()
  if (args[0] === 'login' && args[1] === 'poll') return loginPollCommand(value('--key') || args[2])
  if (args[0] === 'whoami') return output(await call('bili_check_credential'))
  if (args[0] === 'search') return output(await call('bili_search', { keyword: value('--keyword') || args[1], num: Number(value('--num') || 10), order: value('--order') || 'totalrank' }))
  if (args[0] === 'subtitle') return output(await call('bili_subtitle', { bvid: value('--bvid') || args[1] }))
  if (args[0] === 'comments') return output(await call('bili_comments', { bvid: value('--bvid') || args[1], num: Number(value('--num') || 30), order: value('--order') || 'like' }))
  if (args[0] === 'video-info') return output(await call('bili_video_info', { bvid: value('--bvid') || args[1] }))
  if (args[0] === 'hot') return output(await call('bili_hot_videos', { pn: Number(value('--page') || 1), ps: Number(value('--num') || 20) }))
  if (args[0] === 'reply') return writeReply()
  if (args[0] === 'delete') return output({ ok: true, result: await deleteComment({ bvid: value('--bvid'), rpid: value('--rpid'), confirm: args.includes('--confirm') }), audited: true })
  if (args[0] === 'config') {
    const patch = {}
    if (value('--set')) { const [key, val] = value('--set').split('='); patch[key] = val === 'true' ? true : val === 'false' ? false : val }
    return output(saveConfig(patch))
  }
  output({ ok: true, commands: ['setup', 'login start', 'login poll --key KEY', 'whoami', 'search KEYWORD', 'subtitle BV', 'comments BV', 'video-info BV', 'hot', 'reply --bvid BV --text TEXT --confirm', 'delete --bvid BV --rpid ID --confirm', 'config --set key=value', 'agent'] })
}

main().catch(fail)
