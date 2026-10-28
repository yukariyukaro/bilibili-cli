/**
 * 评论 @ / 回复通知的归一化。
 *
 * 这里只做纯计算：不读文件、不发请求、不写状态，便于离线单测与回归。
 * B 站 `x/msgfeed/at` 与 `x/msgfeed/reply` 的 item 字段没有公开稳定契约，
 * 因此按候选字段表提取；取不到就返回 null 并交给调用方记录原因，
 * 绝不猜一个目标去发评论。
 */
import { aid2bvid } from '@yukariyukaro/bilibili-api-ts'

import { isPlainObject } from './guards.mjs'
import { parseJsonLossless } from './json.mjs'
import type { NotifyCursor, NotifyItem, NotifyKind, NotifyTarget } from './types.mjs'

const MAX_TEXT = 2000
const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/u

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'bigint') return value.toString()
  }
  return ''
}

/** 19 位 ID 可能已被 JSON.parse 变成不精确的 number：只保留字符串，不尝试修复。 */
function idString(value: unknown): string {
  if (typeof value === 'string' && /^\d+$/u.test(value)) return BigInt(value).toString()
  if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0) {
    return BigInt(value).toString()
  }
  if (typeof value === 'bigint' && value >= 0n) return value.toString()
  return ''
}

function safePositive(value: unknown): number | null {
  const id = idString(value)
  if (!id) return null
  const numeric = Number(id)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}

function positiveOrZero(value: unknown): number | null {
  const numeric = safePositive(value)
  if (numeric !== null) return numeric
  const zero = idString(value)
  return zero === '0' ? 0 : null
}

/** 判断数字 ID 是否已经超出安全整数范围（解析时可能已丢失精度）。 */
export function isUnsafeNumericId(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && !Number.isSafeInteger(value)
}

function targetType(record: Record<string, unknown>): NotifyTarget['type'] {
  const hints = [record.type, record.business, record.biz_type, record.sub_type]
    .map((value) => firstString(value).toLowerCase())
    .filter(Boolean)
  // 真实 payload：动态 @ 的 type='dynamic'、business='动态'；视频评论可能是
  // type='reply' 或 business 含“评论”，所以每个提示都要看，不能只看第一个。
  for (const raw of hints) {
    // business 字段是中文（“动态”“专栏”），只匹配英文会把它当成 unknown。
    if (/dynamic|dyn|动态|转发/u.test(raw)) return 'dynamic'
    if (/article|opus|read|专栏|图文/u.test(raw)) return 'article'
  }
  for (const raw of hints) {
    if (/video|archive|^av$|comment|^reply$|评论|视频/u.test(raw)) return 'video'
  }
  return 'unknown'
}

function bvidFrom(record: Record<string, unknown>, oid: string | null): string | null {
  const declared = firstString(record.bvid, record.bv_id)
  if (BV_PATTERN.test(declared)) return declared
  if (oid === null || !/^\d+$/u.test(oid)) return null
  const numeric = Number(oid)
  // aid 是 51 位；更大的 oid（动态/专栏）不能交给 aid2bvid，
  // 它不做上界校验，会把任意大数编成看似合法但错误的 BV。
  if (!Number.isSafeInteger(numeric) || numeric <= 0 || numeric >= 2 ** 51) return null
  try {
    const derived = aid2bvid(numeric)
    return BV_PATTERN.test(derived) ? derived : null
  } catch {
    return null
  }
}

function extractText(record: Record<string, unknown>, kind: NotifyKind): string {
  const reply = asRecord(record.reply)
  const replyContent = asRecord(reply.content)
  const candidates = [
    record.content,
    record.source_content,
    replyContent.message,
    asRecord(record.item).content,
    record.title,
  ]
  if (kind === 'at') candidates.push(record.at_content)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, MAX_TEXT)
  }
  return ''
}

function normalizeTarget(record: Record<string, unknown>, kind: NotifyKind): NotifyTarget {
  // business_id 在动态通知里是 0；0 不是有效目标，必须继续找 subject_id/oid。
  const oidCandidates = [record.oid, record.subject_id, record.business_id]
    .map((value) => idString(value))
    .filter((value) => value !== '' && value !== '0')
  const oid = oidCandidates[0] ?? null
  const type = targetType(record)
  const bvid = type === 'video' ? bvidFrom(record, oid) : null
  // at：命中的评论 ID；reply：回复我的那条评论 ID。两种候选顺序不同，因为
  // msgfeed/reply 里 source_id 通常指向被回复的评论，而 target_id 才是新评论。
  const rpidCandidates = kind === 'at'
    ? [record.comment_id, record.source_id, record.target_id, record.reply_id]
    : [record.comment_id, record.target_id, record.source_id, record.reply_id]
  let rpid: number | null = null
  for (const candidate of rpidCandidates) {
    const parsed = safePositive(candidate)
    if (parsed !== null) {
      rpid = parsed
      break
    }
  }
  const root = positiveOrZero(record.root_id) ?? positiveOrZero(record.root)
  return {
    type,
    oid,
    bvid,
    rpid,
    root: root !== null && root > 0 ? root : null,
  }
}

/** 把单条通知归一化；无法识别时返回 null，由调用方记录原因后跳过。 */
export function normalizeNotification(raw: unknown, kind: NotifyKind): NotifyItem | null {
  if (!isPlainObject(raw)) return null
  const record = raw
  const item = asRecord(record.item)
  // 大多数通知把目标放在 item 里；个别类型直接平铺在顶层，用合并后的视图兼容两种。
  const source = Object.keys(item).length ? { ...record, ...item } : record
  const user = asRecord(record.user)
  const uid = idString(user.mid ?? user.uid ?? source.mid ?? record.uid)
  const id = idString(record.id ?? record.notify_id)
  if (!id) return null
  const time = positiveOrZero(source.at_time ?? source.reply_time ?? source.ctime ?? source.time ?? source.ts)
  const name = firstString(user.nickname, user.uname, user.name) || uid || 'unknown'
  const target = normalizeTarget(source, kind)
  const text = extractText(
    { ...record, item: source, content: source.content, source_content: source.source_content },
    kind,
  )
  const uri = firstString(source.uri, source.native_uri, record.uri)
  return {
    id,
    kind,
    time,
    uid,
    name,
    text,
    target,
    uri: uri || null,
  }
}

function extractItems(payload: unknown): { list: unknown[]; cursorRaw: unknown } {
  let value: unknown = payload
  if (typeof value === 'string') value = parseJsonLossless(value)
  if (!isPlainObject(value)) return { list: Array.isArray(value) ? value : [], cursorRaw: null }
  if (value.result !== undefined && value.result !== null) value = value.result
  const record = asRecord(value)
  const data = asRecord(record.data)
  const list = Array.isArray(record.items)
    ? record.items
    : Array.isArray(data.items)
      ? data.items
      : Array.isArray(record.list)
        ? record.list
        : []
  const cursorRaw = record.cursor ?? data.cursor ?? null
  return { list, cursorRaw }
}

function parseCursor(raw: unknown): NotifyCursor | null {
  if (!isPlainObject(raw)) return null
  const id = idString(raw.id ?? raw.cursor_id)
  const time = positiveOrZero(raw.time ?? raw.at_time ?? raw.reply_time)
  const isEnd = raw.is_end === true || raw.is_end === 1 || raw.is_end === 'true'
  if (!id && time === null) return null
  return { id: id || null, time: time === null ? null : time, isEnd }
}

export interface ParsedInbox {
  items: NotifyItem[]
  cursor: NotifyCursor | null
  /** 无法识别的条目数量，供调用方记录告警，不阻塞其余条目。 */
  unparsed: number
}

export function parseInbox(kind: NotifyKind, payload: unknown): ParsedInbox {
  const { list, cursorRaw } = extractItems(payload)
  const items: NotifyItem[] = []
  let unparsed = 0
  for (const entry of list) {
    const item = normalizeNotification(entry, kind)
    if (item === null) unparsed += 1
    else items.push(item)
  }
  return { items, cursor: parseCursor(cursorRaw), unparsed }
}
