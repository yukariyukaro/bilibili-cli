import assert from 'node:assert/strict'

// 旧 23 个命令的 name 集合；不把数量写死，避免新增命令时误报。
export const LEGACY_COMMANDS = [
  'auth login start',
  'auth login poll',
  'auth status',
  'video search',
  'video info',
  'video subtitle',
  'video hot',
  'comment list',
  'comment thread',
  'comment create',
  'comment delete',
  'user info',
  'user relation',
  'inbox',
  'dm status',
  'dm read',
  'dm send',
  'config get',
  'config set',
  'doctor',
  'schema',
  'skills list',
  'skills read',
]

export const BRIDGE_COMMANDS = ['bridge run', 'bridge status', 'bridge stop']
export const ALL_COMMANDS = [...LEGACY_COMMANDS, ...BRIDGE_COMMANDS]

export const BRIDGE_RUN_FIELDS = ['ownerUids', 'pollMs', 'statePath', 'url']
export const BRIDGE_STATE_FIELDS = ['statePath']

export function commandByName(schema, name) {
  const command = schema.commands.find((entry) => entry.name === name)
  assert.ok(command, 'schema 缺少命令：' + name)
  return command
}

/**
 * 统一断言命令/帮助/schema/JSONL 共用同一份契约。
 * 旧 23 个命令的字段默认值/枚举/必填保持不变；新增 3 个 bridge 命令按契约。
 */
export function assertSchemaContract(schema, { version } = {}) {
  assert.equal(schema.schemaVersion, 1, 'schemaVersion 必须保持 1')
  if (version !== undefined) assert.equal(schema.version, version, 'schema.version 必须等于 package.version')
  assert.deepEqual(
    schema.commands.map((entry) => entry.name).sort(),
    [...ALL_COMMANDS].sort(),
    'schema 命令集合必须等于旧23个 + bridge三条；skills cleanup 已迁出公开 CLI',
  )

  const run = commandByName(schema, 'bridge run')
  assert.equal(run.stream, true, 'bridge run 必须是唯一 stream 命令')
  assert.deepEqual(Object.keys(run.fields).sort(), BRIDGE_RUN_FIELDS, 'bridge run 字段契约')
  assert.equal(run.fields.ownerUids.type, 'string')
  assert.equal(run.fields.ownerUids.required, undefined, 'ownerUids 可由 BILIBILI_OWNER_UID 环境变量提供，不强制 CLI 必填')
  assert.equal(run.fields.statePath.type, 'string')
  assert.equal(run.fields.url.type, 'string')
  assert.equal(run.fields.pollMs.type, 'integer')
  assert.equal(run.fields.pollMs.minimum, 6000)
  assert.equal(run.fields.pollMs.default, 6000)
  assert.equal(run.fields.pollMs.defaultSource, 'env', 'schema 必须说明 pollMs 默认来自环境变量')
  assert.equal(run.fields.pollMs.env, 'BILIBILI_POLL_MS')
  assert.equal(run.fields.ownerUids.env, 'BILIBILI_OWNER_UID')
  assert.equal(run.fields.url.env, 'CC_CONNECT_BRIDGE_URL')
  assert.equal(Object.hasOwn(run.fields, 'token'), false, 'token 只能走 CC_CONNECT_BRIDGE_TOKEN 环境变量，不能出现在 schema/argv')

  for (const name of ['bridge status', 'bridge stop']) {
    const command = commandByName(schema, name)
    assert.notEqual(command.stream, true, name + ' 是有限请求，不能标记 stream')
    assert.deepEqual(Object.keys(command.fields).sort(), BRIDGE_STATE_FIELDS, name + ' 字段契约')
    assert.equal(command.fields.statePath.type, 'string')
    assert.equal(command.fields.statePath.required, undefined, name + ' 的 statePath 可选，默认账号目录/bridge/state.json')
  }

  for (const entry of schema.commands) {
    if (entry.name !== 'bridge run') assert.notEqual(entry.stream, true, entry.name + ' 不应标记 stream')
  }

  // 旧 23 个命令的字段契约显式回归（防止迁移顺手改默认值/枚举/必填）。
  const expectedLegacyFields = {
    'auth login poll': ['key'],
    'video search': ['keyword', 'num', 'order'],
    'video info': ['bvid'],
    'video subtitle': ['bvid'],
    'video hot': ['page', 'num'],
    'comment list': ['bvid', 'num', 'order'],
    'comment thread': ['bvid', 'rpid', 'page', 'num'],
    'comment create': ['bvid', 'text', 'rpid', 'root', 'confirm', 'dryRun'],
    'comment delete': ['bvid', 'rpid', 'confirm', 'dryRun'],
    'user info': ['uid'],
    'user relation': ['uid'],
    inbox: ['kind', 'cursorId', 'cursorTime'],
    'dm status': ['uid'],
    'dm read': ['uid'],
    'dm send': ['uid', 'text', 'confirm', 'dryRun'],
    'config get': [],
    'config set': ['key', 'value'],
    doctor: ['setup'],
    schema: [],
    'skills list': [],
    'skills read': ['name'],
  }
  for (const [name, fields] of Object.entries(expectedLegacyFields)) {
    const command = commandByName(schema, name)
    assert.deepEqual(Object.keys(command.fields).sort(), [...fields].sort(), name + ' 字段集合回归')
  }
  assert.equal(commandByName(schema, 'video search').fields.num.default, 10)
  assert.equal(commandByName(schema, 'video search').fields.order.default, 'totalrank')
  assert.equal(commandByName(schema, 'video hot').fields.page.default, 1)
  assert.equal(commandByName(schema, 'video hot').fields.num.default, 20)
  assert.equal(commandByName(schema, 'comment list').fields.num.default, 30)
  assert.equal(commandByName(schema, 'comment thread').fields.num.default, 10)
  assert.deepEqual(commandByName(schema, 'config set').fields.key.enum, ['writesEnabled', 'mentionName', 'dmRecipientUid'])
  assert.equal(commandByName(schema, 'dm send').fields.text.maxLength, 300)
  assert.equal(commandByName(schema, 'comment create').fields.text.maxLength, 150)
  return true
}
