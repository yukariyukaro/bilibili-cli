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
  assert.deepEqual(defaults.reply.commentWatch, {
    kinds: ['at', 'reply'],
    pollMs: 60000,
    maxPerPoll: 5,
    minGapMs: 30000,
    maxAgeMinutes: 1440,
    allowUids: [],
    onlyOwnVideos: true,
  }, '评论通知默认：订阅 @ 与回复、每轮 5 条、间隔 30s、只回自有视频')
  config.validateConsoleConfig(defaults)

  // 没有 commentWatch 的旧 v1 配置仍必须可读，并在校验时补默认值。
  const legacy = validConfig()
  assert.equal(Object.hasOwn(legacy.reply, 'commentWatch'), false)
  const filled = config.validateConsoleConfig(legacy)
  assert.deepEqual(filled.reply.commentWatch, defaults.reply.commentWatch, '旧配置必须回填通知默认值')

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
    ['通知类型为空', validConfig({ reply: { commentWatch: { kinds: [] } } })],
    ['未知通知类型', validConfig({ reply: { commentWatch: { kinds: ['like'] } } })],
    ['每轮通知数越界', validConfig({ reply: { commentWatch: { maxPerPoll: 0 } } })],
    ['通知轮询间隔过小', validConfig({ reply: { commentWatch: { pollMs: 1000 } } })],
    ['白名单含非数字 UID', validConfig({ reply: { commentWatch: { allowUids: ['abc'] } } })],
    ['仅自有视频非布尔', validConfig({ reply: { commentWatch: { onlyOwnVideos: 'yes' } } })],
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
test('评论回复按 CLI 契约上限截断，私信仍按 300', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter, COMMENT_TEXT_MAX, DM_TEXT_MAX } = await load(installed, 'adapter')
  assert.equal(COMMENT_TEXT_MAX, 150, '评论上限必须与 comment create 契约一致')
  assert.equal(DM_TEXT_MAX, 300, '私信上限必须与 dm send 契约一致')

  const posted = []
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge([]),
    backend: {
      readDm: async () => [],
      sendDm: async (uid, text) => { posted.push({ kind: 'dm', text }); return { ok: true, audited: true } },
      postComment: async (target, text) => { posted.push({ kind: 'comment', text }); return { ok: true, audited: true } },
    },
    ownerUids: '1',
    confirmSend: async () => true,
    confirmComment: async () => true,
    replyMax: 300,
  })

  const long = '评'.repeat(200)
  const comment = await adapter.handleReply({ content: long, reply_ctx: { kind: 'comment', bvid: 'BV1xx411c7mD' } })
  assert.equal(comment.ok, true)
  assert.equal(posted.at(-1).kind, 'comment')
  assert.equal(posted.at(-1).text.length, 150, '200 字评论回复必须截断到契约上限 150，否则 CLI 会以 VALIDATION 拒绝')
  assert.equal(posted.at(-1).text, long.slice(0, 149) + '…', '截断保留省略号，总长仍等于契约上限')

  const dm = await adapter.handleReply({ content: long, reply_ctx: { kind: 'dm', uid: '1' } })
  assert.equal(dm.ok, true)
  assert.equal(posted.at(-1).kind, 'dm')
  assert.equal(posted.at(-1).text.length, 200, '200 字私信未超 300 上限，不得截断')

  const tooLong = '私'.repeat(350)
  await adapter.handleReply({ content: tooLong, reply_ctx: { kind: 'dm', uid: '1' } })
  assert.equal(posted.at(-1).text.length, 300, '350 字私信必须截断到 300')
})

test('刷视频循环把控制台配置的任务指令与会话标识带进交给 agent 的帧', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')
  const sent = []
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend: {
      readDm: async () => [],
      sendDm: async () => ({ ok: true }),
      videoHot: async () => ({ videos: [{ bvid: 'BV1xx411c7mD', title: '视频' }] }),
      comments: async () => [{ rpid: 7, content: '真实评论' }],
    },
    ownerUids: '1',
    scroll: { source: 'hot', numVideos: 1, commentsPerVideo: 1, avoidTags: '', style: '' },
  })
  await adapter.runScrollCycle({ prompt: '[本地主人配置的 B 站每日任务]\n只看科技区', sessionKey: 'bilibili:daily' })
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /只看科技区/, '配置的任务指令必须进入交给 agent 的帧')
  assert.equal(sent[0].session_key, 'bilibili:daily', '配置的会话标识必须生效')
})

function notifyBackend(overrides = {}) {
  return {
    readDm: async () => [],
    sendDm: async () => ({ ok: true, audited: true }),
    videoInfo: async () => ({ result: { owner: { mid: 1 } } }),
    postComment: async () => ({ ok: true, audited: true }),
    inboxAt: async () => ({ data: { items: [], cursor: null } }),
    inboxReply: async () => ({ data: { items: [], cursor: null } }),
    ...overrides,
  }
}

function atPayload({ id = 9001, time, uid = '777', name = '路人甲', oid = 170001, commentId = 222, rootId = 333, content = '这个视频怎么看？', type = 'video' } = {}) {
  return {
    data: {
      cursor: { is_end: false, id, time },
      items: [{ id, user: { mid: uid, nickname: name }, item: { type, oid, comment_id: commentId, root_id: rootId }, at_time: time, content }],
    },
  }
}

test('main 装配：GatedBackend 只暴露内层真实提供的可选能力', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { GatedBackend } = await load(installed, 'main')

  const calls = []
  const gate = { read: (fn) => fn() }
  const inner = {
    readDm: async () => [],
    sendDm: async () => ({ ok: true }),
    inboxAt: async (cursor) => { calls.push(cursor); return { items: [] } },
    videoInfo: async () => ({ result: { owner: { mid: 1 } } }),
  }
  const gated = new GatedBackend(inner, gate)
  // 真实缺陷回归：此前 GatedBackend 只转发 readDm/sendDm，装配后通知与刷视频能力全部丢失。
  assert.equal(typeof gated.inboxAt, 'function', '内层提供 inboxAt 时必须转发')
  assert.equal(typeof gated.videoInfo, 'function', '内层提供 videoInfo 时必须转发')
  assert.equal(gated.videoHot, undefined, '内层没有的能力不能凭空出现，否则能力探测会误判')
  assert.equal(gated.comments, undefined)
  assert.equal(gated.postComment, undefined)
  await gated.inboxAt({ id: null, time: null })
  assert.equal(calls.length, 1, '转发必须调用内层实现')
})

test('通知归一化：真实 msgfeed/at 形状（动态 @）可解析且被正确归类', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { parseInbox } = await load(installed, 'notifications')

  // 2026-10-27 用真实账号抓取的 inbox at 结构（昵称与正文已替换，字段名与会话一致）。
  // 真实样本：4 条全部是 dynamic @，business_id 有 0 与 11，subject_id 才是动态 ID。
  const payload = {
    cursor: { is_end: true, id: 1183497415008262, time: 1792418285 },
    items: [{
      id: 1183506181333027,
      user: { mid: 3707017736752090, nickname: '某网友' },
      item: {
        type: 'dynamic',
        business: '动态',
        business_id: 11,
        title: '标题',
        subject_id: 412727015,
        root_id: 0,
        target_id: 0,
        source_id: 0,
        source_content: '在动态里 @ 我',
        uri: 'https://www.bilibili.com/opus/1',
      },
      at_time: 1792419329,
    }],
  }
  const parsed = parseInbox('at', payload)
  assert.equal(parsed.unparsed, 0)
  assert.equal(parsed.items.length, 1)
  const item = parsed.items[0]
  assert.equal(item.target.type, 'dynamic', '动态 @ 必须归类为 dynamic，绝不能当成视频')
  assert.equal(item.target.oid, '412727015', 'business_id 为 0/11 时不能当目标，应取 subject_id')
  assert.equal(item.target.bvid, null)
  assert.equal(item.text, '在动态里 @ 我', '正文从 item.source_content 取')
  assert.equal(item.uid, '3707017736752090')
  assert.equal(item.time, 1792419329)
  assert.equal(parsed.cursor.id, '1183497415008262', '游标 ID 必须按十进制字符串保留')
  assert.equal(parsed.cursor.isEnd, true)

  // type 为空但 business 写“动态”时也必须识别，避免把动态 @ 当视频回复。
  const businessOnly = parseInbox('at', { items: [{ id: 1, user: { mid: 2, nickname: 'x' }, item: { business: '动态', subject_id: 3 }, at_time: 4 }] })
  assert.equal(businessOnly.items[0].target.type, 'dynamic')

  // 2026-10-27 双账号真实闭环中的视频评论 @ 形状（账号/正文已替换，字段名保持原样）：
  // type=reply、business=评论、subject_id=aid、source_id=评论 rpid、root_id=0。
  const realVideoAt = parseInbox('at', {
    items: [{
      id: 1189449921175557,
      user: { mid: 39374538, nickname: '某UP' },
      item: {
        type: 'reply',
        business: '评论',
        business_id: 1,
        title: '视频标题',
        uri: 'https://www.bilibili.com/video/BV1qknH61EoH',
        subject_id: 117484921292400,
        root_id: 0,
        target_id: 0,
        source_id: 322101393024,
        source_content: '@机器人 测试',
        at_details: [{ mid: 3747572327909430, nickname: '机器人' }],
      },
      at_time: 1793127872,
    }],
  })
  const video = realVideoAt.items[0]
  assert.equal(video.target.type, 'video', '真实视频评论 @ 必须归为 video')
  assert.equal(video.target.bvid, 'BV1qknH61EoH', 'subject_id 是 aid，必须换算成 bvid')
  assert.equal(video.target.rpid, 322101393024, 'source_id 是目标评论 rpid')
  assert.equal(video.target.root, null, 'root_id=0 表示根评论，不能当成有效 root')
  assert.equal(video.text, '@机器人 测试')
  assert.equal(video.uid, '39374538')
})

test('评论通知：@ 入站成帧携带精确目标，重启后不重复入队', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')

  const now = Math.floor(Date.now() / 1000)
  const sent = []
  let atCalls = 0
  let saved = null
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend: notifyBackend({ inboxAt: async () => { atCalls += 1; return atPayload({ time: now - 30 }) } }),
    ownerUids: '1',
    commentWatchEnabled: true,
    commentWatch: { minGapMs: 0 },
    saveState: (next) => { saved = next },
  })

  assert.equal((await adapter.pollOnce({ force: true })).forwarded, 1)
  assert.equal(atCalls, 1, '启用后必须真的轮询 @ 通知')
  assert.equal(sent.length, 1)
  const frame = sent[0]
  assert.equal(frame.source.surface, 'comment')
  assert.equal(frame.source.untrusted, true)
  assert.equal(frame.session_key, 'bilibili:comment:BV17x411w7KC', '同一视频的会话应可复用')
  assert.deepEqual(JSON.parse(frame.reply_ctx), {
    kind: 'comment',
    bvid: 'BV17x411w7KC',
    rpid: 222,
    root: 333,
  }, 'aid 必须换算成 bvid，并带上准确的 rpid/root')
  assert.match(frame.content, /路人甲/)
  assert.match(frame.content, /这个视频怎么看？/)
  assert.equal(adapter.getState().notifications.at.id, '9001', '游标必须推进到已处理条目')
  assert.ok(saved, '入队后必须落盘状态')

  const restarted = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend: notifyBackend({ inboxAt: async () => atPayload({ time: now - 30 }) }),
    ownerUids: '1',
    commentWatchEnabled: true,
    commentWatch: { minGapMs: 0 },
    state: saved,
  })
  await restarted.pollOnce({ force: true })
  assert.equal(sent.length, 1, '同一通知重启后不得重复投递')
})

test('评论通知：off 不轮询、draft 不发送、时间窗与白名单与自有视频闸门', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')

  const now = Math.floor(Date.now() / 1000)
  let atCalls = 0
  const off = new BilibiliBridgeAdapter({
    bridge: fakeBridge([]),
    backend: notifyBackend({ inboxAt: async () => { atCalls += 1; return atPayload({ time: now }) } }),
    ownerUids: '1',
  })
  await off.pollOnce({ force: true })
  assert.equal(atCalls, 0, 'commentPolicy=off 时不得轮询通知')

  const sent = []
  const posted = []
  const draft = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend: notifyBackend({
      inboxAt: async () => atPayload({ time: now - 10 }),
      postComment: async (target, text) => { posted.push({ target, text }); return { ok: true, audited: true } },
    }),
    ownerUids: '1',
    commentWatchEnabled: true,
    commentWatch: { minGapMs: 0 },
    confirmComment: async () => false,
  })
  await draft.pollOnce({ force: true })
  assert.equal(sent.length, 1, 'draft 仍要把通知交给 agent')
  const reply = await draft.handleReply({ content: '值得一看', reply_ctx: JSON.parse(sent[0].reply_ctx) })
  assert.equal(reply.ok, false)
  assert.equal(reply.reason, 'not_confirmed')
  assert.equal(posted.length, 0, 'draft 不得真实写评论')

  const cases = [
    ['通知超过有效期', { maxAgeMinutes: 1 }, atPayload({ id: 8001, time: now - 3600 })],
    ['评论者不在白名单', { allowUids: ['999'] }, atPayload({ id: 8002, time: now - 10 })],
    ['动态 @ 不支持', {}, atPayload({ id: 8003, time: now - 10, type: 'dynamic' })],
    ['缺少 rpid', {}, atPayload({ id: 8004, time: now - 10, commentId: 0 })],
    // 动态/专栏的 oid 超出 51 位 aid 范围，不能被 aid2bvid 编成一个看似合法的 BV。
    ['oid 不是视频 aid', {}, atPayload({ id: 8007, time: now - 10, oid: 1100000000000000000, type: 'reply' })],
  ]
  for (const [label, watch, payload] of cases) {
    const frames = []
    const adapter = new BilibiliBridgeAdapter({
      bridge: fakeBridge(frames),
      backend: notifyBackend({ inboxAt: async () => payload }),
      ownerUids: '1',
      commentWatchEnabled: true,
      commentWatch: { minGapMs: 0, ...watch },
    })
    await adapter.pollOnce({ force: true })
    assert.equal(frames.length, 0, label + '：不得产生帧')
  }

  const foreignFrames = []
  const foreign = new BilibiliBridgeAdapter({
    bridge: fakeBridge(foreignFrames),
    backend: notifyBackend({
      inboxAt: async () => atPayload({ id: 8005, time: now - 10 }),
      videoInfo: async () => ({ result: { owner: { mid: 2 } } }),
    }),
    ownerUids: '1',
    commentWatchEnabled: true,
    commentWatch: { minGapMs: 0, onlyOwnVideos: true },
  })
  await foreign.pollOnce({ force: true })
  assert.equal(foreignFrames.length, 0, 'onlyOwnVideos=true 时别人视频下的 @ 不得回复')

  const allowedFrames = []
  const allowed = new BilibiliBridgeAdapter({
    bridge: fakeBridge(allowedFrames),
    backend: notifyBackend({
      inboxAt: async () => atPayload({ id: 8006, time: now - 10 }),
      videoInfo: async () => ({ result: { owner: { mid: 2 } } }),
    }),
    ownerUids: '1',
    commentWatchEnabled: true,
    commentWatch: { minGapMs: 0, onlyOwnVideos: false },
  })
  await allowed.pollOnce({ force: true })
  assert.equal(allowedFrames.length, 1, 'onlyOwnVideos=false 时允许回复他人视频下的 @')
})

test('评论通知：每轮条数截断只推进已处理游标，剩余留到下一轮', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')

  const now = Math.floor(Date.now() / 1000)
  const payload = (time) => ({
    data: {
      cursor: { is_end: false, id: 9100, time },
      items: [
        { id: 9100, user: { mid: '777', nickname: '甲' }, item: { type: 'video', oid: 170001, comment_id: 1001 }, at_time: time, content: '第一条' },
        { id: 9101, user: { mid: '778', nickname: '乙' }, item: { type: 'video', oid: 170001, comment_id: 1002 }, at_time: time + 1, content: '第二条' },
      ],
    },
  })
  let saved = null
  const sent = []
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend: notifyBackend({ inboxAt: async () => payload(now - 60) }),
    ownerUids: '1',
    commentWatchEnabled: true,
    commentWatch: { minGapMs: 0, maxPerPoll: 1 },
    saveState: (next) => { saved = next },
  })
  await adapter.pollOnce({ force: true })
  assert.equal(sent.length, 1, 'maxPerPoll=1 时每轮只处理一条')
  assert.equal(adapter.getState().notifications.at, null, '被截断时不得采用上游游标：上游 id 是游标而不是条目 ID，提前采用会跳过未处理通知')
  assert.equal(adapter.getState().pending.length, 0, '已处理条目不应残留在 pending')

  const second = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend: notifyBackend({ inboxAt: async () => payload(now - 60) }),
    ownerUids: '1',
    commentWatchEnabled: true,
    commentWatch: { minGapMs: 0, maxPerPoll: 1 },
    state: saved,
  })
  await second.pollOnce({ force: true })
  assert.equal(sent.length, 2, '下一轮必须处理剩余通知：靠 seen 去重跳过已处理项')
  assert.equal(second.getState().notifications.at.id, '9100', '整页处理完后采用上游游标 ID')
})

test('状态迁移：v1 state 可读，pending 迁移为 dm 通道', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')

  const sent = []
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge(sent),
    backend: notifyBackend(),
    ownerUids: '1',
    state: {
      version: 1,
      conversations: {},
      pending: [{
        id: 'm1', uid: '1', name: '主人', content: '旧消息',
        seqno: null, timestamp: null, key: null, skipReason: null, created_at: null,
      }],
      seen: [],
    },
  })
  assert.equal(adapter.getState().version, 2, 'v1 state 必须迁移到 v2')
  assert.equal(adapter.getState().pending[0].surface, 'dm')
  assert.equal(adapter.getState().pending[0].target, null)
  await adapter.pollOnce({ force: true })
  assert.equal(sent.length, 1, '迁移后的旧 pending 仍必须投递')
  assert.equal(JSON.parse(sent[0].reply_ctx).kind, 'dm')
})

test('评论回复：root 透传给 CLI，非法 root 直接拒绝', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const { BilibiliBridgeAdapter } = await load(installed, 'adapter')

  const posted = []
  const adapter = new BilibiliBridgeAdapter({
    bridge: fakeBridge([]),
    backend: notifyBackend({ postComment: async (target, text) => { posted.push({ target, text }); return { ok: true, audited: true } } }),
    ownerUids: '1',
    confirmComment: async () => true,
  })
  const ok = await adapter.handleReply({ content: '楼中楼回复', reply_ctx: { kind: 'comment', bvid: 'BV1xx411c7mD', rpid: 42, root: 7 } })
  assert.equal(ok.ok, true)
  assert.deepEqual(posted[0].target, { bvid: 'BV1xx411c7mD', rpid: 42, root: 7 }, 'root 必须透传给 comment create')

  const badRoot = await adapter.handleReply({ content: 'x', reply_ctx: { kind: 'comment', bvid: 'BV1xx411c7mD', root: 7 } })
  assert.equal(badRoot.ok, false, '没有 rpid 却给 root 必须拒绝，不能退化成顶层评论')
  assert.equal(posted.length, 1)
})

