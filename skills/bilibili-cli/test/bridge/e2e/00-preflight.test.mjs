import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import {
  AGENT_HOME,
  AGENT_UID,
  LEGACY_E2E,
  OWNER_HOME,
  OWNER_UID,
  READONLY,
  WRITE_REQUESTED,
  environmentSummary,
  installedOrSkip,
  readonlyConfigIssues,
  readonlyOrSkip,
} from './lib/env.mjs'
import { authStatus, dmStatus, installedVersion } from './lib/cli.mjs'

test('环境门禁：真实只读显式启用，写开关不混入只读套件', (t) => {
  assert.equal(WRITE_REQUESTED, false, 'BILIBILI_E2E_WRITE=1 不能进入只读套件；真实写入口已分离，不能复用只读授权')
  if (LEGACY_E2E) t.diagnostic('BILIBILI_E2E=1 是旧开关，本套件只认 BILIBILI_E2E_READONLY=1；旧开关不会开启任何动作')
  if (!READONLY) {
    t.skip('真实只读未启用：设置 BILIBILI_E2E_READONLY=1、BILIBILI_E2E_INSTALLED_PREFIX、BILIBILI_E2E_AGENT_HOME、BILIBILI_E2E_OWNER_UID 后再运行')
    return
  }
  const issues = readonlyConfigIssues()
  assert.deepEqual(issues, [], '真实只读配置不完整：' + issues.join('；'))
  t.diagnostic('环境摘要：' + JSON.stringify(environmentSummary()))
})

test('安装前缀入口离开仓库且是真实安装产物（离线）', async (t) => {
  const installed = installedOrSkip(t)
  if (!installed) return
  assert.ok(existsSync(installed.bin), 'CLI 入口不存在：' + installed.bin)
  const result = await installedVersion()
  assert.equal(result.code, 0, 'bilibili --version 失败：' + result.stderr)
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+$/m, '--version 必须是语义版本；不硬写当前版本号')
  t.diagnostic('CLI 入口：' + installed.bin)
  t.diagnostic('安装前缀：' + installed.prefix)
})

test('真实只读账号 A 登录态（显式启用后才访问 B 站）', async (t) => {
  const config = readonlyOrSkip(t)
  if (!config) return
  const auth = await authStatus(AGENT_HOME)
  assert.equal(auth.logged_in, true, '账号 A 未登录或凭证不可用（不读取/不打印凭证正文）')
  assert.equal(typeof auth.username, 'string')
  if (AGENT_UID) assert.equal(String(auth.uid), String(AGENT_UID), '账号 A UID 与 BILIBILI_E2E_AGENT_UID 不一致')
  t.diagnostic('账号 A 登录态通过' + (AGENT_UID ? '，UID 与显式配置一致' : ''))
})

test('真实只读账号 B 与互关关系（可选；仅记录，不作为写授权）', async (t) => {
  if (!OWNER_HOME || !OWNER_UID) {
    t.skip('未提供 BILIBILI_E2E_OWNER_HOME / BILIBILI_E2E_OWNER_UID；跳过账号 B 只读预检')
    return
  }
  const config = readonlyOrSkip(t)
  if (!config) return
  const auth = await authStatus(OWNER_HOME)
  assert.equal(auth.logged_in, true, '账号 B 未登录或凭证不可用（不读取/不打印凭证正文）')
  assert.equal(String(auth.uid), String(OWNER_UID), '账号 B UID 与 BILIBILI_E2E_OWNER_UID 不一致')
  const status = await dmStatus(OWNER_UID, AGENT_HOME)
  assert.equal(typeof status.mutual, 'boolean', 'dm status 未返回布尔 mutual')
  t.diagnostic('A 对 B 的互关状态：mutual=' + status.mutual + '（只读记录；不是写授权）')
})
