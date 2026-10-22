import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  IS_WINDOWS,
  PATH_DELIMITER,
  assertNoCredential,
  buildChildEnv,
  resolveInstalledPrefix,
  stripRiskyEnv,
  tail,
} from './env.mjs'

const COMMAND_TIMEOUT = 90000
const OUTPUT_LIMIT = 4 * 1024 * 1024

export function quoteForCmd(value) {
  // cmd.exe 的双引号转义；% 在引号内仍会展开，测试正文不依赖 %。
  return '"' + String(value).replaceAll('"', '""').replaceAll('%', '%%') + '"'
}

export function cmdArg(value) {
  const text = String(value)
  if (text.length === 0) return '""'
  return /[\s"&|<>^()%!]/.test(text) ? quoteForCmd(text) : text
}

export function bilibiliSpawn(command, args, options) {
  if (IS_WINDOWS) {
    const shell = process.env.ComSpec || 'cmd.exe'
    const line = ['bilibili', ...args].map(cmdArg).join(' ')
    return spawn(shell, ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true })
  }
  return spawn(command, args, options)
}

function killChildTree(child) {
  if (!child || child.exitCode !== null) return
  if (IS_WINDOWS) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    killer.once('error', () => { try { child.kill() } catch {} })
    return
  }
  try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
}

function parseSingleEnvelope(stdout, stderr, code) {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
  if (!line) throw new Error('bilibili 无输出(code=' + code + ')：' + stderr.trim().slice(0, 500))
  try {
    return JSON.parse(line)
  } catch {
    throw new Error('bilibili 输出不是 JSON(code=' + code + ')：' + line.slice(0, 500))
  }
}

/**
 * 通过 PATH 上的 bilibili 入口执行命令。默认使用安装前缀的 bin 目录，
 * 绝不把仓库源码路径或全局未知版本当作安装产物。
 */
export function runBilibiliRaw(args, { home = '', input = '', timeout = COMMAND_TIMEOUT, env = {}, cwd, installed } = {}) {
  const prefix = installed || resolveInstalledPrefix({ ...process.env, ...env })
  if (!prefix?.ok) return Promise.reject(new Error(prefix?.reason || '未配置 BILIBILI_E2E_INSTALLED_PREFIX'))
  const childEnv = buildChildEnv({ baseEnv: { ...process.env, ...env }, installed: prefix, home })

  return new Promise((resolveRun, rejectRun) => {
    let child
    try {
      child = bilibiliSpawn('bilibili', args, {
        cwd: cwd || process.cwd(),
        env: childEnv,
        windowsHide: true,
        detached: !IS_WINDOWS,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      rejectRun(error)
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectRun(error)
      else resolveRun(value)
    }

    timer = setTimeout(() => {
      killChildTree(child)
      finish(new Error('bilibili 超时(' + timeout + 'ms)：' + args.join(' ') + '；不自动重试写操作'))
    }, timeout)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.length > OUTPUT_LIMIT) {
        killChildTree(child)
        finish(new Error('bilibili 输出超过限制'))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      if (stderr.length > OUTPUT_LIMIT) {
        killChildTree(child)
        finish(new Error('bilibili stderr 超过限制'))
      }
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => finish(null, { code, signal, stdout, stderr }))

    child.stdin.end(input)
  })
}

export async function runBilibili(args, options = {}) {
  const result = await runBilibiliRaw(args, options)
  const envelope = parseSingleEnvelope(result.stdout, result.stderr, result.code)
  return { ...result, envelope }
}

export async function runJsonl(requests, options = {}) {
  const input = requests.map((request) => typeof request === 'string' ? request : JSON.stringify(request)).join('\n') + '\n'
  const result = await runBilibili(['--jsonl'], { ...options, input })
  const rows = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line, index) => {
    try { return JSON.parse(line) } catch { throw new Error('JSONL 第 ' + (index + 1) + ' 行不是 JSON：' + line.slice(0, 300)) }
  })
  return { ...result, rows }
}

export async function bilibiliOk(args, options) {
  const result = await runBilibili(args, options)
  if (result.envelope?.ok !== true) {
    throw new Error('bilibili 失败：' + args.join(' ') + ' -> ' + JSON.stringify(result.envelope?.error) + '（退出码 ' + result.code + '）')
  }
  return result.envelope.result
}

export function authStatus(home, options = {}) {
  return bilibiliOk(['auth', 'status', '--json'], { home, ...options })
}

export function dmRead(uid, home, options = {}) {
  return bilibiliOk(['dm', 'read', '--uid', String(uid), '--json'], { home, ...options })
}

export function dmStatus(uid, home, options = {}) {
  return bilibiliOk(['dm', 'status', '--uid', String(uid), '--json'], { home, ...options })
}

export function schema(home = '', options = {}) {
  return bilibiliOk(['schema', '--json'], { home, ...options })
}

export function doctor(home, options = {}) {
  return bilibiliOk(['doctor', '--json'], { home, ...options })
}

export function configGet(home, options = {}) {
  return bilibiliOk(['config', 'get', '--json'], { home, ...options })
}

export function skillsList(home = '', options = {}) {
  return bilibiliOk(['skills', 'list', '--json'], { home, ...options })
}

export function installedVersion(home = '', options = {}) {
  return runBilibiliRaw(['--version'], { home, ...options })
}

export function bridgeStatus({ statePath, home = '', installed, env = {}, cwd } = {}) {
  return runBilibili(['bridge', 'status', '--state-path', statePath, '--json'], { home, installed, env, cwd })
}

export function bridgeStop({ statePath, home = '', installed, env = {}, cwd } = {}) {
  return runBilibili(['bridge', 'stop', '--state-path', statePath, '--json'], { home, installed, env, cwd })
}

/** 只用于判断只读测试是否制造了审计文件；不读取正文。 */
export function auditStat(home) {
  try { return statSync(join(home, 'audit.jsonl')) } catch { return null }
}

export { assertNoCredential, tail, dirname, existsSync, resolve, stripRiskyEnv, PATH_DELIMITER }