import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { assertSchemaContract } from '../lib/contract.mjs'
import { freshDir, installedOrSkip } from './lib/env.mjs'
import {
  authStatus,
  configGet,
  doctor,
  installedVersion,
  runBilibili,
  runJsonl,
  schema,
  skillsList,
} from './lib/cli.mjs'

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = resolve(value)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}

test('安装后 CLI 的版本、schema 与 doctor 契约（离线，不访问 B 站）', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-installed-cli-')

  const pkg = JSON.parse(readFileSync(join(installed.packageDir, 'package.json'), 'utf8'))
  const version = await installedVersion()
  assert.equal(version.code, 0, version.stderr)
  assert.equal(version.stdout.trim(), pkg.version, '--version 必须等于安装包 manifest 版本，不硬写版本号')

  const contract = await schema(home)
  assertSchemaContract(contract, { version: pkg.version })
  const dmRead = contract.commands.find((command) => command.name === 'dm read')
  assert.equal(dmRead.fields.uid.required, true)
  const dmSend = contract.commands.find((command) => command.name === 'dm send')
  assert.ok(dmSend.fields.confirm, 'dm send 缺少 confirm 字段')
  assert.ok(dmSend.fields.dryRun, 'dm send 缺少 dryRun 字段')

  const report = await doctor(home)
  assert.equal(report.dependenciesInstalled, true, '安装产物必须自带 @yukariyukaro/bilibili-api-ts')
  assert.equal(report.library, '@yukariyukaro/bilibili-api-ts')
  // 只锁主版本：上游 17.x 的次版本/补丁会继续发布（17.4.x → 17.5.0），写死会误报。
  const declaredLibrary = pkg.dependencies?.['@yukariyukaro/bilibili-api-ts'] ?? ''
  const declaredMajor = /^\^?(\d+)\./.exec(declaredLibrary)?.[1]
  assert.ok(declaredMajor, `安装包必须声明 @yukariyukaro/bilibili-api-ts 依赖，当前为 "${declaredLibrary}"`)
  assert.equal(
    String(report.libraryVersion).split('.')[0],
    declaredMajor,
    `libraryVersion 必须与声明的主版本一致（声明 ${declaredLibrary}，实际 ${report.libraryVersion}）`,
  )
  assert.equal(report.credentialPresent, false)
  assert.equal(report.writesEnabled, false)
  assert.equal(samePath(report.stateDir, home), true, 'doctor 的 stateDir 必须是显式隔离目录')

  const skills = await skillsList(home)
  assert.equal(skills[0].name, 'bilibili-cli')
  const config = await configGet(home)
  assert.equal(config.writesEnabled, false)
  assert.equal(config.mentionName, '')
  assert.equal(config.dmRecipientUid, '')

  assert.equal(existsSync(join(home, 'bili_credential.json')), false)
  assert.equal(existsSync(join(home, 'audit.jsonl')), false)
})

test('安装后 CLI 的只读拒绝路径与 JSONL 信封（离线，不访问 B 站）', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  const home = freshDir('home-installed-cli-jsonl-')

  const auth = await authStatus(home)
  assert.equal(auth.logged_in, false, '隔离目录不能有凭证')

  const invalid = await runBilibili(['dm', 'read', '--uid', 'invalid', '--json'], { home, installed })
  assert.equal(invalid.code, 2, '非法 uid 应以参数错误退出')
  assert.equal(invalid.envelope.ok, false)
  assert.equal(invalid.envelope.error.code, 'VALIDATION')

  const noCredential = await runBilibili(['dm', 'read', '--uid', '1', '--json'], { home, installed })
  assert.equal(noCredential.code, 3, '无凭证读取应以认证失败退出')
  assert.equal(noCredential.envelope.ok, false)
  assert.equal(noCredential.envelope.error.code, 'AUTH')

  const jsonl = await runJsonl([{ id: 'schema-jsonl', command: 'schema' }], { home, installed })
  assert.equal(jsonl.code, 0)
  assert.equal(jsonl.rows.length, 1)
  assert.equal(jsonl.rows[0].id, 'schema-jsonl')
  assert.equal(jsonl.rows[0].ok, true)
  assert.equal(jsonl.rows[0].command, 'schema')

  assert.equal(existsSync(join(home, 'bili_credential.json')), false)
  assert.equal(existsSync(join(home, 'audit.jsonl')), false)
})
