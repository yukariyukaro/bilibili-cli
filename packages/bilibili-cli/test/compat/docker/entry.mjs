#!/usr/bin/env node
/**
 * Node / npm 兼容矩阵的容器入口。
 *
 * 前置：镜像构建期已用目标 Node/npm 版本完成 npm pack + npm install --global，
 * 运行方以 --network none / --read-only / 非 root 启动。
 *
 * 这里只做两件事：
 *   1. 证明“确实是隔离运行 + 镜像版本与记录一致”（隔离检查 + 版本比对）。
 *   2. 复用 compat/lib/combo.mjs 的 verifyInstalledCli 跑公开命令契约，不另写第二套断言。
 *
 * 红灯按测试失败保留（exit 1）；spawn/超时等基础设施问题单独分类。
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { assertNodeCompatible, exec, expectationsFromManifest, verifyInstalledCli } from '../lib/combo.mjs'

const ROOT = process.env.BILIBILI_COMPAT_ROOT || '/opt/compat'
const PREFIX = process.env.BILIBILI_COMPAT_PREFIX || '/opt/bilibili'
const RESULT_TYPE = 'bilibili-cli-compat-container-run'

function readText(file) {
  try { return readFileSync(file, 'utf8').trim() } catch { return null }
}

function verifyIsolation() {
  assert.equal(process.platform, 'linux', '容器入口只能在 Linux 容器内运行')
  assert.equal(typeof process.getuid, 'function', '无法读取 uid，不能证明非 root')
  assert.notEqual(process.getuid(), 0, '容器必须以非 root 运行')
  const external = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      if (!address.internal) external.push({ name, address: address.address, family: address.family })
    }
  }
  assert.deepEqual(external, [], '运行阶段只能有 loopback；实际：' + JSON.stringify(external))
  let defaultRoute = false
  if (existsSync('/proc/net/route')) {
    const lines = readFileSync('/proc/net/route', 'utf8').trim().split(/\r?\n/).slice(1)
    defaultRoute = lines.some((line) => line.trim().split(/\s+/)[1] === '00000000')
  }
  assert.equal(defaultRoute, false, '运行阶段不应有默认路由（--network none）')
  return { loopbackOnly: true, defaultRoute: false, uid: process.getuid() }
}

async function main() {
  const started = Date.now()
  const result = {
    schemaVersion: 1,
    type: RESULT_TYPE,
    status: 'failed',
    classification: 'infrastructure-failure',
    at: new Date().toISOString(),
    node: process.version,
    npm: readText('/opt/npm-version.txt'),
    platform: process.platform,
    checks: [],
    failures: [],
  }
  try {
    result.preflight = verifyIsolation()
    assert.equal(readText('/opt/node-version.txt'), process.version, '镜像记录的 Node 版本与实际运行不一致')
    result.checks.push({ name: '镜像版本记录与运行版本一致', status: 'passed', detail: { node: process.version, npm: result.npm } })

    const npmProbe = await exec('npm', ['--version'], { cwd: '/tmp', env: { ...process.env, npm_config_update_notifier: 'false' }, timeoutMs: 120000, label: 'npm --version' })
    assert.equal(npmProbe.code, 0, 'npm --version 失败：' + (npmProbe.stderr || npmProbe.stdout))
    assert.equal(String(npmProbe.stdout).trim(), result.npm, '镜像记录的 npm 版本与 PATH 上的 npm 不一致')
    result.checks.push({ name: 'npm --version 与构建期一致', status: 'passed', detail: { npm: result.npm } })

    const expected = expectationsFromManifest(JSON.parse(readFileSync(join(ROOT, 'release-package.json'), 'utf8')))
    result.expected = { version: expected.version, enginesNode: expected.enginesNode, library: expected.library }
    result.version = expected.version
    assertNodeCompatible(expected)
    result.checks.push({ name: 'Node 版本满足 engines.node', status: 'passed', detail: { node: process.version, engines: expected.enginesNode } })

    const installed = await verifyInstalledCli({
      prefix: PREFIX,
      expected,
      home: join('/tmp', 'compat-state'),
      workdir: join('/tmp', 'compat-run'),
    })
    result.install = { packageDir: installed.packageDir, binDir: installed.binDir, shim: installed.shim }
    for (const name of installed.checks) result.checks.push({ name, status: 'passed', detail: null })
    result.status = 'passed'
    result.classification = 'passed'
  } catch (error) {
    const message = error?.message || String(error)
    result.checks.push({ name: '容器内安装产物契约', status: 'failed', error: message })
    result.failures.push({ name: '容器内安装产物契约', error: message })
    result.classification = error?.name === 'AssertionError' ? 'compat-failure' : 'infrastructure-failure'
    result.error = message
  }
  result.durationMs = Date.now() - started
  process.stdout.write(JSON.stringify(result) + '\n')
  process.exitCode = result.status === 'passed' ? 0 : 1
}

await main()
