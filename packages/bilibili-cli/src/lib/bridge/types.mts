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

export interface MessageSource {
  platform: string
  surface: 'dm' | 'comment' | 'at'
  untrusted: true
}

export interface MessageFrame {
  type: 'message'
  msg_id: string
  session_key: string
  user_id: string
  user_name: string
  content: string
  reply_ctx: string
  source?: MessageSource
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
  source?: MessageSource
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

/** 已入站的评论目标：notification 与 scroll 共用，root 只对楼中楼回复有意义。 */
export interface PendingTarget {
  bvid: string
  rpid?: number
  root?: number
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
  /** 入站通道：私信或视频评论通知。旧 state 迁移后一律为 dm。 */
  surface: 'dm' | 'comment'
  /** 评论目标；私信为 null。 */
  target: PendingTarget | null
}

export type NotifyKind = 'at' | 'reply'

export interface NotifyTarget {
  /** 只支持 video；dynamic/article 会被丢弃并记录原因。 */
  type: 'video' | 'dynamic' | 'article' | 'unknown'
  oid: string | null
  bvid: string | null
  rpid: number | null
  root: number | null
}

/** 归一化后的单条 @ / 回复通知；字段缺失一律用 null，不用 0 冒充。 */
export interface NotifyItem {
  id: string
  kind: NotifyKind
  time: number | null
  uid: string
  name: string
  text: string
  target: NotifyTarget
  uri: string | null
}

/** 通知分页游标：id 可能是 19 位，统一按十进制字符串保存。 */
export interface NotifyCursor {
  id: string | null
  time: number | null
  isEnd: boolean
}

export interface NotifyCursorInput {
  id: string | null
  time: number | null
}

export interface BridgeState {
  version: 1 | 2
  conversations: Record<string, Conversation>
  /** v2 新增；v1 迁移时置 null。 */
  notifications: { at: NotifyCursor | null; reply: NotifyCursor | null }
  pending: PendingEntry[]
  seen: SeenEntry[]
}

export interface BilibiliCommentTarget {
  bvid: string
  rpid?: number
  /** 楼中楼所属根评论；缺省时 CLI 以 rpid 作根。 */
  root?: number
}

/**
 * bridge 只依赖最小能力面。刷视频与评论是可选能力：缺失时相关动作必须显式拒绝，
 * 不能静默降级成“成功”。
 */
export interface BilibiliDmBackend {
  readDm(uid: string): Promise<unknown>
  sendDm(uid: string, text: string, options?: { confirm?: boolean }): Promise<unknown>
  videoHot?(num: number): Promise<unknown>
  videoSearch?(keyword: string, num: number): Promise<unknown>
  videoInfo?(bvid: string): Promise<unknown>
  comments?(bvid: string, num: number): Promise<unknown[]>
  postComment?(target: BilibiliCommentTarget, text: string, options?: { confirm?: boolean }): Promise<unknown>
  /** 评论区 @ 通知；缺失时评论通知通道显式拒绝，不静默降级。 */
  inboxAt?(cursor: NotifyCursorInput): Promise<unknown>
  /** 收到的回复通知。 */
  inboxReply?(cursor: NotifyCursorInput): Promise<unknown>
}