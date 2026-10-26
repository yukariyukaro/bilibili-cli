import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { once } from 'node:events'
import { errorCode, isPlainObject } from './guards.mjs'
import { resolveBridgeStatePath } from './state-path.mjs'
import { consoleHtml, consoleCss, consoleJs } from './web-assets.mjs'
import { ConsoleError, configRevision, nextScheduledRun, readConsoleConfig, scheduleSlot, writeConsoleConfig } from './web-config.mjs'
import { ConsoleSupervisor } from './web-supervisor.mjs'

export interface ConsoleArgs { port?: number; configPath?: string; statePath?: string }
export async function createConsoleServer(args: ConsoleArgs = {}, env: NodeJS.ProcessEnv = process.env, prepared?: ConsoleSupervisor) {
  const statePath = resolveBridgeStatePath(args.statePath, env)
  const configPath = args.configPath ? resolve(args.configPath) : join(dirname(statePath), 'console.json')
  if (configPath === statePath || configPath === statePath + '.lock' || configPath === statePath + '.stop') throw new ConsoleError('CONFIG_PATH', '控制台配置路径不能覆盖 bridge 状态或控制文件')
  let config = await readConsoleConfig(configPath)
  const token = env.BILIBILI_CONSOLE_TOKEN?.trim() || randomBytes(32).toString('base64url')
  if (token.length < 24 || token.length > 512 || /\s/u.test(token)) throw new ConsoleError('TOKEN', 'BILIBILI_CONSOLE_TOKEN 必须为 24–512 个非空白字符')
  const supervisor = prepared ?? new ConsoleSupervisor(configPath, statePath, env)
  let origin = ''
  let queue: Promise<unknown> = Promise.resolve()
  let nextRunAt = nextScheduledRun(config)
  let lastScheduleSlot = ''
  const journalPath = configPath + '.schedule.json'
  try {
    const journal: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
    if (!isPlainObject(journal) || typeof journal.slot !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(journal.slot)) throw new ConsoleError('SCHEDULE_STATE', '定时记录无效；请人工核对以避免重复执行')
    lastScheduleSlot = journal.slot
  } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
  function serialized<T>(operation: () => Promise<T>): Promise<T> {
    const task = queue.then(operation)
    queue = task.catch(() => {})
    return task
  }
  function headers(response: ServerResponse): void {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'")
  }
  function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)) }
  function authenticate(request: IncomingMessage): void {
    const supplied = request.headers.authorization ?? ''
    const expected = 'Bearer ' + token
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new ConsoleError('UNAUTHORIZED', '请输入当前控制台的访问令牌', 403)
  }
  async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
    if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) throw new ConsoleError('CONTENT_TYPE', '需要 application/json', 415)
    let length = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      length += data.length
      if (length > 65536) throw new ConsoleError('BODY_TOO_LARGE', '请求体超过 64 KiB', 413)
      chunks.push(data)
    }
    let parsed: unknown
    try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new ConsoleError('JSON', '无效 JSON') }
    if (!isPlainObject(parsed)) throw new ConsoleError('JSON', '请求必须是对象')
    return parsed
  }
  const snapshot = () => ({ config, revision: configRevision(config), status: { ...supervisor.status(), nextRunAt }, events: supervisor.events(), tokenConfigured: Boolean(env.CC_CONNECT_BRIDGE_TOKEN?.trim()) })
  const server = createServer((request, response) => {
    headers(response)
    void (async () => {
      if (request.headers.host !== new URL(origin).host) throw new ConsoleError('HOST', '仅接受当前本机地址', 403)
      if (request.headers.origin && request.headers.origin !== origin) throw new ConsoleError('ORIGIN', '不接受跨站请求', 403)
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new ConsoleError('ORIGIN', '不接受跨站请求', 403)
      const url = new URL(request.url ?? '/', origin)
      if (url.search || url.hash) throw new ConsoleError('ROUTE', '不接受查询参数', 404)
      const assets: Record<string, [string, string]> = { '/': ['text/html', consoleHtml], '/assets/console.css': ['text/css', consoleCss], '/assets/console.js': ['text/javascript', consoleJs] }
      const asset = assets[url.pathname]
      if (asset && request.method === 'GET') { response.writeHead(200, { 'Content-Type': asset[0] + '; charset=utf-8' }); response.end(asset[1]); return }
      if (!url.pathname.startsWith('/api/')) throw new ConsoleError('NOT_FOUND', '不存在的路径', 404)
      authenticate(request)
      if (url.pathname === '/api/state' && request.method === 'GET') { json(response, 200, snapshot()); return }
      if (url.pathname === '/api/config' && request.method === 'PUT') {
        const data = await body(request)
        if (typeof data.revision !== 'string' || Object.keys(data).some(k => !['revision', 'config'].includes(k))) throw new ConsoleError('CONFIG', '配置请求需要 config 和 revision')
        await serialized(async () => {
          config = await writeConsoleConfig(configPath, data.config, String(data.revision))
          nextRunAt = nextScheduledRun(config)
          supervisor.event('info', '配置已保存；连接与回复限制在下次启动 bridge 时生效')
        })
        json(response, 200, snapshot()); return
      }
      if (url.pathname === '/api/control' && request.method === 'POST') {
        const data = await body(request)
        if (typeof data.action !== 'string' || Object.keys(data).some(k => k !== 'action')) throw new ConsoleError('ACTION', '需要准确的 action')
        await serialized(() => supervisor.control(String(data.action), config))
        json(response, 200, snapshot()); return
      }
      throw new ConsoleError('METHOD', '路径或方法不支持', 405)
    })().catch((error: unknown) => {
      if (response.destroyed) return
      const known = error instanceof ConsoleError
      json(response, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL', message: known ? error.message : '控制台操作失败；请检查终端，不要重复未知写入' } })
    })
  })
  server.requestTimeout = 10000
  server.headersTimeout = 10000
  const port = args.port ?? 9820
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new ConsoleError('PORT', '端口无效')
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new ConsoleError('LISTEN', '控制台监听失败')
  origin = 'http://127.0.0.1:' + address.port
  let closing = false
  let scheduling = false
  const timer = setInterval(() => {
    if (closing || scheduling) return
    scheduling = true
    void serialized(async () => {
      const slot = scheduleSlot(config)
      nextRunAt = nextScheduledRun(config)
      if (!slot || slot === lastScheduleSlot) return
      // Claim before dispatch: failure or uncertain delivery never silently retries.
      await mkdir(dirname(journalPath), { recursive: true, mode: 0o700 })
      const temporary = journalPath + '.tmp'
      await writeFile(temporary, JSON.stringify({ slot }), { mode: 0o600 })
      await rename(temporary, journalPath)
      lastScheduleSlot = slot
      supervisor.event('info', '每日定时已触发')
      await supervisor.control('run-now', config)
    }).catch(() => supervisor.event('error', '每日定时执行失败；本日不自动重试，请人工核对')).finally(() => { scheduling = false })
  }, 15000)
  timer.unref()
  const close = async (): Promise<void> => {
    if (closing) return
    closing = true
    clearInterval(timer)
    await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeIdleConnections() })
    await queue
    await supervisor.stop()
  }
  return { server, origin, token, configPath, statePath, close }
}

export async function runConsole(args: ConsoleArgs = {}): Promise<number> {
  const consoleServer = await createConsoleServer(args)
  process.stdout.write(JSON.stringify({ type: 'console_ready', url: consoleServer.origin + '/#token=' + encodeURIComponent(consoleServer.token), configPath: consoleServer.configPath, pid: process.pid }) + '\n')
  return new Promise<number>((resolveRun, reject) => {
    let stopping = false
    const stop = (): void => {
      if (stopping) return
      stopping = true
      process.off('SIGINT', stop); process.off('SIGTERM', stop)
      void consoleServer.close().then(() => resolveRun(0), reject)
    }
    process.on('SIGINT', stop); process.on('SIGTERM', stop)
  })
}
