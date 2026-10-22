/**
 * 真实私信消息契约的只读分析。
 *
 * 参考 bilibili-api-python v17.4.1 的 session.py：
 * - fetch_session_msgs 返回 messages（最新在前），消费端用 [::-1] 反转后按时间正序处理；
 * - TEXT 消息的 content 是 JSON 字符串，正文在 content.content；
 * - 自身消息按 sender_uid 过滤；
 * - msg_key 是 64 位事件唯一编号，不能假设 JS Number 安全。
 * 这里只做证据整理，不伪造发送成功。
 */

export const TEXT = 1
export const PICTURE = 2
export const WITHDRAW = 5
export const SHARE_VIDEO = 7

export function messagesOf(result) {
  if (!Array.isArray(result?.messages)) {
    throw new Error('dm read 结果缺少 messages 数组；实际键：' + Object.keys(result ?? {}).sort().join(','))
  }
  return result.messages
}

export function isSafeInteger(value) {
  return typeof value === 'number' && Number.isSafeInteger(value)
}

export function seqnoOf(message) {
  const value = message?.msg_seqno
  if (isSafeInteger(value)) return value
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const number = Number(value)
    return Number.isSafeInteger(number) ? number : null
  }
  return null
}

/** TEXT 私信正文必须是 JSON 字符串，并从 parsed.content 读取。 */
export function decodeText(message) {
  if (message?.msg_type !== TEXT) return { kind: 'non-text' }
  const raw = message?.content
  if (typeof raw !== 'string') return { kind: 'invalid', error: 'content 不是字符串' }
  let parsed
  try { parsed = JSON.parse(raw) } catch { return { kind: 'invalid', error: 'content 不是合法 JSON' } }
  if (!parsed || typeof parsed.content !== 'string') return { kind: 'invalid', error: 'content.content 不是字符串' }
  return { kind: 'text', text: parsed.content }
}

/** 记录原始顺序，不预设“最新在前”一定成立。 */
export function analyzeOrder(result) {
  const messages = messagesOf(result)
  const seqnos = messages.map(seqnoOf)
  const valid = seqnos.every((value) => Number.isSafeInteger(value))
  let direction = 'unknown'
  if (valid && seqnos.length > 1) {
    const ascending = seqnos.every((value, index) => index === 0 || seqnos[index - 1] <= value)
    const descending = seqnos.every((value, index) => index === 0 || seqnos[index - 1] >= value)
    direction = ascending && descending ? 'equal' : ascending ? 'ascending' : descending ? 'descending' : 'mixed'
  }
  const min = valid ? Math.min(...seqnos) : null
  const max = valid ? Math.max(...seqnos) : null
  const normalizeEdge = (value) => {
    if (Number.isSafeInteger(value)) return value
    if (typeof value === 'string' && /^\d+$/.test(value)) {
      const number = Number(value)
      return Number.isSafeInteger(number) ? number : null
    }
    return null
  }
  const minEdge = normalizeEdge(result?.min_seqno)
  const maxEdge = normalizeEdge(result?.max_seqno)
  return {
    count: messages.length,
    direction,
    validSeqnos: valid,
    firstSeqno: seqnos[0] ?? null,
    lastSeqno: seqnos.at(-1) ?? null,
    minSeqno: result?.min_seqno ?? null,
    maxSeqno: result?.max_seqno ?? null,
    minMatches: valid && minEdge !== null ? minEdge === min : null,
    maxMatches: valid && maxEdge !== null ? maxEdge === max : null,
  }
}

export function chronological(messages) {
  return [...messages].sort((left, right) => {
    const a = seqnoOf(left)
    const b = seqnoOf(right)
    if (a === null || b === null) return 0
    return a - b
  })
}

export function senderRole(message, { selfUid, talkerUid } = {}) {
  const sender = String(message?.sender_uid ?? '')
  if (selfUid !== undefined && selfUid !== '' && sender === String(selfUid)) return 'self'
  if (talkerUid !== undefined && talkerUid !== '' && sender === String(talkerUid)) return 'talker'
  return 'other'
}

/** 只输出元数据，不把私信正文写入证据文件。 */
export function messageMetadata(message, context = {}) {
  const decoded = decodeText(message)
  return {
    msg_type: message?.msg_type ?? null,
    receiver_type: message?.receiver_type ?? null,
    seqno: seqnoOf(message),
    msg_key_safe_integer: isSafeInteger(message?.msg_key),
    msg_key_type: typeof message?.msg_key,
    sender_role: senderRole(message, context),
    content_type: typeof message?.content,
    text_decoded: decoded.kind === 'text',
    text_decode_error: decoded.kind === 'invalid' ? decoded.error : null,
    text_length: decoded.kind === 'text' ? decoded.text.length : null,
    timestamp_safe_integer: isSafeInteger(message?.timestamp),
  }
}
