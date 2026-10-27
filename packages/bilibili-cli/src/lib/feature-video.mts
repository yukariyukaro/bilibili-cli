/** Installed API 17.5.0 adapter. Never reads credentials or performs retries. */
import {
  Comment, CommentResourceType, Danmaku, DmMode, User, Video,
  add_emoji, get_emoji_detail, get_emoji_list,
} from '@yukariyukaro/bilibili-api-ts'
import type { Credential } from '@yukariyukaro/bilibili-api-ts'
import { CliError } from './contract.mjs'
import { toFeatureError } from './feature-errors.mjs'
import { isRecord } from './service-types.mjs'

type Params = Record<string, unknown>
type Handler = (dir: string, params: Params) => Promise<unknown>

function invalid(field: string): never {
  throw new CliError('VALIDATION', '参数无效：' + field, 2)
}
function backend(field: string): never {
  throw new CliError('BACKEND', '后端响应格式异常：' + field, 1)
}
function text(p: Params, key: string, fallback?: string): string {
  const value = p[key] === undefined ? fallback : p[key]
  if (typeof value !== 'string') return invalid(key)
  return value
}
function integer(p: Params, key: string, fallback?: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
  const value = p[key] === undefined ? fallback : p[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) return invalid(key)
  return value
}
function boolean(p: Params, key: string, fallback = false): boolean {
  const value = p[key] === undefined ? fallback : p[key]
  if (typeof value !== 'boolean') return invalid(key)
  return value
}
function choice(p: Params, key: string, values: readonly string[], fallback: string): string {
  const value = text(p, key, fallback)
  if (!values.includes(value)) return invalid(key)
  return value
}
function videoId(p: Params): string {
  const value = text(p, 'bvid')
  if (!/^BV[0-9A-Za-z]{10}$/.test(value)) return invalid('bvid')
  return value
}
function decimalId(p: Params, key: string): string {
  const value = text(p, key)
  if (!/^[1-9]\d*$/.test(value)) return invalid(key)
  return value
}
function idList(p: Params, key: string): number[] {
  const value = text(p, key)
  if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(value)) return invalid(key)
  const result = value.split(',').map(Number)
  if (result.some((id) => !Number.isSafeInteger(id) || id < 1)) return invalid(key)
  return [...new Set(result)]
}
function record(value: unknown, field: string): Params {
  if (!isRecord(value)) return backend(field)
  return value
}
function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) return backend(field)
  return value
}
function positive(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return backend(field)
  return value
}
function nonnegative(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return backend(field)
  return value
}
function flag(value: unknown, field: string): boolean {
  if (typeof value === 'boolean') return value
  if (value === 0 || value === 1) return value === 1
  return backend(field)
}

// Keep upstream business fields, never echo credentials/cookies even if a backend includes them.
function publicData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicData)
  if (!isRecord(value)) return value
  const result: Params = {}
  for (const [key, item] of Object.entries(value)) {
    if (/^(credential|credentials|cookies?|sessdata|bili_jct|csrf(?:_token)?|buvid[34]|dedeuserid|authorization|headers)$/i.test(key)) continue
    result[key] = publicData(item)
  }
  return result
}

/** Api.result rejects nonzero envelope codes before returning data/result.
 * undefined is a valid code=0 response with no data. null means an empty HTTP body
 * in 17.5.0's processResponse, so acceptance cannot be established in that case.
 */
function accepted(result: unknown, target: Params): Params {
  if (result !== undefined && !isRecord(result)) {
    throw new CliError('UNKNOWN_STATE', '接口未能确认受理；请人工核对，不要自动重试', 1)
  }
  if (isRecord(result)) {
    if (result.success === false || result.ok === false || result.error ||
        (result.code !== undefined && result.code !== 0) ||
        (result.OK !== undefined && result.OK !== 1)) {
      throw new CliError('BUSINESS', '接口返回业务失败；不要自动重试写操作', 1)
    }
  }
  return { success: true, target, result: result === undefined ? null : publicData(result), visibilityVerified: false }
}

async function pageCid(video: Video, page: number): Promise<number> {
  const raw: unknown = await video.get_pages()
  const pages = list(raw, 'video.pages')
  if (pages.length === 0) return backend('video.pages is empty')
  if (page > pages.length) throw new CliError('VALIDATION', '视频不存在该分 P', 2)
  return positive(record(pages[page - 1], 'video.page').cid, 'video.page.cid')
}

function danmakuItem(value: unknown): Params {
  const item = record(value, 'danmaku.item')
  let dmid: string
  if (typeof item.id_str === 'string' && /^[1-9]\d*$/.test(item.id_str)) dmid = item.id_str
  else if (item.id_str !== undefined && item.id_str !== '') return backend('danmaku.id_str')
  else dmid = String(positive(item.id_, 'danmaku.id_ (missing exact id_str)'))
  if (typeof item.text !== 'string' || typeof item.dm_time !== 'number' || !Number.isFinite(item.dm_time) || item.dm_time < 0) return backend('danmaku.text/time')
  const timeMs = Math.round(item.dm_time * 1000)
  if (!Number.isSafeInteger(timeMs)) return backend('danmaku.timeMs')
  if (typeof item.color !== 'string' || !/^(?:[0-9a-fA-F]{1,6}|special)$/.test(item.color)) return backend('danmaku.color')
  return {
    dmid, text: item.text, timeMs, mode: nonnegative(item.mode, 'danmaku.mode'),
    color: item.color === 'special' ? item.color : item.color.padStart(6, '0').toLowerCase(),
    fontSize: positive(item.font_size, 'danmaku.font_size'),
    sendTime: nonnegative(item.send_time, 'danmaku.send_time'),
    weight: typeof item.weight === 'number' && Number.isSafeInteger(item.weight) ? item.weight : undefined,
    pool: item.pool === undefined ? undefined : nonnegative(item.pool, 'danmaku.pool'),
  }
}

function aiSummary(raw: unknown): Params {
  const data = record(raw, 'summary')
  if (data.code !== undefined && (typeof data.code !== 'number' || !Number.isInteger(data.code))) return backend('summary.code')
  if (typeof data.code === 'number' && data.code !== 0) {
    return { available: false, reason: 'AI_UNAVAILABLE', result: publicData(data) }
  }
  if (data.model_result === null && data.code === 0) return { available: false, reason: 'AI_UNAVAILABLE', result: publicData(data) }
  const model = record(data.model_result, 'summary.model_result')
  const resultType = nonnegative(model.result_type, 'summary.result_type')
  if (resultType === 0) return { available: false, reason: 'AI_UNAVAILABLE', result: publicData(data) }
  if (resultType > 3) return backend('summary.result_type')
  const summary = model.summary
  if (summary !== undefined && typeof summary !== 'string') return backend('summary.summary')
  const outline = model.outline === undefined ? [] : list(model.outline, 'summary.outline')
  for (const item of outline) {
    const section = record(item, 'summary.outline.item')
    if (typeof section.title !== 'string' || !section.title.trim()) return backend('summary.outline.title')
  }
  if (!(typeof summary === 'string' && summary.trim()) && outline.length === 0) return backend('summary has no content')
  return { available: true, summary: summary ?? '', outline: publicData(outline), result: publicData(data) }
}

function emojiPackages(raw: unknown): { result: unknown; items: unknown[] } {
  const data = record(raw, 'emoji')
  const items = list(data.packages, 'emoji.packages')
  for (const item of items) positive(record(item, 'emoji.package').id, 'emoji.package.id')
  return { result: publicData(data), items: items.map(publicData) }
}

export function createVideoHandlers(getCredential: (dir: string, required: boolean) => Credential): Record<string, Handler> {
  const video = (dir: string, p: Params, required: boolean): Video => new Video({ bvid: videoId(p), credential: getCredential(dir, required) })
  const handlers: Record<string, Handler> = {
    async video_relation(dir, p) {
      const result: unknown = await video(dir, p, true).get_relation()
      const data = record(result, 'relation')
      return { bvid: videoId(p), liked: flag(data.like, 'relation.like'), coins: nonnegative(data.coin, 'relation.coin'),
        favorited: flag(data.favorite, 'relation.favorite'), result: publicData(data) }
    },
    async video_like(dir, p) {
      const undo = boolean(p, 'undo')
      const result: unknown = await video(dir, p, true).like(!undo)
      return accepted(result, { bvid: videoId(p), undo })
    },
    async video_coin(dir, p) {
      const num = integer(p, 'num', 1, 1, 2)
      const like = boolean(p, 'like')
      const result: unknown = await video(dir, p, true).pay_coin(num, like)
      return accepted(result, { bvid: videoId(p), num, like, consumesCoins: true })
    },
    async video_favorite(dir, p) {
      const mediaIds = idList(p, 'mediaIds')
      const undo = boolean(p, 'undo')
      const result: unknown = await video(dir, p, true).set_favorite(undo ? [] : mediaIds, undo ? mediaIds : [])
      return accepted(result, { bvid: videoId(p), mediaIds, undo })
    },
    async video_triple(dir, p) {
      const result: unknown = await video(dir, p, true).triple()
      return accepted(result, { bvid: videoId(p), consumesCoins: true, coinAmount: 'determined_by_backend', actions: ['like', 'coin', 'favorite'] })
    },
    async video_snapshot(dir, p) {
      const page = integer(p, 'page', 1)
      const v = video(dir, p, false)
      const cid = await pageCid(v, page)
      // pvideo=true ignores cid in upstream JS. Use the cid-aware endpoint.
      const raw: unknown = await v.get_video_snapshot(cid, true, false)
      const data = record(raw, 'snapshot')
      const images = list(data.image, 'snapshot.image')
      if (!images.every((image) => typeof image === 'string' && image.length > 0)) return backend('snapshot.image item')
      const index = list(data.index, 'snapshot.index')
      if (!index.every((time) => typeof time === 'number' && Number.isFinite(time) && time >= 0)) return backend('snapshot.index item')
      return { bvid: videoId(p), page, cid, images, index, result: publicData(data) }
    },
    async video_summary(dir, p) {
      const page = integer(p, 'page', 1)
      const v = video(dir, p, false)
      const cid = await pageCid(v, page)
      const result: unknown = await v.get_ai_conclusion({ cid })
      return { bvid: videoId(p), page, cid, ...aiSummary(result) }
    },
    async video_toview(dir, p) {
      const undo = boolean(p, 'undo')
      const v = video(dir, p, true)
      const result: unknown = await (undo ? v.delete_from_toview() : v.add_to_toview())
      return accepted(result, { bvid: videoId(p), undo })
    },
    async danmaku_list(dir, p) {
      const page = integer(p, 'page', 1)
      const num = integer(p, 'num', 20, 1, 100)
      const segment = integer(p, 'segment', 1)
      const v = video(dir, p, false)
      const cid = await pageCid(v, page)
      // Upstream converts its zero-based segment range to segment_index + 1.
      const result: unknown = await v.get_danmakus({ cid, from_seg: segment - 1, to_seg: segment - 1 })
      const all = list(result, 'danmakus').map(danmakuItem)
      const items = all.slice(0, num)
      // segmentTotal 是该 6 分钟段内的弹幕总数（不是段数）；count 仅表示本次返回条数。
      return { bvid: videoId(p), cid, page, segment, items, count: items.length, segmentTotal: all.length, truncated: all.length > items.length }
    },
    async danmaku_send(dir, p) {
      const page = integer(p, 'page', 1)
      const content = text(p, 'text')
      if (!content.trim()) return invalid('text')
      const timeMs = integer(p, 'timeMs', undefined, 0)
      const color = text(p, 'color', 'ffffff')
      if (!/^[0-9a-fA-F]{6}$/.test(color)) return invalid('color')
      const mode = choice(p, 'mode', ['scroll', 'top', 'bottom'], 'scroll')
      const modes: Record<string, DmMode> = { scroll: DmMode.FLY, top: DmMode.TOP, bottom: DmMode.BOTTOM }
      let dmTime = timeMs / 1000
      // Correct floating-point underflow (e.g. 1001ms) before upstream truncates.
      if (Math.trunc(dmTime * 1000) < timeMs) dmTime = (timeMs + 0.5) / 1000
      if (Math.trunc(dmTime * 1000) !== timeMs) return invalid('timeMs 无法由上游无损表示')
      const v = video(dir, p, true)
      const cid = await pageCid(v, page)
      const result: unknown = await v.send_danmaku({ cid, danmaku: new Danmaku(content, { dm_time: dmTime, color, mode: modes[mode] }) })
      return accepted(result, { bvid: videoId(p), cid, page, text: content, timeMs, color: color.toLowerCase(), mode })
    },
    async danmaku_recall(dir, p) {
      const page = integer(p, 'page', 1)
      const dmid = decimalId(p, 'dmid')
      const v = video(dir, p, true)
      const cid = await pageCid(v, page)
      const result: unknown = await v.recall_danmaku({ cid, dmid })
      return accepted(result, { bvid: videoId(p), cid, page, dmid })
    },
    async danmaku_like(dir, p) {
      const page = integer(p, 'page', 1)
      const dmid = decimalId(p, 'dmid')
      const undo = boolean(p, 'undo')
      const v = video(dir, p, true)
      const cid = await pageCid(v, page)
      const result: unknown = await v.like_danmaku({ cid, dmid, status: !undo })
      return accepted(result, { bvid: videoId(p), cid, page, dmid, undo })
    },
    async comment_like(dir, p) {
      return commentWrite(dir, p, 'like')
    },
    async comment_pin(dir, p) {
      return commentWrite(dir, p, 'pin')
    },
    async user_videos(dir, p) {
      const uid = integer(p, 'uid')
      const page = integer(p, 'page', 1)
      const num = integer(p, 'num', 20, 1, 100)
      const keyword = text(p, 'keyword', '')
      const order = choice(p, 'order', ['pubdate', 'click', 'stow'], 'pubdate')
      const raw: unknown = await new User(uid, getCredential(dir, false)).get_videos({ pn: page, ps: num, keyword, order })
      const data = record(raw, 'user.videos')
      const items = list(record(data.list, 'user.videos.list').vlist, 'user.videos.vlist')
      for (const item of items) {
        const entry = record(item, 'user.video')
        if (typeof entry.bvid !== 'string' || !/^BV[0-9A-Za-z]{10}$/.test(entry.bvid) || typeof entry.title !== 'string') return backend('user.video bvid/title')
      }
      const total = nonnegative(record(data.page, 'user.videos.page').count, 'user.videos.page.count')
      return { uid, page, num, keyword, order, items: items.map(publicData), count: items.length, total, result: publicData(data) }
    },
    async emoji_list(dir, p) {
      const business = choice(p, 'business', ['reply', 'dynamic'], 'reply')
      const raw: unknown = await get_emoji_list(business, getCredential(dir, false))
      const data = emojiPackages(raw)
      return { business, ...data, count: data.items.length }
    },
    async emoji_detail(_dir, p) {
      const ids = idList(p, 'ids')
      const business = choice(p, 'business', ['reply', 'dynamic'], 'reply')
      const raw: unknown = await get_emoji_detail(ids, business)
      const data = emojiPackages(raw)
      return { ids, business, ...data, count: data.items.length }
    },
    async emoji_add(dir, p) {
      const packageId = integer(p, 'packageId')
      const result: unknown = await add_emoji(packageId, getCredential(dir, true))
      return accepted(result, { packageId, business: 'reply' })
    },
  }
  async function commentWrite(dir: string, p: Params, action: 'like' | 'pin'): Promise<unknown> {
    const rpid = integer(p, 'rpid')
    const undo = boolean(p, 'undo')
    const credential = getCredential(dir, true)
    const v = new Video({ bvid: videoId(p), credential })
    const info: unknown = await v.get_info()
    const aid = positive(record(info, 'video.info').aid, 'video.aid')
    const comment = new Comment(aid, CommentResourceType.VIDEO, rpid, credential)
    const result: unknown = await (action === 'like' ? comment.like(!undo) : comment.pin(!undo))
    return accepted(result, { bvid: videoId(p), aid, rpid, undo, action })
  }
  const guarded: Record<string, Handler> = {}
  for (const [name, handler] of Object.entries(handlers)) {
    guarded[name] = async (dir, p) => {
      try { return await handler(dir, p) }
      catch (error: unknown) {
        // Do not expose library errors: they can include request headers/cookies.
        throw toFeatureError(error, false)
      }
    }
  }
  return guarded
}
