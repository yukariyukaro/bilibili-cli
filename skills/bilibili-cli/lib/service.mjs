/**
 * lib/service.mjs —— 通过 @yukariyukaro/bilibili-api-ts 实现的内部服务层。
 *
 * 这里不启动子进程、不走 MCP，只把 CLI 的命令映射到 npm 包公开的函数，
 * 并把返回值整理成稳定的 JSON 结构。凭证只从状态目录读取，不写日志。
 */
import { existsSync, readFileSync } from 'node:fs'
import { credentialFile } from './portable.mjs'
import { CliError } from './contract.mjs'
import {
  Comment,
  CommentResourceType,
  Credential,
  aid2bvid,
  EventType,
  OrderType,
  OrderVideo,
  SearchObjectType,
  User,
  Video,
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function loadCredential(dir) {
  const file = credentialFile(dir)
  if (!existsSync(file)) return null
  let raw
  try { raw = JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
  return new Credential({
    sessdata: raw.sessdata || null,
    bili_jct: raw.bili_jct || null,
    buvid3: raw.buvid3 || null,
    dedeuserid: raw.dedeuserid || null,
  })
}

function requireCredential(dir) {
  const credential = loadCredential(dir)
  if (!credential) throw new CliError('AUTH', '未登录，请先执行 bilibili auth login start', 3)
  return credential
}

async function authStatus(dir) {
  const credential = loadCredential(dir)
  if (!credential) return { logged_in: false, message: '未登录，请执行 bilibili auth login start' }
  try {
    const info = await get_self_info(credential)
    return { logged_in: true, uid: info?.mid ?? credential.dedeuserid, username: info?.name ?? '', message: '凭证有效' }
  } catch {
    return { logged_in: false, message: '凭证可能已过期，请重新执行 bilibili auth login start' }
  }
}

async function search(dir, { keyword, num, order }) {
  const orderMap = {
    totalrank: OrderVideo.TOTALRANK,
    click: OrderVideo.CLICK,
    pubdate: OrderVideo.PUBDATE,
    dm: OrderVideo.DM,
  }
  const result = await search_by_type({
    keyword,
    search_type: SearchObjectType.VIDEO,
    page: 1,
    order_type: orderMap[order] ?? OrderVideo.TOTALRANK,
  })
  const videos = []
  for (const item of (result?.result ?? []).slice(0, num)) {
    videos.push({
      bvid: item?.bvid || (item?.aid ? aid2bvid(item.aid) : ''),
      aid: item?.aid ?? 0,
      title: String(item?.title ?? '').replace(/<[^>]+>/g, ''),
      author: item?.author ?? '',
      play: item?.play ?? 0,
      review: item?.review ?? 0,
      danmaku: item?.video_review ?? 0,
      duration: item?.duration ?? '',
      description: String(item?.description ?? '').slice(0, 200),
    })
  }
  return { keyword, count: videos.length, videos }
}

async function videoInfo(dir, { bvid }) {
  const credential = requireCredential(dir)
  const info = await new Video({ bvid, credential }).get_info()
  const stat = info?.stat ?? {}
  return {
    bvid: info?.bvid,
    aid: info?.aid,
    title: info?.title,
    description: info?.desc,
    author: info?.owner?.name,
    duration: info?.duration,
    pages: info?.pages?.length ?? 0,
    tags: (info?.tag ?? []).map((item) => item?.tag_name).filter(Boolean),
    stat: {
      view: stat.view ?? 0,
      danmaku: stat.danmaku ?? 0,
      reply: stat.reply ?? 0,
      favorite: stat.favorite ?? 0,
      coin: stat.coin ?? 0,
      like: stat.like ?? 0,
      share: stat.share ?? 0,
    },
  }
}

async function subtitle(dir, { bvid }) {
  const credential = requireCredential(dir)
  const video = new Video({ bvid, credential })
  const info = await video.get_info()
  const cid = info?.cid || info?.pages?.[0]?.cid || 0
  if (!cid) return { error: '无法获取cid' }
  const player = await video.get_player_info({ cid })
  const list = player?.subtitle?.subtitles ?? []
  if (!list.length) return { message: '该视频没有字幕' }
  const target = list.find((item) => ['ai-zh', 'zh-CN', 'zh'].includes(item?.lan)) ?? list[0]
  let url = target?.subtitle_url ?? ''
  if (url.startsWith('//')) url = 'https:' + url
  if (!url) return { message: '字幕地址为空' }
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) })
  if (!response.ok) throw new CliError('BACKEND', `字幕下载失败（HTTP ${response.status}）`)
  const data = await response.json()
  const texts = (data?.body ?? []).map((item) => item?.content ?? '')
  return {
    bvid,
    title: info?.title ?? '',
    language: target?.lan_doc ?? '',
    segments: texts.length,
    text: texts.join('\n'),
  }
}

async function hotVideos(_dir, { pn = 1, ps = 20 }) {
  const result = await get_hot_videos({ pn, ps: Math.min(ps, 50) })
  const videos = []
  for (const item of result?.list ?? []) {
    const stat = item?.stat ?? {}
    videos.push({
      bvid: item?.bvid ?? '',
      title: item?.title ?? '',
      author: item?.owner?.name ?? '',
      play: stat.view ?? 0,
      like: stat.like ?? 0,
      danmaku: stat.danmaku ?? 0,
      reply: stat.reply ?? 0,
      desc: String(item?.desc ?? '').slice(0, 100),
      duration: item?.duration ?? 0,
      tname: item?.tname ?? '',
    })
  }
  return { page: pn, count: videos.length, videos }
}

async function comments(dir, { bvid, num, order }) {
  const credential = requireCredential(dir)
  const info = await new Video({ bvid, credential }).get_info()
  const aid = info?.aid
  const orderType = order === 'time' ? OrderType.TIME : OrderType.LIKE
  const items = []
  let page = 1
  while (items.length < num) {
    let response
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
    const replies = response?.replies ?? []
    if (!replies.length) break
    for (const reply of replies) {
      const item = {
        rpid: reply?.rpid ?? 0,
        user: reply?.member?.uname ?? '',
        content: reply?.content?.message ?? '',
        like: reply?.like ?? 0,
        reply_count: reply?.rcount ?? 0,
        time: reply?.ctime ?? 0,
      }
      const sub = (reply?.replies ?? []).slice(0, 2).map((entry) => ({
        user: entry?.member?.uname ?? '',
        content: entry?.content?.message ?? '',
        like: entry?.like ?? 0,
      }))
      if (sub.length) item.top_replies = sub
      items.push(item)
    }
    page += 1
    await sleep(500)
  }
  return { bvid, count: items.slice(0, num).length, comments: items.slice(0, num) }
}

async function commentThread(dir, { bvid, rpid, page, num }) {
  const credential = requireCredential(dir)
  const info = await new Video({ bvid, credential }).get_info()
  const result = await new Comment(info?.aid, CommentResourceType.VIDEO, rpid, credential).get_sub_comments(page, num)
  return { bvid, rpid, page, num, result }
}

async function reply(dir, { bvid, text, rpid = 0, root = 0 }) {
  const credential = requireCredential(dir)
  const info = await new Video({ bvid, credential }).get_info()
  const options = { text, oid: info?.aid, type_: CommentResourceType.VIDEO, credential }
  if (rpid === 0) {
    const data = await send_comment(options)
    return { success: true, message: '评论发送成功', rpid: data?.rpid ?? data?.reply?.rpid ?? null, root: data?.root ?? null, parent: data?.parent ?? null, at_name_to_mid: data?.reply?.content?.at_name_to_mid ?? data?.content?.at_name_to_mid ?? {} }
  }
  const actualRoot = root !== 0 ? root : rpid
  const data = await send_comment({ ...options, root: actualRoot, parent: rpid })
  return { success: true, message: '评论发送成功', rpid: data?.rpid ?? data?.reply?.rpid ?? null, root: data?.root ?? null, parent: data?.parent ?? null, at_name_to_mid: data?.reply?.content?.at_name_to_mid ?? data?.content?.at_name_to_mid ?? {} }
}

async function deleteComment(dir, { bvid, rpid }) {
  const credential = requireCredential(dir)
  const info = await new Video({ bvid, credential }).get_info()
  const result = await new Comment(info?.aid, CommentResourceType.VIDEO, rpid, credential).delete()
  return { success: true, bvid, rpid, result }
}

async function userInfo(dir, { uid }) {
  const credential = requireCredential(dir)
  return new User(uid, credential).get_user_info()
}

// relation.attribute 是“当前账号对目标”的关系：6 = 互关。
// be_relation.attribute 是“目标对当前账号”的关系：2 只表示对方关注了我，
// 不能当作互关，否则单向关注会被误判。
function relationAttribute(relation) {
  return relation?.relation?.attribute ?? relation?.attribute ?? 0
}

function reverseAttribute(relation) {
  return relation?.be_relation?.attribute ?? 0
}

async function userRelation(dir, { uid }) {
  const credential = requireCredential(dir)
  const self = await get_self_info(credential)
  const selfUid = self?.mid
  if (selfUid === undefined || selfUid === null) throw new CliError('AUTH', '无法确认当前登录用户', 3)
  if (Number(uid) === Number(selfUid)) throw new CliError('VALIDATION', '不能查询自己与自己的关系', 2)
  const relation = await new User(uid, credential).get_relation()
  const attribute = relationAttribute(relation)
  return { uid, attribute, beAttribute: reverseAttribute(relation), mutual: attribute === 6, relation }
}

async function inbox(dir, { kind, cursorId, cursorTime }) {
  const credential = requireCredential(dir)
  // 契约用 0 表示“第一页”；转成 null 让请求省略游标，与 Python 默认值一致。
  const id = cursorId || null
  const time = cursorTime || null
  if (kind === 'reply') return get_replies({ credential, last_reply_id: id, reply_time: time })
  if (kind === 'like') return get_likes({ credential, last_id: id, like_time: time })
  return get_at({ credential, last_id: id, at_time: time })
}

async function dmStatus(dir, { uid }) {
  const credential = requireCredential(dir)
  const [relation, unread] = await Promise.all([
    new User(uid, credential).get_relation(),
    get_unread_messages(credential),
  ])
  const attribute = relationAttribute(relation)
  return { uid, attribute, beAttribute: reverseAttribute(relation), mutual: attribute === 6, unread }
}

async function dmRead(dir, { uid }) {
  return fetch_session_msgs({ talker_id: uid, credential: requireCredential(dir) })
}

async function dmSend(dir, { uid, text }) {
  const relation = await userRelation(dir, { uid })
  if (!relation.mutual) throw new CliError('VALIDATION', '仅允许向已确认互关的用户发送私信', 2)
  const result = await send_msg({ credential: requireCredential(dir), receiver_id: uid, msg_type: EventType.TEXT, content: text })
  return { success: true, uid, result }
}

const handlers = {
  auth_status: (dir) => authStatus(dir),
  search: (dir, args) => search(dir, args),
  video_info: (dir, args) => videoInfo(dir, args),
  subtitle: (dir, args) => subtitle(dir, args),
  hot_videos: (dir, args) => hotVideos(dir, args),
  comments: (dir, args) => comments(dir, args),
  comment_thread: (dir, args) => commentThread(dir, args),
  reply: (dir, args) => reply(dir, args),
  delete: (dir, args) => deleteComment(dir, args),
  user_info: (dir, args) => userInfo(dir, args),
  user_relation: (dir, args) => userRelation(dir, args),
  inbox: (dir, args) => inbox(dir, args),
  dm_status: (dir, args) => dmStatus(dir, args),
  dm_latest: (dir, args) => dmRead(dir, args),
  dm_send: (dir, args) => dmSend(dir, args),
}

export function createService(dir) {
  return {
    async call(name, params = {}) {
      const handler = handlers[name]
      if (!handler) throw new CliError('USAGE', `未知后端命令：${name}`, 2)
      return handler(dir, params)
    },
  }
}
