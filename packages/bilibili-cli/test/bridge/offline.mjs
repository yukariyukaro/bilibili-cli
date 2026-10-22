#!/usr/bin/env node
/**
 * bridge × 安装产物 CLI 的离线 E2E 编排入口。
 *
 *   node test/bridge/offline.mjs build|source
 *
 * 前置：由 verify/build 流程构建、npm pack、临时安装，并设置
 *   BILIBILI_E2E_INSTALLED_PREFIX=<仓库外安装前缀>
 * cwd 必须在仓库外（临时工作目录）。本入口不构建、不安装、不连接 B 站。
 *
 * 分层：
 *   - backend-driver：真实安装 CLI 的 JSONL 传输 + 故障协议（import 已安装 dist/lib/bridge）
 *   - protocol-driver：真实安装的 BridgeClient/adapter 子进程 + 本地 WS fixture（协议测试，非 B 站业务）
 *   - e2e/run.mjs readonly：安装后 CLI 契约、bridge 命令、生命周期；真实只读默认不启用
 *   - lifecycle：PATH bilibili bridge run 生命周期、status/stop、锁、子进程清理
 *   - regressions：两条已确认缺陷的正确期望；修复前保持红灯，不 skip/不放宽
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveInstalledPrefix } from './lib/env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..')
const variant = process.argv[2] || 'build'
assert.ok(['build', 'source'].includes(variant), '用法：node test/bridge/offline.mjs build|source')

const installed = resolveInstalledPrefix(process.env)
assert.ok(installed.ok, '缺少可用安装前缀：' + (installed.reason || ''))
const cwd = process.cwd()
const rel = relative(REPO_ROOT, cwd)
assert.ok(rel !== '' && (rel.startsWith('..') || isAbsolute(rel)), '必须在仓库外工作目录运行，当前：' + cwd)
const workdir = cwd
const home = mkdtempSync(join(workdir, 'bridge 隔离状态 ' + variant + '-'))
assert.equal(existsSync(join(home, 'bili_credential.json')), false)

const childEnv = { ...process.env, BILIBILI_E2E_INSTALLED_PREFIX: installed.prefix, BILIBILI_E2E_WORKDIR: workdir, BILIBILI_BRIDGE_REGRESSIONS_WORKDIR: workdir, BILIBILI_SKILL_HOME: home, NODE_OPTIONS: '', NODE_PATH: '' }
for (const key of ['BILIBILI_E2E', 'BILIBILI_E2E_READONLY', 'BILIBILI_E2E_WRITE']) delete childEnv[key]

const groups = []
function record(name, status, extra = {}) {
  groups.push({ name, status, ...extra })
  process.stdout.write(JSON.stringify({ type: 'group', name, status, ...extra }) + '\n')
}

async function runNode(script, args = [], { timeout = 180000, extraEnv = {} } = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: workdir,
    env: { ...childEnv, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
  })
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true })
      killer.once('error', () => { try { child.kill() } catch {} })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
    }
  }, timeout)
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => { stdout += chunk; process.stdout.write(chunk) })
  child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk) })
  const code = await new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('close', resolveExit)
  })
  clearTimeout(timer)
  return { code, stdout, stderr, timedOut }
}

function lastJsonLine(text, predicate = () => true) {
  for (const line of text.trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line)
      if (predicate(value)) return value
    } catch {}
  }
  return null
}

// 1) 真实安装 CLI 传输与故障协议（import 已安装 dist/lib/bridge/backend.mjs）
for (const mode of ['installed', 'timeout', 'exit', 'malformed', 'audit']) {
  const result = await runNode(join(HERE, 'backend-driver.mjs'), [mode], { timeout: 60000 })
  const pass = result.code === 0 && !result.timedOut
  record('backend:' + mode, pass ? 'passed' : 'failed', pass ? {} : { code: result.code, timedOut: result.timedOut, error: (result.stderr || result.stdout).slice(-4000) })
}

// 2) 安装产物 BridgeClient/adapter 协议回放（非 B 站业务）
{
  const result = await runNode(join(HERE, 'protocol-driver.mjs'), [], { timeout: 120000 })
  const summary = lastJsonLine(result.stdout, (value) => value?.scope === 'bridge-protocol')
  const pass = result.code === 0 && !result.timedOut && summary && summary.failed === 0
  record('protocol:installed-modules', pass ? 'passed' : 'failed', pass ? { details: summary } : { code: result.code, timedOut: result.timedOut, details: summary, error: (result.stderr || result.stdout).slice(-4000) })
}

// 3) 安装后 CLI / bridge 命令 / 本地控制面契约
{
  const result = await runNode(join(HERE, 'e2e', 'run.mjs'), ['readonly'], { timeout: 150000 })
  const pass = result.code === 0 && !result.timedOut
  record('e2e:installed-cli', pass ? 'passed' : 'failed', pass ? {} : { code: result.code, timedOut: result.timedOut, error: (result.stderr || result.stdout).slice(-6000) })
}

// 4) PATH bilibili bridge run 生命周期；source 变体只跑控制/状态 smoke
{
  const args = variant === 'source' ? ['--filter=status/stop'] : []
  const result = await runNode(join(HERE, 'lifecycle.mjs'), args, { timeout: variant === 'source' ? 120000 : 150000 })
  const summary = lastJsonLine(result.stdout, (value) => value && typeof value.ok === 'boolean' && Array.isArray(value.cases))
  const pass = result.code === 0 && !result.timedOut && summary?.ok === true
  record('lifecycle:bridge-run', pass ? 'passed' : 'failed', pass ? { details: summary } : { code: result.code, timedOut: result.timedOut, details: summary, error: (result.stderr || result.stdout).slice(-6000) })
}

// 5) 已确认缺陷回归（仅 build 变体；两条红灯保持正确期望）
if (variant === 'build') {
  const result = await runNode(join(HERE, 'regressions', 'run.mjs'), [], { timeout: 120000 })
  const summary = lastJsonLine(result.stdout, (value) => value?.scope === 'bridge-regressions')
  const pass = result.code === 0 && !result.timedOut && summary && summary.counts?.failed === 0
  record('regressions:red-light-contract', pass ? 'passed' : 'failed', pass ? { details: summary } : { code: result.code, timedOut: result.timedOut, details: summary, error: (result.stderr || result.stdout).slice(-6000) })
} else {
  record('regressions:red-light-contract', 'skipped', { reason: 'source 变体只复验编译后安装闭包与 bridge 控制面；完整红灯回归由 build 变体执行' })
}

const summary = {
  type: 'summary',
  scope: 'bridge-offline',
  package: variant,
  installedPrefix: installed.prefix,
  workdir,
  passedGroups: groups.filter((group) => group.status === 'passed').length,
  failedGroups: groups.filter((group) => group.status === 'failed').length,
  skippedGroups: groups.filter((group) => group.status === 'skipped').length,
  groups,
  skipped: [
    '真实 B 站只读（独立入口 BILIBILI_E2E_READONLY=1）',
    '真实双账号往返（待人工逐次确认，自动化不执行）',
    ...(variant === 'source' ? ['source 变体的完整 lifecycle/regressions（由 build 变体覆盖）'] : []),
  ],
  evidence: '真实安装 CLI + 安装产物 dist/lib/bridge 协议/故障 + PATH bridge run；不是 B 站收发成功证据',
}
writeFileSync(join(workdir, 'bridge-e2e-' + variant + '.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8')
process.stdout.write(JSON.stringify(summary) + '\n')
process.exitCode = summary.failedGroups ? 1 : 0