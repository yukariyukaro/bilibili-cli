import test from 'node:test'
import assert from 'node:assert/strict'
import { statSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { freshDir, installedOrSkip } from './lib/env.mjs'
import { IS_WINDOWS, buildChildEnv } from '../lib/env.mjs'

function quoteForCmd(value) {
  return '"' + String(value).replaceAll('"', '""').replaceAll('%', '%%') + '"'
}

function cmdArg(value) {
  const text = String(value)
  if (text.length === 0) return '""'
  return /[\s"&|<>^()%!]/.test(text) ? quoteForCmd(text) : text
}

/** 与仓库其它用例一致：Windows 经 cmd shim 调用安装产物的 bilibili 入口。 */
function spawnCli(bin, args, options) {
  if (IS_WINDOWS) {
    const shell = process.env.ComSpec || 'cmd.exe'
    const line = [bin, ...args].map(cmdArg).join(' ')
    return spawn(shell, ['/d', '/s', '/c', line], { ...options, windowsVerbatimArguments: true })
  }
  return spawn(bin, args, options)
}

const CONSOLE_TOKEN = 'console-test-' + 'x'.repeat(20)

/** 启动 bridge run，并从 stdout 读取它自动带起的控制台入口。 */
async function startBridge({ installed, home, extra = {} }) {
  const statePath = join(home, 'bridge', 'state.json')
  const configPath = join(home, 'bridge', 'console.json')
  const env = buildChildEnv({
    baseEnv: {
      ...process.env,
      BILIBILI_OWNER_UID: '1',
      CC_CONNECT_BRIDGE_TOKEN: 'sentinel-token-not-used',
      CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws',
      BILIBILI_CONSOLE_PORT: '0',
      BILIBILI_CONSOLE_TOKEN: CONSOLE_TOKEN,
      ...extra,
    },
    installed,
    home,
  })
  // 与仓库其它用例一致：交给 cmd 从 PATH 解析 bilibili，避免中文安装目录的编码问题。
  const child = spawnCli('bilibili', ['bridge', 'run', '--state-path', statePath, '--config-path', configPath], {
    cwd: home,
    env,
    windowsHide: true,
    detached: !IS_WINDOWS,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.once('close', (code) => resolve(code)))

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待 console_ready 超时：' + stderr.slice(-800))), 45000)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const line = stdout.split(/\r?\n/).find((entry) => entry.includes('"console_ready"'))
      if (!line) return
      clearTimeout(timer)
      try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
    })
    child.once('close', (code) => { clearTimeout(timer); reject(new Error('bridge 提前退出 code=' + code + '：' + stderr.slice(-800))) })
  })

  const origin = new URL(ready.url).origin
  return { child, exited, ready, origin, statePath, configPath, token: new URLSearchParams(new URL(ready.url).hash.slice(1)).get('token') }
}

async function stopBridge(bridge) {
  try { bridge.child.stdin.end() } catch {}
  const code = await Promise.race([
    bridge.exited,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), 15000)),
  ])
  if (code === 'timeout') { try { bridge.child.kill('SIGKILL') } catch {} }
  return code
}

test('bridge run 自动带起仅本机控制台，并输出一次性入口', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('console-auto-')
  const bridge = await startBridge({ installed, home })
  try {
    assert.equal(bridge.token, CONSOLE_TOKEN, '入口 token 必须来自显式配置')
    assert.equal(new URL(bridge.ready.url).hostname, '127.0.0.1', '控制台只能绑定回环地址')
    // Windows 下经 cmd shim 启动，child.pid 是 shim 的 PID，因此只校验它是有效的正整数。
    assert.ok(Number.isSafeInteger(bridge.ready.pid) && bridge.ready.pid > 0)
  } finally { await stopBridge(bridge) }
})

test('控制台静态资源、安全响应头与鉴权边界', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('console-http-')
  const bridge = await startBridge({ installed, home })
  const { origin, token } = bridge
  const auth = { Authorization: 'Bearer ' + token }
  try {
    const page = await fetch(origin + '/')
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') ?? '', /text\/html/)
    assert.equal(page.headers.get('cache-control'), 'no-store')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/)
    const html = await page.text()
    assert.match(html, /id="page-overview"/, '首页必须包含概览区')
    assert.match(html, /id="unlock-form"/, '未授权时必须提供令牌解锁入口')

    for (const asset of ['/assets/console.css', '/assets/console.js']) {
      const response = await fetch(origin + asset)
      assert.equal(response.status, 200, asset + ' 必须可被发布产物提供')
    }

    assert.equal((await fetch(origin + '/api/state')).status, 403, '缺少令牌必须拒绝')
    assert.equal((await fetch(origin + '/api/state', { headers: { ...auth, Origin: 'http://evil.test' } })).status, 403, '跨站 Origin 必须拒绝')
    assert.equal((await fetch(origin + '/api/state', { headers: { ...auth, 'Sec-Fetch-Site': 'cross-site' } })).status, 403, '跨站 Fetch Metadata 必须拒绝')
    assert.equal((await fetch(origin + '/api/state?probe=1', { headers: auth })).status, 404, '不接受查询参数')
    assert.equal((await fetch(origin + '/nowhere')).status, 404)

    const state = await fetch(origin + '/api/state', { headers: auth })
    assert.equal(state.status, 200)
    const snapshot = await state.json()
    assert.equal(typeof snapshot.revision, 'string')
    assert.equal(snapshot.config.version, 1)
    assert.equal(typeof snapshot.status.running, 'boolean')
    assert.ok(Array.isArray(snapshot.events))
    assert.equal(JSON.stringify(snapshot).includes(token), false, 'API 不得回显访问令牌')
    assert.equal(JSON.stringify(snapshot).includes('sentinel-token-not-used'), false, 'API 不得回显 bridge token')
  } finally { await stopBridge(bridge) }
})

test('配置写入：类型校验、体检、CAS 冲突与 0600 落盘', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('console-config-')
  const bridge = await startBridge({ installed, home })
  const { origin, token, configPath } = bridge
  const auth = { Authorization: 'Bearer ' + token }
  const put = (body, headers = auth) => fetch(origin + '/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  try {
    const snapshot = await (await fetch(origin + '/api/state', { headers: auth })).json()

    assert.equal((await fetch(origin + '/api/config', { method: 'PUT', headers: auth, body: '{}' })).status, 415, '缺少 JSON content-type 必须拒绝')
    assert.equal((await put({ revision: snapshot.revision })).status, 400, '缺少 config 必须拒绝')
    assert.equal((await put({ revision: 'stale', config: snapshot.config })).status, 409, '过期 revision 必须冲突')
    assert.equal((await put(JSON.stringify({ revision: snapshot.revision, config: snapshot.config, extra: 1 }))).status, 400, '未知字段必须拒绝')

    const invalid = structuredClone(snapshot.config)
    invalid.connection.pollMs = 1
    const invalidResponse = await put({ revision: snapshot.revision, config: invalid })
    assert.equal(invalidResponse.status, 400, '非法配置必须拒绝')
    assert.match(await invalidResponse.text(), /轮询间隔/, '必须指出是轮询间隔非法')

    const valid = structuredClone(snapshot.config)
    valid.schedule.enabled = true
    valid.schedule.time = '09:30'
    valid.reply.policy = 'draft'
    valid.connection.ownerUids = ['39374538']
    valid.notification.channel = 'dm'
    valid.notification.ownerUid = '39374538'
    const saved = await put({ revision: snapshot.revision, config: valid })
    const savedText = await saved.text()
    assert.equal(saved.status, 200, '保存合法配置失败：' + savedText)
    const savedBody = JSON.parse(savedText)
    assert.equal(savedBody.config.schedule.enabled, true)
    assert.equal(savedBody.config.schedule.time, '09:30')
    assert.notEqual(savedBody.revision, snapshot.revision, '保存后 revision 必须变化')
    assert.equal(typeof savedBody.status.nextRunAt, 'string', '启用定时后必须给出下一次运行时间')

    assert.equal(existsSync(configPath), true, '配置必须落盘')
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(onDisk.schedule.time, '09:30')
    if (!IS_WINDOWS) assert.equal(statSync(configPath).mode & 0o777, 0o600, '配置文件必须是 0600')

    const oversized = await put({ revision: savedBody.revision, config: 'x'.repeat(70000) })
    assert.equal(oversized.status, 413, '超大请求体必须拒绝')
  } finally { await stopBridge(bridge) }
})

test('控制动作：暂停/恢复可观测，未知动作与错误方法被拒绝', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('console-control-')
  const bridge = await startBridge({ installed, home })
  const { origin, token } = bridge
  const auth = { Authorization: 'Bearer ' + token }
  const control = (body) => fetch(origin + '/api/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...auth },
    body: JSON.stringify(body),
  })
  try {
    const paused = await control({ action: 'pause' })
    assert.equal(paused.status, 200)
    assert.equal((await paused.json()).status.paused, true, '暂停必须反映在状态里')

    const resumed = await control({ action: 'resume' })
    assert.equal(resumed.status, 200)
    assert.equal((await resumed.json()).status.paused, false, '恢复必须反映在状态里')

    assert.equal((await control({ action: 'nope' })).status, 400, '未知动作必须拒绝')
    assert.equal((await control({ action: 'start', extra: 1 })).status, 400, '多余字段必须拒绝')
    assert.equal((await fetch(origin + '/api/control', { headers: auth })).status, 405, '错误方法必须拒绝')
  } finally { await stopBridge(bridge) }
})

test('控制台随 bridge 生命周期结束：stdin EOF 优雅退出且端口释放', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('console-lifecycle-')
  const bridge = await startBridge({ installed, home })
  const { origin } = bridge
  const code = await stopBridge(bridge)
  assert.equal(code, 0, 'stdin EOF 必须优雅退出 code=0')
  await assert.rejects(() => fetch(origin + '/'), '进程结束后控制台必须不可达')
})
