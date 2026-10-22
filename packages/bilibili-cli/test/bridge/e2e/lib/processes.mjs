import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ARTIFACTS, IS_WINDOWS, PATH_DELIMITER, WORKDIR } from './env.mjs'
import { startBridgeRun } from '../../lib/bridge-run.mjs'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitFor(check, { timeout = 30000, interval = 500, message = '等待条件超时' } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw new Error(message + (lastError ? '（最后一次错误：' + lastError.message + '）' : ''))
}

function createLogger(name) {
  mkdirSync(ARTIFACTS, { recursive: true })
  const file = join(ARTIFACTS, name + '-' + Date.now() + '-' + process.pid + '.log')
  const chunks = []
  let length = 0
  const push = (stream, chunk) => {
    const text = chunk.toString()
    // 不在日志里扩散真实私信正文：只保留控制面/进程输出，调用方不会把正文写日志。
    chunks.push(text)
    length += text.length
    if (length > 2 * 1024 * 1024) {
      chunks.splice(0, chunks.length, chunks.join('').slice(-1024 * 1024))
      length = chunks[0].length
    }
    writeFileSync(file, chunks.join(''), 'utf8')
    if (process.env.BILIBILI_E2E_VERBOSE === '1') process.stdout.write('[' + name + ':' + stream + '] ' + text)
  }
  return { file, push, text: () => chunks.join('') }
}

export function startProcess({ name, command, args, env = {}, cwd = WORKDIR }) {
  const logger = createLogger(name)
  const child = spawn(command, args, {
    cwd,
    shell: false,
    windowsHide: true,
    detached: !IS_WINDOWS,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => logger.push('out', chunk))
  child.stderr.on('data', (chunk) => logger.push('err', chunk))
  const exited = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })))
  return {
    child,
    logger,
    exited,
    output: logger.text,
    logFile: logger.file,
    async stop() {
      await stopProcessTree(child)
    },
    waitForOutput(pattern, { timeout = 15000 } = {}) {
      return waitFor(() => pattern.test(logger.text()), {
        timeout,
        interval: 250,
        message: '进程 ' + name + ' 未在 ' + timeout + 'ms 内输出 ' + pattern + '；日志：' + logger.file,
      })
    },
  }
}

export async function stopProcessTree(child, { timeout = 6000 } = {}) {
  if (!child || child.exitCode !== null) return
  if (IS_WINDOWS) {
    const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
    await Promise.race([once(killer, 'close'), sleep(timeout)])
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { try { child.kill('SIGTERM') } catch {} }
  }
  await Promise.race([once(child, 'close'), sleep(timeout)])
  if (child.exitCode === null) {
    if (IS_WINDOWS) {
      try { child.kill() } catch {}
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
    }
    await Promise.race([once(child, 'close'), sleep(2000)])
  }
}

/**
 * 启动真实安装产物的 bridge run（PATH bilibili bridge run）。
 * 只允许 dry-run；不提供 confirmSend，也不把写开关打开。
 */
export function startBridge({ installed, port, token, ownerUid, skillHome, statePath, extraEnv = {} }) {
  if (!installed?.ok) throw new Error('startBridge 需要已解析的安装前缀')
  if (extraEnv.BILIBILI_BRIDGE_DRY_RUN !== undefined && extraEnv.BILIBILI_BRIDGE_DRY_RUN !== 'true') {
    throw new Error('测试不允许关闭 bridge dry-run')
  }
  const env = {
    BILIBILI_SKILL_HOME: skillHome,
    ...extraEnv,
  }
  const currentPath = env.PATH || env.Path || process.env.PATH || process.env.Path || ''
  const merged = installed.binDir + PATH_DELIMITER + currentPath
  env.PATH = merged
  if (IS_WINDOWS) env.Path = merged
  return startBridgeRun({
    installed,
    home: skillHome,
    statePath,
    ownerUids: String(ownerUid),
    url: 'ws://127.0.0.1:' + port + '/bridge/ws',
    pollMs: 6000,
    token,
    cwd: WORKDIR,
    extraEnv: env,
  })
}

/** 启动一个本地命令并收集输出，用于 cc-connect --version 等离线探测。 */
export function runCommand(command, args = [], { timeout = 15000, cwd = WORKDIR, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: IS_WINDOWS,
      windowsHide: true,
      detached: !IS_WINDOWS,
      env: { ...process.env, ...env },
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => {
      void stopProcessTree(child).catch(() => {})
      finish(new Error('命令超时：' + command + ' ' + args.join(' ')))
    }, timeout)
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => finish(null, { code, signal, stdout, stderr }))
  })
}
