import { isPlainObject } from './guards.mjs'
import type {
  BridgeLogger,
  BridgeMessageInput,
  BridgeSocket,
  IncomingFrame,
  IncomingReplyFrame,
  Metadata,
  OutgoingFrame,
  WebSocketFactory,
} from './types.mjs'
export { hasUnsafeIntegerId, messageId } from './ids.mjs'

const WS_OPEN = 1
const DEFAULT_CONNECTION_TIMEOUT_MS = 15000
const DEFAULT_REGISTRATION_TIMEOUT_MS = 10000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 90000
const MAX_RECONNECT_DELAY_MS = 60000

export class BridgeError extends Error {
  readonly code: string

  constructor(code: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BridgeError'
    this.code = code
  }
}

export class BridgeNotReadyError extends BridgeError {
  constructor(message = 'bridge websocket is not registered') {
    super('NOT_REGISTERED', message)
    this.name = 'BridgeNotReadyError'
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>): void {
  if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
    const unref: unknown = timer.unref
    if (typeof unref === 'function') unref.call(timer)
  }
}

function parseIncomingFrame(value: unknown): IncomingFrame {
  if (!isPlainObject(value) || typeof value.type !== 'string') return { type: 'unknown' }
  if (value.type === 'register_ack') {
    return {
      type: 'register_ack',
      ...(typeof value.ok === 'boolean' ? { ok: value.ok } : {}),
      ...(typeof value.error === 'string' ? { error: value.error } : {}),
    }
  }
  if (value.type === 'ping') {
    return { type: 'ping', ...(typeof value.ts === 'number' ? { ts: value.ts } : {}) }
  }
  if (value.type === 'pong') {
    return { type: 'pong', ...(typeof value.ts === 'number' ? { ts: value.ts } : {}) }
  }
  if (value.type === 'reply') return { ...value, type: 'reply' }
  return { type: 'unknown' }
}

function normalizeWsData(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
  return String(data ?? '')
}

const defaultWsFactory: WebSocketFactory = (target) => new WebSocket(target)

export interface BridgeClientOptions {
  url: string
  token?: string
  platform?: string
  wsFactory?: WebSocketFactory
  logger?: BridgeLogger
  connectionTimeoutMs?: number
  registrationTimeoutMs?: number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  capabilities?: string[]
  metadata?: Metadata
}

export type BridgeClientState = 'idle' | 'connecting' | 'registering' | 'registered' | 'disconnected' | 'closed'

interface RunForeverOptions {
  onConnected?: (client: BridgeClient) => void | Promise<void>
  onDisconnected?: (detail: { registered: boolean }) => void | Promise<void>
  logger?: BridgeLogger
}

export class BridgeClient {
  readonly url: string
  readonly token: string
  readonly platform: string
  readonly wsFactory: WebSocketFactory
  readonly logger: BridgeLogger
  readonly connectionTimeoutMs: number
  readonly registrationTimeoutMs: number
  readonly heartbeatIntervalMs: number
  readonly heartbeatTimeoutMs: number
  readonly capabilities: string[]
  readonly metadata: Metadata

  socket: BridgeSocket | null = null
  closed = false
  connected: boolean | null = null
  onReply: ((reply: unknown) => unknown) | null = null
  state: BridgeClientState = 'idle'

  private heartbeat: ReturnType<typeof setInterval> | null = null
  private _connectPromise: Promise<this> | null = null
  private _rejectConnect: ((error: BridgeError) => void) | null = null
  private readonly _disconnectWaiters = new Set<(reason: string) => void>()
  private _lastInboundAt = 0
  private _registeredAt = 0
  private _reconnectResolve: (() => void) | null = null
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null

  constructor({
    url,
    token = '',
    platform = 'bilibili',
    wsFactory = defaultWsFactory,
    logger = console,
    connectionTimeoutMs = DEFAULT_CONNECTION_TIMEOUT_MS,
    registrationTimeoutMs = DEFAULT_REGISTRATION_TIMEOUT_MS,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
    capabilities = ['text'],
    metadata = { protocol_version: 1, version: '0.1.0', description: 'Bilibili DM adapter' },
  }: BridgeClientOptions) {
    if (!url) throw new Error('bridge url is required')
    this.url = url
    this.token = token
    this.platform = platform
    this.wsFactory = wsFactory
    this.logger = logger
    this.connectionTimeoutMs = Math.max(0, Number(connectionTimeoutMs) || 0)
    this.registrationTimeoutMs = Math.max(0, Number(registrationTimeoutMs) || 0)
    this.heartbeatIntervalMs = Math.max(0, Number(heartbeatIntervalMs) || 0)
    this.heartbeatTimeoutMs = Math.max(0, Number(heartbeatTimeoutMs) || 0)
    this.capabilities = [...capabilities]
    this.metadata = { ...metadata }
  }

  isRegistered(): boolean {
    return this.state === 'registered' && this.socket?.readyState === WS_OPEN
  }

  canSend(): boolean {
    return this.isRegistered()
  }

  getStatus(): { state: BridgeClientState; registered: boolean; connected: boolean; readyState: number | null } {
    return {
      state: this.state,
      registered: this.isRegistered(),
      connected: this.connected === true,
      readyState: this.socket?.readyState ?? null,
    }
  }

  async connect(): Promise<this> {
    if (this.closed) throw new BridgeError('CLOSED', 'bridge client is closed')
    if (this.isRegistered()) return this
    if (this._connectPromise) return this._connectPromise
    const promise = this.connectOnce()
    this._connectPromise = promise.finally(() => {
      this._connectPromise = null
    })
    return this._connectPromise
  }

  private async connectOnce(): Promise<this> {
    const target = this.url + (this.url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(this.token)
    let socket: BridgeSocket
    try {
      socket = this.wsFactory(target)
    } catch (error) {
      throw new BridgeError('WS_FACTORY_FAILED', 'bridge websocket could not be created', { cause: error })
    }
    if (!socket) throw new BridgeError('WS_FACTORY_FAILED', 'websocket factory returned no socket')
    this.socket = socket
    this.state = 'connecting'
    this.connected = null

    return new Promise<this>((resolveConnect, rejectConnect) => {
      let settled = false
      let openTimer: ReturnType<typeof setTimeout> | null = null
      let registerTimer: ReturnType<typeof setTimeout> | null = null

      const clearTimers = (): void => {
        if (openTimer) clearTimeout(openTimer)
        if (registerTimer) clearTimeout(registerTimer)
        openTimer = null
        registerTimer = null
      }

      const finish = (error?: BridgeError | null): void => {
        if (settled) return
        settled = true
        clearTimers()
        this._rejectConnect = null

        if (error) {
          this.closeSocket(socket)
          this.state = this.closed ? 'closed' : 'disconnected'
          this.connected = null
          rejectConnect(error)
          return
        }

        this.state = 'registered'
        this.connected = true
        this._registeredAt = Date.now()
        this._lastInboundAt = this._registeredAt
        this.startHeartbeat()
        this.logger.log?.('[bilibili-bridge] bridge registered')
        resolveConnect(this)
      }

      this._rejectConnect = (error) => {
        finish(error ?? new BridgeError('CLOSED', 'bridge client is closed'))
      }

      if (this.connectionTimeoutMs > 0) {
        openTimer = setTimeout(() => {
          finish(new BridgeError('CONNECT_TIMEOUT', 'bridge websocket did not open within ' + this.connectionTimeoutMs + 'ms'))
        }, this.connectionTimeoutMs)
        unrefTimer(openTimer)
      }

      socket.onopen = () => {
        if (settled || this.socket !== socket) return
        if (openTimer) clearTimeout(openTimer)
        openTimer = null
        this.state = 'registering'
        try {
          this.writeRaw(socket, {
            type: 'register',
            platform: this.platform,
            capabilities: this.capabilities,
            metadata: this.metadata,
          })
        } catch (error) {
          finish(new BridgeError('REGISTER_SEND_FAILED', 'could not send register frame: ' + String(error), { cause: error }))
          return
        }
        if (this.registrationTimeoutMs > 0) {
          registerTimer = setTimeout(() => {
            finish(new BridgeError('REGISTER_TIMEOUT', 'bridge registration timed out after ' + this.registrationTimeoutMs + 'ms'))
          }, this.registrationTimeoutMs)
          unrefTimer(registerTimer)
        }
      }

      socket.onmessage = (event) => {
        if (this.socket !== socket) return
        this.onSocketMessage(event, finish)
      }

      socket.onerror = () => {
        if (settled) {
          this.handleSocketDisconnect(socket, 'websocket error')
          return
        }
        finish(new BridgeError('WS_ERROR', 'bridge websocket error'))
      }

      socket.onclose = (event) => {
        if (settled) {
          this.handleSocketDisconnect(socket, 'websocket closed (code=' + String(event?.code ?? '?') + ')')
          return
        }
        finish(
          new BridgeError(
            'CLOSED_BEFORE_REGISTRATION',
            'bridge websocket closed before registration (code=' + String(event?.code ?? '?') + ')',
          ),
        )
      }
    })
  }

  private onSocketMessage(
    event: MessageEvent,
    finish: (error?: BridgeError | null) => void,
  ): void {
    const data: unknown = event.data
    const text = normalizeWsData(data)
    if (!text) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this.logger.error?.('[bilibili-bridge] invalid JSON from bridge')
      return
    }
    this._lastInboundAt = Date.now()
    const message = parseIncomingFrame(parsed)

    if (message.type === 'register_ack') {
      // 严格协议：缺 ok 或非 boolean 不视为成功，避免坏 ack 开放消费者。
      if (message.ok !== true) {
        // 远端 error 文本可能包含 URL/凭证，只输出固定描述。
        finish(new BridgeError('REGISTER_REJECTED', 'bridge registration rejected'))
        return
      }
      if (!this.isRegistered()) finish(null)
      return
    }

    if (!this.isRegistered()) return

    if (message.type === 'ping') {
      this.safeWrite({ type: 'pong', ts: Date.now() })
      return
    }
    if (message.type === 'pong') return
    if (message.type === 'reply') {
      this.dispatchReply(message)
    }
  }

  private dispatchReply(message: IncomingReplyFrame): void {
    if (typeof this.onReply !== 'function') return
    try {
      const result = this.onReply(message)
      if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
        Promise.resolve(result).catch((error: unknown) => {
          this.logger.error?.('[bilibili-bridge] reply failed: ' + String(error))
        })
      }
    } catch (error) {
      this.logger.error?.('[bilibili-bridge] reply failed: ' + String(error))
    }
  }

  private writeRaw(socket: BridgeSocket | null, message: OutgoingFrame): void {
    if (!socket || socket.readyState !== WS_OPEN) throw new BridgeNotReadyError()
    socket.send(JSON.stringify(message))
  }

  send(message: OutgoingFrame): void {
    if (this.closed) throw new BridgeError('CLOSED', 'bridge client is closed')
    if (!this.isRegistered()) throw new BridgeNotReadyError()
    this.writeRaw(this.socket, message)
  }

  private safeWrite(message: OutgoingFrame): void {
    try {
      this.writeRaw(this.socket, message)
    } catch (error) {
      this.logger.error?.('[bilibili-bridge] bridge write failed: ' + String(error))
      this.failConnection(new BridgeError('WRITE_FAILED', String(error), { cause: error }))
    }
  }

  sendMessage({
    id,
    msg_id,
    uid,
    user_id,
    name,
    user_name,
    content,
    session_key,
    reply_ctx,
    source,
  }: BridgeMessageInput): void {
    const eventId = id ?? msg_id
    const receiver = uid ?? user_id
    if (eventId === null || eventId === undefined || String(eventId).trim() === '') {
      throw new BridgeError('INVALID_MESSAGE', 'message id is required for stable deduplication')
    }
    if (receiver === null || receiver === undefined || String(receiver).trim() === '') {
      throw new BridgeError('INVALID_MESSAGE', 'message uid is required')
    }
    if (typeof content !== 'string' || !content.trim()) {
      throw new BridgeError('INVALID_MESSAGE', 'message content must be a non-empty string')
    }
    const receiverId = String(receiver)
    this.send({
      type: 'message',
      msg_id: String(eventId),
      session_key: session_key || this.platform + ':dm:' + receiverId,
      user_id: receiverId,
      user_name: name ? String(name) : user_name ? String(user_name) : receiverId,
      content,
      reply_ctx:
        typeof reply_ctx === 'string'
          ? reply_ctx
          : JSON.stringify(reply_ctx ?? { kind: 'dm', uid: receiverId }),
      ...(source ? { source } : {}),
    })
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (this.heartbeatIntervalMs <= 0) return
    const timer = setInterval(() => {
      if (!this.isRegistered()) return
      if (this.heartbeatTimeoutMs > 0) {
        const lastActivity = Math.max(this._lastInboundAt || 0, this._registeredAt || 0)
        if (Date.now() - lastActivity > this.heartbeatTimeoutMs) {
          this.failConnection(
            new BridgeError('HEARTBEAT_TIMEOUT', 'bridge heartbeat timed out after ' + this.heartbeatTimeoutMs + 'ms'),
          )
          return
        }
      }
      this.safeWrite({ type: 'ping', ts: Date.now() })
    }, this.heartbeatIntervalMs)
    unrefTimer(timer)
    this.heartbeat = timer
  }

  private failConnection(error: BridgeError): void {
    if (!this.socket) return
    this.logger.error?.('[bilibili-bridge] ' + error.message)
    const socket = this.socket
    this.handleSocketDisconnect(socket, error.message)
    try {
      if (socket.readyState === WS_OPEN || socket.readyState === 0) {
        socket.close(4000, error.message.slice(0, 120))
      }
    } catch {
      // close 失败不影响本地清理
    }
  }

  private handleSocketDisconnect(socket: BridgeSocket | null, reason: string): void {
    if (socket && this.socket && this.socket !== socket) return
    this.closeSocket(socket)
    this.state = this.closed ? 'closed' : 'disconnected'
    this.connected = null
    this.notifyDisconnected(reason)
  }

  private closeSocket(socket: BridgeSocket | null): void {
    if (this.socket === socket) this.socket = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    if (!socket) return
    try {
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
    } catch {
      // 某些 WebSocket 实现不允许改写处理器，忽略
    }
    try {
      if (socket.readyState === WS_OPEN || socket.readyState === 0) socket.close()
    } catch {
      // 已关闭
    }
  }

  private notifyDisconnected(reason: string): void {
    const waiters = [...this._disconnectWaiters]
    this._disconnectWaiters.clear()
    for (const resolveWaiter of waiters) resolveWaiter(reason)
  }

  private waitForDisconnect(): Promise<string> {
    if (!this.isRegistered() && this.state !== 'connecting' && this.state !== 'registering') {
      return Promise.resolve('already disconnected')
    }
    return new Promise((resolveWait) => {
      this._disconnectWaiters.add(resolveWait)
    })
  }

  private wakeReconnect(): void {
    const resolveWake = this._reconnectResolve
    if (resolveWake) resolveWake()
  }

  private waitReconnect(ms: number): Promise<void> {
    return new Promise((resolveWait) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (): void => {
        if (timer) clearTimeout(timer)
        if (this._reconnectTimer === timer) {
          this._reconnectTimer = null
          this._reconnectResolve = null
        }
        resolveWait()
      }
      timer = setTimeout(done, ms)
      // 重连等待必须让进程保持存活，否则 stdin 已 EOF 的常驻场景会静默退出而不是重连。
      this._reconnectTimer = timer
      this._reconnectResolve = done
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new BridgeError('CLOSED', 'bridge client is closed')
    const reject = this._rejectConnect
    this._rejectConnect = null
    reject?.(error)
    const socket = this.socket
    if (socket) this.handleSocketDisconnect(socket, 'client closed')
    this.state = 'closed'
    this.connected = null
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.notifyDisconnected('client closed')
    this.wakeReconnect()
  }

  async runForever({ onConnected, onDisconnected, logger = this.logger }: RunForeverOptions = {}): Promise<void> {
    let delay = 1000
    while (!this.closed) {
      let registeredThisAttempt = false
      try {
        await this.connect()
        registeredThisAttempt = true
        delay = 1000
        try {
          await onConnected?.(this)
        } catch (error) {
          logger.error?.('[bilibili-bridge] onConnected failed: ' + String(error))
        }
        if (!this.closed) await this.waitForDisconnect()
      } catch (error) {
        logger.error?.('[bilibili-bridge] bridge connection failed: ' + String(error))
      } finally {
        if (this.socket) this.handleSocketDisconnect(this.socket, 'connection ended')
        try {
          await onDisconnected?.({ registered: registeredThisAttempt })
        } catch (error) {
          logger.error?.('[bilibili-bridge] onDisconnected failed: ' + String(error))
        }
      }

      if (!this.closed) {
        await this.waitReconnect(delay)
        delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS)
      }
    }
  }
}