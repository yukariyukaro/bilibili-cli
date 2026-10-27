#!/usr/bin/env node
/**
 * Node / npm 版本兼容矩阵的共用断言层。
 *
 * 证明的是同一份构建产物（tarball）在多个 Node 与 npm 版本上仍能
 * pack -> install -> 运行公开命令；断言只走真实交付路径，不读工作树 src。
 *
 * 谁在用：
 *   - test/compat/run.mjs 的 native 模式（宿主 Node × 多个 npm 版本）
 *   - test/compat/docker/entry.mjs（镜像内 Node × 镜像自带或指定 npm 版本）
 *
 * 子进程捕获复用 test/release/lib/fetch.mjs 的 run(): 输出写临时文件而不是管道，
 * 在禁止匿名管道的 Windows 沙箱和容器里都能跑。容器构建上下文会一并复制该文件。
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { npmEnv, run, tail } from '../../release/lib/fetch.mjs'

export const PACKAGE_NAME = '@yukariyukaro/bilibili-cli'
export const LIBRARY_NAME = '@yukariyukaro/bilibili-api-ts'
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** tarball 必须带上的交付物；少一个就说明构建/打包闭包被破坏。 */
export const REQUIRED_TARBALL_FILES = [
  'package.json',
  'dist/cli/bili.mjs',
  'dist/lib/service.mjs',
  'cli/bili.mjs',
  'SKILL.md',
  'references/cli-contract.md',
  'references/bridge.md',
  'CHANGELOG.md',
  'LICENSE',
]

/** 安装产物至少要能列出这些命令；覆盖只读、写入与 bridge 三块。 */
export const REQUIRED_COMMANDS = ['schema', 'doctor', 'skills list', 'video search', 'comment create', 'dm send', 'bridge run', 'bridge web']

export class StepFailure extends Error {
  constructor(step, message) {
    super(message)
    this.name = 'StepFailure'
    this.step = step
    this.classification = 'compat-failure'
  }
}

export function slug(value) {
  return String(value).replace(/[^0-9A-Za-z._-]+/g, '-').replace(/^-+|-+$/g, '') || 'current'
}

export function requestedNpmMajor(spec) {
  return /^(\d+)/.exec(String(spec))?.[1] ?? null
}

/** 发布包 engines.node 只接受 >=X 形式；其它写法无法被矩阵判定，宁可报错也不静默放过。 */
export function expectationsFromManifest(manifest) {
  assert.ok(manifest && typeof manifest === 'object', '发布清单必须是对象')
  assert.equal(manifest.name, PACKAGE_NAME, '包名不是 ' + PACKAGE_NAME)
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, '版本不是语义版本：' + manifest.version)
  assert.equal(manifest.scripts, undefined, '发布清单不应带 scripts（安装期不编译）')
  assert.equal(manifest.devDependencies, undefined, '发布清单不应带 devDependencies')
  assert.match(String(manifest.bin?.bilibili || ''), /dist\/cli\/bili\.mjs$/, 'bin 入口必须指向 dist/cli/bili.mjs')
  const range = String(manifest.dependencies?.[LIBRARY_NAME] ?? '')
  const major = /^\^?(\d+)\./.exec(range)?.[1]
  assert.ok(major, '发布包必须声明 ' + LIBRARY_NAME + ' 依赖（形如 ^X.Y.Z），当前为 "' + range + '"')
  const enginesNode = String(manifest.engines?.node ?? '')
  const minNodeMajor = /^>=\s*(\d+)(?:\.\d+){0,2}$/.exec(enginesNode)?.[1]
  assert.ok(minNodeMajor, 'engines.node 只支持 >=X 形式（当前 "' + enginesNode + '"），矩阵无法判定兼容性')
  return {
    name: manifest.name,
    version: manifest.version,
    binEntry: manifest.bin.bilibili,
    library: { name: LIBRARY_NAME, range, major },
    enginesNode,
    minNodeMajor: Number(minNodeMajor),
    dependencies: Object.keys(manifest.dependencies || {}).sort(),
  }
}

export function readExpectations(releaseDir) {
  const manifestPath = join(releaseDir, 'package.json')
  assert.ok(existsSync(manifestPath), '发布目录缺少 package.json：' + releaseDir)
  assert.ok(existsSync(join(releaseDir, 'dist', 'cli', 'bili.mjs')), '发布目录缺少 dist/cli/bili.mjs：' + releaseDir)
  return expectationsFromManifest(JSON.parse(readFileSync(manifestPath, 'utf8')))
}

export function nodeMajorOf(version = process.version) {
  const major = Number(String(version).replace(/^v/, '').split('.')[0])
  assert.ok(Number.isInteger(major) && major > 0, '无法解析 Node 版本：' + version)
  return major
}

export function assertNodeCompatible(expected, version = process.version) {
  const major = nodeMajorOf(version)
  assert.ok(major >= expected.minNodeMajor, 'Node ' + version + ' 低于发布包 engines.node ' + expected.enginesNode)
  return major
}

export function satisfiesMinNode(major, minNodeMajor) {
  return Number(major) >= Number(minNodeMajor)
}

export function lastJsonValue(text) {
  for (const line of String(text ?? '').trim().split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object') return value
    } catch {}
  }
  return null
}

/** 统一执行：spawn 失败与超时立刻抛错（属于基础设施问题，不是版本兼容结论）。 */
export async function exec(command, args, { cwd, env, timeoutMs = 180000, label = '' } = {}) {
  const prefix = label ? label + '：' : ''
  const result = await run(command, args, { cwd, env, timeoutMs })
  if (result.spawnError) throw new Error(prefix + '无法启动 ' + command + '（' + result.spawnError + '）')
  if (result.timedOut) throw new Error(prefix + command + ' 超时（' + timeoutMs + 'ms）')
  return result
}

export function assertExit(result, label) {
  assert.equal(result.code, 0, label + ' 失败（exit=' + result.code + '）：' + tail(result.stderr || result.stdout, 1500))
  return result
}

/**
 * CLI 运行环境的 PATH 前缀：目标 Node 目录在前、本次组合安装出来的 bilibili 次之。
 *
 * npm 生成的 Windows shim 在 prefix 内找不到 node.exe 时会退回 PATH 里的 node，
 * 不显式把目标 Node 目录放前面，CLI 会静默跑到宿主 Node 上，Node 版本矩阵就没意义了。
 */
export function withBinPath({ binDir, home, base = process.env, nodeDir }) {
  const env = { ...base }
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BILIBILI_E2E', 'BILIBILI_E2E_READONLY', 'BILIBILI_E2E_WRITE']) delete env[key]
  const prefix = nodeDir ? nodeDir + delimiter + binDir + delimiter : binDir + delimiter
  const path = prefix + (env.PATH || env.Path || '')
  env.PATH = path
  if (process.platform === 'win32') env.Path = path
  env.BILIBILI_SKILL_HOME = home
  return env
}

function quoteWinArg(value) {
  return /[\s"]/.test(String(value)) ? '"' + String(value).replace(/"/g, '""') + '"' : String(value)
}

export async function invokeBilibili(args, { env, cwd, timeoutMs = 120000 } = {}) {
  if (process.platform === 'win32') {
    return exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['bilibili', ...args.map(quoteWinArg)].join(' ')], { cwd, env, timeoutMs, label: 'bilibili ' + args.join(' ') })
  }
  return exec('bilibili', args, { cwd, env, timeoutMs, label: 'bilibili ' + args.join(' ') })
}

export async function bilibiliJson(args, options) {
  const result = assertExit(await invokeBilibili([...args, '--json'], options), 'bilibili ' + args.join(' ') + ' --json')
  let parsed
  try {
    parsed = JSON.parse(String(result.stdout).trim())
  } catch {
    throw new Error('bilibili ' + args.join(' ') + ' --json 输出不是 JSON：' + tail(result.stdout, 800))
  }
  assert.equal(parsed?.ok, true, 'bilibili ' + args.join(' ') + ' 未返回 ok=true：' + tail(result.stdout, 800))
  return parsed.result
}

/**
 * 安装产物的契约检查：位置、bin 入口、--version、doctor、schema、skills list 与只读副作用。
 * native 组合与容器入口共用这一份断言，避免两套判定标准。
 */
export async function verifyInstalledCli({ prefix, expected, home, workdir, baseEnv = process.env, timeoutMs = 180000, nodeDir = dirname(process.execPath), expectedNode = process.version }) {
  const checks = []
  const [scope, name] = expected.name.split('/')
  assert.ok(scope && name, '包名必须是 scope/name：' + expected.name)
  const packageDir = [
    join(prefix, 'node_modules', scope, name),
    join(prefix, 'lib', 'node_modules', scope, name),
  ].find((candidate) => existsSync(join(candidate, 'package.json')))
  assert.ok(packageDir, '安装前缀中找不到 ' + expected.name + '：' + prefix)
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, expected.name)
  assert.equal(manifest.version, expected.version, '安装版本与发布目录不一致')
  assert.equal(manifest.scripts, undefined, '安装包不应带安装脚本')
  assert.equal(manifest.devDependencies, undefined, '安装包不应带开发工具链')
  checks.push('安装包位置与清单')

  const binDir = process.platform === 'win32' ? prefix : join(prefix, 'bin')
  const shimNames = process.platform === 'win32' ? ['bilibili.cmd', 'bilibili.ps1', 'bilibili.exe'] : ['bilibili']
  const shim = shimNames.map((file) => join(binDir, file)).find((file) => existsSync(file))
  assert.ok(shim, 'PATH 入口缺失（' + join(binDir, shimNames.join('|')) + '）')
  checks.push('PATH 命令入口')

  mkdirSync(workdir, { recursive: true })
  const env = withBinPath({ binDir, home, base: baseEnv, nodeDir })

  const version = assertExit(await invokeBilibili(['--version'], { cwd: workdir, env, timeoutMs }), 'bilibili --version')
  assert.equal(String(version.stdout).trim(), expected.version, '安装后的 --version 与发布版本不一致')
  checks.push('bilibili --version')

  const schema = await bilibiliJson(['schema'], { cwd: workdir, env, timeoutMs })
  assert.equal(schema.version, expected.version)
  const names = (schema.commands || []).map((command) => command.name)
  for (const required of REQUIRED_COMMANDS) assert.ok(names.includes(required), 'schema 缺少命令：' + required)
  checks.push('schema 命令表')

  const skills = await bilibiliJson(['skills', 'list'], { cwd: workdir, env, timeoutMs })
  assert.ok(Array.isArray(skills) && skills.length === 1, 'skills list 应只返回随包技能：' + JSON.stringify(skills).slice(0, 300))
  assert.equal(skills[0].cliVersion, expected.version)
  assert.equal(skills[0].matchesCli, true, '随包 Skill 文档版本与 CLI 不一致')
  checks.push('随包 Skill 文档')

  // 这三条命令必须完全不碰状态目录（与 scripts/verify.mjs 的既有断言同口径）。
  assert.equal(existsSync(home), false, '只读命令（--version/schema/skills list）不应创建状态目录：' + home)
  checks.push('只读命令无状态副作用')

  const doctor = await bilibiliJson(['doctor'], { cwd: workdir, env, timeoutMs })
  // doctor 报的是 CLI 自己的 process.version；不相等说明 PATH 里的 node 覆盖了目标版本。
  assert.equal(doctor.node, expectedNode, 'CLI 实际运行在 ' + doctor.node + '，不是目标 Node ' + expectedNode + '；PATH 里的 node 覆盖了矩阵版本')
  assert.equal(doctor.dependenciesInstalled, true, 'doctor 报告运行时依赖缺失')
  assert.equal(doctor.library, expected.library.name)
  assert.equal(String(doctor.libraryVersion).split('.')[0], expected.library.major, 'doctor 报出的依赖主版本与声明不一致（声明 ' + expected.library.range + '，实际 ' + doctor.libraryVersion + '）')
  checks.push('doctor 运行时装配')

  // doctor 的装配视图会建出状态目录（既有行为），但绝不能写入凭证、配置或审计。
  for (const state of ['bili_credential.json', 'config.json', 'audit.jsonl']) {
    assert.equal(existsSync(join(home, state)), false, 'doctor 不应写入用户状态 ' + state)
  }
  checks.push('doctor 不写凭证/配置/审计')

  return { packageDir, binDir, shim, checks }
}

export async function packTarball({ npm, releaseDir, destination, env, timeoutMs = 300000 }) {
  mkdirSync(destination, { recursive: true })
  const result = assertExit(
    await exec(npm.command, [...npm.prefix, 'pack', releaseDir, '--pack-destination', destination, '--json'], { cwd: destination, env, timeoutMs, label: 'npm pack' }),
    'npm pack',
  )
  let entries
  try {
    entries = JSON.parse(result.stdout)
  } catch {
    throw new Error('npm pack 输出不是 JSON：' + tail(result.stdout, 600))
  }
  const entry = Array.isArray(entries) ? entries[0] : entries
  assert.ok(entry?.filename, 'npm pack 未返回文件名')
  const file = join(destination, entry.filename)
  assert.ok(existsSync(file), 'npm pack 未生成 tarball：' + file)

  const files = (entry.files || []).map((item) => item.path)
  for (const required of REQUIRED_TARBALL_FILES) assert.ok(files.includes(required), 'tarball 缺少 ' + required)
  const strays = files.filter((path) => /^(?:src|test|scripts)\//.test(path) || path === 'tsconfig.json' || /\.m?ts$/.test(path))
  assert.deepEqual(strays, [], 'tarball 含源码/测试/脚本：' + strays.join(', '))
  assert.ok(!files.some((path) => /(^|\/)node_modules\//.test(path)), 'tarball 含 node_modules')
  for (const state of ['bili_credential.json', 'config.json', 'audit.jsonl']) {
    assert.ok(!files.some((path) => path.split('/').pop() === state), 'tarball 含用户状态 ' + state)
  }
  return { file, filename: entry.filename, files: files.length, bytes: statSync(file).size }
}

export async function installTarball({ npm, tarball, prefix, env, timeoutMs = 300000 }) {
  mkdirSync(dirname(prefix), { recursive: true })
  assertExit(
    await exec(npm.command, [...npm.prefix, 'install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', tarball], { cwd: dirname(prefix), env, timeoutMs, label: 'npm install -g' }),
    'npm install -g ' + tarball,
  )
  return { prefix }
}

/** npm exec 是用户文档里的验证入口，缓存布局与去重行为在 npm 主版本间会变，单独断言。 */
export async function verifyNpmExec({ npm, tarball, expected, workdir, cache, home, baseEnv = process.env, timeoutMs = 300000, nodeDir = dirname(process.execPath) }) {
  mkdirSync(workdir, { recursive: true })
  const env = { ...baseEnv }
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BILIBILI_E2E', 'BILIBILI_E2E_READONLY', 'BILIBILI_E2E_WRITE']) delete env[key]
  env.npm_config_cache = cache
  env.npm_config_ignore_scripts = 'true'
  env.npm_config_audit = 'false'
  env.npm_config_fund = 'false'
  env.BILIBILI_SKILL_HOME = home
  // 去掉一切外部 bilibili shim，避免 npm exec 的解析结果被 PATH 冒名。
  const shimNames = process.platform === 'win32' ? ['bilibili.cmd', 'bilibili.exe', 'bilibili.ps1'] : ['bilibili']
  const parts = String(env.PATH || env.Path || '').split(delimiter).filter((part) => part && !shimNames.some((name) => existsSync(join(part, name))))
  if (nodeDir && !parts.some((part) => resolve(part) === resolve(nodeDir))) parts.unshift(nodeDir)
  env.PATH = parts.join(delimiter)
  if (process.platform === 'win32') env.Path = env.PATH

  const result = assertExit(
    await exec(npm.command, [...npm.prefix, 'exec', '--yes', '--package', tarball, '--', 'bilibili', '--version'], { cwd: workdir, env, timeoutMs, label: 'npm exec' }),
    'npm exec --package <tarball> -- bilibili --version',
  )
  const lines = String(result.stdout).trim().split(/\r?\n/)
  assert.equal(lines[lines.length - 1], expected.version, 'npm exec 运行的版本与发布版本不一致')
  assert.equal(existsSync(join(cache, '_npx')), true, 'npm exec 未把 tarball 安装到隔离缓存的 _npx 下')
  assert.equal(existsSync(join(workdir, 'package.json')), false, 'npm exec 不应在运行目录创建项目清单')
  assert.equal(existsSync(home), false, 'npm exec --version 不应创建状态目录')
  return { cache, workdir }
}

/**
 * native 模式下单个 npm 版本的完整组合：pack -> install -> 契约 -> npm exec。
 * 失败不抛出到矩阵层，而是记进该组合的 checks/failures，矩阵继续跑其它版本。
 */
export async function runNativeCombo({ npmSpec, npm, releaseDir, expected, root, baseEnv = process.env, node = { path: process.execPath, version: process.version } }) {
  const dir = join(root, 'combos', 'npm-' + slug(npmSpec))
  mkdirSync(dir, { recursive: true })
  const env = npmEnv({ cache: join(dir, 'npm-cache'), registry: DEFAULT_REGISTRY, base: baseEnv })
  const nodeDir = dirname(node.path)
  const combo = {
    requested: { npm: npmSpec },
    node: node.version,
    nodeBin: node.path,
    npm: null,
    status: 'failed',
    checks: [],
    failures: [],
  }
  const step = async (name, fn) => {
    try {
      const detail = await fn()
      combo.checks.push({ name, status: 'passed', detail: detail ?? null })
      return detail
    } catch (error) {
      if (error?.name === 'StepFailure') throw error
      const message = error?.message || String(error)
      combo.checks.push({ name, status: 'failed', error: message })
      combo.failures.push({ name, error: message })
      throw new StepFailure(name, message)
    }
  }
  try {
    await step('Node 版本满足 engines.node', () => ({ version: node.version, engines: expected.enginesNode, major: assertNodeCompatible(expected, node.version) }))
    combo.npm = await step('npm --version 可用', async () => {
      const result = await exec(npm.command, [...npm.prefix, '--version'], { cwd: dir, env, timeoutMs: 120000, label: 'npm --version' })
      assertExit(result, 'npm --version')
      return String(result.stdout).trim()
    })
    await step('npm 主版本符合请求', () => {
      const requested = requestedNpmMajor(npmSpec)
      if (requested) assert.equal(combo.npm.split('.')[0], requested, '请求 npm ' + npmSpec + '，实际 ' + combo.npm)
      return { requested: requested || 'current', actual: combo.npm }
    })
    const packed = await step('npm pack 交付目录', () => packTarball({ npm, releaseDir, destination: join(dir, 'pack'), env }))
    combo.tarball = { filename: packed.filename, bytes: packed.bytes, files: packed.files }
    await step('npm install -g 到隔离前缀', () => installTarball({ npm, tarball: packed.file, prefix: join(dir, 'prefix'), env }))
    const installed = await step('安装产物 CLI 契约（doctor/schema/skills）', () => verifyInstalledCli({ prefix: join(dir, 'prefix'), expected, home: join(dir, 'state'), workdir: join(dir, 'run'), baseEnv: env, nodeDir, expectedNode: node.version }))
    combo.install = { packageDir: installed.packageDir, binDir: installed.binDir }
    await step('npm exec 直接运行 tarball', () => verifyNpmExec({ npm, tarball: packed.file, expected, workdir: join(dir, 'exec'), cache: join(dir, 'exec-cache'), home: join(dir, 'exec-state'), baseEnv: env, nodeDir }))
    combo.status = 'passed'
  } catch (error) {
    combo.status = 'failed'
    combo.classification = error?.classification || 'infrastructure-failure'
    combo.error = error?.message || String(error)
  }
  combo.label = 'node ' + node.version + ' / npm ' + (combo.npm || npmSpec)
  return combo
}
