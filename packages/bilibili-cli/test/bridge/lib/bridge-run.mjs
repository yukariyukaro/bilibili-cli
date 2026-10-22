import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  IS_WINDOWS,
  PATH_DELIMITER,
  buildChildEnv,
  resolveInstalledPrefix,
  sleep,
  tail,
  waitFor,
} from './env.mjs'
import { bilibiliSpawn, cmdArg, runBilibili } from './cli.mjs'

export const RUN_EVENT_TYPES = ['registered', 'ready', 'stopped', 'error']

export function bridgeRunArgs({ statePath, ownerUids, url, pollMs = 6000 }) {
  const args = ['bridge', 'run']
  if (statePath) args.push('--state-path', String(statePath))
  if (ownerUids !== undefined && ownerUids !== null && String(ownerUids).length) args.push('--owner-uids', String(ownerUids))
  if (url) args.push('--url', String(url))
  if (pollMs !== undefined && pollMs !== null) args.push('--poll-ms', String(pollMs))
  return args
}

/**
 * 通过 PATH 上的 bilibili 入口启动 bridge run。
 * 这是长驻事件流，不进入 --jsonl；stdout 只应出现 registered/ready/error/stopped 事件。
 */
export function startBridgeRun({ installed, home, statePath, ownerUids, url, pollMs = 6000, token, extraEnv = {}, cwd }) {
  const prefix = installed || resolveInstalledPrefix()
  if (!prefix?.ok) throw new Error(prefix?.reason || 'startBridgeRun 需要已解析的安装前缀')
  if (!token) throw new Error('startBridgeRun 需要 token（只放环境变量 CC_CONNECT_BRIDGE_TOKEN，不放 argv）')
  const args = bridgeRunArgs({ statePath, ownerUids, url, pollMs })
  const env = buildChildEnv({
    baseEnv: { ...process.env, ...extraEnv },
    installed: prefix,
    home,
    extra: {
      CC_CONNECT_BRIDGE_TOKEN: token,
      // 测试只允许 dry-run；本地 WS 不会发 reply。
      BILIBILI_BRIDGE_DRY_RUN: 'true',
      BILIBILI_BRIDGE_DEBUG: '1',
    },
  })
  const child = bilibiliSpawn('bilibili', args, {
    cwd: cwd || process.cwd(),
    env,
    windowsHide: true,
    detached: !IS_WINDOWS,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const events = []
  const stdoutLines = []
  const stderrLines = []
  let stdoutBuffer = ''
  let stderrBuffer = ''
  let exitInfo = null
  const waiters = new Set()

  const notify = (event) => {
    events.push(event)
    for (const waiter of [...waiters]) {
      let matched = false
      try { matched = waiter.predicate(event) === true } catch { matched = false }
      if (!matched) continue
      clearTimeout(waiter.timer)
      waiters.delete(waiter)
      waiter.resolve(event)
    }
  }

  const pushLine = (target, line) => {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line
    target.push(trimmed)
    let event
    try { event = JSON.parse(trimmed) } catch { event = { type: 'non-json', line: trimmed } }
    if (event && typeof event === 'object' && !Array.isArray(event)) notify(event)
  }

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk
    while (true) {
      const index = stdoutBuffer.indexOf('\n')
      if (index < 0) break
      pushLine(stdoutLines, stdoutBuffer.slice(0, index))
      stdoutBuffer = stdoutBuffer.slice(index + 1)
    }
  })
  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk
    while (true) {
      const index = stderrBuffer.indexOf('\n')
      if (index < 0) break
      stderrLines.push(stderrBuffer.slice(0, index).replace(/\r$/, ''))
      stderrBuffer = stderrBuffer.slice(index + 1)
    }
  })
  child.stdin.on('error', () => {})

  const exited = new Promise((resolveExit) => {
    child.once('close', (code, signal) => {
      if (stdoutBuffer) pushLine(stdoutLines, stdoutBuffer)
      if (stderrBuffer) stderrLines.push(stderrBuffer)
      exitInfo = { code, signal }
      for (const waiter of [...waiters]) {
        clearTimeout(waiter.timer)
        waiters.delete(waiter)
        waiter.reject(new Error('bridge run 已退出(code=' + code + ',signal=' + signal + ') 而等待 ' + waiter.description + '；stderr=' + tail(stderrLines.join('\n'), 1200)))
      }
      resolveExit(exitInfo)
    })
  })

  const proc = {
    child,
    args,
    env,
    events,
    stdoutLines,
    stderrLines,
    exited,
    exitInfo: () => exitInfo,
    alive: () => exitInfo === null,
    stdout: () => stdoutLines.join('\n'),
    stderr: () => stderrLines.join('\n'),
    output: () => stderrLines.join('\n') + '\n' + stdoutLines.join('\n'),
    waitEvent(predicate, { timeout = 15000, from = 0, description = 'run 事件' } = {}) {
      const found = events.slice(from).find(predicate)
      if (found) return Promise.resolve(found)
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            rejectWait(new Error('等待' + description + '超时（' + timeout + 'ms）；events=' + JSON.stringify(events.slice(-8)) + '；stderr=' + tail(stderrLines.join('\n'), 1200)))
          }, timeout),
        }
        waiters.add(waiter)
      })
    },
    waitType(type, options = {}) {
      return proc.waitEvent((event) => event.type === type, { description: type + ' 事件', ...options })
    },
    waitStderr(pattern, timeout = 15000) {
      return waitFor(() => stderrLines.find((line) => pattern.test(line)), { timeout, interval: 100, description: 'stderr 匹配 ' + pattern })
    },
    async write(text) {
      if (exitInfo) return
      await new Promise((resolveWrite, rejectWrite) => {
        child.stdin.write(text, (error) => (error ? rejectWrite(error) : resolveWrite()))
      })
    },
    async stopStdin({ timeout = 10000 } = {}) {
      await proc.write(JSON.stringify({ type: 'stop' }) + '\n').catch(() => {})
      return withTimeout(exited, timeout, 'stdin stop 后 bridge run 未退出')
    },
    waitForOutput(pattern, { timeout = 15000 } = {}) {
      return waitFor(() => pattern.test(proc.output()), { timeout, interval: 150, description: '输出匹配 ' + pattern })
    },
    async stop() {
      return proc.kill()
    },
    async stopCli({ timeout = 20000 } = {}) {
      const result = await runBilibili(['bridge', 'stop', '--state-path', String(statePath), '--json'], {
        installed: prefix,
        home,
        env: extraEnv,
        cwd,
        timeout,
      })
      return result
    },
    async kill() {
      if (exitInfo) return
      try { child.stdin.end() } catch {}
      await killTree(child.pid)
      await Promise.race([exited, sleep(5000)])
    },
  }
  return proc
}

export function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

export async function killTree(pid) {
  if (!pid) return
  if (!IS_WINDOWS) {
    try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} }
    return
  }
  await new Promise((resolveKill) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', resolveKill)
    killer.once('close', resolveKill)
  })
}

export function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function listDescendants(rootPid, { cwd, env } = {}) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) return []
  if (IS_WINDOWS) {
    const script = [
      '$root = ' + rootPid,
      '$all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId',
      '$result = New-Object System.Collections.Generic.List[int]',
      '$queue = New-Object System.Collections.Generic.Queue[int]',
      '$queue.Enqueue($root)',
      'while ($queue.Count -gt 0) {',
      '  $current = $queue.Dequeue()',
      '  foreach ($child in $all) {',
      '    if ($child.ParentProcessId -eq $current) {',
      '      $result.Add([int]$child.ProcessId)',
      '      $queue.Enqueue([int]$child.ProcessId)',
      '    }',
      '  }',
      '}',
      "$result -join ','",
    ].join('\n')
    const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { cwd, env, timeout: 20000 })
    if (result.timedOut) throw new Error('读取 Windows 进程树超时')
    if (result.code !== 0) throw new Error('读取 Windows 进程树失败：' + result.stderr)
    const text = result.stdout.trim()
    return text ? text.split(',').map((value) => Number(value)).filter((value) => Number.isSafeInteger(value) && value > 0) : []
  }
  const result = await runProcess('ps', ['-eo', 'pid=,ppid='], { cwd, env, timeout: 10000 })
  if (result.timedOut) throw new Error('读取 POSIX 进程树超时')
  if (result.code !== 0) throw new Error('读取 POSIX 进程树失败：' + result.stderr)
  const children = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid)) continue
    if (!children.has(ppid)) children.set(ppid, [])
    children.get(ppid).push(pid)
  }
  const found = []
  const queue = [rootPid]
  while (queue.length > 0) {
    const current = queue.shift()
    for (const child of children.get(current) ?? []) {
      if (!found.includes(child)) {
        found.push(child)
        queue.push(child)
      }
    }
  }
  return found
}

export async function runProcess(command, args, { cwd, env, timeout = 20000 } = {}) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  let timer
  const result = await Promise.race([
    new Promise((resolveExit) => child.once('exit', (code) => resolveExit({ code, stdout, stderr }))),
    new Promise((resolveTimeout) => {
      timer = setTimeout(() => resolveTimeout({ code: null, stdout, stderr, timedOut: true }), timeout)
    }),
  ])
  clearTimeout(timer)
  return result
}

export function assertRunEventStream(proc) {
  for (const line of proc.stdoutLines) {
    let event
    try { event = JSON.parse(line) } catch { throw new Error('bridge run stdout 出现非 JSON 事件行：' + line) }
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('bridge run stdout 事件必须是 JSON 对象：' + line)
    if (!RUN_EVENT_TYPES.includes(event.type)) throw new Error('bridge run stdout 出现未知事件类型：' + line)
  }
}

export function assertNoToken(text, token) {
  if (!token) return
  if (String(text).includes(token)) throw new Error('bridge run 输出泄漏 token（不打印 token 原文）')
}

export { pathToFileURL, join, resolve, existsSync }