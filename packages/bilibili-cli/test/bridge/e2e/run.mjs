#!/usr/bin/env node
/**
 * bridge E2E 统一入口（只读 / 写入口分离）。
 *
 *   node test/bridge/e2e/run.mjs readonly   运行离线契约 + 显式启用的真实只读
 *   node test/bridge/e2e/run.mjs write      当前没有人工逐次确认入口，明确拒绝
 *
 * 只读模式不会设置 BILIBILI_E2E_WRITE，也不会把 BILIBILI_BRIDGE_DRY_RUN
 * 改成 false；真实只读仍要求 BILIBILI_E2E_READONLY=1。
 *
 * 配置门禁：显式开启 BILIBILI_E2E_READONLY=1 后，缺少/非法
 * BILIBILI_E2E_INSTALLED_PREFIX、BILIBILI_E2E_AGENT_HOME 或
 * BILIBILI_E2E_OWNER_UID 时，入口直接以 exit 2 配置错误退出，不启动测试、
 * 不把“全部 skip”伪装成通过。未开启 READONLY 时，缺少 prefix 只让安装类
 * 测试 skip，仍运行本地控制面/协议测试，并明确报告 status=partial。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const e2eDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(e2eDir, '..', '..', '..', '..', '..')
const mode = process.argv[2] || 'readonly'

if (!['readonly', 'write'].includes(mode)) {
  console.error('用法：node test/bridge/e2e/run.mjs readonly|write')
  process.exit(2)
}

const isWindows = process.platform === 'win32'
const pathDelimiter = isWindows ? ';' : ':'

function realOrResolve(value) {
  try { return realpathSync(value) } catch { return resolve(value) }
}

function compared(value) {
  const resolved = resolve(value)
  return isWindows ? resolved.toLowerCase() : resolved
}

function isInside(parent, child) {
  const rel = relative(compared(parent), compared(child))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function resolveWorkdir() {
  const configured = process.env.BILIBILI_E2E_WORKDIR
  if (configured) {
    const dir = resolve(configured)
    if (isInside(repoRoot, dir)) {
      throw new Error('BILIBILI_E2E_WORKDIR 必须离开仓库：' + dir)
    }
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const dir = mkdtempSync(join(tmpdir(), 'bilibili-bridge-e2e-'))
  if (isInside(repoRoot, dir)) throw new Error('临时工作目录不能位于仓库内：' + dir)
  return dir
}

/** 与 lib/env.mjs 的安装前缀契约为同一规则；入口先拦截，避免测试层 skip 掩蔽配置错误。 */
function installedFromPrefix(prefix) {
  if (!prefix) return { ok: false, reason: '缺少 BILIBILI_E2E_INSTALLED_PREFIX' }
  const resolved = resolve(prefix)
  if (!existsSync(resolved)) return { ok: false, reason: '安装前缀不存在：' + resolved }
  if (isInside(repoRoot, resolved)) {
    return { ok: false, reason: 'BILIBILI_E2E_INSTALLED_PREFIX 必须离开仓库：' + resolved }
  }
  const candidates = isWindows
    ? [join(resolved, 'bilibili.cmd'), join(resolved, 'bilibili.exe'), join(resolved, 'node_modules', '.bin', 'bilibili.cmd')]
    : [join(resolved, 'bin', 'bilibili'), join(resolved, 'node_modules', '.bin', 'bilibili')]
  const bin = candidates.find((candidate) => existsSync(candidate))
  if (!bin) return { ok: false, reason: '安装前缀中找不到 CLI 入口；期望 ' + candidates.join(' 或 ') }
  if (isInside(repoRoot, realOrResolve(bin))) {
    return { ok: false, reason: 'CLI 入口实际指向仓库源码：' + realOrResolve(bin) }
  }
  const packageCandidates = [
    join(resolved, 'node_modules', '@yukariyukaro', 'bilibili-cli'),
    join(resolved, 'lib', 'node_modules', '@yukariyukaro', 'bilibili-cli'),
  ]
  const packageDir = packageCandidates.find((candidate) => existsSync(candidate))
  if (packageDir && isInside(repoRoot, realOrResolve(packageDir))) {
    return { ok: false, reason: '安装前缀里的 @yukariyukaro/bilibili-cli 实际指向仓库源码：' + realOrResolve(packageDir) }
  }
  return { ok: true, prefix: resolved, bin, binDir: dirname(bin) }
}

function homeProblem(value, label, { required = false } = {}) {
  if (!value) return required ? '缺少 ' + label + '（只使用显式隔离目录，不读取默认凭证）' : null
  if (!isAbsolute(value)) return label + ' 必须是绝对路径：' + value
  if (isInside(repoRoot, value)) return label + ' 不能位于仓库内：' + value
  if (!existsSync(value)) return label + ' 不存在：' + value
  return null
}

function uidProblem(value, label, { required = false } = {}) {
  if (!value) return required ? '缺少 ' + label + '（真实只读必须显式指定目标 UID）' : null
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return label + ' 必须是安全正整数：' + value
  return null
}

function validateConfiguration({ readOnlyEnabled, writeRequested }) {
  const errors = []
  const prefixValue = process.env.BILIBILI_E2E_INSTALLED_PREFIX || ''
  let installed = null
  if (prefixValue) {
    installed = installedFromPrefix(prefixValue)
    if (!installed.ok) errors.push(installed.reason)
  } else if (readOnlyEnabled) {
    errors.push('缺少 BILIBILI_E2E_INSTALLED_PREFIX（显式只读不能使用全局未知版本或仓库源码）')
  }
  if (writeRequested) {
    errors.push('BILIBILI_E2E_WRITE=1 不能进入只读入口；真实写入口已分离且当前明确拒绝')
  }
  if (readOnlyEnabled) {
    for (const problem of [
      homeProblem(process.env.BILIBILI_E2E_AGENT_HOME, 'BILIBILI_E2E_AGENT_HOME', { required: true }),
      homeProblem(process.env.BILIBILI_E2E_OWNER_HOME, 'BILIBILI_E2E_OWNER_HOME'),
      uidProblem(process.env.BILIBILI_E2E_OWNER_UID, 'BILIBILI_E2E_OWNER_UID', { required: true }),
      uidProblem(process.env.BILIBILI_E2E_AGENT_UID, 'BILIBILI_E2E_AGENT_UID'),
    ]) {
      if (problem) errors.push(problem)
    }
  }
  return { errors, installed }
}

function childEnvironment(workdir, installed) {
  const env = { ...process.env }
  // 写入口和旧混合开关绝不能泄漏进只读测试。
  delete env.BILIBILI_E2E_WRITE
  delete env.BILIBILI_E2E
  env.BILIBILI_E2E_WORKDIR = workdir
  env.BILIBILI_E2E_REPORT_DIR = join(workdir, 'artifacts')
  delete env.NODE_OPTIONS
  delete env.NODE_PATH
  if (installed?.ok) {
    const merged = installed.binDir + pathDelimiter + (env.PATH || env.Path || '')
    env.PATH = merged
    if (isWindows) env.Path = merged
  }
  return env
}

function writeReport(workdir, report) {
  mkdirSync(workdir, { recursive: true })
  const path = join(workdir, 'bridge-e2e-' + mode + '-report.json')
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8')
  return path
}

function parseTap(text) {
  const count = (name) => {
    const match = text.match(new RegExp('^# ' + name + ' (\\d+)', 'm'))
    return match ? Number(match[1]) : 0
  }
  return {
    tests: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    cancelled: count('cancelled'),
    skipped: count('skipped'),
    todo: count('todo'),
  }
}

function testFiles() {
  return readdirSync(e2eDir).filter((name) => name.endsWith('.test.mjs')).sort()
}

function runTests(workdir, installed) {
  const files = testFiles().map((name) => join(e2eDir, name))
  if (files.length === 0) throw new Error('没有找到 test/e2e/*.test.mjs')

  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      process.execPath,
      ['--test', '--test-concurrency=1', '--test-reporter=tap', ...files],
      {
        cwd: workdir,
        env: childEnvironment(workdir, installed),
        windowsHide: true,
        detached: !isWindows,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) rejectRun(error)
      else resolveRun(value)
    }
    const timer = setTimeout(() => {
      if (isWindows) {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.once('close', () => {})
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
      }
      finish(new Error('bridge E2E 总超时（300000ms）'))
    }, 300000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
      process.stderr.write(chunk)
    })
    child.once('error', (error) => finish(error))
    child.once('close', (code, signal) => finish(null, { code, signal, stdout, stderr }))
  })
}

let workdir
try {
  workdir = resolveWorkdir()
} catch (error) {
  console.error('[bridge-e2e] 工作目录配置失败：' + error.message)
  process.exit(2)
}

const readOnlyEnabled = process.env.BILIBILI_E2E_READONLY === '1'
const writeRequested = process.env.BILIBILI_E2E_WRITE === '1'
const legacyE2EIgnored = process.env.BILIBILI_E2E === '1'

if (mode === 'write') {
  const report = {
    schemaVersion: 1,
    type: 'bridge-e2e-summary',
    mode,
    status: 'refused',
    at: new Date().toISOString(),
    workdir,
    writesAttempted: 0,
    realBilibiliWrites: 0,
    reason: '当前 bridge 没有逐次人工确认入口：main.mjs 不注入 confirmSend，adapter 默认拒绝。真实写不能由自动化入口代替用户确认，也不能自动打开 writesEnabled 或把 dry-run 改成 false。',
    requiredManualFlow: [
      '人工确认准确收件人 UID 与最终正文',
      '人工显式开启 CLI writesEnabled 并仅执行一次 --confirm',
      '人工核对接收方实际收件；接口受理不等于对方已读',
      '结束后恢复 writesEnabled=false；未知结果不得自动重试',
    ],
    notes: ['本入口不运行真实写测试，不产生任何 B 站副作用。', '写入口与只读入口分离；返回码 3 表示明确拒绝。'],
  }
  const path = writeReport(workdir, report)
  console.log(JSON.stringify(report, null, 2))
  console.error('[bridge-e2e] write 模式明确拒绝；未执行任何真实写。报告：' + path)
  process.exit(3)
}

const { errors: configErrors, installed } = validateConfiguration({ readOnlyEnabled, writeRequested })
if (configErrors.length) {
  const report = {
    schemaVersion: 1,
    type: 'bridge-e2e-summary',
    mode,
    status: 'config-error',
    at: new Date().toISOString(),
    workdir,
    installPrefix: process.env.BILIBILI_E2E_INSTALLED_PREFIX || null,
    gates: { readOnly: readOnlyEnabled, writeRequestedIgnored: writeRequested, legacyE2EIgnored },
    counts: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 },
    exitCode: 2,
    errors: configErrors,
    testFiles: testFiles(),
    evidenceBoundary: '配置错误发生在测试启动前；没有执行任何真实 B 站读写，也没有把全部 skip 报告成通过。',
    notes: [
      readOnlyEnabled
        ? 'BILIBILI_E2E_READONLY=1 已显式开启，但必需配置缺失或非法；入口拒绝运行。'
        : '只读未显式开启；仅允许离线测试运行，真实只读测试会 skip。',
      '真实只读必需：BILIBILI_E2E_INSTALLED_PREFIX、BILIBILI_E2E_AGENT_HOME、BILIBILI_E2E_OWNER_UID。',
      '可选：BILIBILI_E2E_OWNER_HOME、BILIBILI_E2E_AGENT_UID。',
    ],
  }
  const path = writeReport(workdir, report)
  console.error('[bridge-e2e] 配置错误（exit 2）；未启动测试：')
  for (const error of configErrors) console.error('  - ' + error)
  console.error('[bridge-e2e] report=' + path)
  process.exit(2)
}

let result
try {
  result = await runTests(workdir, installed)
} catch (error) {
  console.error('[bridge-e2e] 测试运行失败：' + error.message)
  process.exit(1)
}

const counts = parseTap(result.stdout)
const status = counts.fail > 0 || counts.cancelled > 0 || result.code !== 0
  ? 'failed'
  : counts.tests === 0
    ? 'unavailable'
    : counts.pass === 0 && counts.todo > 0
      ? 'todo'
      : counts.pass === 0
        ? 'skipped'
        : counts.skipped > 0 || counts.todo > 0
          ? 'partial'
          : 'passed'

const report = {
  schemaVersion: 1,
  type: 'bridge-e2e-summary',
  mode,
  status,
  at: new Date().toISOString(),
  workdir,
  installPrefix: process.env.BILIBILI_E2E_INSTALLED_PREFIX || null,
  gates: {
    readOnly: readOnlyEnabled,
    writeRequestedIgnored: writeRequested,
    legacyE2EIgnored,
  },
  counts,
  exitCode: result.code,
  signal: result.signal ?? null,
  testFiles: testFiles(),
  evidenceBoundary: '离线安装/本地控制面协议 + 显式启用的真实只读 CLI；真实私信往返未自动执行，真实写为 0；接口受理不等于接收方已读。',
  notes: [
    readOnlyEnabled ? '真实只读已显式启用。' : '真实只读未启用：只运行离线契约；设置 BILIBILI_E2E_READONLY=1 后才访问 B 站。',
    'TODO 表示已知实现缺口，不是通过；SKIP 表示条件不满足或需要人工。',
    '没有自动开启 writesEnabled，也没有设置 confirmSend=true。',
  ],
}
const reportPath = writeReport(workdir, report)
console.log('')
console.log('[bridge-e2e] mode=' + mode + ' status=' + status + ' pass=' + counts.pass + ' fail=' + counts.fail + ' skipped=' + counts.skipped + ' todo=' + counts.todo)
console.log('[bridge-e2e] report=' + reportPath)
if (status === 'failed' || status === 'unavailable') process.exit(1)
if (status === 'skipped' || status === 'todo') process.exit(2)
process.exit(0)
