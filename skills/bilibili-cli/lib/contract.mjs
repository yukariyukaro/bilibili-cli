export class CliError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message)
    this.code = code
    this.exitCode = exitCode
  }
}

const string = (description, extra = {}) => ({ type: 'string', description, ...extra })
const integer = (description, minimum, maximum, defaultValue) => ({ type: 'integer', description, minimum, maximum, ...(defaultValue === undefined ? {} : { default: defaultValue }) })
const bvid = string('视频 BV 号', { pattern: '^BV[0-9A-Za-z]{10}$', required: true })
const rpid = integer('评论正整数 ID', 1, Number.MAX_SAFE_INTEGER)
const uid = { ...integer('用户 UID', 1, Number.MAX_SAFE_INTEGER), required: true }
const write = { confirm: { type: 'boolean', description: '本次准确目标和正文已经用户确认', default: false }, dryRun: { type: 'boolean', description: '仅预览，不调用接口或写审计', default: false } }

export const commands = [
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
]

export function validate(definition, input, cli = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CliError('VALIDATION', 'args 必须是对象', 2)
  for (const key of Object.keys(input)) if (!Object.hasOwn(definition.fields, key)) throw new CliError('VALIDATION', `未知参数：${key}`, 2)
  const result = {}
  for (const [key, field] of Object.entries(definition.fields)) {
    let value = input[key] === undefined ? field.default : input[key]
    if (value === undefined) {
      if (field.required) throw new CliError('VALIDATION', `缺少参数：${key}`, 2)
      continue
    }
    if (cli && field.type === 'integer' && typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value)) value = Number(value)
    const invalid = field.type === 'integer'
      ? !Number.isSafeInteger(value) || value < field.minimum || value > field.maximum
      : typeof value !== field.type || (field.type === 'string' && (!value.trim() || value.length > (field.maxLength ?? 4096) || (field.pattern && !new RegExp(field.pattern).test(value))))
    if (invalid || (field.enum && !field.enum.includes(value))) throw new CliError('VALIDATION', `参数无效：${key}`, 2)
    result[key] = value
  }
  if (definition.name === 'comment create' && result.root !== undefined && result.rpid === undefined) throw new CliError('VALIDATION', 'root 必须与 rpid 同时使用', 2)
  return result
}

export function envelope(command, result, error, id) {
  return { schemaVersion: 1, ...(id === undefined ? {} : { id }), command, ok: !error, ...(error ? { error: { code: error.code || 'INTERNAL', message: error instanceof CliError ? error.message : '操作失败；请检查运行环境，不要自动重试写操作' } } : { result }) }
}
