import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_HOME, AGENT_UID, ARTIFACTS, readonlyOrSkip, statOrNull } from './lib/env.mjs'
import { configGet, dmRead } from './lib/cli.mjs'
import { analyzeOrder, decodeText, messagesOf } from './lib/conversation.mjs'

function safeIntegerValue(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.isSafeInteger(Number(value))
  return false
}

function valueType(value) {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

test('真实私信数据契约：字段、TEXT JSON 正文、顺序与精度（只读）', async (t) => {
  const config = readonlyOrSkip(t)
  if (!config) return

  // 只读前后的写开关与审计只做 stat，不读取私信正文或凭证正文。
  const beforeConfig = await configGet(AGENT_HOME)
  const beforeAudit = statOrNull(join(AGENT_HOME, 'audit.jsonl'))

  const result = await dmRead(config.talkerUid, AGENT_HOME)
  const messages = messagesOf(result)
  if (messages.length === 0) {
    t.skip('会话为空：无法验证真实消息字段、JSON 正文与顺序；未发送任何测试私信')
    return
  }

  assert.ok(Object.hasOwn(result, 'min_seqno'), 'dm read 缺少 min_seqno')
  assert.ok(Object.hasOwn(result, 'max_seqno'), 'dm read 缺少 max_seqno')
  assert.ok(Object.hasOwn(result, 'has_more'), 'dm read 缺少 has_more')

  for (const message of messages) {
    assert.ok(Object.hasOwn(message, 'msg_key'), '消息缺少 msg_key：seqno=' + message?.msg_seqno)
    assert.ok(Object.hasOwn(message, 'msg_seqno'), '消息缺少 msg_seqno')
    assert.equal(typeof message.msg_seqno, 'number', 'msg_seqno 不是数字')
    assert.ok(Number.isSafeInteger(message.msg_seqno), 'msg_seqno 超出 JS 安全整数：' + message.msg_seqno)
    assert.equal(typeof message.msg_type, 'number', 'msg_type 不是数字')
    assert.ok(Number.isSafeInteger(message.msg_type), 'msg_type 不是安全整数')
    assert.ok(Number.isSafeInteger(message.timestamp), 'timestamp 不是安全整数')
    assert.equal(Number(message.receiver_type), 1, '私聊消息 receiver_type 应为 1：seqno=' + message.msg_seqno)
    assert.ok(safeIntegerValue(message.sender_uid), 'sender_uid 不是安全整数：seqno=' + message.msg_seqno)
    assert.ok(typeof message.content === 'string' || (message.content && typeof message.content === 'object'), 'content 既不是字符串也不是对象')
  }

  const textMessages = messages.filter((message) => message.msg_type === 1)
  if (textMessages.length === 0) {
    t.diagnostic('本页没有 TEXT 消息，无法验证 content.content 解码')
  } else {
    for (const message of textMessages) {
      const decoded = decodeText(message)
      // 断言失败只带 seqno/原因，不带真实正文。
      assert.equal(decoded.kind, 'text', 'TEXT 私信正文解码失败：seqno=' + message.msg_seqno + '，原因=' + (decoded.error || '非 TEXT'))
      assert.equal(typeof decoded.text, 'string')
    }
  }

  const order = analyzeOrder(result)
  const messageTypes = {}
  for (const message of messages) {
    const key = String(message.msg_type)
    messageTypes[key] = (messageTypes[key] ?? 0) + 1
  }
  const fieldNames = [...new Set(messages.flatMap((message) => Object.keys(message)))].sort()
  const fieldTypes = Object.fromEntries(fieldNames.map((name) => [
    name,
    [...new Set(messages.map((message) => valueType(message[name])))].sort(),
  ]))

  // 输出只给数量/类型/顺序，不打印任何真实正文。
  t.diagnostic('私信数量：' + messages.length)
  t.diagnostic('消息类型计数：' + JSON.stringify(messageTypes))
  t.diagnostic('字段名：' + fieldNames.join(','))
  t.diagnostic('字段类型：' + JSON.stringify(fieldTypes))
  t.diagnostic('顺序：' + JSON.stringify({
    count: order.count,
    direction: order.direction,
    validSeqnos: order.validSeqnos,
    firstSeqno: order.firstSeqno,
    lastSeqno: order.lastSeqno,
    minMatches: order.minMatches,
    maxMatches: order.maxMatches,
  }))

  assert.equal(order.validSeqnos, true, '存在无法解析的 msg_seqno')
  if (messages.length > 1) {
    assert.notEqual(order.direction, 'mixed', 'dm read 的 msg_seqno 既非正序也非倒序，bridge 无法可靠排序')
    assert.equal(order.minMatches, true, 'min_seqno 与消息集合最小值不一致')
    assert.equal(order.maxMatches, true, 'max_seqno 与消息集合最大值不一致')
  }
  // B 站 dm read 参考实现按最新在前返回；adapter 使用 seqno 排序后按正序转发。
  if (order.direction === 'descending') {
    t.diagnostic('真实返回为最新在前（descending）；adapter 的排序/转发由 test/protocol-driver.mjs 子进程覆盖')
  }

  const unsafeKeys = messages.filter((message) => !Number.isSafeInteger(message.msg_key))
  const unsafeSeqnos = messages.filter((message) => !Number.isSafeInteger(message.msg_seqno))
  if (unsafeKeys.length > 0) {
    t.diagnostic('已知缺口：' + unsafeKeys.length + ' 条 msg_key 超出 JS 安全整数；CLI JSON 数字已可能丢失精度，不能把解析后的 msg_key 当无损唯一键')
  }
  assert.equal(unsafeSeqnos.length, 0, 'msg_seqno 出现超出安全整数的值')

  const afterConfig = await configGet(AGENT_HOME)
  assert.equal(afterConfig.writesEnabled, beforeConfig.writesEnabled, '只读测试改变了 writesEnabled')
  const afterAudit = statOrNull(join(AGENT_HOME, 'audit.jsonl'))
  const sameAudit = (!beforeAudit && !afterAudit) || (
    beforeAudit && afterAudit && beforeAudit.size === afterAudit.size && beforeAudit.mtimeMs === afterAudit.mtimeMs
  )
  assert.equal(sameAudit, true, '只读 dm read 不应写入审计文件')

  const evidence = {
    at: new Date().toISOString(),
    scope: 'real-readonly-dm-contract',
    count: messages.length,
    fieldNames,
    fieldTypes,
    messageTypes,
    order,
    hasMore: result.has_more,
    precision: {
      msgKeyUnsafeCount: unsafeKeys.length,
      msgSeqnoUnsafeCount: unsafeSeqnos.length,
    },
    writesEnabledBefore: beforeConfig.writesEnabled,
    writesEnabledAfter: afterConfig.writesEnabled,
    auditChanged: !sameAudit,
    note: '仅记录数量/字段类型/顺序等元数据，不落盘私信正文或凭证；接口受理/回读不等于接收方已读。',
  }
  writeFileSync(join(ARTIFACTS, 'dm-contract.json'), JSON.stringify(evidence, null, 2) + '\n', 'utf8')
  t.diagnostic('证据：' + join(ARTIFACTS, 'dm-contract.json'))
})
