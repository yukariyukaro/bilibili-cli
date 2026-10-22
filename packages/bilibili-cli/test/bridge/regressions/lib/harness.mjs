import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBridgeRun } from '../../lib/bridge-run.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** skills/bilibili-cli/test/bridge/regressions/lib */
export const TEST_BRIDGE_DIR = resolve(HERE, '..', '..')
export const REGRESSIONS_DIR = resolve(HERE, '..')
export const REPO_ROOT = resolve(TEST_BRIDGE_DIR, '..', '..', '..')
export const IS_WINDOWS = process.platform === 'win32'
export const PATH_DELIMITER = IS_WINDOWS ? ';' : ':'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME_BYTES = 4 * 1024 * 1024

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

export function tail(text, limit = 1600) {
  const value = String(text ?? '')
  return value.length <= limit ? value : '…' + value.slice(-limit)
}

function realOrResolve(value) {
  try { return realpathSync(value) } catch { return resolve(value) }
}

function isInsideRepo(value) {
  const rel = relative(realOrResolve(REPO_ROOT), realOrResolve(value))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** 所有状态、home 和日志都在仓库外的显式工作目录；拒绝把仓库源码当安装产物/工作目录。 */
export function resolveWorkdir(env = process.env) {
  const configured = env.BILIBILI_E2E_WORKDIR || env.BILIBILI_BRIDGE_REGRESSIONS_WORKDIR
  if (configured) {
    const dir = resolve(configured)
    if (isInsideRepo(dir)) throw new Error('工作目录必须离开仓库：' + dir)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const dir = mkdtempSync(join(tmpdir(), 'bilibili-bridge-regressions-'))
  if (isInsideRepo(dir)) throw new Error('临时工作目录不能位于仓库内：' + dir)
  return dir
}

/**
 * 只认 lead 的统一安装前缀；不构建、不安装、不回落全局未知版本。
 * Windows: <prefix>\bilibili.cmd | <prefix>\bilibili.exe | <prefix>\node_modules\.bin\bilibili.cmd
 * POSIX:   <prefix>/bin/bilibili | <prefix>/node_modules/.bin/bilibili
 */
export function resolveInstalledPrefix(env = process.env) {
  const configured = env.BILIBILI_E2E_INSTALLED_PREFIX
  if (!configured) {
    return { ok: false, reason: '缺少 BILIBILI_E2E_INSTALLED_PREFIX（必须来自统一安装，不能用全局未知版本或仓库源码）' }
  }
  const prefix = resolve(configured)
  if (!existsSync(prefix)) return { ok: false, reason: '安装前缀不存在：' + prefix }
  if (isInsideRepo(prefix)) return { ok: false, reason: '安装前缀位于仓库内，不能作为安装产物验收：' + prefix }

  const candidates = IS_WINDOWS
    ? [join(prefix, 'bilibili.cmd'), join(prefix, 'bilibili.exe'), join(prefix, 'node_modules', '.bin', 'bilibili.cmd')]
    : [join(prefix, 'bin', 'bilibili'), join(prefix, 'node_modules', '.bin', 'bilibili')]
  const bin = candidates.find((candidate) => existsSync(candidate))
  if (!bin) return { ok: false, reason: '安装前缀中找不到 bilibili 入口；期望 ' + candidates.join(' 或 ') }

  const packageCandidates = [
    join(prefix, 'node_modules', '@yukariyukaro', 'bilibili-cli'),
    join(prefix, 'lib', 'node_modules', '@yukariyukaro', 'bilibili-cli'),
  ]
  const packageDir = packageCandidates.find((candidate) => existsSync(candidate))
  if (packageDir && isInsideRepo(packageDir)) {
    return { ok: false, reason: '安装前缀里的 @yukariyukaro/bilibili-cli 指向仓库源码（junction/symlink）：' + packageDir }
  }
  if (isInsideRepo(bin)) return { ok: false, reason: 'CLI 入口实际指向仓库源码：' + bin }

  return { ok: true, prefix, bin, binDir: dirname(bin) }
}

function stripRiskyEnv(baseEnv) {
  const env = { ...baseEnv }
  for (const key of [
    'BILIBILI_E2E_WRITE',
    'BILIBILI_E2E',
    'BILIBILI_E2E_READONLY',
    'NODE_OPTIONS',
    'NODE_PATH',
  ]) delete env[key]
  return env
}

/** 只用安装前缀的 PATH + 隔离状态目录；强制真实 CLI 命令名，避免外层环境注入另一实现。 */
export function buildChildEnv({ baseEnv = process.env, installed, home, statePath, port, token, ownerUid, pollMs = 6000 }) {
  if (!installed?.ok) throw new Error('buildChildEnv 需要已解析的安装前缀')
  const env = stripRiskyEnv(baseEnv)
  env.CC_CONNECT_BRIDGE_URL = 'ws://127.0.0.1:' + port + '/bridge/ws'
  env.CC_CONNECT_BRIDGE_TOKEN = token
  env.BILIBILI_OWNER_UID = String(ownerUid)
  env.BILIBILI_POLL_MS = String(pollMs)
  env.BILIBILI_BRIDGE_DRY_RUN = 'true'
  env.BILIBILI_BRIDGE_STATE = statePath
  env.BILIBILI_SKILL_HOME = home
  env.BILIBILI_BRIDGE_DEBUG = '1'
  env.BILIBILI_CLI_COMMAND = 'bilibili'
  const currentPath = env.PATH || env.Path || ''
  const merged = installed.binDir + PATH_DELIMITER + currentPath
  env.PATH = merged
  if (IS_WINDOWS) env.Path = merged
  return env
}

export function assertNoCredential(home) {
  for (const name of ['bili_credential.json', 'credential.json']) {
    const file = join(home, name)
    if (existsSync(file)) throw new Error('隔离状态目录出现凭证文件，拒绝继续（不读取/不打印）：' + file)
  }
}

export function freshCaseDir(workdir, name) {
  // 只创建全新唯一目录，绝不删除调用者指定的既有路径；workdir 必须是仓库外目录。
  mkdirSync(workdir, { recursive: true })
  const dir = mkdtempSync(join(workdir, name + '-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  assertNoCredential(home)
  return { dir, home, statePath: join(dir, 'state.json') }
}

// ---------------------------------------------------------------------------
// state v1 fixtures（本地生成，只用于验证恢复/队列语义；不是 B 站消息）
// ---------------------------------------------------------------------------

export function orderAt(uid, seqno, { at = null } = {}) {
  const key = 'dm:' + uid + ':mk:' + seqno
  return {
    seqno: String(seqno),
    timestamp: 1700000000 + seqno,
    key,
    empty: false,
    ...(at === null ? {} : { at }),
  }
}

export function pendingEntry({ uid, seqno, content }) {
  const key = 'dm:' + uid + ':mk:' + seqno
  return {
    id: key,
    uid: String(uid),
    name: 'regression',
    content,
    seqno: String(seqno),
    timestamp: 1700000000 + seqno,
    key,
    skipReason: null,
    created_at: '2026-10-21T00:00:00.000Z',
  }
}

export function writeState(statePath, { ownerUid, cursorSeqno, pending = [], seen = [] }) {
  const baseline = orderAt(ownerUid, cursorSeqno, { at: '2026-10-21T00:00:00.000Z' })
  const cursor = orderAt(ownerUid, cursorSeqno)
  delete cursor.at
  const state = {
    version: 1,
    conversations: { [String(ownerUid)]: { baseline, cursor } },
    seen,
    pending,
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
  return state
}

export function readState(statePath) {
  try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return null }
}

// ---------------------------------------------------------------------------
// 最小本地控制面 WebSocket 服务（cc-connect 协议子集；不连接 B 站）
// ---------------------------------------------------------------------------

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  let header
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length])
  } else if (body.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(body.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(body.length), 2)
  }
  return Buffer.concat([header, body])
}

export async function startWsServer({ token, path = '/bridge/ws' } = {}) {
  if (!token) throw new Error('startWsServer 需要 token')
  const events = []
  const waiters = new Set()
  const sockets = new Set()

  const notify = (event) => {
    events.push(event)
    for (const waiter of [...waiters]) {
      let matched = false
      try { matched = waiter.predicate(event) === true } catch { matched = false }
      if (!matched) continue
      waiters.delete(waiter)
      clearTimeout(waiter.timer)
      waiter.resolve(event)
    }
  }

  const server = createServer((_request, response) => {
    response.writeHead(426, { 'content-type': 'text/plain' })
    response.end('WebSocket upgrade required')
  })

  server.on('upgrade', (request, socket) => {
    let url
    try { url = new URL(request.url || '/', 'http://127.0.0.1') } catch { socket.destroy(); return }
    if (url.pathname !== path || url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    const key = request.headers['sec-websocket-key']
    if (!key) { socket.destroy(); return }
    const accept = createHash('sha1').update(String(key) + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n',
    )
    socket.setNoDelay(true)
    sockets.add(socket)

    const sendJson = (value) => {
      if (socket.destroyed) return
      try { socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(value), 'utf8'))) } catch { socket.destroy() }
    }

    let buffer = Buffer.alloc(0)
    const handleText = (text) => {
      let message
      try { message = JSON.parse(text) } catch { return }
      notify({ message, at: Date.now() })
      if (message?.type === 'register') sendJson({ type: 'register_ack', ok: true, platform: 'local-regression', capabilities: ['text'] })
      else if (message?.type === 'ping') sendJson({ type: 'pong', ts: Date.now() })
    }

    const parse = () => {
      while (!socket.destroyed) {
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
          if (big > BigInt(MAX_FRAME_BYTES)) { socket.destroy(); return }
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
        buffer = buffer.subarray(offset + length)
        if (mask) {
          for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
        }
        if (!fin) continue
        if (opcode === 0x1) handleText(payload.toString('utf8'))
        else if (opcode === 0x8) { socket.end(); return }
        else if (opcode === 0x9) { try { socket.write(encodeFrame(0xa, payload)) } catch { socket.destroy() } }
      }
    }

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      parse()
    })
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket) })
  })

  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => {
      server.off('error', onError)
      rejectListen(error)
    }
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError)
      resolveListen()
    })
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0

  return {
    url: 'ws://127.0.0.1:' + port + path,
    port,
    events,
    messages: () => events.filter((event) => event.message?.type === 'message').map((event) => event.message),
    hasEvent: (predicate) => events.some(predicate),
    waitFor(predicate, { timeout = 15000, description = '本地控制面事件' } = {}) {
      const existing = events.find(predicate)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolveWait, rejectWait) => {
        const waiter = {
          predicate,
          resolve: resolveWait,
          timer: setTimeout(() => {
            waiters.delete(waiter)
            rejectWait(new Error('等待' + description + '超时（' + timeout + 'ms）；已收到 ' + events.length + ' 个事件'))
          }, timeout),
        }
        waiters.add(waiter)
      })
    },
    async close() {
      for (const waiter of waiters) clearTimeout(waiter.timer)
      waiters.clear()
      for (const socket of sockets) {
        try { socket.destroy() } catch {}
      }
      sockets.clear()
      await new Promise((resolveClose) => {
        const timer = setTimeout(resolveClose, 2000)
        server.close(() => { clearTimeout(timer); resolveClose() })
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 真实安装产物 bridge run 子进程（PATH bilibili bridge run，不 spawn 旧 src/main.mjs）
// ---------------------------------------------------------------------------

export function startMain({ env, cwd, name = 'main' }) {
  const installed = resolveInstalledPrefix(env)
  if (!installed.ok) throw new Error(installed.reason)
  const proc = startBridgeRun({
    installed,
    home: env.BILIBILI_SKILL_HOME,
    statePath: env.BILIBILI_BRIDGE_STATE,
    ownerUids: env.BILIBILI_OWNER_UID,
    url: env.CC_CONNECT_BRIDGE_URL,
    pollMs: env.BILIBILI_POLL_MS,
    token: env.CC_CONNECT_BRIDGE_TOKEN,
    cwd,
    extraEnv: env,
  })
  return {
    name,
    child: proc.child,
    events: proc.events,
    exited: proc.exited,
    exitInfo: proc.exitInfo,
    stdout: () => proc.stdout(),
    stderr: () => proc.stderr(),
    output: () => proc.output(),
    async stop({ timeout = 8000 } = {}) {
      if (proc.exitInfo()) return proc.exitInfo()
      try { await proc.write(JSON.stringify({ type: 'stop' }) + '\n') } catch {}
      const graceful = await Promise.race([proc.exited.then(() => true), sleep(timeout).then(() => false)])
      if (!graceful) await proc.kill()
      else { try { proc.child.stdin.end() } catch {} }
      return proc.exitInfo()
    },
  }
}

// ---------------------------------------------------------------------------
// 安装前缀预检（离线 --version；不读写凭证）
// ---------------------------------------------------------------------------

export async function runInstalledCliVersion(installed, { baseEnv = process.env, cwd, timeout = 20000 } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'bilibili-bridge-regressions-preflight-'))
  const env = stripRiskyEnv(baseEnv)
  env.BILIBILI_SKILL_HOME = home
  const currentPath = env.PATH || env.Path || ''
  const merged = installed.binDir + PATH_DELIMITER + currentPath
  env.PATH = merged
  if (IS_WINDOWS) env.Path = merged
  const command = IS_WINDOWS ? (env.ComSpec || 'cmd.exe') : 'bilibili'
  const args = IS_WINDOWS ? ['/d', '/s', '/c', 'bilibili --version'] : ['--version']
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: IS_WINDOWS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      finish({ code: null, signal: null, stdout, stderr, timedOut: true })
    }, timeout)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', (error) => finish({ code: null, signal: null, stdout, stderr, error: error.message }))
    child.once('close', (code, signal) => finish({ code, signal, stdout, stderr }))
  })
}

export async function waitFor(check, { timeout = 15000, interval = 150, description = '条件' } = {}) {
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
  throw new Error('等待' + description + '超时（' + timeout + 'ms）' + (lastError ? '；最后一次错误：' + lastError.message : ''))
}

export function evidenceOf({ frames, stderr, state, extra = {} }) {
  return {
    frames: (frames || []).map((frame) => ({
      type: frame.type,
      msg_id: frame.msg_id,
      user_id: frame.user_id,
      content: frame.content,
    })),
    stderr: tail(stderr, 1600),
    ...(state ? { state } : {}),
    ...extra,
  }
}
