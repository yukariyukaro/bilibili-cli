import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installedBridgeModule } from '../lib/env.mjs'
import {
  BRIDGE_TEST_DIR,
  E2E_DIR,
  freshDir,
  installedOrSkip,
} from './lib/env.mjs'
import { configGet, runBilibili, runJsonl } from './lib/cli.mjs'
import { startProcess } from './lib/processes.mjs'

const quietLogger = { log() {}, warn() {}, error() {} }

async function loadInstalledBackend(installed) {
  const module = await import(pathToFileURL(installedBridgeModule(installed, 'backend.mjs')).href)
  return module.BilibiliCliBackend
}

test('真实安装 CLI 的写保护：dry-run 可用，--confirm 在 writesEnabled=false 下明确拒绝且不写审计', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-write-safety-')
  const before = await configGet(home)
  assert.equal(before.writesEnabled, false, '隔离状态目录不应预置写权限')

  const dry = await runBilibili(
    ['dm', 'send', '--uid', '1', '--text', '只读安全 dry-run 不发送', '--dry-run', '--json'],
    { home, installed },
  )
  assert.equal(dry.code, 0, dry.stderr)
  assert.equal(dry.envelope.ok, true)
  assert.equal(dry.envelope.result.dryRun, true)

  const confirmed = await runBilibili(
    ['dm', 'send', '--uid', '1', '--text', '只读安全 不发送', '--confirm', '--json'],
    { home, installed },
  )
  assert.equal(confirmed.code, 3, 'CLI 应以写保护退出码 3 拒绝')
  assert.equal(confirmed.envelope.ok, false)
  assert.equal(confirmed.envelope.error.code, 'WRITE_DISABLED')

  const jsonl = await runJsonl(
    [{ id: 'write-refusal', command: 'dm send', args: { uid: 1, text: '只读安全 不发送', confirm: true } }],
    { home, installed },
  )
  assert.equal(jsonl.code, 3)
  assert.equal(jsonl.rows.length, 1)
  assert.equal(jsonl.rows[0].id, 'write-refusal')
  assert.equal(jsonl.rows[0].ok, false)
  assert.equal(jsonl.rows[0].error.code, 'WRITE_DISABLED')

  assert.equal(existsSync(join(home, 'audit.jsonl')), false, '禁写路径不能产生审计')
  assert.equal(existsSync(join(home, 'bili_credential.json')), false, '测试不能创建或复制凭证')
})

test('bridge CLI 传输层（真实安装 CLI 子进程）：无确认不放行，确认后仍由 CLI 写保护拒绝，且不自动重试', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-backend-write-safety-')
  const BilibiliCliBackend = await loadInstalledBackend(installed)
  const currentPath = process.env.PATH || process.env.Path || ''
  const mergedPath = installed.binDir + (process.platform === 'win32' ? ';' : ':') + currentPath
  const backend = new BilibiliCliBackend({
    command: 'bilibili',
    env: {
      ...process.env,
      BILIBILI_SKILL_HOME: home,
      BILIBILI_BRIDGE_DRY_RUN: 'false',
      PATH: mergedPath,
      ...(process.platform === 'win32' ? { Path: mergedPath } : {}),
    },
    logger: quietLogger,
    requestTimeoutMs: 10000,
  })
  try {
    await assert.rejects(backend.sendDm('1', '不发送'), (error) => error.code === 'CONFIRM_REQUIRED')
    await assert.rejects(backend.sendDm('1', '不发送', { confirm: true }), (error) => error.code === 'WRITE_DISABLED')
    assert.equal(backend.sequence, 1, '确认后只调用一次；未知/失败结果不能自动重发')
    assert.equal(backend.pending.size, 0, '失败后不能留下 pending 请求')
  } finally {
    await backend.close()
  }
  assert.equal(existsSync(join(home, 'audit.jsonl')), false)
})

test('只读入口配置门禁：显式 READONLY 但缺 prefix/home/ownerUid 时 exit 2，不运行测试', async (t) => {
  const proc = startProcess({
    name: 'run-readonly-config-error',
    command: process.execPath,
    args: [join(E2E_DIR, 'run.mjs'), 'readonly'],
    env: {
      ...process.env,
      BILIBILI_E2E_READONLY: '1',
      BILIBILI_E2E_INSTALLED_PREFIX: '',
      BILIBILI_E2E_AGENT_HOME: '',
      BILIBILI_E2E_OWNER_UID: '',
      BILIBILI_E2E_WRITE: '',
      BILIBILI_E2E: '',
    },
  })
  t.after(async () => { await proc.stop() })
  const result = await proc.exited
  assert.equal(result.code, 2, '显式只读缺必需配置必须 exit 2，而不是全部 skip 后 exit 0：' + proc.output())
  assert.match(proc.output(), /配置错误（exit 2）/, '应明确报告配置错误')
  assert.match(proc.output(), /BILIBILI_E2E_INSTALLED_PREFIX/, '应指出缺少安装前缀')
  assert.doesNotMatch(proc.output(), /# tests \d+/, '配置错误时不能启动测试运行器')
})

test('写入口分离：run.mjs write 与旧 integration.mjs 都明确拒绝，不执行真实写', async (t) => {
  const write = startProcess({
    name: 'run-write-refusal',
    command: process.execPath,
    args: [join(E2E_DIR, 'run.mjs'), 'write'],
    env: { ...process.env, BILIBILI_E2E_WRITE: '1' },
  })
  t.after(async () => { await write.stop() })
  const writeResult = await write.exited
  assert.equal(writeResult.code, 3, '写入口必须以非零状态拒绝：' + write.output())
  assert.match(write.output(), /refused|拒绝/i)

  const legacy = startProcess({
    name: 'integration-refusal',
    command: process.execPath,
    args: [join(BRIDGE_TEST_DIR, 'integration.mjs')],
    env: { ...process.env, BILIBILI_E2E_WRITE: '1' },
  })
  t.after(async () => { await legacy.stop() })
  const legacyResult = await legacy.exited
  assert.equal(legacyResult.code, 3, '旧 fake 集成测试入口必须拒绝：' + legacy.output())
  assert.match(legacy.output(), /REFUSED|拒绝|迁移/i)
})
