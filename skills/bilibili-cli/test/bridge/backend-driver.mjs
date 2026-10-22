// 由离线 E2E 启动的独立 bridge 传输驱动，不作为单元测试导入。
// 只 import 已安装的 dist/lib/bridge/backend.mjs；绝不 import 仓库 src，也不伪造 B 站业务成功。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { installedBridgeModule, resolveInstalledPrefix } from './lib/env.mjs'

const mode = process.argv[2] || 'installed'
const installed = resolveInstalledPrefix(process.env)
assert.ok(installed.ok, 'backend-driver 需要 BILIBILI_E2E_INSTALLED_PREFIX：' + (installed.reason || ''))
const backendModule = await import(pathToFileURL(installedBridgeModule(installed, 'backend.mjs')).href)
const { BilibiliCliBackend } = backendModule
assert.equal(typeof BilibiliCliBackend, 'function', '安装产物 backend.mjs 未导出 BilibiliCliBackend')

// 即使直接运行 driver 也绝不回落到调用者的真实状态；不迁移任何凭证。
const home = mkdtempSync(join(tmpdir(), 'bridge-backend-no-auth-'))
const env = { ...process.env, BILIBILI_SKILL_HOME: home, NODE_OPTIONS: '', NODE_PATH: '' }
assert.equal(existsSync(join(env.BILIBILI_SKILL_HOME, 'bili_credential.json')), false)
const backend = new BilibiliCliBackend({ env, requestTimeoutMs: 10000 })
const errorCode = (code) => (error) => { assert.equal(error.code, code); return true }
try {
  if (mode === 'installed') {
    const schema = await backend.call('schema')
    assert.ok(schema.commands.some((item) => item.name === 'dm read'))
    const pair = await Promise.all([backend.call('doctor'), backend.call('skills list')])
    assert.equal(pair[0].dependenciesInstalled, true)
    assert.equal(pair[1][0].name, 'bilibili-cli')
    await assert.rejects(backend.call('dm read', { uid: 'invalid' }), errorCode('VALIDATION'))
    const auth = await backend.call('auth status')
    assert.equal(auth.logged_in, false)
    const preview = await backend.sendDm('946974', '仅预览 中文 & % " 不执行')
    assert.equal(preview.dryRun, true)
    // bridge 开关关闭 dry-run 不代表 CLI 写入开关已开启。
    env.BILIBILI_BRIDGE_DRY_RUN = 'false'
    await assert.rejects(backend.sendDm('946974', '不发送'), errorCode('CONFIRM_REQUIRED'))
    await assert.rejects(backend.sendDm('946974', '不发送', { confirm: true }), errorCode('WRITE_DISABLED'))
    await assert.rejects(backend.call('not a command'), errorCode('USAGE'))
    await backend.call('config set', { key: 'dmRecipientUid', value: '946974' })
    await assert.rejects(backend.call('dm send', { uid: 946975, text: '不发送', dryRun: true }), errorCode('VALIDATION'))
    // 仅操作本轮新建的无凭证隔离目录：审计 attempt 先失败，不能调用远端。
    await backend.call('config set', { key: 'writesEnabled', value: 'true' })
    const blockedAudit = join(env.BILIBILI_SKILL_HOME, 'audit.jsonl')
    mkdirSync(blockedAudit)
    try { await assert.rejects(backend.sendDm('946974', '审计前拒绝 不发送', { confirm: true }), errorCode('AUDIT')) }
    finally {
      await backend.call('config set', { key: 'writesEnabled', value: 'false' })
      rmdirSync(blockedAudit) // 精确删除刚由测试创建的空目录，绝不访问真实状态。
    }
    assert.ok((await backend.call('schema')).commands.length > 0, '业务失败不破坏 JSONL 传输')
    console.log(JSON.stringify({ type: 'pass', scope: 'installed-cli', module: 'dist/lib/bridge/backend.mjs', cases: ['schema/doctor', 'JSONL correlation', 'validation', 'no-auth', 'preview', 'confirmation refusal', 'CLI write disabled', 'recipient restriction', 'audit attempt failure'] }))
  } else {
    await backend.close()
    const fixture = {
      timeout: 'process.stdin.resume(); setInterval(()=>{},1000)',
      exit: 'process.stdin.once("data",()=>process.exit(17))',
      malformed: 'process.stdin.once("data",()=>{console.log("not-json");process.stdin.resume()})',
      audit: 'let b="";process.stdin.on("data",c=>{b+=c;let n;while((n=b.indexOf("\\n"))>=0){const r=JSON.parse(b.slice(0,n));b=b.slice(n+1);console.log(JSON.stringify({id:r.id,ok:false,error:{code:"AUDIT_FAILED",message:"fixture audit failure; outcome unknown"}}))}})',
    }[mode]
    assert.ok(fixture, 'unknown transport-fault mode')
    // 仅故障协议子进程：永不伪造成功的 B 站发送/读取。
    const transport = new BilibiliCliBackend({ command: process.execPath, args: ['-e', fixture], env: { ...env, BILIBILI_BRIDGE_DRY_RUN: 'false' }, requestTimeoutMs: mode === 'timeout' ? 200 : 3000 })
    try {
      const expected = { timeout: 'CLI_TIMEOUT', exit: 'CLI_EXIT', malformed: 'CLI_PROTOCOL', audit: 'AUDIT_FAILED' }[mode]
      await assert.rejects(mode === 'audit' ? transport.sendDm('946974', '仅故障协议', { confirm: true }) : transport.call('schema'), errorCode(expected))
      assert.equal(transport.sequence, 1, '故障/未知结果不能自动重发')
      assert.equal(transport.pending.size, 0)
      console.log(JSON.stringify({ type: 'pass', scope: 'transport-fault-' + mode, module: 'dist/lib/bridge/backend.mjs', checks: 3, timeoutRecorded: mode === 'timeout', retried: false }))
    } finally { await transport.close() }
  }
} finally {
  await backend.close()
  assert.equal(existsSync(join(env.BILIBILI_SKILL_HOME, 'bili_credential.json')), false)
  assert.equal(existsSync(join(env.BILIBILI_SKILL_HOME, 'audit.jsonl')), false)
}
