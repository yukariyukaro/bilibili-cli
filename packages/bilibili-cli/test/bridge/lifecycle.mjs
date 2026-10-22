import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { installedBridgeModule, resolveInstalledPrefix } from './lib/env.mjs'
import { startBridgeRun } from './lib/bridge-run.mjs'
import { runBilibili } from './lib/cli.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TEST_BRIDGE_DIR = resolve(HERE, '..')
const INSTALLED = resolveInstalledPrefix(process.env)
if (!INSTALLED.ok) throw new Error('lifecycle E2E 需要 BILIBILI_E2E_INSTALLED_PREFIX：' + (INSTALLED.reason || ''))
const STATE_MODULE = pathToFileURL(installedBridgeModule(INSTALLED, 'state.mjs')).href
const IS_WINDOWS = process.platform === 'win32'
const TEST_TOKEN = 'lifecycle-offline-token'
const TEST_OWNER_UID = '424242'
const LIVE_PROCESSES = new Set()
const LIVE_SERVERS = new Set()

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(check, { timeout = 10000, interval = 50, message = '等待条件超时' } = {}) {
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

function attachLines(stream, target, onLine) {
  stream.setEncoding('utf8')
  let buffer = ''
  const push = (line) => {
    const normalized = line.endsWith('\r') ? line.slice(0, -1) : line
    target.push(normalized)
    if (onLine) onLine(normalized)
  }
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) !== -1) {
      push(buffer.slice(0, index))
      buffer = buffer.slice(index + 1)
    }
  })
  stream.on('end', () => {
    if (buffer.length) push(buffer)
    buffer = ''
  })
}

function parseEvent(line) {
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

function countMatch(lines, pattern) {
  return lines.filter((line) => pattern.test(line)).length
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

async function killTree(pid) {
  if (!pid) return
  if (!IS_WINDOWS) {
    try { process.kill(pid, 'SIGKILL') } catch {}
    return
  }
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
    killer.once('error', resolve)
    killer.once('close', resolve)
  })
}

async function listDescendants(rootPid, { cwd, env } = {}) {
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
      '$result -join \',\'',
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

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function startMain({ env, cwd }) {
  const proc = startBridgeRun({
    installed: INSTALLED,
    home: env.BILIBILI_SKILL_HOME,
    statePath: env.BILIBILI_BRIDGE_STATE,
    ownerUids: env.BILIBILI_OWNER_UID,
    url: env.CC_CONNECT_BRIDGE_URL,
    pollMs: env.BILIBILI_POLL_MS,
    token: env.CC_CONNECT_BRIDGE_TOKEN,
    cwd,
    extraEnv: env,
  })
  const lockPid = () => {
    try { return JSON.parse(readFileSync(env.BILIBILI_BRIDGE_STATE + '.lock', 'utf8')).pid } catch { return null }
  }
  const registeredPid = () => proc.events.find((event) => event.type === 'registered' && Number.isSafeInteger(event.pid))?.pid ?? null
  const wrapper = {
    ...proc,
    stdout: proc.stdoutLines,
    stderr: proc.stderrLines,
    pid: () => registeredPid() ?? lockPid() ?? proc.child.pid,
    waitEvent: (type, timeout = 15000) => proc.waitType(type, { timeout }),
    waitStderr: (pattern, timeout = 15000) => proc.waitStderr(pattern, timeout),
    write: (text) => proc.write(text),
    stopStdin: () => proc.stopStdin(),
    kill: () => proc.kill(),
    alive: () => proc.alive(),
  }
  LIVE_PROCESSES.add(wrapper)
  return wrapper
}

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}

async function runProcess(command, args, { cwd, env, timeout = 20000 } = {}) {
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

// 最小 RFC6455 服务：只完成握手、解析客户端帧、回 register_ack 和模拟断线。
// 不发送 message/reply，也不伪造任何 B 站收发的成功结果。
class MiniWsServer {
  constructor({ autoAck = true } = {}) {
    this.autoAck = autoAck
    this.connections = new Set()
    this.frames = []
    this.registerCount = 0
    this.messageFrames = []
    this.accepting = true
    this.server = createServer((request, response) => {
      response.writeHead(426, { 'content-type': 'text/plain' })
      response.end('websocket required')
    })
    this.server.on('upgrade', (request, socket) => this.#accept(request, socket))
  }

  async listen() {
    LIVE_SERVERS.add(this)
    await new Promise((resolveListen, rejectListen) => {
      this.server.once('error', rejectListen)
      this.server.listen(0, '127.0.0.1', resolveListen)
    })
    this.port = this.server.address().port
    this.url = 'ws://127.0.0.1:' + this.port + '/bridge/ws'
    return this.url
  }

  #accept(request, socket) {
    if (!this.accepting) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    const key = request.headers['sec-websocket-key']
    if (!key) {
      socket.destroy()
      return
    }
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n')
    const connection = {
      socket,
      buffer: Buffer.alloc(0),
      closed: false,
      registered: false,
      acked: false,
    }
    this.connections.add(connection)
    socket.on('data', (chunk) => {
      connection.buffer = Buffer.concat([connection.buffer, chunk])
      this.#drain(connection)
    })
    socket.on('close', () => {
      connection.closed = true
      this.connections.delete(connection)
    })
    socket.on('error', () => {})
  }

  #drain(connection) {
    while (!connection.closed) {
      const buffer = connection.buffer
      if (buffer.length < 2) return
      const first = buffer[0]
      const second = buffer[1]
      const fin = (first & 0x80) !== 0
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let offset = 2
      if (length === 126) {
        if (buffer.length < 4) return
        length = buffer.readUInt16BE(2)
        offset = 4
      } else if (length === 127) {
        if (buffer.length < 10) return
        const big = buffer.readBigUInt64BE(2)
        if (big > 1_000_000n) {
          connection.socket.destroy()
          connection.closed = true
          return
        }
        length = Number(big)
        offset = 10
      }
      let mask = null
      if (masked) {
        if (buffer.length < offset + 4) return
        mask = buffer.subarray(offset, offset + 4)
        offset += 4
      }
      if (buffer.length < offset + length) return
      const payload = Buffer.from(buffer.subarray(offset, offset + length))
      if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
      connection.buffer = buffer.subarray(offset + length)
      if (!fin) continue // 本测试的客户端指令都是单帧。
      this.#handleFrame(connection, opcode, payload)
    }
  }

  #handleFrame(connection, opcode, payload) {
    if (opcode === 0x1) {
      let message
      try {
        message = JSON.parse(payload.toString('utf8'))
      } catch {
        return
      }
      this.frames.push(message)
      if (message.type === 'register') {
        this.registerCount += 1
        connection.registered = true
        if (this.autoAck) this.ack(connection)
      } else if (message.type === 'message' || message.type === 'reply') {
        this.messageFrames.push(message)
      }
      return
    }
    if (opcode === 0x8) {
      this.#send(connection, 0x8, payload)
      connection.socket.end()
      return
    }
    if (opcode === 0x9) this.#send(connection, 0xa, payload)
  }

  #send(connection, opcode, payload) {
    if (connection.closed || connection.socket.destroyed) return
    let header
    if (payload.length < 126) {
      header = Buffer.from([0x80 | opcode, payload.length])
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 126
      header.writeUInt16BE(payload.length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 127
      header.writeBigUInt64BE(BigInt(payload.length), 2)
    }
    connection.socket.write(Buffer.concat([header, payload]))
  }

  ack(connection) {
    if (!connection || connection.closed || connection.acked) return
    connection.acked = true
    this.#send(connection, 0x1, Buffer.from(JSON.stringify({ type: 'register_ack', ok: true })))
  }

  ackAll() {
    for (const connection of this.connections) {
      if (connection.registered) this.ack(connection)
    }
  }

  disconnectAll() {
    for (const connection of this.connections) {
      connection.closed = true
      connection.socket.destroy()
    }
    this.connections.clear()
  }

  async waitForRegister(count, timeout = 20000) {
    await waitFor(() => this.registerCount >= count, { timeout, message: '未收到第 ' + count + ' 次 register' })
  }

  async close() {
    this.accepting = false
    this.disconnectAll()
    try { this.server.closeAllConnections?.() } catch {}
    this.server.unref?.()
    await new Promise((resolveClose) => {
      let done = false
      const finish = () => { if (done) return; done = true; resolveClose() }
      try { this.server.close(finish) } catch { finish() }
      setTimeout(finish, 1000).unref?.()
    })
    LIVE_SERVERS.delete(this)
  }
}

async function makeBaseEnv(providedEnv) {
  const provided = providedEnv && Object.keys(providedEnv).length > 0
  const base = provided ? { ...providedEnv } : { ...process.env }
  if (!provided || !base.BILIBILI_SKILL_HOME) {
    // 独立运行或调用方未提供隔离目录时，强制使用全新的空状态目录，绝不回落到真实凭证目录。
    base.BILIBILI_SKILL_HOME = await mkdtemp(join(tmpdir(), 'bilibili-bridge-lifecycle-home-'))
  }
  for (const key of ['PATH', 'Path', 'path']) {
    if (!base[key] && process.env[key]) base[key] = process.env[key]
  }
  if (!base.ComSpec) base.ComSpec = process.env.ComSpec || (IS_WINDOWS ? 'cmd.exe' : '')
  base.CC_CONNECT_BRIDGE_TOKEN = TEST_TOKEN
  base.BILIBILI_OWNER_UID = TEST_OWNER_UID
  base.BILIBILI_POLL_MS = '6000'
  base.BILIBILI_BRIDGE_DEBUG = '1'
  // 测试绝不触发真实写；本地 WS 也不会发送 reply。
  base.BILIBILI_BRIDGE_DRY_RUN = 'true'
  base.BILIBILI_CLI_COMMAND = 'bilibili'
  base.NODE_OPTIONS = ''
  base.NODE_PATH = ''
  return base
}

function envCase(baseEnv, overrides) {
  return { ...baseEnv, ...overrides }
}

async function assertJsonlEvents(proc) {
  for (const line of proc.stdout) {
    const event = parseEvent(line)
    assert.ok(event, 'stdout 必须只有 JSON 对象行：' + line)
    assert.ok(['registered', 'ready', 'stopped', 'error'].includes(event.type), '未知 stdout 事件类型：' + line)
  }
}

async function assertNoTempStateFiles(statePath) {
  const dir = dirname(statePath)
  const prefix = '.' + statePath.split(/[\\/]/).pop() + '.'
  if (!existsSync(dir)) return
  const files = await readdir(dir)
  assert.deepEqual(files.filter((name) => name.startsWith(prefix) && name.endsWith('.tmp')), [], '残留原子写临时文件')
}

export async function runLifecycleTests({ env: providedEnv, cwd, throwOnFailure = true, filter = null } = {}) {
  const baseEnv = await makeBaseEnv(providedEnv)
  const workDir = cwd || process.cwd()
  const results = []
  const run = async (name, fn) => {
    if (filter && !name.includes(filter)) {
      results.push({ name, status: 'skipped' })
      return
    }
    process.stderr.write('[lifecycle] 开始：' + name + '\n')
    try {
      await fn()
      results.push({ name, status: 'passed' })
      process.stderr.write('[lifecycle] 通过：' + name + '\n')
    } catch (error) {
      results.push({ name, status: 'failed', error: error?.stack || error?.message || String(error) })
      process.stderr.write('[lifecycle] 失败：' + name + '：' + (error?.message || error) + '\n')
    }
  }

  await run('预检：真实安装的 bilibili CLI 可执行', async () => {
    const env = envCase(baseEnv, {})
    const command = IS_WINDOWS ? (env.ComSpec || 'cmd.exe') : 'bilibili'
    const args = IS_WINDOWS ? ['/d', '/s', '/c', 'bilibili --version'] : ['--version']
    const result = await runProcess(command, args, { cwd: workDir, env })
    assert.equal(result.timedOut, undefined, 'bilibili --version 超时')
    assert.equal(result.code, 0, 'bilibili --version 失败：' + result.stderr)
    assert.match(result.stdout, /\d+\.\d+/, 'bilibili --version 输出缺少版本号')
  })

  await run('坏状态文件：报错退出且不改写原文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-state-'))
    const statePath = join(dir, 'state.json')
    const corrupt = '{"seen": ['
    await writeFile(statePath, corrupt, 'utf8')
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
      }),
    })
    try {
      const exit = await withTimeout(proc.exited, 15000, '坏状态进程未退出')
      assert.equal(exit.code, 2, '坏状态应以 exit 2 失败')
      const error = await proc.waitEvent('error', 1000)
      assert.equal(error.stage, 'state')
      assert.equal(error.code, 'STATE_CORRUPT')
      assert.equal(await readFile(statePath, 'utf8'), corrupt, '坏状态文件被改写')
      assert.equal(existsSync(statePath + '.lock'), false, '坏状态不应创建锁')
      assert.equal(proc.events.some((event) => event.type === 'registered' || event.type === 'ready'), false)
      await assertJsonlEvents(proc)
    } finally {
      await proc.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('坏的有效 JSON：version/seen/pending 结构错误时 fail closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-schema-'))
    const statePath = join(dir, 'state.json')
    const variants = [
      {
        label: 'pending 缺字段',
        text: JSON.stringify({ version: 1, conversations: {}, seen: [], pending: [{ id: 'dm:1' }] }),
      },
      {
        label: '未知 version',
        text: JSON.stringify({ version: 2, conversations: {}, seen: [], pending: [] }),
      },
      {
        label: 'seen 对象缺 id',
        text: JSON.stringify({ seen: [{ at: '2026-10-21T00:00:00.000Z' }] }),
      },
      { label: '顶层 null', text: 'null' },
      { label: '顶层数组', text: '[]' },
      { label: '顶层数字', text: '42' },
      { label: '顶层字符串', text: JSON.stringify('string') },
    ]
    try {
      for (const variant of variants) {
        await writeFile(statePath, variant.text, 'utf8')
        const proc = startMain({
          cwd: workDir,
          env: envCase(baseEnv, {
            BILIBILI_BRIDGE_STATE: statePath,
            CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
          }),
        })
        try {
          const exit = await withTimeout(proc.exited, 15000, variant.label + ' 进程未退出')
          assert.equal(exit.code, 2, variant.label + ' 应以 exit 2 失败')
          const error = await proc.waitEvent('error', 1000)
          assert.equal(error.stage, 'state', variant.label + ' 应报告 state 错误')
          assert.equal(error.code, 'STATE_CORRUPT', variant.label + ' 应报告 STATE_CORRUPT')
          assert.equal(await readFile(statePath, 'utf8'), variant.text, variant.label + ' 不应改写原文件')
          assert.equal(existsSync(statePath + '.lock'), false, variant.label + ' 不应创建锁')
          await assertJsonlEvents(proc)
        } finally {
          await proc.kill()
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('单实例：同 statePath 第二个进程被拒绝，退出后释放锁', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-single-'))
    const statePath = join(dir, 'state.json')
    const env = envCase(baseEnv, {
      BILIBILI_BRIDGE_STATE: statePath,
      CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
    })
    const first = startMain({ cwd: workDir, env })
    let second = null
    try {
      await waitFor(async () => {
        const lock = await readJson(statePath + '.lock')
        return lock && lock.pid === first.pid()
      }, { timeout: 10000, message: '首个实例未创建锁' })
      second = startMain({ cwd: workDir, env })
      const secondExit = await withTimeout(second.exited, 10000, '第二个实例未退出')
      assert.equal(secondExit.code, 2, '第二个实例应以 exit 2 失败')
      assert.equal(second.events.find((event) => event.type === 'error')?.code, 'ALREADY_RUNNING')
      assert.equal(first.alive(), true, '第二个实例不应影响首个实例')
      const lock = await readJson(statePath + '.lock')
      assert.equal(lock.pid, first.pid())

      const firstExit = await first.stopStdin()
      assert.equal(firstExit.code, 0)
      assert.equal(first.events.find((event) => event.type === 'stopped')?.reason, 'stdin')
      await waitFor(() => !existsSync(statePath + '.lock'), { timeout: 5000, message: '进程退出后锁未释放' })
      await assertJsonlEvents(first)
      await assertJsonlEvents(second)
    } finally {
      await first.kill()
      await second?.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('stale 锁：dead pid 可回收并重建', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-stale-'))
    const statePath = join(dir, 'state.json')
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    const deadPid = dead.pid
    await new Promise((resolveExit) => dead.once('exit', resolveExit))
    await writeFile(statePath + '.lock', JSON.stringify({
      pid: deadPid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      token: 'stale-token',
    }) + '\n', 'utf8')
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
      }),
    })
    try {
      await waitFor(async () => {
        const lock = await readJson(statePath + '.lock')
        return lock && lock.pid === proc.pid() && lock.token !== 'stale-token'
      }, { timeout: 10000, message: 'stale 锁未被回收' })
      assert.equal(proc.alive(), true)
      const exit = await proc.stopStdin()
      assert.equal(exit.code, 0)
      await waitFor(() => !existsSync(statePath + '.lock'), { timeout: 5000, message: '退出后锁未释放' })
    } finally {
      await proc.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('真实 main 强杀后重启：stale 锁恢复', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-kill-restart-'))
    const statePath = join(dir, 'state.json')
    const env = envCase(baseEnv, {
      BILIBILI_BRIDGE_STATE: statePath,
      CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
    })
    const first = startMain({ cwd: workDir, env })
    let second = null
    try {
      await waitFor(async () => {
        const lock = await readJson(statePath + '.lock')
        return lock && lock.pid === first.pid()
      }, { timeout: 10000, message: '首个实例未创建锁' })
      const stale = await readJson(statePath + '.lock')
      assert.ok(stale && stale.token, '缺少可核对的锁 token')

      // 强杀进程树，绕过 SIGINT/SIGTERM/stdin stop 的清理路径，模拟真实崩溃。
      await first.kill()
      await first.exited
      assert.equal(existsSync(statePath + '.lock'), true, '强杀后应保留 stale 锁')
      const leftover = await readJson(statePath + '.lock')
      assert.equal(leftover.pid, first.pid(), 'stale 锁 pid 不是被强杀的实例')
      assert.equal(leftover.token, stale.token)
      let alive = true
      try { process.kill(first.pid(), 0) } catch { alive = false }
      assert.equal(alive, false, '被强杀的 main 仍存活')

      second = startMain({ cwd: workDir, env })
      await waitFor(async () => {
        const lock = await readJson(statePath + '.lock')
        return lock && lock.pid === second.pid() && lock.token !== stale.token
      }, { timeout: 10000, message: '重启后未回收 stale 锁' })
      assert.equal(second.alive(), true, '重启实例未存活')
      const exit = await second.stopStdin()
      assert.equal(exit.code, 0)
      await waitFor(() => !existsSync(statePath + '.lock'), { timeout: 5000, message: '重启实例退出后锁未释放' })
      await assertJsonlEvents(second)
    } finally {
      await first.kill()
      await second?.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('损坏锁：fail closed，不自动删除', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-badlock-'))
    const statePath = join(dir, 'state.json')
    const lockPath = statePath + '.lock'
    const corruptLock = 'not a lock file'
    await writeFile(lockPath, corruptLock, 'utf8')
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
      }),
    })
    try {
      const exit = await withTimeout(proc.exited, 10000, '损坏锁进程未退出')
      assert.equal(exit.code, 2)
      const error = await proc.waitEvent('error', 1000)
      assert.equal(error.stage, 'lock')
      assert.equal(error.code, 'LOCK_UNREADABLE')
      assert.equal(await readFile(lockPath, 'utf8'), corruptLock, '损坏锁被自动删除或改写')
    } finally {
      await proc.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('不可达 WS：无 registered/ready，stdin stop 优雅退出', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-unreachable-'))
    const statePath = join(dir, 'state.json')
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
      }),
    })
    try {
      await sleep(1500)
      assert.equal(proc.events.some((event) => event.type === 'registered' || event.type === 'ready'), false)
      assert.equal(countMatch(proc.stderr, /poller started/), 0)
      await proc.waitStderr(/bridge connection failed/, 5000)
      const exit = await proc.stopStdin()
      assert.equal(exit.code, 0)
      const stopped = await proc.waitEvent('stopped', 1000)
      assert.equal(stopped.reason, 'stdin')
      assert.equal(stopped.code, 0)
      assert.equal(existsSync(statePath + '.lock'), false)
      await assertJsonlEvents(proc)
    } finally {
      await proc.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('延迟 register_ack：ack 前零 registered / 零 poller / 零 backend 读', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-delayed-ack-'))
    const statePath = join(dir, 'state.json')
    const server = new MiniWsServer({ autoAck: false })
    await server.listen()
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: server.url,
      }),
    })
    try {
      await server.waitForRegister(1, 15000)
      await sleep(1200)
      assert.equal(proc.events.some((event) => event.type === 'registered'), false, 'ack 前不应发 registered')
      assert.equal(proc.events.some((event) => event.type === 'ready'), false, 'ack 前不应发 ready')
      assert.equal(countMatch(proc.stderr, /poller started/), 0, 'ack 前不应启动 poller')
      assert.equal(countMatch(proc.stderr, /poll failed uid=424242/), 0, 'ack 前不应读取 backend（真实 CLI 未登录失败）')
      assert.equal(proc.alive(), true, '等待 ack 时 main 不应退出')

      server.ackAll()
      await proc.waitEvent('registered', 10000)
      await proc.waitStderr(/poller started/, 5000)
      await proc.waitStderr(/poll failed uid=424242/, 20000)
      assert.equal(countMatch(proc.stderr, /poller started/), 1)
      const exit = await proc.stopStdin()
      assert.equal(exit.code, 0)
      await assertJsonlEvents(proc)
    } finally {
      await proc.kill()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('stdin 重复 stop：一次退出且只发一个 stopped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-double-stop-'))
    const statePath = join(dir, 'state.json')
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
      }),
    })
    try {
      await waitFor(async () => {
        const lock = await readJson(statePath + '.lock')
        return lock && lock.pid === proc.pid()
      }, { timeout: 10000, message: 'main 未完成初始化' })
      // 两行同时提交：第二个 stop 必须被幂等忽略，不能产生第二个 stopped/error。
      await proc.write(JSON.stringify({ type: 'stop' }) + '\n' + JSON.stringify({ type: 'stop' }) + '\n').catch(() => {})
      const exit = await withTimeout(proc.exited, 10000, '重复 stop 后进程未退出')
      assert.equal(exit.code, 0)
      await sleep(250)
      assert.equal(proc.events.filter((event) => event.type === 'stopped').length, 1, '重复 stop 产生多个 stopped')
      assert.equal(proc.events.filter((event) => event.type === 'error').length, 0, '重复 stop 不应报 error')
      assert.equal(proc.events.find((event) => event.type === 'stopped')?.reason, 'stdin')
      assert.equal(existsSync(statePath + '.lock'), false, '退出后锁未释放')
      await assertJsonlEvents(proc)
    } finally {
      await proc.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('register_ack 后才启动一次 poller；断线暂停，重连恢复', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-ws-'))
    const statePath = join(dir, 'state.json')
    const server = new MiniWsServer()
    await server.listen()
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: server.url,
      }),
    })
    try {
      await server.waitForRegister(1, 15000)
      await proc.waitEvent('registered', 10000)
      assert.equal(proc.events.some((event) => event.type === 'ready'), false, '离线未建立 baseline 时不应伪造 ready')
      await proc.waitStderr(/poller started/, 5000)
      assert.equal(countMatch(proc.stderr, /poller started/), 1)

      // 真实 installed CLI 在隔离目录下执行 dm read；未登录会失败，绝对不是模拟 B 站成功。
      // main 不再输出 /poll attempt/ 调试日志，改为观察真实 CLI 的 AUTH 失败计数。
      const pollFailure = await proc.waitStderr(/poll failed uid=424242/, 20000)
      assert.match(
        pollFailure,
        /未登录|AUTH/,
        '应看到真实 CLI 的未登录错误，而不是模拟成功；stderr 尾部：' + proc.stderr.slice(-8).join(' | '),
      )
      assert.equal(proc.alive(), true, '轮询失败不应导致进程退出')
      assert.equal(server.messageFrames.length, 0, '不应向本地 WS 伪造 B 站消息')

      server.accepting = false
      server.disconnectAll()
      await proc.waitStderr(/poller paused/, 10000)
      const failuresAfterPause = countMatch(proc.stderr, /poll failed uid=424242/)
      await sleep(7000)
      assert.equal(countMatch(proc.stderr, /poll failed uid=424242/), failuresAfterPause, '断线后仍发起 backend 轮询')

      server.accepting = true
      await server.waitForRegister(2, 25000)
      await proc.waitStderr(/poller resumed/, 10000)
      await waitFor(() => countMatch(proc.stderr, /poll failed uid=424242/) > failuresAfterPause, {
        timeout: 20000,
        interval: 250,
        message: '重连后未继续真实 CLI 轮询',
      })
      assert.equal(countMatch(proc.stderr, /poller started/), 1, '重连不应再次启动 poller')
      assert.equal(proc.events.filter((event) => event.type === 'registered').length, 1, 'registered 只应发一次')
      assert.equal(server.messageFrames.length, 0, '不应向本地 WS 伪造 B 站消息')

      const exit = await proc.stopStdin()
      assert.equal(exit.code, 0)
      const stopped = await proc.waitEvent('stopped', 1000)
      assert.equal(stopped.reason, 'stdin')
      assert.equal(server.messageFrames.length, 0)
      await assertJsonlEvents(proc)
    } finally {
      await proc.kill()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('main 优雅停止后 backend CLI 子进程退出（OS 进程树）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-child-exit-'))
    const statePath = join(dir, 'state.json')
    const server = new MiniWsServer()
    await server.listen()
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: server.url,
      }),
    })
    try {
      await server.waitForRegister(1, 15000)
      await proc.waitEvent('registered', 10000)
      const rootPid = proc.pid() // registered 中的真实 Node PID，不是 Windows cmd 启动器。
      await proc.waitStderr(/poll failed/, 20000)
      const before = await listDescendants(rootPid, { cwd: workDir, env: baseEnv })
      assert.ok(before.length > 0, '未观察到 backend CLI 子进程，无法证明清理；进程树读取结果为空')

      const exit = await proc.stopStdin()
      assert.equal(exit.code, 0)
      // 先在 main 存活时记录后代 PID，再逐个验证退出；POSIX 上 main 死后子进程会被
      // reparent，不能只靠“从 root 再遍历一次”判断，否则会误绿。
      await waitFor(() => before.every((pid) => !isPidAlive(pid)), {
        timeout: 8000,
        interval: 300,
        message: 'main 退出后仍残留 CLI 子进程：' + before.filter((pid) => isPidAlive(pid)).join(','),
      })
      const remaining = await listDescendants(rootPid, { cwd: workDir, env: baseEnv })
      assert.equal(remaining.length, 0, 'main 退出后仍能从进程树看到 CLI 后代')
    } finally {
      await proc.kill()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('已有 baseline 状态：registered 后发 ready，标明 baselineReady', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-ready-'))
    const statePath = join(dir, 'state.json')
    await writeFile(statePath, JSON.stringify({
      version: 1,
      conversations: {
        [TEST_OWNER_UID]: {
          baseline: { seqno: null, timestamp: null, key: null, empty: true, at: '2026-10-21T00:00:00.000Z' },
          cursor: { seqno: null, timestamp: null, key: null, empty: true },
        },
      },
      seen: [],
      pending: [],
    }) + '\n', 'utf8')
    const server = new MiniWsServer()
    await server.listen()
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: server.url,
      }),
    })
    try {
      await proc.waitEvent('registered', 15000)
      const ready = await proc.waitEvent('ready', 10000)
      assert.equal(ready.baselineReady, true)
      assert.equal(ready.registered, true)
      assert.ok(proc.events.findIndex((event) => event.type === 'registered') < proc.events.findIndex((event) => event.type === 'ready'))
      await proc.stopStdin()
      await assertJsonlEvents(proc)
    } finally {
      await proc.kill()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('ready 负向：顶层 baseline/baselineReady 不得触发 ready', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-ready-negative-'))
    const statePath = join(dir, 'state.json')
    await writeFile(statePath, JSON.stringify({
      seen: [],
      baseline: { seqno: '1', timestamp: 1700000000000, key: 'fake', empty: false },
      baselineReady: true,
    }) + '\n', 'utf8')
    const server = new MiniWsServer()
    await server.listen()
    const proc = startMain({
      cwd: workDir,
      env: envCase(baseEnv, {
        BILIBILI_BRIDGE_STATE: statePath,
        CC_CONNECT_BRIDGE_URL: server.url,
      }),
    })
    try {
      await proc.waitEvent('registered', 15000)
      await sleep(1500)
      assert.equal(proc.events.some((event) => event.type === 'ready'), false, '顶层 baseline/baselineReady 不应被当成 adapter 的 conversations baseline')
      await proc.stopStdin()
      await assertJsonlEvents(proc)
    } finally {
      await proc.kill()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('持久化（child 驱动）：原子写、失败不改写、无临时残留', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-atomic-'))
    const statePath = join(dir, '状态 目录', 'state.json')
    const childCode = [
      "import { readFile } from 'node:fs/promises'",
      'import { createStateStore } from ' + JSON.stringify(STATE_MODULE),
      'const statePath = ' + JSON.stringify(statePath),
      'const owner = ' + JSON.stringify(TEST_OWNER_UID),
      'const store = createStateStore(statePath)',
      'await store.load()',
      'const writes = Array.from({ length: 20 }, (_, index) => store.save({',
      '  version: 1,',
      '  conversations: {',
      '    [owner]: {',
      "      baseline: { seqno: null, timestamp: null, key: null, empty: true, at: '2026-10-21T00:00:00.000Z' },",
      "      cursor: { seqno: null, timestamp: null, key: null, empty: true },",
      '    },',
      '  },',
      "  seen: [{ id: 'id-' + index, at: '2026-10-21T00:00:00.000Z' }],",
      '  pending: index === 19 ? [{',
      "    id: 'dm:' + owner + ':mk:1',",
      '    uid: owner,',
      "    name: 'owner',",
      "    content: 'hello',",
      "    seqno: '1',",
      '    timestamp: 1700000000000,',
      "    key: '1',",
      '    skipReason: null,',
      "    created_at: '2026-10-21T00:00:00.000Z',",
      '  }] : [],',
      '}))',
      'await Promise.all(writes)',
      'const before = await readFile(statePath, "utf8")',
      'let invalidError = null',
      'try { await store.save({ seen: "not-an-array" }) } catch (error) { invalidError = error.code }',
      'const after = await readFile(statePath, "utf8")',
      'console.log(JSON.stringify({ invalidError, unchanged: before === after }))',
    ].join('\n')
    try {
      const result = await runProcess(process.execPath, ['--input-type=module', '-e', childCode], {
        cwd: workDir,
        env: baseEnv,
        timeout: 30000,
      })
      assert.equal(result.timedOut, undefined, 'child 原子写测试超时')
      assert.equal(result.code, 0, 'child 原子写测试失败：' + result.stderr)
      const payload = JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1))
      assert.equal(payload.invalidError, 'STATE_CORRUPT')
      assert.equal(payload.unchanged, true, '非法 state 不应改写现有文件')

      const saved = JSON.parse(await readFile(statePath, 'utf8'))
      assert.equal(saved.seen[0].id, 'id-19', '并发保存必须按调用顺序落盘')
      assert.equal(saved.version, 1)
      assert.equal(saved.pending[0].id, 'dm:424242:mk:1', '完整 pending 字段必须通过严格校验')
      assert.equal(saved.pending[0].content, 'hello')
      await assertNoTempStateFiles(statePath)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  const runCli = (args, env) => runBilibili(args, { installed: INSTALLED, home: env.BILIBILI_SKILL_HOME, env, cwd: workDir })
  const statusOf = (env) => runCli(['bridge', 'status', '--state-path', env.BILIBILI_BRIDGE_STATE, '--json'], env)
  const stopOf = (env) => runCli(['bridge', 'stop', '--state-path', env.BILIBILI_BRIDGE_STATE, '--json'], env)

  await run('bridge status/stop 控制：同实例、token 不泄漏、幂等', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-control-'))
    const statePath = join(dir, 'state.json')
    const server = new MiniWsServer()
    await server.listen()
    const env = envCase(baseEnv, { BILIBILI_BRIDGE_STATE: statePath, CC_CONNECT_BRIDGE_URL: server.url })
    const proc = startMain({ cwd: workDir, env })
    try {
      await proc.waitEvent('registered', 15000)
      const status = await statusOf(env)
      assert.equal(status.code, 0, status.stderr)
      assert.equal(status.envelope.ok, true)
      assert.equal(status.envelope.result.running, true)
      assert.equal(status.envelope.result.pid, proc.pid(), 'status.pid 必须是真实 bridge 进程')
      assert.equal(resolve(status.envelope.result.statePath), resolve(statePath))
      assert.equal(proc.stdout.join('\n').includes(TEST_TOKEN), false, 'run stdout 泄漏 token')
      assert.equal(proc.stderr.join('\n').includes(TEST_TOKEN), false, 'run stderr 泄漏 token')

      const stopped = await stopOf(env)
      assert.equal(stopped.code, 0, stopped.stderr)
      assert.equal(stopped.envelope.ok, true)
      assert.deepEqual(stopped.envelope.result, { running: false, stopped: true, statePath: resolve(statePath) })
      const exit = await withTimeout(proc.exited, 15000, 'CLI stop 后 bridge 未退出')
      assert.equal(exit.code, 0)
      const stoppedEvent = await proc.waitEvent('stopped', 5000)
      assert.equal(stoppedEvent.reason, 'control')
      assert.equal(stoppedEvent.code, 0)
      await waitFor(() => !existsSync(statePath + '.lock'), { timeout: 5000, message: 'stop 后锁未释放' })
      assert.equal(existsSync(statePath + '.stop'), false, 'stop marker 应被清理')
      await assertJsonlEvents(proc)

      const again = await stopOf(env)
      assert.equal(again.code, 0)
      assert.deepEqual(again.envelope.result, { running: false, stopped: true, statePath: resolve(statePath) })
      const after = await statusOf(env)
      assert.equal(after.code, 0)
      assert.equal(after.envelope.result.running, false)
    } finally {
      await proc.kill()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('bridge stop：错误 token 标记不能停当前实例', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-wrong-token-'))
    const statePath = join(dir, 'state.json')
    const server = new MiniWsServer()
    await server.listen()
    const env = envCase(baseEnv, { BILIBILI_BRIDGE_STATE: statePath, CC_CONNECT_BRIDGE_URL: server.url })
    const proc = startMain({ cwd: workDir, env })
    try {
      const lock = await waitFor(async () => readJson(statePath + '.lock'), { timeout: 10000, message: '实例未创建锁' })
      await writeFile(statePath + '.stop', JSON.stringify({ pid: lock.pid, token: 'wrong-token', requestedAt: new Date().toISOString() }) + '\n', 'utf8')
      await sleep(1200)
      assert.equal(proc.alive(), true, '错误 token 的 marker 不应停止实例')
      assert.equal(proc.events.some((event) => event.type === 'stopped'), false, '错误 token 不应触发 stopped')
      assert.equal(existsSync(statePath + '.stop'), true, '不匹配的 marker 不应被主循环删除')

      const stopped = await stopOf(env)
      assert.equal(stopped.code, 0, stopped.stderr)
      assert.equal(stopped.envelope.result.stopped, true)
      await proc.waitEvent('stopped', 15000)
      assert.equal(proc.events.find((event) => event.type === 'stopped')?.reason, 'control')
      assert.equal(existsSync(statePath + '.lock'), false)
    } finally {
      await proc.kill()
      await server.close()
      await rm(dir, { recursive: true, force: true })
    }
  })

  await run('并发恢复同一 stale 锁：最多一个实例存活', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bilibili-lifecycle-concurrent-stale-'))
    const statePath = join(dir, 'state.json')
    const dead = spawn(process.execPath, ['-e', ''], { stdio: 'ignore', windowsHide: true })
    const deadPid = dead.pid
    await new Promise((resolveExit) => dead.once('exit', resolveExit))
    await writeFile(statePath + '.lock', JSON.stringify({
      pid: deadPid,
      host: hostname(),
      startedAt: new Date().toISOString(),
      token: 'stale-token',
    }) + '\n', 'utf8')
    const env = envCase(baseEnv, { BILIBILI_BRIDGE_STATE: statePath, CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws' })
    const a = startMain({ cwd: workDir, env })
    const b = startMain({ cwd: workDir, env })
    try {
      await sleep(6000)
      const alive = [a, b].filter((proc) => proc.alive())
      assert.equal(alive.length, 1, '并发恢复同一 stale 锁后应恰好一个实例存活；实际存活 ' + alive.length + ' 个（TOCTOU 双实例是缺陷）')
      const lock = await readJson(statePath + '.lock')
      assert.equal(lock.pid, alive[0].pid(), '存活实例必须持有锁')
      for (const loser of [a, b].filter((proc) => !proc.alive())) {
        const info = await loser.exited
        assert.equal(info.code, 2, '失败实例应以配置/锁错误退出')
        assert.equal(loser.events.find((event) => event.type === 'error')?.code, 'ALREADY_RUNNING')
      }
      const exit = await alive[0].stopStdin()
      assert.equal(exit.code, 0)
      await waitFor(() => !existsSync(statePath + '.lock'), { timeout: 5000, message: '存活实例退出后锁未释放' })
    } finally {
      await a.kill()
      await b.kill()
      await rm(dir, { recursive: true, force: true })
    }
  })

  // 资源兜底：所有 case 的 finally 应已清理；这里再次保证测试进程自然退出，
  // 不残留监听 server、bridge run 或其 CLI 子进程（不是用 process.exit 掩盖）。
  for (const proc of [...LIVE_PROCESSES]) {
    try { await proc.kill() } catch {}
    LIVE_PROCESSES.delete(proc)
  }
  for (const server of [...LIVE_SERVERS]) {
    try { await server.close() } catch {}
    LIVE_SERVERS.delete(server)
  }
  await sleep(250)

  const failed = results.filter((result) => result.status === 'failed')
  const skipped = results.filter((result) => result.status === 'skipped')
  const report = {
    ok: failed.length === 0,
    total: results.length,
    passed: results.filter((result) => result.status === 'passed').length,
    failed: failed.length,
    skipped: skipped.length,
    cases: results,
  }
  if (!report.ok && throwOnFailure) {
    const error = new Error('bridge 生命周期测试失败：' + failed.map((result) => result.name).join('；'))
    error.report = report
    throw error
  }
  return report
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const filterArg = process.argv.find((arg) => arg.startsWith('--filter='))
  const filter = filterArg ? filterArg.slice('--filter='.length) : null
  const report = await runLifecycleTests({ throwOnFailure: false, filter })
  process.stdout.write(JSON.stringify(report) + '\n')
  process.exitCode = report.ok ? 0 : 1
}