import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { freshDir, installedOrSkip } from './lib/env.mjs'
import {
  bridgeStatus,
  bridgeStop,
  installedVersion,
  runBilibili,
  runBilibiliRaw,
  runJsonl,
  schema,
} from './lib/cli.mjs'

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

function sentinelToken() {
  return 'sentinel-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

test('bridge 帮助/schema 不创建用户状态、不联网、不读 token', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = join(freshDir('home-bridge-help-'), '未创建的状态目录')
  assert.equal(existsSync(home), false)
  const offlineProxy = {
    HTTP_PROXY: 'http://127.0.0.1:1',
    HTTPS_PROXY: 'http://127.0.0.1:1',
    ALL_PROXY: 'http://127.0.0.1:1',
    NO_PROXY: '',
  }
  const started = Date.now()
  for (const args of [
    ['bridge', '--help'],
    ['bridge', 'run', '--help'],
    ['bridge', 'status', '--help'],
    ['bridge', 'stop', '--help'],
    ['schema', '--json'],
  ]) {
    const result = await runBilibiliRaw(args, { home, installed, env: offlineProxy, timeout: 15000 })
    assert.equal(result.code, 0, args.join(' ') + ' 失败：' + result.stderr)
  }
  assert.ok(Date.now() - started < 15000, '帮助/schema 不应等待网络')
  assert.equal(existsSync(home), false, '帮助/schema 不应创建 BILIBILI_SKILL_HOME')
  assert.equal(existsSync(join(home, 'bridge', 'state.json')), false)
  assert.equal(existsSync(join(home, 'bili_credential.json')), false)
  assert.equal(existsSync(join(home, 'audit.jsonl')), false)
})

test('bridge status/stop 是有限请求：未运行幂等、不创建状态、JSONL 可用', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-bridge-finite-')
  const statePath = join(home, 'bridge-state', 'state.json')

  const status = await bridgeStatus({ statePath, home, installed })
  assert.equal(status.code, 0, status.stderr)
  assert.equal(status.envelope.ok, true)
  assert.equal(status.envelope.result.running, false)
  assert.equal(status.envelope.result.pid, undefined, '未运行时不应返回 pid')
  assert.equal(samePath(status.envelope.result.statePath, statePath), true)
  assert.equal(existsSync(statePath), false, 'status 不应创建 state 文件')
  assert.equal(existsSync(statePath + '.lock'), false, 'status 不应创建锁')

  const stopped = await bridgeStop({ statePath, home, installed })
  assert.equal(stopped.code, 0, stopped.stderr)
  assert.equal(stopped.envelope.ok, true)
  assert.equal(stopped.envelope.result.running, false)
  assert.equal(stopped.envelope.result.stopped, true)
  assert.equal(samePath(stopped.envelope.result.statePath, statePath), true)
  assert.equal(existsSync(statePath + '.stop'), false, '未运行时不应残留 stop marker')

  const jsonl = await runJsonl([
    { id: 'status-jsonl', command: 'bridge status', args: { statePath } },
    { id: 'stop-jsonl', command: 'bridge stop', args: { statePath } },
  ], { home, installed })
  assert.equal(jsonl.code, 0, jsonl.stderr)
  assert.deepEqual(jsonl.rows.map((row) => row.id), ['status-jsonl', 'stop-jsonl'])
  assert.ok(jsonl.rows.every((row) => row.ok === true))
  assert.equal(jsonl.rows[0].result.running, false)
  assert.equal(jsonl.rows[1].result.stopped, true)
  assert.equal(existsSync(statePath), false)
})

test('statePath 传递：--state-path > BILIBILI_BRIDGE_STATE > 账号目录/bridge/state.json', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const root = freshDir('home-bridge-state-path-')
  const explicit = join(root, '显式 状态', 'state.json')
  const fromEnv = join(root, '环境 状态', 'state.json')

  const explicitResult = await bridgeStatus({ statePath: explicit, home: join(root, 'home-explicit'), installed })
  assert.equal(explicitResult.envelope.result.running, false)
  assert.equal(samePath(explicitResult.envelope.result.statePath, explicit), true, '--state-path 必须是最高优先级')
  assert.equal(existsSync(explicit), false)

  const envResult = await runBilibili(['bridge', 'status', '--json'], {
    installed,
    home: join(root, 'home-env'),
    env: { BILIBILI_BRIDGE_STATE: fromEnv },
  })
  assert.equal(envResult.code, 0, envResult.stderr)
  assert.equal(envResult.envelope.ok, true)
  assert.equal(samePath(envResult.envelope.result.statePath, fromEnv), true, 'BILIBILI_BRIDGE_STATE 应作为默认状态路径')

  const home = join(root, '账号 目录')
  const defaultResult = await runBilibili(['bridge', 'status', '--json'], { installed, home })
  assert.equal(defaultResult.code, 0, defaultResult.stderr)
  assert.equal(defaultResult.envelope.ok, true)
  assert.equal(samePath(defaultResult.envelope.result.statePath, join(home, 'bridge', 'state.json')), true, '默认状态路径必须是账号目录/bridge/state.json')
  assert.equal(existsSync(join(home, 'bridge', 'state.json')), false)
})

test('JSONL：bridge run 先校验再 STREAM_ONLY，后续有限请求继续处理', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-bridge-jsonl-')
  const pkg = JSON.parse(readFileSync(join(installed.packageDir, 'package.json'), 'utf8'))

  const validRun = {
    id: 'run-jsonl',
    command: 'bridge run',
    args: { statePath: join(home, 'state.json'), ownerUids: '424242', url: 'ws://127.0.0.1:1/bridge/ws', pollMs: 6000 },
  }
  const result = await runJsonl([validRun, { id: 'schema-after-run', command: 'schema' }], { home, installed })
  assert.equal(result.code, 2, 'bridge run 在 JSONL 中应以参数/用法错误退出 2')
  assert.equal(result.rows.length, 2, 'run 被拒绝后同一 stdin 的 schema 仍必须响应')
  assert.equal(result.rows[0].id, 'run-jsonl')
  assert.equal(result.rows[0].ok, false)
  assert.equal(result.rows[0].error.code, 'STREAM_ONLY')
  assert.equal(result.rows[1].id, 'schema-after-run')
  assert.equal(result.rows[1].ok, true)
  assert.equal(result.rows[1].result.schemaVersion, 1)
  assert.equal(result.rows[1].result.version, pkg.version)

  const invalidRun = {
    id: 'run-invalid',
    command: 'bridge run',
    args: { statePath: join(home, 'state.json'), ownerUids: 'not-a-uid', url: 'ws://127.0.0.1:1/bridge/ws', pollMs: 6000 },
  }
  const invalid = await runJsonl([invalidRun, { id: 'status-after-invalid', command: 'bridge status', args: { statePath: join(home, 'state.json') } }], { home, installed })
  assert.equal(invalid.code, 2)
  assert.equal(invalid.rows.length, 2)
  assert.equal(invalid.rows[0].error.code, 'VALIDATION', 'run 必须先执行参数校验，不能直接 STREAM_ONLY')
  assert.equal(invalid.rows[1].ok, true)
  assert.equal(invalid.rows[1].result.running, false)
  assert.equal(existsSync(join(home, 'state.json')), false, 'JSONL 拒绝/有限状态请求不应创建 state')
})

test('bridge run 参数校验失败退出 2，不创建状态或锁', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-bridge-validation-')
  const statePath = join(home, 'state.json')
  const token = sentinelToken()
  const result = await runBilibiliRaw([
    'bridge', 'run',
    '--state-path', statePath,
    '--owner-uids', 'not-a-uid',
    '--url', 'ws://127.0.0.1:1/bridge/ws',
    '--poll-ms', '6000',
  ], { home, installed, env: { CC_CONNECT_BRIDGE_TOKEN: token }, timeout: 20000 })
  assert.equal(result.code, 2, 'CLI 参数校验失败应以 exit 2 退出')
  assert.equal(result.stdout.trim(), '', 'stream 参数校验失败不能输出 JSON 事件或正常事件流')
  assert.match(result.stderr, /参数无效|ownerUids|VALIDATION/i, '应输出明确校验错误')
  assert.equal(result.stdout.includes(token), false, 'pre-run 校验失败 stdout 不得包含 token')
  assert.equal(result.stderr.includes(token), false, 'pre-run 校验失败 stderr 不得包含 token')
  assert.equal(existsSync(statePath), false, '校验失败不应创建 state')
  assert.equal(existsSync(statePath + '.lock'), false, '校验失败不应创建锁')
})

test('bridge run runtime CONFIG 失败：JSON error 事件、token 不泄漏、不建状态/锁', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-bridge-runtime-config-')
  const statePath = join(home, 'state.json')
  const token = sentinelToken()
  // CLI 参数合法（故意省略 --owner-uids），由 bridge readConfig 读取非法的
  // BILIBILI_OWNER_UID，必须输出 type:error 事件而不是退回 JSONL/text 错误。
  const result = await runBilibiliRaw([
    'bridge', 'run',
    '--state-path', statePath,
    '--url', 'ws://127.0.0.1:1/bridge/ws',
    '--poll-ms', '6000',
  ], { home, installed, env: { CC_CONNECT_BRIDGE_TOKEN: token, BILIBILI_OWNER_UID: 'not-a-uid' }, timeout: 20000 })
  assert.equal(result.code, 2, 'runtime config 失败应以 exit 2 退出')
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  assert.equal(lines.length, 1, 'runtime config 失败 stdout 应恰好一条 error 事件：' + result.stdout)
  const event = JSON.parse(lines[0])
  assert.equal(event.type, 'error')
  assert.equal(event.stage, 'config')
  assert.equal(event.code, 'CONFIG')
  assert.equal(event.fatal, true)
  assert.equal(result.stdout.includes(token), false, 'runtime CONFIG stdout 不得包含 token')
  assert.equal(result.stderr.includes(token), false, 'runtime CONFIG stderr 不得包含 token')
  assert.equal(existsSync(statePath), false, 'runtime CONFIG 不应创建 state')
  assert.equal(existsSync(statePath + '.lock'), false, 'runtime CONFIG 不应创建锁')
})
