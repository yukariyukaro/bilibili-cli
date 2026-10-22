import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// state v1 fixtures（本地生成，只用于验证恢复/队列语义；不是 B 站消息）。

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
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
  return state
}

export function readState(statePath) {
  try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch { return null }
}

export function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}