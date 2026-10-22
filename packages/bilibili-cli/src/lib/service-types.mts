/**
 * src/lib/service-types.mts —— 服务层、运行时与登录适配层共享的边界类型。
 *
 * 上游 @yukariyukaro/bilibili-api-ts 的公开签名大量返回 any。这里不复制兄弟仓类型，
 * 也不整包声明 any：调用点一律先落到 unknown，再用本文件的守卫窄化到可校验的
 * Record<string, unknown> / string / number / unknown[]，把不可信边界留在适配层。
 */

export interface SetupInfo {
  installed: boolean
  library: string
  spec: string
  version: string | null
}

export type LoginAction = 'start' | 'poll'

export type LoginState = 'waiting' | 'scanned' | 'ok' | 'expired' | 'unknown'

/** 产品内部凭证文件的四个字段；只按旧实现的字段名读写，不在此打印。 */
export interface CredentialRecord {
  sessdata?: string | null
  bili_jct?: string | null
  buvid3?: string | null
  dedeuserid?: string | null
}

export interface LoginStartResult {
  key: string
  url: string
}

export type LoginPollResult =
  | { state: 'ok'; code: unknown; credential: CredentialRecord }
  | { state: 'waiting' | 'scanned' | 'expired' | 'unknown'; code: unknown; message: string }

/** createRuntime 的公开形态；application 只依赖这些方法。 */
export interface Runtime {
  close(): void
  call(name: string, params: Record<string, unknown>): Promise<unknown>
  setup(): Promise<SetupInfo>
  login(action: LoginAction, key?: string): Promise<unknown>
}

/** createService 的公开形态。 */
export interface Service {
  call(name: string, params: Record<string, unknown>): Promise<unknown>
}

/** 出站投影保留旧实现的原始值类型；业务判断仍走各自的显式 guard。 */
export interface SubReply {
  user: unknown
  content: unknown
  like: unknown
}

export interface CommentItem {
  rpid: unknown
  user: unknown
  content: unknown
  like: unknown
  reply_count: unknown
  time: unknown
  top_replies?: SubReply[]
}

/** object 且非数组才视为记录；其余全部落到空记录，避免把坏数据当成功。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function toRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

export function toList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export function toText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function toOptionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 旧实现用 `|| null` 处理凭证字段：只保留非空字符串。 */
export function toNullableText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** 旧实现 `value ?? fallback` 的逐字语义：保留原值，不做类型收编。 */
export function nullishOr(value: unknown, fallback: unknown): unknown {
  return value === null || value === undefined ? fallback : value
}

/** 旧实现 `String(value ?? '')` 的逐字语义：null/undefined -> ''，其余按 String 转换。 */
export function stringOrEmpty(value: unknown): string {
  return String(value ?? '')
}

export function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}
