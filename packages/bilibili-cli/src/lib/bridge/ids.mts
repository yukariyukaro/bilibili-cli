import { createHash } from 'node:crypto'

import { isIntegerString, isPlainObject } from './guards.mjs'

export function normalizeIntegerString(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return Number.isSafeInteger(value) ? String(value) : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!isIntegerString(text)) return null
    try {
      return BigInt(text).toString()
    } catch {
      return null
    }
  }
  return null
}

export function normalizeTimestamp(value: unknown): number | null {
  if (typeof value === 'bigint') {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : null
  }
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : null
  if (typeof value === 'string') {
    const text = value.trim()
    if (!isIntegerString(text)) return null
    const number = Number(text)
    return Number.isSafeInteger(number) ? number : null
  }
  return null
}

export function compareIntegerStrings(left: string, right: string): number {
  try {
    const a = BigInt(left)
    const b = BigInt(right)
    return a < b ? -1 : a > b ? 1 : 0
  } catch {
    return left < right ? -1 : left > right ? 1 : 0
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {}
}

export function primaryIdString(message: unknown): string | null {
  const record = asRecord(message)
  const raw = record.msg_key ?? record.msg_id ?? record.message_id ?? record.id
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'bigint') return raw.toString()
  if (typeof raw === 'string') return raw.trim() || null
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? String(raw) : null
  return null
}

export function hasUnsafeIntegerId(message: unknown): boolean {
  if (!isPlainObject(message)) return false
  for (const field of ['msg_key', 'msg_id', 'message_id', 'id']) {
    const value = message[field]
    if (typeof value === 'number' && !Number.isSafeInteger(value)) return true
  }
  return false
}

function contentFingerprint(content: unknown): string {
  let text: string
  if (typeof content === 'string') {
    text = content
  } else if (content === null || content === undefined) {
    text = ''
  } else {
    try {
      text = JSON.stringify(content, (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() + 'n' : value)) ?? String(content)
    } catch {
      text = String(content)
    }
  }
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)
}

/**
 * 稳定事件 ID。优先使用字符串/安全整数 ID；数值已超出安全整数时不能直接
 * String(number)，改用会话、序号、时间、方向与正文指纹的复合键。
 */
export function messageId(uid: unknown, message: unknown = {}): string {
  const record = asRecord(message)
  const owner = String(uid ?? record.uid ?? record.sender_uid ?? '')
  const key = primaryIdString(record)
  if (key) return `dm:${owner}:mk:${key}`

  const sender = String(record.sender_uid ?? record.from_uid ?? record.uid ?? '')
  const receiver = String(record.receiver_id ?? record.receiver_uid ?? record.to_uid ?? '')
  const type = normalizeIntegerString(record.msg_type ?? record.type) ?? ''
  const seqno = normalizeIntegerString(record.msg_seqno ?? record.seqno ?? record.msg_seq ?? '') ?? ''
  const timestamp = normalizeIntegerString(
    record.timestamp ?? record.create_time ?? record.ctime ?? record.time ?? record.ts ?? '',
  ) ?? ''
  const fingerprint = contentFingerprint(record.content)
  return `dm:${owner}:${sender}:${receiver}:${type}:${seqno}:${timestamp}:${fingerprint}`
}
