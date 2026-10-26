import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { installedOrSkip } from './lib/env.mjs'
import { installedBridgeModule } from '../lib/env.mjs'

async function load(installed, name) {
  const file = installedBridgeModule(installed, name.endsWith('.mjs') ? name : name + '.mjs')
  return import(pathToFileURL(file).href)
}

function validConfig(overrides = {}) {
  return {
    version: 1,
    connection: { url: 'ws://127.0.0.1:9810/bridge/ws', ownerUids: ['1'], pollMs: 6000, maxPolls: 0, ...overrides.connection },
    reply: { policy: 'off', maxLength: 300, maxReplies: 10, commentPolicy: 'off', commentMaxReplies: 3, style: '', ...overrides.reply },
    scroll: { enabled: true, source: 'hot', keywords: '', numVideos: 5, readComments: true, commentsPerVideo: 10, readSubtitles: true, preferTags: '', avoidTags: '', reportDirectory: 'r', ...overrides.scroll },
    schedule: { enabled: false, time: '09:00', timeZone: 'Asia/Shanghai', weekdays: [1, 2, 3, 4, 5, 6, 7], ...overrides.schedule },
    notification: { channel: 'none', ownerUid: '', mentionName: '', bvid: '', ...overrides.notification },
    agent: { sessionKey: 'bilibili:daily', prompt: 'p', ...overrides.agent },
  }
}

test('控制台配置：默认值、revision 与拒绝非法输入', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const config = await load(installed, 'web-config')

  const defaults = config.defaultConsoleConfig()
  assert.equal(defaults.version, 1)
  assert.equal(defaults.reply.policy, 'off', '默认不自动回复')
  assert.equal(defaults.reply.commentPolicy, 'off', '默认不自动评论')
  assert.equal(defaults.schedule.enabled, false)
  config.validateConsoleConfig(defaults)

  const first = config.configRevision(defaults)
  assert.equal(config.configRevision(structuredClone(defaults)), first, '同内容 revision 必须稳定')
  const changed = structuredClone(defaults)
  changed.connection.pollMs = 7000
  assert.notEqual(config.configRevision(changed), first, '内容变化必须改变 revision')

  const rejects = [
    ['未知顶层字段', { ...validConfig(), extra: 1 }],
    ['轮询间隔过小', validConfig({ connection: { pollMs: 1 } })],
    ['时区非法', validConfig({ schedule: { timeZone: 'Not/AZone' } })],
    ['星期越界', validConfig({ schedule: { weekdays: [0, 8] } })],
    ['时间格式非法', validConfig({ schedule: { time: '9:00' } })],
    ['通知 UID 不在白名单', validConfig({ notification: { channel: 'dm', ownerUid: '2' } })],
    ['评论通知缺少 BV 号', validConfig({ notification: { channel: 'comment', ownerUid: '1', mentionName: 'x' } })],
    ['未知回复策略', validConfig({ reply: { policy: 'always' } })],
  ]
  for (const [label, value] of rejects) {
    assert.throws(() => config.validateConsoleConfig(value), /.*/u, label + ' 必须被拒绝')
  }
})

test('定时计算：关闭返回 null，开启给出未来且匹配星期的时刻', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const config = await load(installed, 'web-config')

  assert.equal(config.nextScheduledRun(validConfig(), new Date('2026-10-26T00:00:00Z')), null, '未启用时必须为 null')

  const enabled = validConfig({ schedule: { enabled: true, time: '09:30', weekdays: [1] } })
  const now = new Date('2026-10-25T02:00:00Z') // 周日 10:00 +08
  const next = config.nextScheduledRun(enabled, now)
  assert.ok(next, '必须算出下一次运行')
  assert.ok(new Date(next) > now, '必须是未来时刻')
  assert.equal(new Date(next).getUTCDay() === 1 || new Date(next).getUTCDay() === 0, true, '必须落在配置的星期（UTC 视图差异容忍）')

  const daily = validConfig({ schedule: { enabled: true, time: '00:30', weekdays: [1, 2, 3, 4, 5, 6, 7] } })
  const lateNight = config.nextScheduledRun(daily, new Date('2026-10-25T15:45:00Z')) // 23:45 +08
  assert.ok(lateNight, '跨日必须能算出下一次')
  assert.ok(new Date(lateNight) > new Date('2026-10-25T15:45:00Z'))
})

function fakeBridge(sent) {
  return {
    platform: 'bilibili',
    isRegistered: () => true,
    async sendMessage(frame) { sent.push(frame); return true },
  }
}

test('评论回复：策略拒绝、目标校验、上限与成功落评论', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')

  const posted = []
  const backend = {
    readDm: async () => [],
    sendDm: async () => ({ ok: true }),
    postComment: async (target, text) => { posted.push({ target, text }); return { ok: true, audited: true } },
  }
  const sent = []
  let allow = false
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend,
    ownerUids: '1',
    confirmSend: async () => false,
    confirmComment: async () => allow,
    commentMaxReplies: 1,
  })

  const dm = await adapter.handleReply({ content: 'hi', reply_ctx: { kind: 'dm', uid: '1' } })
  assert.equal(dm.ok, false, '未确认的私信回复必须被拒绝')

  const denied = await adapter.handleReply({ content: '评论', reply_ctx: { kind: 'comment', bvid: 'BV1xx411c7mD' } })
  assert.equal(denied.ok, false)
  assert.equal(posted.length, 0, '策略拒绝时不得写入')

  assert.equal((await adapter.handleReply({ content: 'x', reply_ctx: { kind: 'comment', bvid: 'bad' } })).ok, false)
  assert.equal((await adapter.handleReply({ content: 'x', reply_ctx: { kind: 'other' } })).ok, false)

  allow = true
  const ok = await adapter.handleReply({ content: '这条是回复', reply_ctx: { kind: 'comment', bvid: 'BV1xx411c7mD', rpid: 42 } })
  assert.equal(ok.ok, true, '策略允许时必须落为评论')
  assert.deepEqual(posted[0].target, { bvid: 'BV1xx411c7mD', rpid: 42 })
  assert.equal(posted[0].text, '这条是回复')
  assert.equal(adapter.stats.comments, 1)

  const overLimit = await adapter.handleReply({ content: '再来一条', reply_ctx: { kind: 'comment', bvid: 'BV1xx411c7mD' } })
  assert.equal(overLimit.ok, false, '超过评论上限必须拒绝')
  assert.equal(posted.length, 1)
})

test('刷视频循环：按评论目标投递、遵守屏蔽标签、缺能力时如实失败', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')

  const sent = []
  const backend = {
    readDm: async () => [],
    sendDm: async () => ({ ok: true }),
    videoHot: async () => ({ videos: [
      { bvid: 'BV1xx411c7mD', title: '想看的视频', tname: '生活' },
      { bvid: 'BV1yy411c7mE', title: '不想看的视频', tname: '鬼畜' },
    ] }),
    comments: async () => [{ rpid: 7, content: '真实评论' }],
  }
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend,
    ownerUids: '1',
    scroll: { source: 'hot', numVideos: 5, commentsPerVideo: 5, avoidTags: '鬼畜', style: '简短' },
  })
  const summary = await adapter.runScrollCycle()
  assert.equal(summary.videos, 2)
  assert.equal(summary.offered, 1, '被屏蔽的视频不得投递')
  assert.equal(sent.length, 1)
  const frame = sent[0]
  assert.equal(frame.source.surface, 'comment')
  assert.equal(frame.source.untrusted, true)
  assert.match(frame.content, /BV1xx411c7mD/)
  assert.match(frame.content, /真实评论/)
  const ctx = JSON.parse(frame.reply_ctx)
  assert.equal(ctx.kind, 'comment')
  assert.equal(ctx.rpid, 7)

  const noCapability = new BilibiliBridgeAdapter({ bridge: fakeBridge([]), backend: { readDm: async () => [], sendDm: async () => ({}) }, ownerUids: '1' })
  const empty = await noCapability.runScrollCycle()
  assert.equal(empty.offered, 0)
  assert.equal(empty.readFailures, 1, '缺少视频能力必须如实记为读取失败')
})
