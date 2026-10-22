#!/usr/bin/env node
/**
 * Container entry: verify the curated source snapshot, then run the SAME bridge
 * offline suite used on the host. There is intentionally no second bridge test
 * suite here.
 *
 * test/bridge/offline.mjs build -> backend + protocol + e2e/readonly + lifecycle + regressions
 * The source package install is already covered by the Windows verify run; the
 * container does not repeat a second installation mode.
 *
 * A red result from the shared suite is preserved as a test failure (exit 1),
 * not reported as an infrastructure failure. Docker daemon unavailability is
 * handled before this file runs, by run.mjs, with exit 2 and status=unavailable.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { networkInterfaces, tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'

const CLI_ROOT = resolve(process.env.BILIBILI_E2E_CLI_ROOT || '/workspace/packages/bilibili-cli')
const TEST_BRIDGE_ROOT = join(CLI_ROOT, 'test', 'bridge')
const PREFIX = resolve(process.env.BILIBILI_E2E_INSTALLED_PREFIX || '/opt/bilibili')
const MANIFEST = process.env.BILIBILI_E2E_MANIFEST || '/workspace/context-manifest.json'
const RESULT_TYPE = 'bilibili-cli-bridge-docker-container-run'

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + '/') && !isAbsolute(rel))
}

function verifySnapshot() {
  assert.ok(existsSync(MANIFEST), '缺少 context-manifest.json，不能证明测试使用当前源码快照')
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  assert.equal(manifest.kind, 'bilibili-cli-bridge-docker-context')
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0)
  let checked = 0
  for (const item of manifest.files) {
    if (!item.path.startsWith('skills/bilibili-cli/test/bridge/')) continue
    const target = join(CLI_ROOT, item.path.slice('skills/bilibili-cli/'.length))
    assert.ok(existsSync(target), 'context 文件缺失：' + item.path)
    assert.equal(sha256File(target), item.sha256, 'context 文件哈希不一致：' + item.path)
    checked += 1
  }
  assert.ok(checked > 0, 'manifest 中没有 test/bridge 文件')
  const packageDir = join(PREFIX, 'lib', 'node_modules', '@yukariyukaro', 'bilibili-cli')
  for (const rel of ['dist/cli/bili.mjs', 'dist/lib/bridge/main.mjs', 'dist/lib/bridge/backend.mjs', 'dist/lib/bridge/bridge.mjs', 'dist/lib/bridge/adapter.mjs']) {
    assert.ok(existsSync(join(packageDir, rel)), '安装产物缺少编译文件：' + rel)
  }
  assert.ok(!existsSync(join(packageDir, 'src')), '安装产物不应包含 TypeScript 源码')
  assert.ok(!existsSync(join(packageDir, 'test')), '安装产物不应包含测试')
  return { files: manifest.files.length, testFilesChecked: checked, manifestSha256: sha256File(MANIFEST), packageDir }
}

function verifyIsolation() {
  const external = []
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    for (const address of addresses || []) {
      if (!address.internal) external.push({ name, address: address.address, family: address.family })
    }
  }
  assert.deepEqual(external, [], '容器运行阶段只能有 loopback；实际：' + JSON.stringify(external))
  let defaultRoute = false
  if (existsSync('/proc/net/route')) {
    const lines = readFileSync('/proc/net/route', 'utf8').trim().split(/\r?\n/).slice(1)
    defaultRoute = lines.some((line) => line.trim().split(/\s+/)[1] === '00000000')
  }
  assert.equal(defaultRoute, false, '容器运行阶段不应有默认路由（--network none）')
  return { loopbackOnly: true, defaultRoute: false }
}

function verifyProcpsAndPrefix() {
  assert.ok(existsSync(join(PREFIX, 'bin', 'bilibili')), '安装前缀缺少 POSIX bilibili 入口：' + PREFIX)
  assert.ok(readFileSync(join(PREFIX, 'bin', 'bilibili')).length > 0, 'bilibili 入口为空')
  const ps = spawnSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8', timeout: 10000, windowsHide: true })
  assert.equal(ps.error, undefined, 'ps 启动失败：' + (ps.error?.message || ''))
  assert.equal(ps.status, 0, 'ps 不可用或失败；lifecycle 进程树检查不能静默跳过：' + (ps.stderr || '').slice(0, 800))
  assert.ok(ps.stdout.trim().split(/\r?\n/).length > 1, 'ps 输出异常')
  assert.ok(!isInside(CLI_ROOT, PREFIX), '安装前缀不能位于 CLI 源码树内')
  return { prefix: PREFIX, ps: 'available', dist: 'present' }
}

function runOffline(variant, runRoot) {
  return new Promise((resolveRun) => {
    const workdir = join(runRoot, variant + '-workdir')
    mkdirSync(workdir, { recursive: true })
    const env = {
      ...process.env,
      BILIBILI_E2E_CLI_ROOT: CLI_ROOT,
      BILIBILI_E2E_INSTALLED_PREFIX: PREFIX,
      BILIBILI_E2E_WORKDIR: workdir,
      BILIBILI_BRIDGE_REGRESSIONS_WORKDIR: workdir,
    }
    for (const key of ['BILIBILI_E2E_READONLY', 'BILIBILI_E2E', 'BILIBILI_E2E_WRITE']) delete env[key]
    const child = spawn(process.execPath, [join(TEST_BRIDGE_ROOT, 'offline.mjs'), variant], {
      cwd: runRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, 180000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk; process.stderr.write(chunk) })
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk) })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolveRun({ variant, spawnError: error.message, code: null, signal: null, timedOut, stdout, stderr })
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      resolveRun({ variant, spawnError: null, code, signal, timedOut, stdout, stderr })
    })
  })
}

function parseSummary(text) {
  const lines = text.trim().split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const value = JSON.parse(line)
      if (value && value.scope === 'bridge-offline') return value
    } catch {}
  }
  return null
}

function summarizeVariant(run) {
  const summary = parseSummary(run.stdout)
  const groups = Array.isArray(summary?.groups) ? summary.groups : []
  const failed = groups.filter((group) => group.status === 'failed')
  return {
    variant: run.variant,
    exitCode: run.code,
    signal: run.signal,
    timedOut: run.timedOut,
    spawnError: run.spawnError,
    offline: summary,
    summary: summary ? {
      passedGroups: summary.passedGroups,
      failedGroups: summary.failedGroups,
      groups: groups.map((group) => ({ name: group.name, status: group.status, code: group.code })),
      skipped: summary.skipped,
    } : null,
    passedGroups: groups.filter((group) => group.status === 'passed').length,
    failedGroups: failed.length,
    redLights: failed.map((group) => ({
      name: group.name,
      code: group.code,
      error: (group.error || '').slice(-1200),
    })),
    stderrTail: run.stderr.slice(-2000),
  }
}

async function main() {
  const startedAt = new Date().toISOString()
  const started = Date.now()
  const result = {
    schemaVersion: 1,
    type: RESULT_TYPE,
    status: 'failed',
    classification: 'infrastructure-failure',
    container: true,
    platform: process.platform,
    node: process.version,
    installedPrefix: PREFIX,
    cliRoot: CLI_ROOT,
    testBridgeRoot: TEST_BRIDGE_ROOT,
    at: startedAt,
    evidenceBoundary: '容器内使用真实安装的 bilibili CLI + 与宿主相同的 bridge 测试套件；运行阶段 --network none；不访问 B 站、不执行真实写、不读取凭证；regressions 红灯按测试失败保留。',
  }
  try {
    assert.equal(process.platform, 'linux', 'Docker entry 只能在 Linux 容器运行')
    result.preflight = {
      snapshot: verifySnapshot(),
      isolation: verifyIsolation(),
      tooling: verifyProcpsAndPrefix(),
    }
    const runRoot = mkdtempSync(join(tmpdir(), 'bilibili-cli-bridge-docker-run-'))
    const variants = []
    for (const variant of ['build']) {
      variants.push(summarizeVariant(await runOffline(variant, runRoot)))
    }
    result.variants = Object.fromEntries(variants.map((variant) => [variant.variant, variant]))
    const redLights = variants.flatMap((variant) => variant.redLights.map((entry) => ({ variant: variant.variant, ...entry })))
    const infra = variants.some((variant) => variant.spawnError || variant.timedOut || !variant.summary)
    const failedGroups = variants.reduce((sum, variant) => sum + variant.failedGroups, 0)
    if (infra) {
      result.classification = 'infrastructure-failure'
      result.error = '同一套件没有产出完整 summary（spawn/timeout）'
    } else if (failedGroups > 0) {
      result.classification = 'test-failure'
      result.redExpected = true
      result.error = '同一套件存在 ' + failedGroups + ' 个失败 group；这是测试结果，不是基础设施失败，未被跳过'
    } else {
      result.status = 'passed'
      result.classification = 'passed'
    }
    result.redLights = redLights
    result.durationMs = Date.now() - started
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = result.status === 'passed' ? 0 : 1
  } catch (error) {
    result.classification = 'infrastructure-failure'
    result.error = error?.message || String(error)
    result.durationMs = Date.now() - started
    process.stdout.write(JSON.stringify(result) + '\n')
    process.exitCode = 1
  }
}

await main()
