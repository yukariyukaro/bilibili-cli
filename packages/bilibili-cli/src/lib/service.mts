/**
 * src/lib/service.mts —— 通过 @yukariyukaro/bilibili-api-ts 实现的内部服务层。
 *
 * 这里不启动子进程、不走 MCP，只把 CLI 的命令映射到 npm 包公开的函数，
 * 并把返回值整理成稳定的 JSON 结构。凭证只从状态目录读取，不写日志。
 *
 * 上游库的返回签名是 any；本文件在每次调用点显式落到 unknown，再用
 * service-types 的守卫读取字段，避免 any 扩散，同时保留旧实现的字段名与兜底值。
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  Comment,
  CommentResourceType,
  Credential,
  EventType,
  OrderType,
  OrderVideo,
  SearchObjectType,
  User,
  Video,
  aid2bvid,
  fetch_session_msgs,
  get_at,
  get_comments,
  get_hot_videos,
  get_likes,
  get_replies,
  get_self_info,
  get_unread_messages,
  search_by_type,
  send_comment,
  send_msg,
} from '@yukariyukaro/bilibili-api-ts'
import { CliError } from './contract.mjs'
import { credentialFile } from './portable.mjs'
import type { CommentItem, Service, SubReply } from './service-types.mjs'
import {
  isRecord,
  nullishOr,
  stringOrEmpty,
  toNullableText,
  toNumber,
  toOptionalNumber,
  toRecord,
} from './service-types.mjs'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** runtime.call 的 params 来自已校验的命令契约；防御性收窄到旧实现使用的类型。 */
function paramText(params: Record<string, unknown>, key: string, fallback = ''): string {
  const value = params[key]
  return typeof value === 'string' ? value : fallback
}

function paramNumber(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 旧实现的 `??` 链：只跳过 null/undefined，保留其余原始值。 */
function definedOrEmpty(...candidates: unknown[]): unknown {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null) return candidate
  }
  return {}
}

/** 旧实现用 `?? []` 的字段：null/undefined 视为空列表；非数组响应必须失败，不能伪装成空结果。 */
function responseList(value: unknown, field: string): unknown[] {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value
  throw new CliError('BACKEND', `后端响应格式异常：${field} 不是数组`, 1)
}

/** 需要 aid 才能定位视频的命令；缺失时明确失败，避免用 0 继续请求造成伪成功。 */
function requireVideoAid(info: unknown): number {
  const aid = toOptionalNumber(toRecord(info).aid)
  if (aid === undefined) throw new CliError('BACKEND', '无法确认视频 aid', 1)
  return aid
}

/** 旧实现 `item?.aid ? aid2bvid(item.aid) : ''` 的入参兼容；数字/数字字符串均按 Number 处理。 */
function aidToBvid(value: unknown): string {
  return aid2bvid(Number(value))
}

/** 旧实现 `value?.length ?? 0` 的逐字语义。 */
function lengthOrZero(value: unknown): unknown {
  if (typeof value === 'string' || Array.isArray(value)) return value.length
  if (typeof value === 'object' && value !== null) return nullishOr(toRecord(value).length, 0)
  return 0
}

/** 旧实现 `value?.[0]` 的逐字语义（数组/字符串/带 "0" 属性的对象）。 */
function firstOrUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value[0]
  if (typeof value === 'string') return value[0]
  if (typeof value === 'object' && value !== null) return toRecord(value)['0']
  return undefined
}

function loadCredential(dir: string): Credential | null {
  const file = credentialFile(dir)
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  const raw = parsed
  return new Credential({
    sessdata: toNullableText(raw.sessdata),
    bili_jct: toNullableText(raw.bili_jct),
    buvid3: toNullableText(raw.buvid3),
    dedeuserid: toNullableText(raw.dedeuserid),
  })
}

function requireCredential(dir: string): Credential {
  const credential = loadCredential(dir)
  if (!credential) throw new CliError('AUTH', '未登录，请先执行 bilibili auth login start', 3)
  return credential
}

async function authStatus(dir: string): Promise<unknown> {
  const credential = loadCredential(dir)
  // credentialPresent 只表示状态目录里有可解析的凭证文件；是否仍然有效由 B 站接口判定。
  // 自动化（E2E/CI）据此区分“没有登录态”和“登录态可能过期”，不需要读取凭证正文。
  if (!credential) {
    return {
      logged_in: false,
      credentialPresent: false,
      stateDir: dir,
      message: '未登录，请执行 bilibili auth login start',
    }
  }
  try {
    const info: unknown = await get_self_info(credential)
    const data = toRecord(info)
    return {
      logged_in: true,
      credentialPresent: true,
      stateDir: dir,
      uid: nullishOr(data.mid, credential.dedeuserid),
      username: nullishOr(data.name, ''),
      message: '凭证有效',
    }
  } catch {
    return {
      logged_in: false,
      credentialPresent: true,
      stateDir: dir,
      message: '凭证可能已过期或网络不可用，请重新执行 bilibili auth login start',
    }
  }
}

async function search(_dir: string, params: Record<string, unknown>): Promise<unknown> {
  const keyword = paramText(params, 'keyword')
  const num = paramNumber(params, 'num', 10)
  const orderMap: Record<string, OrderVideo> = {
    totalrank: OrderVideo.TOTALRANK,
    click: OrderVideo.CLICK,
    pubdate: OrderVideo.PUBDATE,
    dm: OrderVideo.DM,
  }
  const result: unknown = await search_by_type({
    keyword,
    search_type: SearchObjectType.VIDEO,
    page: 1,
    order_type: orderMap[paramText(params, 'order', 'totalrank')] ?? OrderVideo.TOTALRANK,
  })
  const videos: unknown[] = []
  for (const item of responseList(toRecord(result).result, 'result').slice(0, num)) {
    const data = toRecord(item)
    videos.push({
      bvid: data.bvid || (data.aid ? aidToBvid(data.aid) : ''),
      aid: nullishOr(data.aid, 0),
      title: stringOrEmpty(data.title).replace(/<[^>]+>/g, ''),
      author: nullishOr(data.author, ''),
      play: nullishOr(data.play, 0),
      review: nullishOr(data.review, 0),
      danmaku: nullishOr(data.video_review, 0),
      duration: nullishOr(data.duration, ''),
      description: stringOrEmpty(data.description).slice(0, 200),
    })
  }
  return { keyword, count: videos.length, videos }
}

async function videoInfo(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const info: unknown = await new Video({ bvid: paramText(params, 'bvid'), credential }).get_info()
  const data = toRecord(info)
  const stat = toRecord(data.stat)
  return {
    bvid: data.bvid,
    aid: data.aid,
    title: data.title,
    description: data.desc,
    author: toRecord(data.owner).name,
    duration: data.duration,
    pages: lengthOrZero(data.pages),
    tags: responseList(data.tag, 'tag')
      .map((item) => toRecord(item).tag_name)
      .filter((item) => Boolean(item)),
    stat: {
      view: nullishOr(stat.view, 0),
      danmaku: nullishOr(stat.danmaku, 0),
      reply: nullishOr(stat.reply, 0),
      favorite: nullishOr(stat.favorite, 0),
      coin: nullishOr(stat.coin, 0),
      like: nullishOr(stat.like, 0),
      share: nullishOr(stat.share, 0),
    },
  }
}

async function subtitle(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const bvid = paramText(params, 'bvid')
  const video = new Video({ bvid, credential })
  const info: unknown = await video.get_info()
  const data = toRecord(info)
  const cid = toNumber(data.cid, 0) || toNumber(toRecord(firstOrUndefined(data.pages)).cid, 0) || 0
  if (!cid) return { error: '无法获取cid' }
  const player: unknown = await video.get_player_info({ cid })
  const list = responseList(toRecord(toRecord(player).subtitle).subtitles, 'subtitles')
  if (!list.length) return { message: '该视频没有字幕' }
  const target = list.find((item) => {
    const language = toRecord(item).lan
    return language === 'ai-zh' || language === 'zh-CN' || language === 'zh'
  }) ?? list[0]
  const targetData = toRecord(target)
  const subtitleUrl = nullishOr(targetData.subtitle_url, '')
  if (typeof subtitleUrl !== 'string') throw new CliError('BACKEND', '后端响应格式异常：subtitle_url 不是字符串', 1)
  let url = subtitleUrl
  if (url.startsWith('//')) url = 'https:' + url
  if (!url) return { message: '字幕地址为空' }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new CliError('BACKEND', `字幕下载失败（HTTP ${response.status}）`)
  const body: unknown = await response.json()
  const texts = responseList(toRecord(body).body, 'body').map((item) => nullishOr(toRecord(item).content, ''))
  return {
    bvid,
    title: nullishOr(data.title, ''),
    language: nullishOr(targetData.lan_doc, ''),
    segments: texts.length,
    text: texts.join('\n'),
  }
}

async function hotVideos(_dir: string, params: Record<string, unknown>): Promise<unknown> {
  const pn = paramNumber(params, 'pn', 1)
  const ps = paramNumber(params, 'ps', 20)
  const result: unknown = await get_hot_videos({ pn, ps: Math.min(ps, 50) })
  const videos: unknown[] = []
  for (const item of responseList(toRecord(result).list, 'list')) {
    const data = toRecord(item)
    const stat = toRecord(data.stat)
    videos.push({
      bvid: nullishOr(data.bvid, ''),
      title: nullishOr(data.title, ''),
      author: nullishOr(toRecord(data.owner).name, ''),
      play: nullishOr(stat.view, 0),
      like: nullishOr(stat.like, 0),
      danmaku: nullishOr(stat.danmaku, 0),
      reply: nullishOr(stat.reply, 0),
      desc: stringOrEmpty(data.desc).slice(0, 100),
      duration: nullishOr(data.duration, 0),
      tname: nullishOr(data.tname, ''),
    })
  }
  return { page: pn, count: videos.length, videos }
}

async function comments(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const bvid = paramText(params, 'bvid')
  const num = paramNumber(params, 'num', 30)
  const info: unknown = await new Video({ bvid, credential }).get_info()
  const aid = requireVideoAid(info)
  const orderType = paramText(params, 'order', 'like') === 'time' ? OrderType.TIME : OrderType.LIKE
  const items: CommentItem[] = []
  let page = 1
  while (items.length < num) {
    let response: unknown
    try {
      response = await get_comments({
        oid: aid,
        type_: CommentResourceType.VIDEO,
        page_index: page,
        order: orderType,
        credential,
      })
    } catch (error) {
      // 首页失败必须上抛（鉴权/风控/网络），否则会把失败伪装成“0 条评论”；
      // 翻页失败才允许返回已取得的部分结果。
      if (page === 1) throw error
      break
    }
    const replies = responseList(toRecord(response).replies, 'replies')
    if (!replies.length) break
    for (const reply of replies) {
      const data = toRecord(reply)
      const item: CommentItem = {
        rpid: nullishOr(data.rpid, 0),
        user: nullishOr(toRecord(data.member).uname, ''),
        content: nullishOr(toRecord(data.content).message, ''),
        like: nullishOr(data.like, 0),
        reply_count: nullishOr(data.rcount, 0),
        time: nullishOr(data.ctime, 0),
      }
      const sub = responseList(data.replies, 'replies').slice(0, 2).map((entry): SubReply => {
        const subData = toRecord(entry)
        return {
          user: nullishOr(toRecord(subData.member).uname, ''),
          content: nullishOr(toRecord(subData.content).message, ''),
          like: nullishOr(subData.like, 0),
        }
      })
      if (sub.length) item.top_replies = sub
      items.push(item)
    }
    page += 1
    await sleep(500)
  }
  return { bvid, count: items.slice(0, num).length, comments: items.slice(0, num) }
}

async function commentThread(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const bvid = paramText(params, 'bvid')
  const rpid = paramNumber(params, 'rpid', 0)
  const page = paramNumber(params, 'page', 1)
  const num = paramNumber(params, 'num', 10)
  const info: unknown = await new Video({ bvid, credential }).get_info()
  const result: unknown = await new Comment(
    requireVideoAid(info),
    CommentResourceType.VIDEO,
    rpid,
    credential,
  ).get_sub_comments(page, num)
  return { bvid, rpid, page, num, result }
}

function sentComment(data: unknown): Record<string, unknown> {
  const result = toRecord(data)
  const reply = toRecord(result.reply)
  return {
    success: true,
    message: '评论发送成功',
    rpid: nullishOr(result.rpid, nullishOr(reply.rpid, null)),
    root: nullishOr(result.root, null),
    parent: nullishOr(result.parent, null),
    at_name_to_mid: definedOrEmpty(
      toRecord(reply.content).at_name_to_mid,
      toRecord(result.content).at_name_to_mid,
    ),
  }
}

async function reply(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const bvid = paramText(params, 'bvid')
  const info: unknown = await new Video({ bvid, credential }).get_info()
  const options = {
    text: paramText(params, 'text'),
    oid: requireVideoAid(info),
    type_: CommentResourceType.VIDEO,
    credential,
  }
  const rpid = paramNumber(params, 'rpid', 0)
  if (rpid === 0) {
    const data: unknown = await send_comment(options)
    return sentComment(data)
  }
  const root = paramNumber(params, 'root', 0)
  const actualRoot = root !== 0 ? root : rpid
  const data: unknown = await send_comment({ ...options, root: actualRoot, parent: rpid })
  return sentComment(data)
}

async function deleteComment(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const bvid = paramText(params, 'bvid')
  const rpid = paramNumber(params, 'rpid', 0)
  const info: unknown = await new Video({ bvid, credential }).get_info()
  const result: unknown = await new Comment(
    requireVideoAid(info),
    CommentResourceType.VIDEO,
    rpid,
    credential,
  ).delete()
  return { success: true, bvid, rpid, result }
}

async function userInfo(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const info: unknown = await new User(paramNumber(params, 'uid', 0), credential).get_user_info()
  return info
}

// relation.attribute 是“当前账号对目标”的关系：6 = 互关。
// be_relation.attribute 是“目标对当前账号”的关系：2 只表示对方关注了我，
// 不能当作互关，否则单向关注会被误判。
function relationAttribute(relation: unknown): unknown {
  const data = toRecord(relation)
  return nullishOr(toRecord(data.relation).attribute, nullishOr(data.attribute, 0))
}

function reverseAttribute(relation: unknown): unknown {
  return nullishOr(toRecord(toRecord(relation).be_relation).attribute, 0)
}

interface RelationResult {
  uid: number
  attribute: unknown
  beAttribute: unknown
  mutual: boolean
  relation: unknown
}

async function userRelation(dir: string, params: Record<string, unknown>): Promise<RelationResult> {
  const credential = requireCredential(dir)
  const uid = paramNumber(params, 'uid', 0)
  const self: unknown = await get_self_info(credential)
  const selfUid = toRecord(self).mid
  if (selfUid === undefined || selfUid === null) throw new CliError('AUTH', '无法确认当前登录用户', 3)
  if (Number(uid) === Number(selfUid)) throw new CliError('VALIDATION', '不能查询自己与自己的关系', 2)
  const relation: unknown = await new User(uid, credential).get_relation()
  const attribute = relationAttribute(relation)
  return { uid, attribute, beAttribute: reverseAttribute(relation), mutual: attribute === 6, relation }
}

async function inbox(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  // 契约用 0 表示“第一页”；转成 null 让请求省略游标，与 Python 默认值一致。
  const id = paramNumber(params, 'cursorId', 0) || null
  const time = paramNumber(params, 'cursorTime', 0) || null
  const kind = paramText(params, 'kind', 'at')
  if (kind === 'reply') {
    const result: unknown = await get_replies({ credential, last_reply_id: id, reply_time: time })
    return result
  }
  if (kind === 'like') {
    const result: unknown = await get_likes({ credential, last_id: id, like_time: time })
    return result
  }
  const result: unknown = await get_at({ credential, last_id: id, at_time: time })
  return result
}

async function dmStatus(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const credential = requireCredential(dir)
  const uid = paramNumber(params, 'uid', 0)
  const [relation, unread]: [unknown, unknown] = await Promise.all([
    new User(uid, credential).get_relation(),
    get_unread_messages(credential),
  ])
  const attribute = relationAttribute(relation)
  return { uid, attribute, beAttribute: reverseAttribute(relation), mutual: attribute === 6, unread }
}

async function dmRead(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const uid = paramNumber(params, 'uid', 0)
  const result: unknown = await fetch_session_msgs({ talker_id: uid, credential: requireCredential(dir) })
  return result
}

async function dmSend(dir: string, params: Record<string, unknown>): Promise<unknown> {
  const uid = paramNumber(params, 'uid', 0)
  const text = paramText(params, 'text')
  const relation = await userRelation(dir, { uid })
  if (!relation.mutual) throw new CliError('VALIDATION', '仅允许向已确认互关的用户发送私信', 2)
  const result: unknown = await send_msg({
    credential: requireCredential(dir),
    receiver_id: uid,
    msg_type: EventType.TEXT,
    content: text,
  })
  return { success: true, uid, result }
}

type Handler = (dir: string, params: Record<string, unknown>) => Promise<unknown>

const handlers: Record<string, Handler> = {
  auth_status: (dir) => authStatus(dir),
  search,
  video_info: videoInfo,
  subtitle,
  hot_videos: hotVideos,
  comments,
  comment_thread: commentThread,
  reply,
  delete: deleteComment,
  user_info: userInfo,
  user_relation: userRelation,
  inbox,
  dm_status: dmStatus,
  dm_latest: dmRead,
  dm_send: dmSend,
}

export function createService(dir: string): Service {
  return {
    async call(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
      const handler = handlers[name]
      if (!handler) throw new CliError('USAGE', `未知后端命令：${name}`, 2)
      return handler(dir, params)
    },
  }
}
