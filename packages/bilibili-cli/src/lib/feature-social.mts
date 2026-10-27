/** Social/creator adapters against the installed bilibili-api-ts 17.5.0 API.
 * Authorization, confirmation and auditing belong to the application/service entry.
 */
import { lstatSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import {
  BuildDynamic, ChannelOrder, ChannelSeries, ChannelSeriesType, Dynamic, Picture, User, Video,
  add_aids_to_series, create_channel_series, create_video_favorite_list,
  del_aids_from_series, del_channel_series, delete_video_favorite_list,
  get_archive_edits, get_archive_parts, get_available_topics, get_dynamic_page_info,
  get_fan_overview, get_missions, get_overview, get_self_info,
  get_video_favorite_list, get_video_favorite_list_content, send_dynamic, upload_cover,
} from '@yukariyukaro/bilibili-api-ts'
import type { Credential } from '@yukariyukaro/bilibili-api-ts'
import { CliError } from './contract.mjs'
import { toFeatureError } from './feature-errors.mjs'
import { isRecord } from './service-types.mjs'

type Params = Record<string, unknown>
type Handler = (dir: string, params: Params) => Promise<unknown>
type GetCredential = (dir: string, required: boolean) => Credential

function invalid(message: string): never { throw new CliError('VALIDATION', message, 2) }
function backend(field: string): never { throw new CliError('BACKEND', '后端响应格式异常：' + field, 1) }

function text(p: Params, key: string, max: number, fallback?: string): string {
  const value = p[key] === undefined ? fallback : p[key]
  if (typeof value !== 'string' || value.length > max || (fallback === undefined && !value.trim())) {
    invalid(key + ' 必须是' + (fallback === undefined ? '非空' : '') + '字符串，长度不超过 ' + max)
  }
  return value
}
function integer(p: Params, key: string, max = Number.MAX_SAFE_INTEGER, fallback?: number): number {
  const value = p[key] === undefined ? fallback : p[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) invalid(key + ' 必须是 1..' + max + ' 的安全整数')
  return value
}
function flag(p: Params, key: string, fallback = false): boolean {
  const value = p[key] === undefined ? fallback : p[key]
  if (typeof value !== 'boolean') invalid(key + ' 必须是布尔值')
  return value
}
function dynamicId(p: Params): string {
  const id = text(p, 'id', 100)
  if (!/^[1-9]\d*$/.test(id)) invalid('id 必须是正整数字符串（不转换为 number）')
  return id
}
function aidsParam(p: Params): number[] {
  const value = text(p, 'aids', 20000)
  if (!/^[1-9]\d*(,[1-9]\d*)*$/.test(value)) invalid('aids 必须是逗号分隔的正安全整数串')
  const aids = value.split(',').map((part) => Number(part))
  if (aids.some((aid) => !Number.isSafeInteger(aid) || aid < 1)) invalid('aids 包含非安全整数')
  return aids
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) backend(field + ' 不是对象')
  if (value.code !== undefined && value.code !== 0) backend(field + ' 返回错误状态')
  if (value.success === false) backend(field + ' 返回失败状态')
  return value
}
function list(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) backend(field + ' 不是数组')
  return value
}
function recordList(value: unknown, field: string): Record<string, unknown>[] {
  return list(value, field).map((item) => record(item, field + '[]'))
}
function responseInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) backend(field + ' 不是有效整数')
  return value
}
function opaqueData(value: unknown, field: string): Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return recordList(value, field)
  const data = record(value, field)
  if (Object.keys(data).length === 0) backend(field + ' 是空对象')
  return data
}
function dynamicItem(value: unknown, field: string): Record<string, unknown> {
  const item = record(value, field)
  if (typeof item.id_str !== 'string' || !/^[1-9]\d*$/.test(item.id_str)) backend(field + '.id_str 不是正整数字符串')
  return item
}
function unknownState(message: string): never {
  throw new CliError('UNKNOWN_STATE', message + '；写结果未知，不自动重试，请人工核对', 1)
}
function accepted(value: unknown, target: Params): Params {
  // 17.5.0 returns undefined after validating code=0 when data/result is absent.
  // Unlike that normal empty acknowledgement, null may bypass code validation
  // entirely via the content-length=0 branch of Api.processResponse.
  if (value === null) unknownState('上游返回未校验状态的空 HTTP 响应')
  if (value !== undefined) record(value, '写操作受理结果')
  return { success: true, accepted: true, visibility: 'not_verified', ...target, response: value }
}
function creationResponse(value: unknown, target: string): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).length === 0) unknownState(target + '：创建操作未返回可识别的新目标信息')
  return record(value, '创建操作受理结果')
}
function createdDynamicId(value: unknown, target: string): string {
  // Never repair an imprecise numeric dynamic ID by String(number).
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) unknownState(target + '：创建响应缺少有效的动态 ID 字符串')
  return value
}
function createdSafeId(value: unknown, target: string): number | string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value))) return value
  unknownState(target + '：创建响应缺少正安全整数 ID')
}
function safeHandler(handler: Handler): Handler {
  return async (dir, params) => {
    try { return await handler(dir, params) }
    catch (error: unknown) {
      // Never echo upstream request/config objects, which can contain cookies or bodies.
      throw toFeatureError(error, true)
    }
  }
}
function localFile(p: Params, key: string, extensions: readonly string[], maxBytes: number): string {
  const path = resolve(text(p, key, 32767))
  if (path.startsWith('\\\\')) invalid(key + ' 必须是本地路径，不接受 UNC 网络路径')
  if (!extensions.includes(extname(path).toLowerCase())) invalid(key + ' 的文件扩展名仅支持 ' + extensions.join(', '))
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.size <= 0 || info.size > maxBytes) invalid(key + ' 必须是非空普通文件，大小不超过 ' + maxBytes + ' 字节（不接受符号链接）')
  } catch (error: unknown) {
    if (error instanceof CliError) throw error
    invalid(key + ' 文件不存在或无法读取')
  }
  return path
}
const COVER_LIMIT = 10 * 1024 * 1024
function localCover(p: Params, key: string): Picture {
  const path = localFile(p, key, ['.jpg', '.jpeg', '.png'], COVER_LIMIT)
  try {
    const picture = Picture.from_file(path)
    // from_file trusts the extension for imageType. Re-detect without an override
    // so a GIF/WebP renamed to .png cannot be sent with the wrong MIME type.
    picture.__setPictureMetaFromBytes()
    const type = picture.imageType.toLowerCase()
    const extension = extname(path).toLowerCase()
    if (!['jpg', 'jpeg', 'png'].includes(type) || picture.width <= 0 || picture.height <= 0) invalid(key + ' 不是可识别的 JPEG/PNG 图片')
    if ((extension === '.png') !== (type === 'png')) invalid(key + ' 的图片格式与扩展名不一致')
    return picture
  } catch (error: unknown) {
    if (error instanceof CliError) throw error
    invalid(key + ' 不是可读取的 JPEG/PNG 图片')
  }
}

export function createSocialHandlers(getCredential: GetCredential): Record<string, (dir: string, params: Record<string, unknown>) => Promise<unknown>> {
  async function targetUser(dir: string, p: Params): Promise<{ uid: number; credential: Credential }> {
    if (p.uid !== undefined) return { uid: integer(p, 'uid'), credential: getCredential(dir, false) }
    const credential = getCredential(dir, true)
    const raw: unknown = await get_self_info(credential)
    return { uid: responseInteger(record(raw, 'self_info').mid, 'self_info.mid', 1), credential }
  }
  const handlers: Record<string, Handler> = {
    dynamic_list: async (dir, p) => {
      const num = integer(p, 'num', 20, 20)
      const offset = text(p, 'offset', 1000, '')
      const { uid, credential } = await targetUser(dir, p)
      const raw: unknown = await get_dynamic_page_info(credential, { host_mid: uid, offset })
      const data = record(raw, 'dynamic_list')
      const items = list(data.items, 'dynamic_list.items').map((item) => dynamicItem(item, 'dynamic_list.items[]'))
      if (typeof data.offset !== 'string') backend('dynamic_list.offset 不是字符串')
      if (typeof data.has_more !== 'boolean' && data.has_more !== 0 && data.has_more !== 1) backend('dynamic_list.has_more 无效')
      // Upstream controls page size; expose the whole received page as well so a
      // display limit never silently loses items when its next offset is followed.
      return { uid, count: Math.min(num, items.length), items: items.slice(0, num), pageItems: items, offset: data.offset, hasMore: Boolean(data.has_more), pageSize: items.length }
    },
    dynamic_info: async (dir, p) => {
      const id = dynamicId(p)
      const raw: unknown = await new Dynamic(id, getCredential(dir, false)).get_info()
      const item = dynamicItem(record(raw, 'dynamic_info').item, 'dynamic_info.item')
      if (item.id_str !== id) backend('dynamic_info.item.id_str 与请求目标不一致')
      return { id, item }
    },
    dynamic_post: async (dir, p) => {
      const body = text(p, 'text', 1000)
      // Plain text deliberately does not resolve @names or interpret rich-text directives.
      const raw: unknown = await send_dynamic(BuildDynamic.empty().add_plain_text(body), getCredential(dir, true))
      const data = creationResponse(raw, '发布动态')
      // dyn_id_str was verified in the parent's historical live response.
      const id = createdDynamicId(data.dyn_id_str, '发布动态')
      return accepted(data, { id, text: body })
    },
    dynamic_delete: async (dir, p) => {
      const id = dynamicId(p)
      const raw: unknown = await new Dynamic(id, getCredential(dir, true)).delete()
      return accepted(raw, { id })
    },
    dynamic_like: async (dir, p) => {
      const id = dynamicId(p), undo = flag(p, 'undo')
      const raw: unknown = await new Dynamic(id, getCredential(dir, true)).set_like(!undo)
      return accepted(raw, { id, undo })
    },
    dynamic_repost: async (dir, p) => {
      const id = dynamicId(p), body = text(p, 'text', 150, '转发动态')
      const raw: unknown = await new Dynamic(id, getCredential(dir, true)).repost(body)
      const target = '转发源动态 id=' + id
      creationResponse(raw, target)
      // Parent reports no verified repost response ID field. Do not infer one
      // from send_dynamic, guess between candidates, or issue a second GET/write.
      // Preserve the exact source target while asking for manual reconciliation.
      unknownState(target + '：上游返回的新动态 ID 字段契约尚未验证')
    },
    dynamic_top: async (dir, p) => {
      const id = dynamicId(p), undo = flag(p, 'undo')
      const dynamic = new Dynamic(id, getCredential(dir, true))
      const raw: unknown = await (undo ? dynamic.remove_top() : dynamic.set_top())
      return accepted(raw, { id, undo })
    },
    favorite_list: async (dir, p) => {
      const { uid, credential } = await targetUser(dir, p)
      const raw: unknown = await get_video_favorite_list(uid, null, credential)
      // 上游 code=0 但无 data 时返回 undefined；这是「没有可见收藏夹」，不是格式错误。
      if (raw === undefined || raw === null) return { uid, count: 0, items: [], empty: true, reason: 'NO_DATA' }
      const data = record(raw, 'favorite_list')
      return { uid, count: responseInteger(data.count, 'favorite_list.count'), items: recordList(data.list, 'favorite_list.list') }
    },
    favorite_content: async (dir, p) => {
      const mediaId = integer(p, 'mediaId'), page = integer(p, 'page', 1000, 1), num = integer(p, 'num', 20, 20)
      const keyword = text(p, 'keyword', 1000, '')
      // 17.5.0 exposes no page-size option here and hardcodes ps=20.
      const raw: unknown = await get_video_favorite_list_content(mediaId, { page, keyword, credential: getCredential(dir, false) })
      const data = record(raw, 'favorite_content')
      const info = record(data.info, 'favorite_content.info')
      // 空收藏夹上游不返回 medias/has_more：这是「本页没有内容」，不是格式错误。
      const medias = data.medias === undefined || data.medias === null ? [] : data.medias
      const items = recordList(medias, 'favorite_content.medias')
      const hasMoreRaw = data.has_more === undefined ? 0 : data.has_more
      if (typeof hasMoreRaw !== 'boolean' && hasMoreRaw !== 0 && hasMoreRaw !== 1) backend('favorite_content.has_more 无效')
      const hasMore = Boolean(hasMoreRaw)
      const view = { mediaId, page, pageSize: 20, count: Math.min(num, items.length), items: items.slice(0, num), pageItems: items, info, hasMore }
      return items.length === 0 && !hasMore ? { ...view, empty: true, reason: 'NO_DATA' } : view
    },
    favorite_create: async (dir, p) => {
      const title = text(p, 'title', 80), description = text(p, 'description', 500, ''), private_ = flag(p, 'private')
      const raw: unknown = await create_video_favorite_list(title, description, private_, getCredential(dir, true))
      const data = creationResponse(raw, '创建收藏夹')
      const mediaId = createdSafeId(data.id, '创建收藏夹')
      return accepted(data, { mediaId, title, description, private: private_ })
    },
    favorite_delete: async (dir, p) => {
      const mediaId = integer(p, 'mediaId')
      const raw: unknown = await delete_video_favorite_list([mediaId], getCredential(dir, true))
      return accepted(raw, { mediaId })
    },
    season_list: async (dir, p) => {
      const uid = integer(p, 'uid'), user = new User(uid, getCredential(dir, false))
      const seasons: Record<string, unknown>[] = [], series: Record<string, unknown>[] = []
      const seen = new Set<string>()
      let expectedTotal = 0
      for (let page = 1; page <= 1000; page += 1) {
        const raw: unknown = await user.get_channel_list(page, 20)
        const data = record(record(raw, 'season_list').items_lists, 'season_list.items_lists')
        const pagination = record(data.page, 'season_list.page')
        const total = responseInteger(pagination.total, 'season_list.page.total')
        responseInteger(pagination.page_size, 'season_list.page.page_size', 1)
        const pageSeasons = recordList(data.seasons_list, 'season_list.seasons_list')
        const pageSeries = recordList(data.series_list, 'season_list.series_list')
        for (const [kind, items] of [['season', pageSeasons], ['series', pageSeries]] as const) {
          for (const item of items) {
            const id = responseInteger(record(item.meta, kind + '.meta')[kind + '_id'], kind + '.meta.id', 1)
            const key = kind + '-' + id
            if (seen.has(key)) backend('season_list 分页返回重复合集，请重新查询')
            seen.add(key)
          }
        }
        if (page > 1 && total !== expectedTotal) backend('season_list 分页总数发生变化，请重新查询')
        seasons.push(...pageSeasons); series.push(...pageSeries)
        expectedTotal = total
        if (seen.size > total) backend('season_list 列表数量超过分页总数')
        if (seen.size === total) return { uid, seasons, series, total }
        if (pageSeasons.length + pageSeries.length === 0) backend('season_list 分页提前返回空页')
      }
      throw new CliError('BACKEND', '合集列表超过安全分页上限（1000 页），未返回不完整列表；total=' + expectedTotal, 1)
    },
    season_videos: async (dir, p) => {
      const uid = integer(p, 'uid'), seasonId = integer(p, 'seasonId'), page = integer(p, 'page', 1000, 1), num = integer(p, 'num', 100, 20)
      const kind = text(p, 'kind', 6)
      if (kind !== 'season' && kind !== 'series') invalid('kind 必须是 season 或 series')
      const user = new User(uid, getCredential(dir, false))
      const raw: unknown = await (kind === 'season' ? user.get_channel_videos_season(seasonId, ChannelOrder.DEFAULT, page, num) : user.get_channel_videos_series(seasonId, ChannelOrder.DEFAULT, page, num))
      const data = record(raw, 'season_videos')
      const items = recordList(data.archives, 'season_videos.archives')
      return { uid, seasonId, kind, page, pageSize: num, count: items.length, items, pagination: record(data.page, 'season_videos.page') }
    },
    season_create: async (dir, p) => {
      const title = text(p, 'title', 80), description = text(p, 'description', 500, ''), aids = aidsParam(p)
      const raw: unknown = await create_channel_series(title, aids, [], description, getCredential(dir, true))
      const data = creationResponse(raw, '创建旧版视频列表（series）')
      // series_id was verified in the parent's historical live response.
      const seriesId = createdSafeId(data.series_id, '创建旧版视频列表（series）')
      return accepted(data, { kind: 'series', seriesId, title, description, aids, note: '创建的是旧版视频列表（series），不是新版 season 合集' })
    },
    season_add: async (dir, p) => {
      const seriesId = integer(p, 'seriesId'), aids = aidsParam(p)
      const raw: unknown = await add_aids_to_series(seriesId, aids, getCredential(dir, true))
      return accepted(raw, { kind: 'series', seriesId, aids })
    },
    season_remove: async (dir, p) => {
      const seriesId = integer(p, 'seriesId'), aids = aidsParam(p)
      const raw: unknown = await del_aids_from_series(seriesId, aids, getCredential(dir, true))
      return accepted(raw, { kind: 'series', seriesId, aids })
    },
    season_delete: async (dir, p) => {
      const seriesId = integer(p, 'seriesId'), credential = getCredential(dir, true)
      // Validate metadata before upstream's legacy deletion computes pages from total.
      const metaRaw: unknown = await new ChannelSeries(-1, ChannelSeriesType.SERIES, seriesId, credential).get_meta()
      const meta = record(metaRaw, 'series.meta')
      const total = responseInteger(meta.total, 'series.meta.total')
      const owner = responseInteger(meta.mid, 'series.meta.mid', 1)
      if (total > 20000) throw new CliError('BACKEND', '旧版列表超过安全删除分页上限（20000 个视频），未提交删除', 1)
      const selfRaw: unknown = await get_self_info(credential)
      const self = responseInteger(record(selfRaw, 'self_info').mid, 'self_info.mid', 1)
      if (owner !== self) throw new CliError('VALIDATION', '只能删除当前登录账号自己的旧版视频列表（series）', 2)
      const raw: unknown = await del_channel_series(seriesId, credential)
      return accepted(raw, { kind: 'series', seriesId })
    },
    stats_overview: async (dir) => {
      const raw: unknown = await get_overview(getCredential(dir, true))
      if (raw === undefined || raw === null) return { period: 'week', empty: true, reason: 'NO_DATA', data: {} }
      return { period: 'week', data: opaqueData(raw, 'stats_overview') }
    },
    stats_video: async (dir, p) => {
      const bvid = text(p, 'bvid', 12)
      if (!/^BV[0-9A-Za-z]{10}$/.test(bvid)) invalid('bvid 格式无效')
      const video = new Video({ bvid, credential: getCredential(dir, true) })
      const edits: unknown = await get_archive_edits(video)
      const parts: unknown = await get_archive_parts(video)
      return { bvid, dataSource: 'creator_archive_management', edits: opaqueData(edits, 'stats_video.edits'), parts: opaqueData(parts, 'stats_video.parts'), unavailable: ['completion_rate'], note: '仅返回本账号单稿编辑记录和分 P 管理数据；17.5.0 没有按 bvid 查询完播率的公开接口，不以账号整体完播率冒充单稿数据' }
    },
    stats_fans: async (dir) => {
      const raw: unknown = await get_fan_overview(getCredential(dir, true))
      if (raw === undefined || raw === null) return { period: 'week', empty: true, reason: 'NO_DATA', data: {} }
      return { period: 'week', data: opaqueData(raw, 'stats_fans') }
    },
    upload_topics: async (dir, p) => {
      const tid = integer(p, 'tid')
      const raw: unknown = await get_available_topics(tid, getCredential(dir, true))
      return { tid, topics: recordList(raw, 'upload_topics') }
    },
    upload_missions: async (dir, p) => {
      const tid = p.tid === 0 ? 0 : integer(p, 'tid')
      const raw: unknown = await get_missions(tid, getCredential(dir, false))
      return { tid, data: opaqueData(raw, 'upload_missions') }
    },
    upload_cover: async (dir, p) => {
      // All local validation and decoding happens before credential loading/network.
      const cover = localCover(p, 'file')
      const raw: unknown = await upload_cover(cover, getCredential(dir, true))
      if (typeof raw !== 'string' || !/^https?:\/\//.test(raw)) unknownState('upload_cover 未返回有效封面 URL')
      return { success: true, accepted: true, url: raw, visibility: 'not_verified' }
    },
  }
  return Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, safeHandler(handler)]))
}
