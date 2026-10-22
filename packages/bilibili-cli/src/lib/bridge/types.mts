export interface BridgeLogger {
  log?(message: string): void
  info?(message: string): void
  warn?(message: string): void
  error?(message: string): void
  debug?(message: string): void
}

export interface BridgeSocket {
  readonly readyState: number
  onopen: ((event: Event) => void) | null
  onmessage: ((event: MessageEvent) => void) | null
  onerror: ((event: Event) => void) | null
  onclose: ((event: CloseEvent) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}

export type WebSocketFactory = (url: string) => BridgeSocket

export type Metadata = Record<string, string | number | boolean>

export interface RegisterFrame {
  type: 'register'
  platform: string
  capabilities: string[]
  metadata: Metadata
}

export interface MessageFrame {
  type: 'message'
  msg_id: string
  session_key: string
  user_id: string
  user_name: string
  content: string
  reply_ctx: string
}

export interface PingFrame {
  type: 'ping'
  ts: number
}

export interface PongFrame {
  type: 'pong'
  ts: number
}

export type OutgoingFrame = RegisterFrame | MessageFrame | PingFrame | PongFrame

export interface RegisterAckFrame {
  type: 'register_ack'
  ok?: boolean
  error?: string
}

export interface IncomingPingFrame {
  type: 'ping'
  ts?: number
}

export interface IncomingPongFrame {
  type: 'pong'
  ts?: number
}

export type IncomingReplyFrame = Record<string, unknown> & { type: 'reply' }

export interface UnknownIncomingFrame {
  type: 'unknown'
}

export type IncomingFrame =
  | RegisterAckFrame
  | IncomingPingFrame
  | IncomingPongFrame
  | IncomingReplyFrame
  | UnknownIncomingFrame

export interface BridgeMessageInput {
  type?: 'message'
  id?: string | number | null
  msg_id?: string | number | null
  uid?: string | number | null
  user_id?: string | number | null
  name?: string
  user_name?: string
  content: string
  session_key?: string
  reply_ctx?: string | Record<string, unknown>
}

export interface BridgeSender {
  readonly platform?: string
  readonly connected?: boolean | null
  isRegistered?(): boolean
  canSend?(): boolean
  sendMessage(input: BridgeMessageInput): unknown | Promise<unknown>
  onReply?: ((reply: unknown) => unknown) | null
}

export interface Order {
  seqno: string | null
  timestamp: number | null
  key: string | null
  empty: boolean
}

export interface BaselineOrder extends Order {
  at: string | null
}

export interface Conversation {
  baseline: BaselineOrder | null
  cursor: Order | null
}

export interface SeenEntry {
  id: string
  at: string | null
}

export interface PendingEntry {
  id: string
  uid: string
  name: string
  content: string
  seqno: string | null
  timestamp: number | null
  key: string | null
  skipReason: string | null
  created_at: string | null
}

export interface BridgeState {
  version: 1
  conversations: Record<string, Conversation>
  pending: PendingEntry[]
  seen: SeenEntry[]
}

export interface BilibiliDmBackend {
  readDm(uid: string): Promise<unknown>
  sendDm(uid: string, text: string, options?: { confirm?: boolean }): Promise<unknown>
}