#!/usr/bin/env node
/**
 * Node / npm 版本兼容矩阵（可选套件，不参与默认 npm test）。
 *
 *   node test/compat/run.mjs --check            只做静态校验；不联网、不建镜像
 *   node test/compat/run.mjs [--native]         宿主 Node × 多个 npm 版本（需要网络）
 *   node test/compat/run.mjs --docker           Node 22/24 镜像 × 指定 npm 版本（需要 Docker）
 *
 * 每个组合都走真实交付路径：npm pack 发布目录 -> npm install -g 隔离前缀 -> PATH 调 CLI
 * -> doctor/schema/skills -> npm exec 直接运行 tarball。断言在 lib/combo.mjs 一处，
 * 容器入口复用同一份，不另写第二套标准。
 *
 * 退出码：0 通过；1 失败（含组合红灯）；2 Docker 不可用；64 参数错误。
 *
 * 证据边界：证明 tarball 在给定 Node/npm 版本上可安装并运行公开命令；不证明真实 B 站
 * 收发、写入、bridge 真实会话，也不替代 test/release 的发布物下载校验。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { npmEnv, run, tail } from '../release/lib/fetch.mjs'
import {
  DEFAULT_REGISTRY,
  assertNodeCompatible,
  lastJsonValue,
  readExpectations,
  requestedNpmMajor,
  runNativeCombo,
  satisfiesMinNode,
  slug,
} from './lib/combo.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLI_ROOT = resolve(HERE, '..', '..')
const REPO_ROOT = resolve(CLI_ROOT, '..', '..')
const DOCKER_DIR = join(HERE, 'docker')
const RESULT_TYPE = 'bilibili-cli-node-npm-compat'
const EXIT = { PASS: 0, FAIL: 1, UNAVAILABLE: 2, USAGE: 64 }
/** Node >= 22 对应 npm >= 10；9 仍在默认矩阵里，因为这是用户显式降级会遇到的边界。 */
const DEFAULT_NATIVE_NPM = ['current', '9', '10', '11']
const DEFAULT_DOCKER_NODE = ['22', '24']
const DEFAULT_DOCKER_NPM = ['current']

const USAGE = [
  '用法：',
  '  node packages/bilibili-cli/test/compat/run.mjs [--check|--native|--docker] [选项]',
  '',
  '模式：',
  '  --check     只做静态校验；不联网、不构建、不运行容器',
  '  --native    宿主机 Node × 多个 npm 版本（默认模式，需要网络）',
  '  --docker    Node 22/24 镜像（每镜像自带 npm，可用 --npm 追加版本，需要 Docker）',
  '',
  '选项：',
  '  --npm <spec>         npm 版本，逗号分隔或重复；current 表示当前 npm（默认 native: current,9,10,11；docker: current）',
  '  --node <major>       Docker 基础镜像 Node 主版本，逗号分隔（默认 22,24；仅 --docker）',
  '  --node-bin <path>    用指定 Node 可执行文件跑 native 组合（例如解压的 node-v22 二进制）；断言 CLI 确实运行在该 Node 上',
  '  --release-dir <dir>  复用已构建的发布目录，跳过 build（需要含 package.json 与 dist/cli/bili.mjs）',
  '  --workdir <dir>      工作目录，必须在仓库外（默认系统临时目录）',
  '  --keep               保留工作目录、镜像与容器取证',
  '  --verbose            把子进程输出流到 stderr',
  '  --help               显示帮助',
  '',
  '证据：stdout 一份 JSON 报告；BILIBILI_COMPAT_REPORT 可另存文件。',
  '退出码：0 通过    1 失败    2 Docker 不可用    64 用法错误',
].join('\n')

function splitList(value) {
  return String(value).split(',').map((item) => item.trim()).filter(Boolean)
}

function unique(values) {
  return [...new Set(values)]
}

export function parseArgs(argv) {
  const options = { mode: 'native', npm: [], node: [], releaseDir: '', workdir: '', nodeBin: '', keep: false, verbose: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = () => {
      const value = argv[++index]
      if (!value) throw new Error(arg + ' 需要参数')
      return value
    }
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--check') options.mode = 'check'
    else if (arg === '--native') options.mode = 'native'
    else if (arg === '--docker') options.mode = 'docker'
    else if (arg === '--npm') options.npm.push(...splitList(next()))
    else if (arg === '--node') options.node.push(...splitList(next()))
    else if (arg === '--release-dir') options.releaseDir = next()
    else if (arg === '--node-bin') options.nodeBin = next()
    else if (arg === '--workdir') options.workdir = next()
    else if (arg === '--keep') options.keep = true
    else if (arg === '--verbose') options.verbose = true
    else throw new Error('未知参数：' + arg)
  }
  for (const spec of options.npm) {
    if (!/^(?:current|\d+(?:\.\d+){0,2})$/.test(spec)) throw new Error('--npm 只接受 current 或 X / X.Y / X.Y.Z：' + spec)
  }
  for (const major of options.node) {
    if (!/^\d+$/.test(major)) throw new Error('--node 只接受 Node 主版本号：' + major)
  }
  if (options.mode !== 'docker' && options.node.length) throw new Error('--node 只在 --docker 下生效；native 模式用 --node-bin 指定 Node 可执行文件')
  if (options.nodeBin && options.mode === 'docker') throw new Error('--node-bin 只用于 --native；Docker 模式用 --node <主版本>')
  options.npm = options.npm.length ? unique(options.npm) : (options.mode === 'docker' ? [...DEFAULT_DOCKER_NPM] : [...DEFAULT_NATIVE_NPM])
  options.node = options.node.length ? unique(options.node) : [...DEFAULT_DOCKER_NODE]
  return options
}

function log(line) {
  process.stderr.write('[compat] ' + line + '\n')
}

function assertOutsideRepo(target, label) {
  const resolved = resolve(target)
  const rel = relative(REPO_ROOT, resolved)
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) {
    throw new Error(label + ' 必须离开仓库：' + resolved)
  }
}

function resolveWorkdir(options) {
  const dir = options.workdir ? resolve(options.workdir) : mkdtempSync(join(tmpdir(), 'bilibili-cli-compat-'))
  assertOutsideRepo(dir, '--workdir')
  mkdirSync(dir, { recursive: true })
  return dir
}

function baseReport(mode, options, workdir, startedAt) {
  return {
    schemaVersion: 1,
    type: RESULT_TYPE,
    mode,
    at: startedAt,
    host: { node: process.version, npm: null, platform: process.platform, arch: process.arch },
    node: null,
    matrix: { npm: options.npm, node: mode === 'docker' ? options.node : [process.version] },
    workdir,
    combos: [],
    evidenceBoundary: '证明构建产物在给定 Node/npm 版本上可 pack、可安装、可运行公开命令；不证明真实 B 站收发、真实写入或 bridge 真实会话，也不替代 test/release 的发布物下载校验。',
  }
}

function summarize(report) {
  const combos = report.combos || []
  report.summary = {
    total: combos.length,
    passed: combos.filter((combo) => combo.status === 'passed').length,
    failed: combos.filter((combo) => combo.status === 'failed').length,
    skipped: combos.filter((combo) => combo.status === 'skipped').length,
  }
  const failed = report.summary.failed
  report.status = combos.length > 0 && failed === 0 && report.summary.skipped === 0 ? 'passed' : 'failed'
  if (combos.length === 0) report.status = 'failed'
  return report
}

function emit(report) {
  const text = JSON.stringify(report, null, 2) + '\n'
  process.stdout.write(text)
  const target = process.env.BILIBILI_COMPAT_REPORT
  if (target) {
    const file = resolve(target)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
    process.stderr.write('[compat] report=' + file + '\n')
  }
}

async function prepareReleaseDir(options, workdir) {
  if (options.releaseDir) {
    const dir = resolve(options.releaseDir)
    assert.ok(existsSync(dir), '--release-dir 不存在：' + dir)
    return { dir, built: false }
  }
  const dir = join(workdir, 'release')
  log('构建发布目录：' + dir)
  const result = await run(process.execPath, [join(CLI_ROOT, 'scripts', 'build.mjs'), dir], { cwd: CLI_ROOT, timeoutMs: 600000 })
  if (result.code !== 0) {
    throw new Error('构建发布目录失败（先运行 npm ci 安装 TypeScript）：' + tail(result.stderr || result.stdout, 2000))
  }
  return { dir, built: true }
}

function npmCliCandidates(nodePath) {
  const dir = dirname(nodePath)
  return [
    join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dir, '..', 'lib', 'node_modules', 'npm', 'lib', 'cli.js'),
  ]
}

/** npm 必须跟着目标 Node 走：用宿主 npm 跑目标 Node 的包装，等于没测那个发行版。 */
function resolveNpmForNode(node) {
  const same = resolve(node.path) === resolve(process.execPath)
  const candidates = [
    ...(same && process.env.npm_execpath ? [process.env.npm_execpath] : []),
    ...npmCliCandidates(node.path),
  ].filter((value) => typeof value === 'string' && value.length > 0)
  const cli = candidates.find((candidate) => candidate.endsWith('.js') && existsSync(candidate))
  return cli ? { command: node.path, prefix: [cli] } : null
}

async function npmVersionOf(npm) {
  if (!npm) return null
  const result = await run(npm.command, [...npm.prefix, '--version'], { timeoutMs: 120000 })
  return result.code === 0 ? String(result.stdout).trim() : null
}

/** 目标 Node：默认是跑本套件的 Node；--node-bin 可指向另一个发行版（例如解压出来的 node-v22）。 */
async function resolveNode(options) {
  if (!options.nodeBin) return { path: process.execPath, version: process.version, source: 'harness' }
  const path = resolve(options.nodeBin)
  assert.ok(existsSync(path), '--node-bin 不存在：' + path)
  const result = await run(path, ['--version'], { timeoutMs: 60000 })
  assert.equal(result.code, 0, '--node-bin --version 失败：' + tail(result.stderr || result.stdout, 800))
  const version = String(result.stdout).trim()
  assert.match(version, /^v\d+\.\d+\.\d+/, '--node-bin 版本输出异常：' + version)
  return { path, version, source: 'node-bin' }
}

async function resolveNpmForSpec(spec, { root, node }) {
  if (spec === 'current') {
    const npm = resolveNpmForNode(node)
    if (!npm) throw new Error('在 ' + node.path + ' 同级找不到 npm；该 Node 发行版不完整，或改用 --npm <版本>')
    return npm
  }
  const prefix = join(root, 'npm-installed', slug(spec))
  const candidates = [
    join(prefix, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(prefix, 'node_modules', 'npm', 'lib', 'cli.js'),
    join(prefix, 'lib', 'node_modules', 'npm', 'lib', 'cli.js'),
  ]
  let cli = candidates.find((candidate) => existsSync(candidate))
  if (!cli) {
    const bootstrap = resolveNpmForNode(node)
    if (!bootstrap) throw new Error('找不到可用于安装 npm@' + spec + ' 的 npm（Node ' + node.version + '）')
    const env = npmEnv({ cache: join(root, 'npm-install-cache'), registry: DEFAULT_REGISTRY })
    log('安装 npm@' + spec + ' 到隔离前缀（需要网络）')
    const result = await run(bootstrap.command, [...bootstrap.prefix, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', 'npm@' + spec], { cwd: root, env, timeoutMs: 900000 })
    if (result.code !== 0) throw new Error('无法安装 npm@' + spec + '（需要网络）：' + tail(result.stderr || result.stdout, 1500))
    cli = candidates.find((candidate) => existsSync(candidate))
    if (!cli) throw new Error('npm@' + spec + ' 安装后找不到 npm cli：' + prefix)
  }
  return { command: node.path, prefix: [cli] }
}

async function runNativeMode(options, workdir, startedAt, started) {
  const report = baseReport('native', options, workdir, startedAt)
  try {
    const node = await resolveNode(options)
    report.node = { version: node.version, bin: node.path, source: node.source }
    report.matrix.node = [node.version]
    report.host.npm = await npmVersionOf(resolveNpmForNode({ path: process.execPath, version: process.version }))
    const prepared = await prepareReleaseDir(options, workdir)
    const expected = readExpectations(prepared.dir)
    report.release = { dir: prepared.dir, built: prepared.built }
    report.expected = {
      version: expected.version,
      binEntry: expected.binEntry,
      enginesNode: expected.enginesNode,
      library: expected.library,
      dependencies: expected.dependencies,
    }
    assertNodeCompatible(expected, node.version)

    for (const spec of options.npm) {
      log('native 组合 npm ' + spec + ' …')
      let npm
      try {
        npm = await resolveNpmForSpec(spec, { root: workdir, node })
      } catch (error) {
        report.combos.push({ requested: { npm: spec }, node: node.version, status: 'failed', classification: 'infrastructure-failure', error: error?.message || String(error), checks: [], failures: [] })
        continue
      }
      const combo = await runNativeCombo({ npmSpec: spec, npm, releaseDir: prepared.dir, expected, root: workdir, node })
      log('native 组合 npm ' + spec + ' → ' + combo.status)
      report.combos.push(combo)
    }
    summarize(report)
    report.durationMs = Date.now() - started
    if (report.status === 'passed' && !options.keep) rmSync(workdir, { recursive: true, force: true })
    emit(report)
    process.exit(report.status === 'passed' ? EXIT.PASS : EXIT.FAIL)
  } catch (error) {
    report.status = 'failed'
    report.classification = 'infrastructure-failure'
    report.error = error?.message || String(error)
    report.durationMs = Date.now() - started
    summarize(report)
    emit(report)
    process.exit(EXIT.FAIL)
  }
}

async function probeDocker() {
  const client = await run('docker', ['--version'], { timeoutMs: 15000 })
  const clientVersion = /Docker version\s+([^,\s]+)/.exec(client.stdout || '')?.[1] || null
  if (!clientVersion) return { available: false, reason: 'client-missing', clientVersion: null, serverVersion: null, detail: tail(client.spawnError || client.stderr, 500) }
  const probe = await run('docker', ['version', '--format', '{{json .}}'], { timeoutMs: 20000 })
  let parsed = null
  try { parsed = JSON.parse(probe.stdout) } catch {}
  const serverVersion = parsed?.Server?.Version ?? null
  if (probe.spawnError || probe.code !== 0 || !serverVersion) {
    return { available: false, reason: 'daemon-unreachable', clientVersion, serverVersion: null, detail: tail(probe.stderr || probe.stdout, 600) }
  }
  return { available: true, reason: null, clientVersion, serverVersion, detail: '' }
}

async function runStreaming(command, args, { cwd, timeoutMs, verbose = false }) {
  const result = await run(command, args, { cwd, timeoutMs })
  if (verbose) process.stderr.write(result.stdout + result.stderr)
  return result
}

function dockerBuildArgs(contextDir, nodeMajor, npmSpec, tag) {
  return [
    'build',
    '--build-arg', 'NODE_VERSION=' + nodeMajor,
    '--build-arg', 'NPM_VERSION=' + (npmSpec === 'current' ? '' : npmSpec),
    '-f', join(contextDir, 'Dockerfile'),
    '-t', tag,
    contextDir,
  ]
}

function dockerRunArgs(tag, containerName) {
  assert.match(containerName, /^bilibili-cli-compat-[a-z0-9-]+$/, '容器名必须是本次运行生成的唯一安全名称')
  return [
    'run', '--rm', '--init', '--name', containerName,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,size=1g',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '1g',
    tag,
  ]
}

async function runDockerCombo({ nodeMajor, npmSpec, releaseDir, expected, workdir, verbose }) {
  const part = 'node' + nodeMajor + '-npm-' + slug(npmSpec)
  const tag = 'bilibili-cli-compat:' + part + '-' + process.pid + '-' + Date.now().toString(36)
  const containerName = 'bilibili-cli-compat-' + part + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  const contextDir = join(workdir, 'docker', part)
  mkdirSync(contextDir, { recursive: true })
  cpSync(releaseDir, join(contextDir, 'release-source'), { recursive: true })
  cpSync(join(CLI_ROOT, 'test', 'release', 'lib'), join(contextDir, 'release', 'lib'), { recursive: true })
  cpSync(join(HERE, 'lib'), join(contextDir, 'compat', 'lib'), { recursive: true })
  mkdirSync(join(contextDir, 'compat', 'docker'), { recursive: true })
  cpSync(join(DOCKER_DIR, 'entry.mjs'), join(contextDir, 'compat', 'docker', 'entry.mjs'))
  cpSync(join(DOCKER_DIR, 'Dockerfile'), join(contextDir, 'Dockerfile'))
  writeFileSync(join(contextDir, 'release-package.json'), JSON.stringify(JSON.parse(readFileSync(join(releaseDir, 'package.json'), 'utf8')), null, 2) + '\n', 'utf8')

  const combo = {
    requested: { node: nodeMajor, npm: npmSpec },
    status: 'failed',
    checks: [],
    failures: [],
  }
  try {
    log('docker 组合 node ' + nodeMajor + ' / npm ' + npmSpec + '：构建镜像')
    const build = await runStreaming('docker', dockerBuildArgs(contextDir, nodeMajor, npmSpec, tag), { cwd: contextDir, timeoutMs: 1800000, verbose })
    if (build.code !== 0 || build.timedOut) {
      combo.classification = 'infrastructure-failure'
      combo.stage = 'build'
      combo.error = { timedOut: build.timedOut, exitCode: build.code, stderrTail: tail(build.stderr, 3000), stdoutTail: tail(build.stdout, 1500) }
      return combo
    }
    combo.checks.push({ name: '镜像内 pack + install -g', status: 'passed', detail: null })
    log('docker 组合 node ' + nodeMajor + ' / npm ' + npmSpec + '：运行契约检查')
    const executed = await runStreaming('docker', dockerRunArgs(tag, containerName), { cwd: contextDir, timeoutMs: 900000, verbose })
    const entry = lastJsonValue(executed.stdout)
    if (!entry || entry.type !== 'bilibili-cli-compat-container-run') {
      combo.classification = 'infrastructure-failure'
      combo.stage = 'run'
      combo.error = { timedOut: executed.timedOut, exitCode: executed.code, stdoutTail: tail(executed.stdout, 2500), stderrTail: tail(executed.stderr, 2500) }
      return combo
    }
    combo.node = entry.node
    combo.npm = entry.npm
    combo.version = entry.version
    combo.checks.push(...(entry.checks || []))
    combo.failures.push(...(entry.failures || []))
    combo.status = entry.status === 'passed' && executed.code === 0 ? 'passed' : 'failed'
    combo.classification = entry.classification
    if (entry.error) combo.error = entry.error
  } catch (error) {
    combo.classification = 'infrastructure-failure'
    combo.error = error?.message || String(error)
  } finally {
    await runStreaming('docker', ['rm', '-f', containerName], { cwd: contextDir, timeoutMs: 60000 })
    await runStreaming('docker', ['image', 'rm', '-f', tag], { cwd: contextDir, timeoutMs: 120000 })
  }
  combo.label = 'node ' + (combo.node || nodeMajor) + ' / npm ' + (combo.npm || npmSpec)
  return combo
}

async function runDockerMode(options, workdir, startedAt, started) {
  const docker = await probeDocker()
  if (!docker.available) {
    emit({
      schemaVersion: 1,
      type: RESULT_TYPE,
      mode: 'docker',
      status: 'unavailable',
      reason: docker.reason,
      docker,
      message: 'Docker daemon 不可达；没有构建镜像或运行容器。这不是通过。',
      next: '先运行 node packages/bilibili-cli/test/compat/run.mjs --check；或用 --native 在宿主机验证 npm 版本。',
    })
    process.exit(EXIT.UNAVAILABLE)
  }
  const report = baseReport('docker', options, workdir, startedAt)
  report.docker = docker
  try {
    report.checks = runStaticChecks()
    const prepared = await prepareReleaseDir(options, workdir)
    const expected = readExpectations(prepared.dir)
    report.release = { dir: prepared.dir, built: prepared.built }
    report.expected = {
      version: expected.version,
      binEntry: expected.binEntry,
      enginesNode: expected.enginesNode,
      library: expected.library,
      dependencies: expected.dependencies,
    }
    for (const nodeMajor of options.node) {
      if (!satisfiesMinNode(nodeMajor, expected.minNodeMajor)) {
        log('跳过 node ' + nodeMajor + '：低于 engines.node ' + expected.enginesNode)
        report.combos.push({ requested: { node: nodeMajor }, status: 'skipped', reason: 'Node ' + nodeMajor + ' 低于发布包 engines.node ' + expected.enginesNode, checks: [], failures: [] })
        continue
      }
      for (const npmSpec of options.npm) {
        const combo = await runDockerCombo({ nodeMajor, npmSpec, releaseDir: prepared.dir, expected, workdir, verbose: options.verbose })
        log('docker 组合 node ' + nodeMajor + ' / npm ' + npmSpec + ' → ' + combo.status)
        report.combos.push(combo)
      }
    }
    summarize(report)
    report.durationMs = Date.now() - started
    if (report.status === 'passed' && !options.keep) rmSync(workdir, { recursive: true, force: true })
    emit(report)
    process.exit(report.status === 'passed' ? EXIT.PASS : EXIT.FAIL)
  } catch (error) {
    report.status = 'failed'
    report.classification = 'infrastructure-failure'
    report.error = error?.message || String(error)
    report.durationMs = Date.now() - started
    summarize(report)
    emit(report)
    process.exit(EXIT.FAIL)
  }
}

function collectCompatFiles() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (extname(entry.name).toLowerCase() === '.mjs') files.push(full)
    }
  }
  walk(HERE)
  return files.sort()
}

function nodeCheckAll() {
  const files = collectCompatFiles()
  for (const file of files) {
    // 只要退出码：stderr 直接继承，避免在受限环境额外申请管道。
    const result = spawnSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
    assert.equal(result.status, 0, 'node --check 失败：' + relative(REPO_ROOT, file))
  }
  return files.length
}

export function runStaticChecks() {
  const checks = []
  const record = (name, fn) => {
    const detail = fn()
    checks.push({ name, status: 'passed', detail: detail === true ? {} : detail })
  }
  record('兼容矩阵文件齐全', () => {
    for (const rel of ['run.mjs', 'lib/combo.mjs', 'docker/Dockerfile', 'docker/entry.mjs', 'README.md']) {
      assert.ok(existsSync(join(HERE, rel)), '缺少 test/compat/' + rel)
    }
    return { files: 5 }
  })
  record('默认 npm test 不包含兼容矩阵（可选入口）', () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8'))
    const repo = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    assert.equal(pkg.scripts.test, 'node scripts/verify.mjs', '产品 npm test 必须保持默认套件')
    assert.equal(repo.scripts.test, 'node packages/bilibili-cli/scripts/verify.mjs', '根 npm test 必须保持默认套件')
    for (const [label, value] of [['产品', pkg.scripts.test], ['根', repo.scripts.test]]) {
      assert.doesNotMatch(value, /compat/, label + ' test 脚本不应包含 compat')
    }
    assert.doesNotMatch(readFileSync(join(CLI_ROOT, 'scripts', 'verify.mjs'), 'utf8'), /test\/compat/, 'verify.mjs 不应调用兼容矩阵')
    return { productTest: pkg.scripts.test, repoTest: repo.scripts.test }
  })
  record('兼容矩阵脚本已注册', () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8'))
    const repo = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    const expected = { 'test:compat': 'test/compat/run.mjs', 'test:compat:check': 'test/compat/run.mjs --check', 'test:compat:docker': 'test/compat/run.mjs --docker' }
    for (const [name, fragment] of Object.entries(expected)) {
      assert.ok(pkg.scripts?.[name], '产品 package.json 缺少 ' + name)
      assert.ok(String(pkg.scripts[name]).includes(fragment), '产品 ' + name + ' 应指向 ' + fragment)
      assert.ok(repo.scripts?.[name], '根 package.json 缺少 ' + name)
      assert.ok(String(repo.scripts[name]).includes(fragment), '根 ' + name + ' 应指向 ' + fragment)
    }
    return { scripts: Object.keys(expected) }
  })
  record('Dockerfile 只从本地构建上下文取产物', () => {
    const text = readFileSync(join(DOCKER_DIR, 'Dockerfile'), 'utf8')
    assert.match(text, /^ARG NODE_VERSION=22$/m, 'Dockerfile 必须有 NODE_VERSION 默认值')
    assert.ok(text.includes('COPY release-source'), 'Dockerfile 必须使用构建出的发布目录')
    assert.ok(text.includes('--ignore-scripts'), '安装期不得执行脚本')
    assert.match(text, /^USER node$/m, 'runtime 必须以非 root 运行')
    assert.ok(text.includes('compat/docker/entry.mjs'), 'runtime CMD 必须进入容器入口')
    assert.doesNotMatch(text, /^\s*COPY\s+\.\s/m, '禁止把整个 build context 复制进镜像')
    assert.doesNotMatch(text, /\b(?:curl|wget)\b/i, '下载必须走 npm，不引入 curl/wget')
    assert.doesNotMatch(text, /registry\.npmmirror/, '默认下载源不能指向镜像')
    return true
  })
  record('容器入口复用同一套断言并校验隔离', () => {
    const text = readFileSync(join(DOCKER_DIR, 'entry.mjs'), 'utf8')
    for (const needle of ['verifyInstalledCli', 'expectationsFromManifest', 'networkInterfaces', '/proc/net/route', 'getuid', 'bilibili-cli-compat-container-run']) {
      assert.ok(text.includes(needle), '容器入口缺少 ' + needle)
    }
    return true
  })
  record('默认矩阵与 engines.node 一致', () => {
    const pkg = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8'))
    const minNodeMajor = /^>=\s*(\d+)/.exec(String(pkg.engines?.node ?? ''))?.[1]
    assert.ok(minNodeMajor, '产品 engines.node 只支持 >=X 形式')
    for (const major of DEFAULT_DOCKER_NODE) {
      assert.ok(Number(major) >= Number(minNodeMajor), '默认 Node ' + major + ' 低于 engines.node ' + pkg.engines.node)
    }
    for (const spec of DEFAULT_NATIVE_NPM) {
      if (spec === 'current') continue
      assert.ok(requestedNpmMajor(spec), '默认 npm 规格不是版本号：' + spec)
    }
    return { engines: pkg.engines.node, nativeNpm: DEFAULT_NATIVE_NPM, dockerNode: DEFAULT_DOCKER_NODE, dockerNpm: DEFAULT_DOCKER_NPM }
  })
  record('矩阵脚本均通过 node --check', () => ({ files: nodeCheckAll() }))
  record('README 写明可选入口与证据边界', () => {
    const text = readFileSync(join(HERE, 'README.md'), 'utf8')
    for (const needle of ['npm run test:compat', '--check', '--docker', '--node-bin', '不参与默认']) {
      assert.ok(text.includes(needle), 'README 缺少 ' + needle)
    }
    return true
  })
  return checks
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    emit({ schemaVersion: 1, type: RESULT_TYPE, status: 'usage-error', error: error.message, usage: USAGE })
    process.exit(EXIT.USAGE)
  }
  if (options.help) {
    process.stdout.write(USAGE + '\n')
    return
  }
  const startedAt = new Date().toISOString()
  const started = Date.now()

  if (options.mode === 'check') {
    try {
      const checks = runStaticChecks()
      emit({
        schemaVersion: 1,
        type: RESULT_TYPE,
        mode: 'check',
        status: 'static-checked',
        at: startedAt,
        durationMs: Date.now() - started,
        checks,
        evidenceBoundary: '只做静态校验：未联网、未构建、未安装、未运行容器；不能作为 Node/npm 兼容性证据。',
      })
      process.exit(EXIT.PASS)
    } catch (error) {
      emit({ schemaVersion: 1, type: RESULT_TYPE, mode: 'check', status: 'failed', error: error.message })
      process.exit(EXIT.FAIL)
    }
  }

  const workdir = resolveWorkdir(options)
  if (options.mode === 'docker') await runDockerMode(options, workdir, startedAt, started)
  else await runNativeMode(options, workdir, startedAt, started)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  await main()
}
