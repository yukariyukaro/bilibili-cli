/**
 * lib/login.mjs —— 扫码登录（直接在 JS 里走 B站 passport 接口）
 * ============================================================================
 * 为什么不用它自带的 `bili_login`：那个把码存成 PNG 就返回，**字段全是空**（踩过一次，见 lesson）。
 * 我们按实测跑通的那条来：
 *   ① GET  /x/passport-login/web/qrcode/generate?source=main-fe-header  → data.url + data.qrcode_key
 *   ② 手机扫 → 轮询 /x/passport-login/web/qrcode/poll?qrcode_key=…
 *      data.code：86101 未扫 / 86090 已扫待确认 / 0 成功 / 86038 过期
 *   ③ ⭐ **凭证在轮询响应的 `Set-Cookie` 头里**（成功时那条 `data.url` 里没有 SESSDATA，
 *      那是别的域的游戏票 —— 别在 url 里找）
 *   ④ 写成后端认识的四个字段：sessdata / bili_jct / buvid3 / dedeuserid
 *
 * 二维码图片：由 npm 依赖 `qrcode` 直接生成 PNG（无外部进程、无需 Python）；
 * 生成失败时退回"只给 URL"，不影响扫码流程。
 * ============================================================================
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const pollUrl = (key) => 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=' + encodeURIComponent(key) + '&source=main-fe-header'
const SPI = 'https://api.bilibili.com/x/frontend/finger/spi'

/** 从 Set-Cookie 数组里抠出我们要的几个 */
function pickCookies(list) {
  const jar = {}
  const want = { SESSDATA: 'sessdata', bili_jct: 'bili_jct', DedeUserID: 'dedeuserid', buvid3: 'buvid3' }
  for (const raw of list ?? []) {
    const first = String(raw).split(';')[0] || ''
    const i = first.indexOf('=')
    if (i <= 0) continue
    const name = first.slice(0, i).trim()
    const value = first.slice(i + 1).trim()
    if (want[name]) jar[want[name]] = value
  }
  return jar
}

/** 拿不到 buvid3 时补一张"指纹"（非致命，失败就当空） */
async function ensureBuvid3(jar) {
  if (jar.buvid3) return jar
  try {
    const r = await fetch(SPI, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
    const j = await r.json()
    const v = j?.data?.b_3
    if (v) jar.buvid3 = v
  } catch { /* 拿不到就算了 */ }
  return jar
}

export async function loginStart() {
  const r = await fetch(GEN, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) })
  const j = await r.json()
  const data = j?.data
  if (!data?.qrcode_key || !data?.url) throw new Error(`生成二维码失败：${j?.message || '返回里没有 qrcode_key'}`)
  return { key: data.qrcode_key, url: data.url }
}

/** 轮询一次。state: waiting / scanned / ok / expired / unknown */
export async function loginPoll(key) {
  const res = await fetch(pollUrl(key), { headers: { 'User-Agent': UA }, redirect: 'manual', signal: AbortSignal.timeout(30000) })
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : []
  let body = {}
  try { body = await res.json() } catch { /* poll 有时返回空体 */ }
  const code = body?.data?.code
  if (code === 0) {
    const jar = await ensureBuvid3(pickCookies(setCookies))
    if (!jar.sessdata) return { state: 'unknown', code, message: '登录成功了，但响应里没有 SESSDATA —— 把这次的结果记下来再排查' }
    return { state: 'ok', code, credential: jar }
  }
  const map = { 86101: 'waiting', 86090: 'scanned', 86038: 'expired' }
  return { state: map[code] ?? 'unknown', code, message: body?.message || '' }
}

/** 把凭证写进后端读取的那个文件（家目录里的 bili_credential.json） */
export function saveCredential(stateDir, credential) {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'bili_credential.json')
  writeFileSync(file, JSON.stringify({
    sessdata: credential.sessdata ?? '',
    bili_jct: credential.bili_jct ?? '',
    buvid3: credential.buvid3 || '',
    dedeuserid: credential.dedeuserid ?? '',
  }, null, 2), { encoding: 'utf8', mode: 0o600 })
  return file
}

/** 用纯 JS 的 qrcode 生成登录二维码 PNG；失败时返回 null，不影响 URL 展示 */
export async function renderQrPng(stateDir, url) {
  try {
    const png = join(stateDir, 'qrcode_login.png')
    await QRCode.toFile(png, url, { width: 360, margin: 1 })
    return png
  } catch {
    return null
  }
}
