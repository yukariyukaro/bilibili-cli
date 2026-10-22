/**
 * src/lib/login.mts —— 扫码登录（直接在 JS 里走 B站 passport 接口）。
 * ============================================================================
 * 保持旧实现实测路径：
 *   ① GET  /x/passport-login/web/qrcode/generate → data.url + data.qrcode_key
 *   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
 *      data.code：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
 *   ③ 凭证在轮询响应的 Set-Cookie 头里，不在 data.url 里
 *   ④ 写成后端认识的四个字段：sessdata / bili_jct / buvid3 / dedeuserid
 *
 * 二维码 PNG 由 npm 依赖 qrcode 生成；失败时只返回 null，不影响 URL 展示。
 * 响应体是外部输入，统一先当 unknown 再窄化；不在日志或异常里输出凭证值。
 * ============================================================================
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import type { CredentialRecord, LoginPollResult, LoginStartResult } from './service-types.mjs'
import { isRecord, toList, toRecord, toText } from './service-types.mjs'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key: string): string => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 只在结构匹配时调用 headers.getSetCookie；DOM/Node 类型定义不一定声明该方法。 */
interface GetSetCookieHeaders {
  getSetCookie(): unknown
}

function hasGetSetCookie(value: unknown): value is GetSetCookieHeaders {
  return isRecord(value) && typeof value.getSetCookie === 'function'
}

function readSetCookies(headers: unknown): string[] {
  if (!hasGetSetCookie(headers)) return []
  return toList(headers.getSetCookie()).filter((item): item is string => typeof item === 'string')
}

/** 从 Set-Cookie 数组里抠出后端认识的四个字段。 */
function pickCookies(list: readonly string[]): CredentialRecord {
  const jar: CredentialRecord = {}
  const want: Record<string, string> = {
    SESSDATA: 'sessdata',
    bili_jct: 'bili_jct',
    DedeUserID: 'dedeuserid',
    buvid3: 'buvid3',
  }
  for (const raw of list) {
    const first = String(raw).split(';')[0] || ''
    const index = first.indexOf('=')
    if (index <= 0) continue
    const name = first.slice(0, index).trim()
    const value = first.slice(index + 1).trim()
    const field = want[name]
    if (!field) continue
    if (field === 'sessdata') jar.sessdata = value
    else if (field === 'bili_jct') jar.bili_jct = value
    else if (field === 'dedeuserid') jar.dedeuserid = value
    else jar.buvid3 = value
  }
  return jar
}

/** 拿不到 buvid3 时补一张“指纹”（非致命，失败就当空）。 */
async function ensureBuvid3(jar: CredentialRecord): Promise<CredentialRecord> {
  if (jar.buvid3) return jar
  try {
    const response = await fetch(SPI, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
    const body: unknown = await response.json()
    const value = toRecord(toRecord(body).data).b_3
    if (typeof value === 'string' && value) jar.buvid3 = value
  } catch {
    /* 拿不到就算了 */
  }
  return jar
}

export async function loginStart(): Promise<LoginStartResult> {
  const response = await fetch(GEN, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
  const body: unknown = await response.json()
  const data = toRecord(toRecord(body).data)
  const key = typeof data.qrcode_key === 'string' ? data.qrcode_key : ''
  const url = typeof data.url === 'string' ? data.url : ''
  if (!key || !url) throw new Error(`生成二维码失败：${toText(toRecord(body).message) || '返回里没有 qrcode_key'}`)
  return { key, url }
}

/** 轮询一次。state: waiting / scanned / ok / expired / unknown */
export async function loginPoll(key: string): Promise<LoginPollResult> {
  const response = await fetch(pollUrl(key), {
    headers: { 'User-Agent': UA },
    redirect: 'manual',
    signal: AbortSignal.timeout(30000),
  })
  const setCookies = readSetCookies(response.headers)
  let body: unknown = {}
  try {
    body = await response.json()
  } catch {
    /* poll 有时返回空体 */
  }
  const code = toRecord(toRecord(body).data).code
  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(setCookies))
    if (!jar.sessdata) return { state: 'unknown', code, message: '登录成功了，但响应里没有 SESSDATA —— 把这次的结果记下来再排查' }
    return { state: 'ok', code, credential: jar }
  }
  let state: 'waiting' | 'scanned' | 'expired' | 'unknown' = 'unknown'
  if (code === 86101) state = 'waiting'
  else if (code === 86090) state = 'scanned'
  else if (code === 86038) state = 'expired'
  return { state, code, message: toText(toRecord(body).message) }
}

/** 把凭证写进后端读取的那个文件（状态目录里的 bili_credential.json）。 */
export function saveCredential(dir: string, credential: CredentialRecord): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'bili_credential.json')
  writeFileSync(file, JSON.stringify({
    sessdata: credential.sessdata ?? '',
    bili_jct: credential.bili_jct ?? '',
    buvid3: credential.buvid3 || '',
    dedeuserid: credential.dedeuserid ?? '',
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return file
}

/** 用纯 JS 的 qrcode 生成登录二维码 PNG；失败时返回 null，不影响 URL 展示。 */
export async function renderQrPng(dir: string, url: string): Promise<string | null> {
  try {
    const png = join(dir, 'qrcode_login.png')
    await QRCode.toFile(png, url, { width: 360, margin: 1 })
    return png
  } catch {
    return null
  }
}
