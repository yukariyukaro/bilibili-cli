import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { freshDir, installedOrSkip, uniqueToken } from './lib/env.mjs'
import { startWsServer } from './lib/ws-server.mjs'
import { startBridge } from './lib/processes.mjs'

function lifecycleEvents(proc) {
  return proc.output()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

test('离线进程生命周期：真实安装 CLI、本地控制面注册就绪、读取失败不退出（不访问 B 站）', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return

  const home = freshDir('home-lifecycle-')
  const statePath = join(freshDir('state-lifecycle-'), 'state.json')
  const token = uniqueToken('token')
  const server = await startWsServer({ token })
  let proc
  t.after(async () => {
    if (proc) await proc.stop()
    await server.close()
  })

  proc = startBridge({
    installed,
    port: server.port,
    token,
    ownerUid: '42',
    skillHome: home,
    statePath,
  })

  const registered = await server.waitFor((event) => event.message?.type === 'register', { timeout: 20000 })
  assert.equal(registered.message.platform, 'bilibili')
  assert.deepEqual(registered.message.capabilities, ['text'])
  assert.equal(registered.message.metadata?.protocol_version, 1)

  // 实际就绪信号是 register_ack 后的生命周期事件，不是固定等待或伪造日志。
  await proc.waitForOutput(/"type":"registered"/, { timeout: 20000 })
  const eventsAfterRegister = lifecycleEvents(proc)
  assert.ok(eventsAfterRegister.some((event) => event.type === 'registered' && event.transportRegistered === true))
  assert.equal(eventsAfterRegister.some((event) => event.type === 'ready'), false, '空凭证目录没有基线，不能伪造 ready')

  // 没有凭证时必须由真实 CLI 返回 AUTH；adapter 记录 poll failed 但进程继续运行。
  await proc.waitForOutput(/poll failed uid=42: 未登录/, { timeout: 20000 })
  assert.equal(proc.child.exitCode, null, 'CLI 读取失败后 bridge 不应退出')

  assert.equal(existsSync(join(home, 'bili_credential.json')), false, '测试不能创建或复制凭证')
  assert.equal(existsSync(join(home, 'audit.jsonl')), false, '读取失败不能产生写审计')
  assert.equal(existsSync(statePath), false, '读取失败不能提交状态')
  assert.equal(existsSync(statePath + '.lock'), true, '运行中必须有单实例锁文件')

  const log = proc.output()
  assert.doesNotMatch(log, /bili_credential|SESSDATA|bili_jct/i, '进程日志不能包含凭证字段')
  t.diagnostic('生命周期日志：' + proc.logFile)

  await proc.stop()
  assert.notEqual(proc.child.exitCode, null, '停止后进程应退出')
})

test('离线进程重启：同一本地控制面重新注册，普通重启不产生写状态（不访问 B 站）', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return

  const home = freshDir('home-restart-')
  const statePath = join(freshDir('state-restart-'), 'state.json')
  const token = uniqueToken('token')
  const server = await startWsServer({ token })
  let proc
  t.after(async () => {
    if (proc) await proc.stop()
    await server.close()
  })

  proc = startBridge({ installed, port: server.port, token, ownerUid: '42', skillHome: home, statePath })
  await server.waitFor((event) => event.message?.type === 'register', { timeout: 20000 })
  await proc.waitForOutput(/poll failed uid=42: 未登录/, { timeout: 20000 })
  await proc.stop()

  const before = server.events.filter((event) => event.message?.type === 'register').length
  proc = startBridge({ installed, port: server.port, token, ownerUid: '42', skillHome: home, statePath })
  await server.waitFor(() => server.events.filter((event) => event.message?.type === 'register').length > before, { timeout: 20000 })
  await proc.waitForOutput(/poll failed uid=42: 未登录/, { timeout: 20000 })

  assert.equal(proc.child.exitCode, null)
  assert.equal(existsSync(statePath), false)
  assert.equal(existsSync(join(home, 'audit.jsonl')), false)
  t.diagnostic('重启后重新注册；state 未提交：' + statePath)
})
