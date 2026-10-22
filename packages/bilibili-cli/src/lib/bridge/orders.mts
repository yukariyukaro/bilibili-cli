import { compareIntegerStrings } from './ids.mjs'
import type { Order, PendingEntry } from './types.mjs'

export function compareOrders(left: Order | null | undefined, right: Order | null | undefined): number {
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  if (left.seqno !== null && right.seqno !== null) {
    const compared = compareIntegerStrings(left.seqno, right.seqno)
    if (compared !== 0) return compared
  }
  if (left.timestamp !== null && right.timestamp !== null && left.timestamp !== right.timestamp) {
    return left.timestamp < right.timestamp ? -1 : 1
  }
  if (left.key && right.key && left.key !== right.key) {
    return left.key < right.key ? -1 : 1
  }
  return 0
}

export function isAfterOrder(order: Order, cursor: Order | null | undefined): boolean {
  if (!cursor) return true
  if (cursor.empty) return true
  if (cursor.seqno === null && cursor.timestamp === null && cursor.key === null) return true
  if (order.seqno !== null && cursor.seqno !== null) {
    const compared = compareIntegerStrings(order.seqno, cursor.seqno)
    if (compared !== 0) return compared > 0
  }
  if (order.timestamp !== null && cursor.timestamp !== null && order.timestamp !== cursor.timestamp) {
    return order.timestamp > cursor.timestamp
  }
  if (order.key && cursor.key && order.key !== cursor.key) return order.key > cursor.key
  if (order.seqno !== null && cursor.seqno === null) {
    if (order.timestamp !== null && cursor.timestamp !== null) return order.timestamp > cursor.timestamp
    return true
  }
  if (order.timestamp !== null && cursor.timestamp === null) return true
  return false
}

export function orderFromPending(entry: PendingEntry): Order {
  return {
    seqno: entry.seqno,
    timestamp: entry.timestamp,
    key: entry.key,
    empty: false,
  }
}

export function comparePendingEntries(left: PendingEntry, right: PendingEntry): number {
  const compared = compareOrders(orderFromPending(left), orderFromPending(right))
  if (compared !== 0) return compared
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}
