import type { CommandDefinition, FieldDefinition, IntegerFieldDefinition, StringFieldDefinition, ValidatedArgs } from './cli-types.mjs'
import { isRecord } from './cli-types.mjs'
import { featureCommands } from './feature-contract.mjs'

export class CliError extends Error {
  readonly code: string
  readonly exitCode: number

  constructor(code: string, message: string, exitCode = 1) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

const string = (description: string, extra: Partial<Omit<StringFieldDefinition, 'type' | 'description'>> = {}): StringFieldDefinition => ({ type: 'string', description, ...extra })
const integer = (description: string, minimum: number, maximum: number, defaultValue?: number): IntegerFieldDefinition => ({ type: 'integer', description, minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) })
const bvid: FieldDefinition = string('视频 BV 号', { pattern: '^BV[0-9A-Za-z]{10}$', required: true })
const rpid: FieldDefinition = integer('评论正整数 ID', 1, Number.MAX_SAFE_INTEGER)
const uid: FieldDefinition = { ...integer('用户 UID', 1, Number.MAX_SAFE_INTEGER), required: true }
const write: Record<string, FieldDefinition> = { confirm: { type: 'boolean', description: '本次准确目标和正文已经用户确认', default: false }, dryRun: { type: 'boolean', description: '仅预览，不调用接口或写审计', default: false } }

export const commands: CommandDefinition[] = [
  ...featureCommands,
  { name: 'auth login start', description: '生成扫码登录二维码', fields: {} },
  { name: 'auth login poll', description: '轮询一次扫码状态', fields: { key: string('二维码 key', { required: true }) } },
  { name: 'auth status', description: '检查账户登录状态', tool: 'auth_status', fields: {} },
  { name: 'video search', description: '搜索视频', tool: 'search', fields: { keyword: string('搜索关键词', { required: true }), num: integer('结果数量', 1, 50, 10), order: string('排序', { enum: ['totalrank', 'click', 'pubdate', 'dm'], default: 'totalrank' }) } },
  { name: 'video info', description: '查看视频信息', tool: 'video_info', fields: { bvid } },
  { name: 'video subtitle', description: '读取视频完整字幕', tool: 'subtitle', fields: { bvid } },
  { name: 'video hot', description: '读取热门视频', tool: 'hot_videos', fields: { page: integer('页码', 1, 1000, 1), num: integer('结果数量', 1, 50, 20) } },
  { name: 'comment list', description: '读取视频评论', tool: 'comments', fields: { bvid, num: integer('结果数量', 1, 100, 30), order: string('排序', { enum: ['like', 'time'], default: 'like' }) } },
  { name: 'comment thread', description: '读取指定根评论的楼中楼', tool: 'comment_thread', fields: { bvid, rpid: { ...rpid, required: true }, page: integer('页码', 1, 1000, 1), num: integer('结果数量', 1, 20, 10) } },
  { name: 'comment create', description: '发送经本次确认的评论或回复', tool: 'reply', write: true, fields: { bvid, text: string('最终正文', { required: true, maxLength: 150 }), rpid, root: { ...rpid, description: '回复楼中楼时所属根评论 ID，必须同时指定 rpid' }, ...write } },
  { name: 'comment delete', description: '删除经本次确认的评论，不可自动重试', tool: 'delete', write: true, fields: { bvid, rpid: { ...rpid, required: true }, ...write } },
  { name: 'user info', description: '查看用户公开资料', tool: 'user_info', fields: { uid } },
  { name: 'user relation', description: '查看与用户的关系', tool: 'user_relation', fields: { uid } },
  { name: 'inbox', description: '读取回复、点赞或 @ 通知单页', tool: 'inbox', fields: { kind: string('通知类型', { enum: ['reply', 'like', 'at'], required: true }), cursorId: integer('分页 ID 游标', 0, Number.MAX_SAFE_INTEGER, 0), cursorTime: integer('分页时间游标', 0, Number.MAX_SAFE_INTEGER, 0) } },
  { name: 'dm status', description: '读取与指定用户的互关关系及未读计数', tool: 'dm_status', fields: { uid } },
  { name: 'dm read', description: '单次读取指定会话消息，最多 30 条', tool: 'dm_latest', fields: { uid } },
  { name: 'dm send', description: '向已确认互关的用户发送经本次确认的纯文本私信', tool: 'dm_send', write: true, fields: { uid, text: string('最终正文', { required: true, maxLength: 300 }), ...write } },
  { name: 'config get', description: '读取非敏感配置', fields: {} },
  { name: 'config set', description: '设置单个白名单配置项', fields: { key: string('配置键', { required: true, enum: ['writesEnabled', 'mentionName', 'dmRecipientUid'] }), value: string('配置值（writesEnabled 仅 true/false；dmRecipientUid 为正整数，非空时限定私信收件人）', { required: true }) } },
  { name: 'doctor', description: '检查运行环境与内置依赖（@yukariyukaro/bilibili-api-ts）', fields: { setup: { type: 'boolean', description: '输出运行时库版本与依赖状态', default: false } } },
  { name: 'schema', description: '输出版本化命令契约', fields: {} },
  { name: 'skills list', description: '列出随 CLI 交付的技能', fields: {} },
  { name: 'skills read', description: '读取技能指导', fields: { name: string('技能名', { default: 'bilibili-cli', enum: ['bilibili-cli'] }) } },
  {
    name: 'bridge run',
    description: '启动长期 bridge 监听（长期事件流，不作为普通 JSON/JSONL 请求）',
    stream: true,
    fields: {
      statePath: string('bridge 状态文件路径；默认账号目录内 bridge/state.json'),
      ownerUids: string('允许的 B 站账号 UID，逗号分隔正安全整数；未传时读取 BILIBILI_OWNER_UID', { pattern: '^[1-9][0-9]*(?:,[1-9][0-9]*)*$', env: 'BILIBILI_OWNER_UID' }),
      url: string('cc-connect bridge WebSocket 地址，仅 ws:// 或 wss://；未传时读取 CC_CONNECT_BRIDGE_URL', { pattern: '^wss?://', env: 'CC_CONNECT_BRIDGE_URL' }),
      pollMs: { type: 'integer', description: '轮询间隔毫秒，最小 6000；未传时读取 BILIBILI_POLL_MS，再回退 6000', minimum: 6000, maximum: 2147483647, default: 6000, defaultSource: 'env', env: 'BILIBILI_POLL_MS' },
      configPath: string('Web 控制台配置文件路径；显式提供时读取控制台配置'),
    },
  },
  {
    name: 'bridge web',
    description: '启动本机 Web 控制台（仅 127.0.0.1）',
    stream: true,
    fields: {
      port: integer('本机控制台端口', 0, 65535, 9820),
      configPath: string('控制台配置文件路径；默认 bridge/console.json'),
      statePath: string('bridge 状态文件路径；默认账号目录内 bridge/state.json'),
    },
  },
  { name: 'bridge status', description: '读取已运行 bridge 的有限状态', fields: { statePath: string('bridge 状态文件路径；默认账号目录内 bridge/state.json') } },
  { name: 'bridge stop', description: '请求已运行 bridge 优雅停止', fields: { statePath: string('bridge 状态文件路径；默认账号目录内 bridge/state.json') } },
  {
    name: 'bridge console get',
    description: '读取本机控制台配置（定时任务、下次执行时间与 revision）',
    fields: {
      configPath: string('控制台配置文件路径；默认 bridge/console.json'),
      statePath: string('bridge 状态文件路径；默认账号目录内 bridge/state.json'),
    },
  },
  {
    name: 'bridge console set',
    description: '修改本机控制台配置（定时任务、刷视频与任务指令）；保存后需重启 bridge 才生效',
    fields: {
      configPath: string('控制台配置文件路径；默认 bridge/console.json'),
      statePath: string('bridge 状态文件路径；默认账号目录内 bridge/state.json'),
      expectRevision: string('期望的配置 revision；与实际不一致时拒绝写入，避免覆盖别的页面或进程的修改'),
      scheduleEnabled: { type: 'boolean', description: '是否启用定时任务' },
      scheduleTime: string('每日执行时间，24 小时制 HH:MM', { pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' }),
      scheduleTimeZone: string('IANA 时区，例如 Asia/Shanghai', { pattern: '^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*$' }),
      scheduleWeekdays: string('每周执行日，1=周一 … 7=周日，逗号分隔', { pattern: '^[1-7](?:,[1-7])*$' }),
      scrollEnabled: { type: 'boolean', description: '刷视频任务开关；关闭时即使定时开启也不会执行' },
      agentPrompt: string('交给外部 agent 的任务指令', { maxLength: 8000 }),
      agentSessionKey: string('外部 agent 的会话标识'),
    },
  },
]

export function validate(definition: CommandDefinition, input: unknown, cli = false): ValidatedArgs {
  if (!isRecord(input)) throw new CliError('VALIDATION', 'args 必须是对象', 2)
  for (const key of Object.keys(input)) if (!Object.hasOwn(definition.fields, key)) throw new CliError('VALIDATION', `未知参数：${key}`, 2)
  const result: ValidatedArgs = {}
  for (const [key, field] of Object.entries(definition.fields)) {
    let value: unknown = input[key] === undefined ? field.default : input[key]
    if (value === undefined) {
      if (field.required) throw new CliError('VALIDATION', `缺少参数：${key}`, 2)
      continue
    }
    if (cli && field.type === 'integer' && typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) value = Number(value)
    let invalid: boolean
    if (field.type === 'integer') {
      invalid = typeof value !== 'number' || !Number.isSafeInteger(value) || value < field.minimum || value > field.maximum
    } else if (field.type === 'boolean') {
      invalid = typeof value !== 'boolean'
    } else {
      invalid = typeof value !== 'string' || !value.trim() || value.length > (field.maxLength ?? 4096) || (field.pattern !== undefined && !new RegExp(field.pattern).test(value))
      if (!invalid && field.enum !== undefined) invalid = typeof value !== 'string' || !field.enum.includes(value)
    }
    if (invalid) throw new CliError('VALIDATION', `参数无效：${key}`, 2)
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') throw new CliError('VALIDATION', `参数无效：${key}`, 2)
    result[key] = value
  }
  if (definition.name === 'comment create' && result.root !== undefined && result.rpid === undefined) throw new CliError('VALIDATION', 'root 必须与 rpid 同时使用', 2)
  if (definition.name === 'bridge run') validateBridgeRun(result)
  for (const key of ['mediaIds', 'ids', 'aids']) {
    const value = result[key]
    if (typeof value === 'string') {
      const ids = value.split(',')
      if (ids.length > 20 || ids.some(id => !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
        throw new CliError('VALIDATION', '参数无效：' + key + '（最多20个正安全整数）', 2)
      }
    }
  }
  return result
}

function validateBridgeRun(result: ValidatedArgs): void {
  const ownerUids = result.ownerUids
  if (typeof ownerUids === 'string') {
    const invalid = ownerUids.split(',').find((value) => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    if (invalid !== undefined) throw new CliError('VALIDATION', '参数无效：ownerUids（逗号分隔的正安全整数）', 2)
  }
  const url = result.url
  if (typeof url === 'string') {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new CliError('VALIDATION', '参数无效：url（必须是合法 ws:// 或 wss:// 地址）', 2)
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new CliError('VALIDATION', '参数无效：url（必须是合法 ws:// 或 wss:// 地址）', 2)
  }
}

export interface ErrorBody {
  code: string
  message: string
}

export interface Envelope {
  schemaVersion: 1
  id?: string | number
  command: string | null
  ok: boolean
  result?: unknown
  error?: ErrorBody
}

export function errorCodeOf(error: unknown): string {
  if (error instanceof CliError) return error.code
  if (isRecord(error) && typeof error.code === 'string' && error.code) return error.code
  return 'INTERNAL'
}

function errorBody(error: unknown): ErrorBody {
  if (error instanceof CliError) return { code: error.code, message: error.message }
  return { code: errorCodeOf(error), message: '操作失败；请检查运行环境，不要自动重试写操作' }
}

export function envelope(command: string | null, result: unknown, error: unknown = null, id?: string | number): Envelope {
  return {
    schemaVersion: 1,
    ...(id === undefined ? {} : { id }),
    command,
    ok: !error,
    ...(error ? { error: errorBody(error) } : { result }),
  }
}
