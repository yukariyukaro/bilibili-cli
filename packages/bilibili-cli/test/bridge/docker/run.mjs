#!/usr/bin/env node
/**
 * Optional Docker E2E for bilibili-cli TS × the real installed CLI.
 *
 * Modes:
 *   node packages/bilibili-cli/test/bridge/docker/run.mjs --check
 *       Build a temporary, curated context and run real static checks.
 *       Does not use the Docker daemon and does not execute product tests.
 *   node packages/bilibili-cli/test/bridge/docker/run.mjs
 *       Probe the Docker daemon, build the image, run the same bridge tests
 *       (offline.mjs build) in a --network none container.
 *       Docker unavailable => explicit status=unavailable and exit 2.
 *
 * This runner never mounts host HOME/credentials/Docker socket, never starts a
 * Docker daemon, and never copies the repository root into the context.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// HERE = <repo>/packages/bilibili-cli/test/bridge/docker
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..')
const CLI_ROOT = resolve(HERE, '..', '..', '..')
const SKILL_ROOT = resolve(REPO_ROOT, 'skills', 'bilibili-cli')
const TEST_BRIDGE_ROOT = resolve(HERE, '..')
const CONTAINER_ROOT = resolve(HERE, 'container')
const EXIT = { PASS: 0, FAIL: 1, UNAVAILABLE: 2, USAGE: 64 }
const EXPECTED_TOP_LEVEL = ['Dockerfile', '.dockerignore', 'context-manifest.json', 'packages', 'skills']
const CLI_TOP_FILES = ['package.json', 'package-lock.json', 'tsconfig.json', 'README.md', 'LICENSE', 'CHANGELOG.md']
const CLI_DIRS = [
  ['src', ['.mts']],
  ['cli', ['.mjs']],
]
const SKILL_FILES = ['SKILL.md']
const SKILL_DIRS = [['references', ['.md']]]
const CLI_SCRIPT_FILES = ['scripts/compile.mjs', 'scripts/build.mjs', 'scripts/closure.mjs']
const TEST_BRIDGE_EXTENSIONS = ['.mjs', '.md', '.txt']
const REQUIRED_TEST_BRIDGE_FILES = [
  'offline.mjs',
  'backend-driver.mjs',
  'protocol-driver.mjs',
  'lifecycle.mjs',
  'lib/env.mjs',
  'e2e/run.mjs',
  'regressions/run.mjs',
]
const FORBIDDEN_SEGMENT = /(^|[\\/])(?:node_modules|\.git|\.state|\.artifacts|artifacts|\.cc-connect|\.npm|cookies?|credentials?|secrets?)([\\/]|$)/i
const FORBIDDEN_FILE = /^(?:bili_credential\.json|credential\.json|credentials\.json|audit\.jsonl|qrcode_login\.png|\.npmrc|\.netrc|\.env(?:\..*)?|\.git-credentials|id_rsa|id_ed25519)$/i
const FORBIDDEN_EXT = new Set(['.pem', '.key', '.p12', '.pfx', '.tgz', '.zip', '.log', '.sqlite', '.db'])
const SIZE_LIMIT = 512 * 1024
const TOTAL_LIMIT = 8 * 1024 * 1024
const SECRET_PATTERNS = [
  [/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/, 'private key block'],
  [/^\s*(?:\/\/[^\s]+:)?_authToken\s*=\s*\S+/m, 'npm auth token'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/, 'GitHub token'],
  [/\bSESSDATA\s*=\s*[A-Za-z0-9%]{16,}/i, 'Bilibili SESSDATA cookie'],
  [/\bbili_jct\s*=\s*[0-9a-f]{16,}/i, 'Bilibili bili_jct cookie'],
]

const USAGE = `用法：
  node packages/bilibili-cli/test/bridge/docker/run.mjs [--check] [选项]

模式：
  --check             只准备临时 context 并做真实静态校验；不调用 Docker daemon
  （默认）            探活 Docker -> build -> docker run；daemon 不可用则 exit 2

选项：
  --node-version <22|24>  基础镜像 Node 主版本（默认 24）
  --keep-context          保留临时 context
  --keep-image            构建成功后保留镜像
  --verbose               把 docker build/run 输出流到 stderr
  --help                  显示帮助

退出码：
  0 通过    1 失败（含同一套件的红灯）    2 Docker 不可用    64 用法/配置错误
`

function parseArgs(argv) {
  const options = {
    mode: 'docker',
    nodeVersion: '24',
    keepContext: false,
    keepImage: false,
    verbose: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--check') options.mode = 'check'
    else if (arg === '--keep-context') options.keepContext = true
    else if (arg === '--keep-image') options.keepImage = true
    else if (arg === '--verbose') options.verbose = true
    else if (arg === '--node-version') {
      const value = argv[++index]
      if (!value) throw new Error('--node-version 需要参数')
      options.nodeVersion = value
    } else if (arg.startsWith('--node-version=')) options.nodeVersion = arg.slice('--node-version='.length)
    else throw new Error('未知参数：' + arg)
  }
  if (!['22', '24'].includes(options.nodeVersion)) throw new Error('--node-version 只支持 22 或 24')
  return options
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function assertOutsideRepo(target, label) {
  const resolved = resolve(target)
  const rel = relative(REPO_ROOT, resolved)
  if (rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))) {
    throw new Error(label + ' 必须离开仓库：' + resolved)
  }
}

function checkPath(rel) {
  const posix = toPosix(rel)
  if (FORBIDDEN_SEGMENT.test(posix)) throw new Error('context 路径包含禁止段：' + posix)
  const name = basename(posix)
  if (FORBIDDEN_FILE.test(name)) throw new Error('context 包含疑似凭证/状态文件：' + posix)
  const ext = extname(name).toLowerCase()
  if (FORBIDDEN_EXT.has(ext)) throw new Error('context 包含禁止扩展名：' + posix)
}

function scanContent(rel, file) {
  const size = statSync(file).size
  if (size > SIZE_LIMIT) throw new Error('context 文件超过单文件大小上限：' + rel + ' (' + size + ' bytes)')
  const text = readFileSync(file, 'utf8')
  for (const [pattern, label] of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new Error('context 文件疑似包含 ' + label + '：' + rel)
  }
}

function walkFiles(root, extensions, { skipDirs = new Set() } = {}) {
  const output = []
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      const rel = toPosix(relative(REPO_ROOT, abs))
      if (entry.isSymbolicLink()) throw new Error('禁止符号链接：' + rel)
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name.toLowerCase())) continue
        visit(abs)
        continue
      }
      if (!entry.isFile()) throw new Error('禁止特殊文件：' + rel)
      const ext = extname(entry.name).toLowerCase()
      if (!extensions.includes(ext)) throw new Error('context 目录出现未允许扩展名：' + rel)
      checkPath(rel)
      output.push({ abs, rel })
    }
  }
  visit(root)
  return output
}

function collectContextInputs() {
  const files = []
  const add = (abs, rel) => {
    const stat = lstatSync(abs)
    if (stat.isSymbolicLink()) throw new Error('禁止符号链接：' + rel)
    if (!stat.isFile()) throw new Error('不是普通文件：' + rel)
    checkPath(rel)
    files.push({ abs, rel: toPosix(rel) })
  }

  for (const name of CLI_TOP_FILES) {
    const abs = join(CLI_ROOT, name)
    if (!existsSync(abs)) throw new Error('缺少 CLI 发布闭包文件：' + name)
    add(abs, relative(REPO_ROOT, abs))
  }
  for (const [dir, extensions] of CLI_DIRS) {
    const abs = join(CLI_ROOT, dir)
    if (!existsSync(abs)) throw new Error('缺少 CLI 发布闭包目录：' + dir)
    for (const item of walkFiles(abs, extensions)) add(item.abs, relative(REPO_ROOT, item.abs))
  }
  for (const name of CLI_SCRIPT_FILES) {
    const abs = join(CLI_ROOT, name)
    if (!existsSync(abs)) throw new Error('缺少编译/发布脚本：' + name)
    add(abs, relative(REPO_ROOT, abs))
  }
  for (const name of SKILL_FILES) {
    const abs = join(SKILL_ROOT, name)
    if (!existsSync(abs)) throw new Error('缺少 Skill 文档：' + name)
    add(abs, relative(REPO_ROOT, abs))
  }
  for (const [dir, extensions] of SKILL_DIRS) {
    const abs = join(SKILL_ROOT, dir)
    if (!existsSync(abs)) throw new Error('缺少 Skill 文档目录：' + dir)
    for (const item of walkFiles(abs, extensions)) add(item.abs, relative(REPO_ROOT, item.abs))
  }
  for (const name of REQUIRED_TEST_BRIDGE_FILES) {
    if (!existsSync(join(TEST_BRIDGE_ROOT, name))) {
      throw new Error('缺少 test/bridge/' + name + '；ts-e2e 迁移尚未落盘，不能生成可运行的 Docker context')
    }
  }
  for (const item of walkFiles(TEST_BRIDGE_ROOT, TEST_BRIDGE_EXTENSIONS, { skipDirs: new Set(['docker', '.artifacts', 'node_modules']) })) {
    add(item.abs, relative(REPO_ROOT, item.abs))
  }
  add(join(CONTAINER_ROOT, 'entry.mjs'), relative(REPO_ROOT, join(CONTAINER_ROOT, 'entry.mjs')))
  for (const name of ['Dockerfile', '.dockerignore']) {
    const abs = join(HERE, name)
    if (!existsSync(abs)) throw new Error('缺少 docker 文件：' + name)
    // These two belong at the build-context root, not under the repository path.
    add(abs, name)
  }
  const unique = new Map()
  for (const item of files) {
    if (unique.has(item.rel)) throw new Error('context 文件重复：' + item.rel)
    unique.set(item.rel, item)
  }
  return [...unique.values()].sort((left, right) => left.rel.localeCompare(right.rel))
}

function prepareContext() {
  const inputs = collectContextInputs()
  let total = 0
  for (const input of inputs) total += statSync(input.abs).size
  if (total > TOTAL_LIMIT) throw new Error('context 总大小超过上限：' + total)
  const root = mkdtempSync(join(tmpdir(), 'bilibili-cli-bridge-docker-context-'))
  assertOutsideRepo(root, '临时 context')
  const manifestFiles = []
  try {
    for (const input of inputs) {
      const rel = input.rel
      const dest = join(root, rel)
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(input.abs, dest)
      scanContent(rel, dest)
      manifestFiles.push({ path: rel, sha256: sha256File(dest), bytes: statSync(dest).size })
    }
    // Detect a source change during the copy so a concurrent edit cannot make the
    // image silently test a mixture of file versions.
    const after = collectContextInputs()
    if (after.length !== inputs.length) throw new Error('复制期间源文件集合发生变化')
    for (let index = 0; index < inputs.length; index += 1) {
      if (after[index].rel !== inputs[index].rel) throw new Error('复制期间源文件集合发生变化')
      if (sha256File(after[index].abs) !== manifestFiles[index].sha256) {
        throw new Error('复制期间源文件发生变化：' + inputs[index].rel)
      }
    }
    const manifest = {
      schemaVersion: 1,
      kind: 'bilibili-cli-bridge-docker-context',
      createdAt: new Date().toISOString(),
      files: manifestFiles,
    }
    writeFileSync(join(root, 'context-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
    const topLevel = readdirSync(root, { withFileTypes: true }).map((entry) => entry.name).sort()
    assert.deepEqual(topLevel, [...EXPECTED_TOP_LEVEL].sort(), 'context 顶层必须只包含显式白名单')
    return {
      root,
      inputs,
      manifest,
      manifestSha256: sha256File(join(root, 'context-manifest.json')),
      fileCount: manifestFiles.length,
      bytes: manifestFiles.reduce((sum, file) => sum + file.bytes, 0),
      topLevel,
    }
  } catch (error) {
    if (!process.env.BILIBILI_DOCKER_KEEP_FAILED_CONTEXT) rmSync(root, { recursive: true, force: true })
    throw error
  }
}

function validateCliPackage(context) {
  const pkgPath = join(context.root, 'packages', 'bilibili-cli', 'package.json')
  const lockPath = join(context.root, 'packages', 'bilibili-cli', 'package-lock.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  assert.equal(pkg.name, '@yukariyukaro/bilibili-cli')
  assert.equal(pkg.private, undefined, '发布 CLI 不能是 private package')
  assert.deepEqual(pkg.bin, { bilibili: './dist/cli/bili.mjs' }, 'bin 必须指向编译后的唯一入口')
  assert.ok(Array.isArray(pkg.files), 'package.files 必须是数组')
  for (const name of ['dist', 'cli', 'SKILL.md', 'references', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    assert.ok(pkg.files.includes(name), 'package.files 缺少发布项：' + name)
  }
  for (const forbidden of ['src', 'test', 'scripts', 'tsconfig.json', 'node_modules', 'release']) {
    assert.ok(!pkg.files.includes(forbidden), 'package.files 不得包含源码/测试/工具链：' + forbidden)
  }
  assert.deepEqual(Object.keys(pkg.dependencies || {}).sort(), ['@yukariyukaro/bilibili-api-ts', 'commander', 'qrcode'])
  assert.deepEqual(Object.keys(pkg.devDependencies || {}).sort(), ['@types/node', '@types/qrcode', 'typescript'])
  assert.equal(pkg.scripts?.prepack, 'node scripts/compile.mjs', 'prepack 必须自动编译')
  assert.equal(pkg.scripts?.compile, 'node scripts/compile.mjs', 'compile 脚本必须存在')
  for (const name of ['preinstall', 'install', 'postinstall', 'prepare']) {
    assert.equal(pkg.scripts?.[name], undefined, 'CLI 不应有安装生命周期脚本：' + name)
  }
  assert.equal(lock.name, pkg.name)
  assert.equal(lock.version, pkg.version)
  assert.deepEqual(lock.packages?.['']?.dependencies, pkg.dependencies, 'lockfile 直接依赖必须与清单一致')
  assert.deepEqual(lock.packages?.['']?.devDependencies, pkg.devDependencies, 'lockfile 开发依赖必须与清单一致')
  const normalizeBin = (value) => String(value || '').replace(/^\.\//, '')
  assert.equal(normalizeBin(lock.packages?.['']?.bin?.bilibili), normalizeBin(pkg.bin.bilibili), 'lockfile bin 必须与清单一致（允许 ./ 前缀差异）')
  for (const [path, entry] of Object.entries(lock.packages || {})) {
    if (path === '') continue
    assert.ok(path.startsWith('node_modules/'), 'lockfile 包路径越界：' + path)
    assert.equal(entry.link, undefined, 'lockfile 禁止 link 依赖：' + path)
    assert.ok(!/(?:dsh-bili-scroll|@deepseek-ai\/|^(?:file|link|workspace):)/.test(path), 'lockfile 禁止宿主/本地依赖：' + path)
    if (entry.resolved) assert.match(entry.resolved, /^https:\/\//, 'lockfile 只允许 HTTPS registry：' + path)
  }
  return { name: pkg.name, version: pkg.version, dependencies: Object.keys(pkg.dependencies).sort(), devDependencies: Object.keys(pkg.devDependencies).sort() }
}

function validateDockerfile(context) {
  const text = readFileSync(join(context.root, 'Dockerfile'), 'utf8')
  assert.match(text, /^ARG NODE_VERSION=24$/m)
  assert.ok(text.includes('FROM node:${NODE_VERSION}-bookworm-slim AS base'))
  assert.ok(text.includes('FROM base AS cli-builder'))
  assert.ok(text.includes('FROM base AS runtime'))
  assert.match(text, /apt-get[^\n]*install[^\n]*procps/i, 'builder/runtime 必须安装 procps，供 lifecycle 的 ps 进程树检查使用')
  assert.match(text, /npm ci --ignore-scripts/, 'builder 必须用 npm ci 安装含 TypeScript 的开发依赖')
  assert.match(text, /node scripts\/compile\.mjs/, 'builder 必须实际执行 TypeScript 编译')
  assert.match(text, /npm pack --pack-destination/, 'builder 必须实际执行 npm pack')
  assert.match(text, /pack\.json[\s\S]*dist\/cli\/bili\.mjs[\s\S]*dist\/lib\/bridge\/main\.mjs[\s\S]*cli\/bili\.mjs[\s\S]*CHANGELOG\.md/, 'pack 断言必须检查编译后的 CLI、bridge、兼容 shim 与 CHANGELOG')
  assert.match(text, /npm install --global --prefix \/opt\/bilibili[^\n]*--ignore-scripts/, '必须把实际 tgz 安装到仓库外前缀')
  assert.match(text, /test -x \/opt\/bilibili\/bin\/bilibili/, 'builder 必须校验 POSIX bin 可执行')
  assert.match(text, /COPY --from=cli-builder \/opt\/bilibili \/opt\/bilibili/)
  assert.match(text, /COPY packages\/bilibili-cli\/test .\/packages\/bilibili-cli\/test/, 'runtime 必须复制白名单后的 test/bridge 树')
  assert.match(text, /COPY packages\/bilibili-cli\/cli .\/cli/, 'builder 必须包含 cli 兼容 shim')
  assert.match(text, /COPY packages\/bilibili-cli\/CHANGELOG\.md/, 'builder 必须包含 CHANGELOG.md')
  assert.match(text, /COPY context-manifest\.json/)
  assert.match(text, /^USER node$/m)
  assert.match(text, /CMD \["node", "\.\/packages\/bilibili-cli\/test\/bridge\/docker\/container\/entry\.mjs"\]/)
  assert.doesNotMatch(text, /^\s*(?:COPY|ADD)\s+\.\s/m, '禁止把整个 build context 复制进镜像')
  assert.doesNotMatch(text, /^VOLUME\b/m)
  assert.doesNotMatch(text, /--mount=type=secret|--mount=type=ssh/m)
  assert.doesNotMatch(text, /\b(?:curl|wget)\b/i)
  assert.doesNotMatch(text, /api\.bilibili\.com/i)
  const runtimeStage = text.slice(text.indexOf('FROM base AS runtime'))
  assert.doesNotMatch(runtimeStage, /^\s*RUN\s+.*\bnpm\b/m, 'runtime 不重新安装依赖')
  assert.doesNotMatch(runtimeStage, /^\s*COPY packages\/bilibili-cli\/(?:src|scripts|tsconfig)/m, 'runtime 不得复制源码/工具链')
  return true
}

function validateDockerignore(context) {
  const text = readFileSync(join(context.root, '.dockerignore'), 'utf8').toLowerCase()
  for (const pattern of ['**/node_modules', '**/.git', '**/.env', '**/.npmrc', '**/bili_credential.json', '**/*.pem', '**/audit.jsonl', 'packages/bilibili-cli/test/bridge/.artifacts']) {
    assert.ok(text.includes(pattern), '.dockerignore 缺少：' + pattern)
  }
  assert.ok(!text.includes('packages/bilibili-cli/test/bridge\n'), '.dockerignore 不能排除整个 bridge 测试目录')
  return true
}

function dockerBuildArgs(context, imageTag, nodeVersion) {
  return ['build', '--build-arg', 'NODE_VERSION=' + nodeVersion, '-f', join(context.root, 'Dockerfile'), '-t', imageTag, context.root]
}

function dockerRunArgs(imageTag, containerName) {
  assert.match(containerName, /^bilibili-cli-e2e-[a-z0-9-]+$/, '容器名必须是本次运行生成的唯一安全名称')
  return [
    'run', '--rm', '--init', '--name', containerName,
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=512m',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', '1g',
    imageTag,
  ]
}

function validateRunnerArgs() {
  const build = dockerBuildArgs({ root: '/tmp/context' }, 'bilibili-cli-e2e:check', '24')
  assert.deepEqual(build.slice(0, 3), ['build', '--build-arg', 'NODE_VERSION=24'])
  assert.ok(!build.some((value) => value === '--secret' || value === '--ssh' || value === '-v' || value === '--volume'))
  const run = dockerRunArgs('bilibili-cli-e2e:check', 'bilibili-cli-e2e-check')
  assert.ok(run.includes('--name') && run.includes('bilibili-cli-e2e-check'), 'docker run 必须使用唯一 --name 以便精确清理')
  const forbidden = new Set(['-v', '--volume', '--mount', '--env', '-e', '--env-file', '--privileged', '--device', '--cap-add', '--group-add', '--userns', '--pid', '--ipc', '--uts', '--net=host', '--network=host'])
  for (const value of run) assert.ok(!forbidden.has(value), 'docker run 参数禁止：' + value)
  assert.deepEqual(run.slice(run.indexOf('--network'), run.indexOf('--network') + 2), ['--network', 'none'])
  assert.ok(run.includes('--read-only'))
  assert.ok(run.includes('--cap-drop') && run.includes('ALL'))
  assert.ok(run.includes('--security-opt') && run.includes('no-new-privileges'))
  assert.ok(run.includes('--tmpfs') && run.some((value) => value.startsWith('/tmp:')))
  return { build, run }
}

function nodeCheck(context) {
  const files = context.inputs.filter((file) => file.rel.endsWith('.mjs'))
  for (const file of files) {
    const target = join(context.root, file.rel)
    const result = spawnSync(process.execPath, ['--check', target], { encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, 'node --check 失败：' + file.rel + '\n' + (result.stderr || '').slice(0, 1200))
  }
  return files.length
}

function validateEntry(context) {
  const file = join(context.root, 'packages', 'bilibili-cli', 'test', 'bridge', 'docker', 'container', 'entry.mjs')
  const text = readFileSync(file, 'utf8')
  assert.match(text, /offline\.mjs/, 'container entry 必须复用 test/bridge/offline.mjs，而不是另写重复 suite')
  assert.match(text, /for \(const variant of \['build'\]\)|\[\s*'build'\s*\]/, 'container entry 只运行 offline.mjs build')
  assert.match(text, /mkdtemp/, 'container entry 必须在仓库外创建临时工作目录')
  assert.match(text, /BILIBILI_E2E_INSTALLED_PREFIX/, 'container entry 必须把安装前缀传给同一套件')
  assert.match(text, /spawnSync\('ps'/, 'container entry 必须显式验证 ps，缺失时报告失败而不是静默 skip')
  assert.match(text, /dist\/lib\/bridge/, 'container entry 必须验证安装产物 dist/lib/bridge')
  return true
}

function validateTsConfig(context) {
  const root = join(context.root, 'packages', 'bilibili-cli')
  const tsconfig = JSON.parse(readFileSync(join(root, 'tsconfig.json'), 'utf8'))
  assert.equal(tsconfig.compilerOptions?.rootDir, 'src')
  assert.equal(tsconfig.compilerOptions?.outDir, 'dist')
  assert.equal(tsconfig.compilerOptions?.module, 'NodeNext')
  assert.equal(tsconfig.compilerOptions?.moduleResolution, 'NodeNext')
  assert.equal(tsconfig.compilerOptions?.strict, true)
  assert.equal(tsconfig.compilerOptions?.noEmitOnError, true)
  assert.ok(tsconfig.include?.some((glob) => glob.includes('src/**/*.mts')), 'tsconfig 必须编译 src/**/*.mts')
  assert.ok(tsconfig.exclude?.includes('test'), 'tsconfig 不得编译 test')
  const compile = readFileSync(join(root, 'scripts', 'compile.mjs'), 'utf8')
  assert.match(compile, /['"]typescript['"]/, 'compile.mjs 必须使用开发期 TypeScript')
  assert.match(compile, /['"]tsc['"]/, 'compile.mjs 必须调用 tsc')
  assert.match(compile, /tsconfig\.json/, 'compile.mjs 必须使用 tsconfig')
  assert.ok(existsSync(join(root, 'src', 'cli', 'bili.mts')), '缺少 src/cli/bili.mts')
  assert.ok(existsSync(join(root, 'src', 'lib', 'bridge', 'main.mts')), '缺少 src/lib/bridge/main.mts')
  assert.ok(existsSync(join(root, 'cli', 'bili.mjs')), '缺少兼容 launcher cli/bili.mjs')
  const shim = readFileSync(join(root, 'cli', 'bili.mjs'), 'utf8')
  assert.match(shim, /\.\.\/dist\/lib\/command\.mjs/, 'cli/bili.mjs 只能转 dist/lib/command.mjs，不能是第二实现')
  assert.ok(!existsSync(join(root, 'dist')), 'context 不应包含旧 dist；容器内必须从源码编译')
  return { rootDir: 'src', outDir: 'dist', module: 'NodeNext', strict: true, sourceFilesCompiled: true, compatShim: 'cli/bili.mjs' }
}

function runStaticChecks(context) {
  const checks = []
  const record = (name, fn) => {
    const detail = fn()
    checks.push({ name, status: 'passed', detail })
  }
  record('临时 context 仅含显式白名单文件，未复制仓库根', () => ({
    fileCount: context.fileCount,
    bytes: context.bytes,
    topLevel: context.topLevel,
    hasRepoRootMarkers: ['promo', 'bilibili-api-ts', 'bilibili-api-python', 'release', '.git'].filter((name) => existsSync(join(context.root, name))),
  }))
  assert.deepEqual(checks.at(-1).detail.hasRepoRootMarkers, [], 'context 不应包含仓库无关目录')
  record('CLI 发布清单/锁文件闭包', () => validateCliPackage(context))
  record('TypeScript 严格编译配置与开发依赖', () => validateTsConfig(context))
  record('Dockerfile 编译、实际 tgz 安装、复用同一 test/bridge 树、安装 procps', () => validateDockerfile(context))
  record('Dockerfile/.dockerignore 禁止凭证与仓库根复制', () => validateDockerignore(context))
  record('docker run 无宿主挂载/无宿主环境/运行阶段无网络', () => validateRunnerArgs())
  record('所有 context .mjs 通过 node --check', () => ({ files: nodeCheck(context) }))
  record('container entry 复用 offline.mjs build', () => validateEntry(context))
  record('容器按唯一 name 清理，且 run.code!=0 不得报 passed', () => {
    const text = readFileSync(join(HERE, 'run.mjs'), 'utf8')
    assert.match(text, /dockerRunArgs\(imageTag, containerName\)/, 'docker run 必须传本次唯一 containerName')
    assert.match(text, /'rm', '-f', containerName/, '清理必须精确本次 containerName')
    assert.match(text, /entry\.classification/, '分类必须读取 entry.classification')
    assert.match(text, /run\.code === 0/, 'run.code!=0 不得报 passed')
    return { namedCleanup: true, exitCodeGate: true }
  })
  record('context 无凭证/状态/artifact 文件', () => {
    const forbidden = context.inputs.filter((file) => /(?:credential|cookie|\.artifacts|audit\.jsonl|qrcode_login)/i.test(file.rel))
    assert.deepEqual(forbidden, [], 'context 出现禁止文件：' + forbidden.map((file) => file.rel).join(', '))
    return { forbidden: 0 }
  })
  const regressions = context.inputs.filter((file) => file.rel.startsWith('packages/bilibili-cli/test/bridge/regressions/'))
  const e2e = context.inputs.filter((file) => file.rel.startsWith('packages/bilibili-cli/test/bridge/e2e/'))
  const scripts = context.inputs.filter((file) => file.rel.startsWith('packages/bilibili-cli/scripts/'))
  assert.ok(regressions.some((file) => file.rel.endsWith('/run.mjs')), 'context 必须包含 test/bridge/regressions/run.mjs')
  assert.ok(e2e.some((file) => file.rel.endsWith('/run.mjs')), 'context 必须包含 test/bridge/e2e/run.mjs')
  assert.ok(scripts.some((file) => file.rel.endsWith('/compile.mjs')) && scripts.some((file) => file.rel.endsWith('/build.mjs')) && scripts.some((file) => file.rel.endsWith('/closure.mjs')), 'context 必须包含 compile/build/closure')
  checks.push({ name: '同一套件文件齐全（offline/backend/protocol/lifecycle/e2e/regressions/lib）', status: 'passed', detail: { e2eFiles: e2e.length, regressionFiles: regressions.length, scriptFiles: scripts.length } })
  return checks
}

async function runProcess(command, args, { cwd, env, timeoutMs = 600000, verbose = false } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let overflow = false
    const limit = 12 * 1024 * 1024
    const append = (target, chunk) => {
      if (typeof target === 'string' && target.length > limit) {
        overflow = true
        try { child.kill() } catch {}
        return target
      }
      return target + chunk
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch {}
    }, timeoutMs)
    const finish = (code, signal, error) => {
      clearTimeout(timer)
      resolveRun({ code, signal, stdout, stderr, timedOut, overflow, error })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk)
      if (verbose) process.stderr.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
      if (verbose) process.stderr.write(chunk)
    })
    child.once('error', (error) => finish(null, null, error))
    child.once('close', (code, signal) => finish(code, signal, null))
  })
}

function parseDockerVersion() {
  const client = spawnSync('docker', ['--version'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
  if (client.error || client.status !== 0) {
    return { available: false, reason: 'client-missing', clientVersion: null, detail: (client.error?.message || client.stderr || '').trim().slice(0, 800) }
  }
  const clientVersion = /Docker version\s+([^,\s]+)/.exec(client.stdout)?.[1] || null
  const probe = spawnSync('docker', ['version', '--format', '{{json .}}'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  let parsed = null
  try { parsed = JSON.parse(probe.stdout) } catch {}
  const serverVersion = parsed?.Server?.Version ?? null
  if (probe.error || probe.status !== 0 || !serverVersion) {
    return {
      available: false,
      reason: 'daemon-unreachable',
      clientVersion,
      serverVersion,
      detail: (probe.error?.message || probe.stderr || probe.stdout || '').trim().replace(/\s+/g, ' ').slice(0, 800),
    }
  }
  return { available: true, reason: null, clientVersion, serverVersion, detail: '' }
}

function writeReport(report) {
  const dir = mkdtempSync(join(tmpdir(), 'bilibili-cli-bridge-docker-report-'))
  const path = join(dir, 'report.json')
  writeFileSync(path, JSON.stringify(report, null, 2) + '\n', 'utf8')
  return path
}

async function emit(report, code) {
  const reportPath = writeReport(report)
  report.reportPath = reportPath
  const text = JSON.stringify(report, null, 2) + '\n'
  await new Promise((resolveWrite) => process.stdout.write(text, resolveWrite))
  if (code !== EXIT.PASS) process.stderr.write('[bilibili-cli-bridge-docker] ' + report.status + (report.reason ? '：' + report.reason : '') + '\n')
  process.exit(code)
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    await emit({ schemaVersion: 1, type: 'bilibili-cli-bridge-docker-e2e', status: 'usage-error', error: error.message, usage: USAGE }, EXIT.USAGE)
    return
  }
  if (options.help) {
    process.stdout.write(USAGE)
    return
  }
  const startedAt = new Date().toISOString()
  const started = Date.now()

  if (options.mode === 'check') {
    let context
    try {
      context = prepareContext()
      const checks = runStaticChecks(context)
      const report = {
        schemaVersion: 1,
        type: 'bilibili-cli-bridge-docker-e2e',
        mode: 'check',
        status: 'static-checked',
        at: startedAt,
        durationMs: Date.now() - started,
        nodeVersion: options.nodeVersion,
        docker: { probed: false, note: '--check 不调用 Docker daemon，不构建、不运行容器' },
        context: {
          fileCount: context.fileCount,
          bytes: context.bytes,
          topLevel: context.topLevel,
          manifestSha256: context.manifestSha256,
          kept: options.keepContext,
          root: options.keepContext ? context.root : null,
        },
        checks,
        suite: {
          entry: 'packages/bilibili-cli/test/bridge/docker/container/entry.mjs',
          variants: ['build'],
          reused: ['offline.mjs', 'backend-driver.mjs', 'protocol-driver.mjs', 'lifecycle.mjs', 'e2e/run.mjs', 'regressions/run.mjs'],
          note: '--check 只做静态校验；容器内只运行同一套 offline.mjs build（不再重复 source 安装），regressions 红灯会保留为非零，而不是基础设施失败。',
        },
        evidenceBoundary: '真实静态执行（context 准备、node --check、清单/锁文件/Dockerfile/参数校验）；未构建镜像、未运行容器、未访问 B 站、未读取凭证。',
      }
      if (!options.keepContext) rmSync(context.root, { recursive: true, force: true })
      await emit(report, EXIT.PASS)
    } catch (error) {
      if (context && !options.keepContext) rmSync(context.root, { recursive: true, force: true })
      await emit({
        schemaVersion: 1,
        type: 'bilibili-cli-bridge-docker-e2e',
        mode: 'check',
        status: 'failed',
        at: startedAt,
        durationMs: Date.now() - started,
        error: error.message,
        evidenceBoundary: '静态校验失败；未构建镜像、未运行容器、未访问 B 站、未读取凭证。',
      }, EXIT.FAIL)
    }
    return
  }

  const docker = parseDockerVersion()
  if (!docker.available) {
    await emit({
      schemaVersion: 1,
      type: 'bilibili-cli-bridge-docker-e2e',
      mode: 'docker',
      status: 'unavailable',
      at: startedAt,
      durationMs: Date.now() - started,
      nodeVersion: options.nodeVersion,
      docker: { probed: true, ...docker },
      reason: docker.reason,
      message: 'Docker daemon 不可达；未构建镜像、未运行容器、未执行测试。这不是通过。',
      next: '先运行 node packages/bilibili-cli/test/bridge/docker/run.mjs --check 做无需 daemon 的静态校验；修复 Docker 环境后再运行本命令。',
      evidenceBoundary: 'Docker 不可用；没有容器证据。未启动 Docker daemon、未访问 B 站、未读取凭证。',
    }, EXIT.UNAVAILABLE)
    return
  }

  let context
  let imageTag = 'bilibili-cli-e2e:' + process.pid + '-' + Date.now().toString(36)
  const containerName = 'bilibili-cli-e2e-' + process.pid + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  try {
    context = prepareContext()
    const checks = runStaticChecks(context)
    const buildArgs = dockerBuildArgs(context, imageTag, options.nodeVersion)
    const build = await runProcess('docker', buildArgs, { cwd: context.root, env: process.env, timeoutMs: 900000, verbose: options.verbose })
    if (build.error || build.timedOut || build.code !== 0) {
      if (!options.keepContext) rmSync(context.root, { recursive: true, force: true })
      await emit({
        schemaVersion: 1,
        type: 'bilibili-cli-bridge-docker-e2e',
        mode: 'docker',
        status: 'failed',
        classification: 'infrastructure-failure',
        stage: 'build',
        at: startedAt,
        durationMs: Date.now() - started,
        nodeVersion: options.nodeVersion,
        docker,
        context: { fileCount: context.fileCount, bytes: context.bytes, manifestSha256: context.manifestSha256 },
        checks,
        commands: { build: buildArgs },
        error: {
          timedOut: build.timedOut,
          exitCode: build.code,
          stderrTail: (build.stderr || '').slice(-4000),
          stdoutTail: (build.stdout || '').slice(-2000),
        },
        evidenceBoundary: '镜像构建失败；未获得容器测试证据。',
      }, EXIT.FAIL)
      return
    }

    const runArgs = dockerRunArgs(imageTag, containerName)
    if (!options.verbose) process.stderr.write('[bilibili-cli-bridge-docker] 构建完成，启动 --network none 容器...\n')
    const run = await runProcess('docker', runArgs, { cwd: context.root, env: process.env, timeoutMs: 600000, verbose: options.verbose })
    let entry = null
    for (const line of run.stdout.trim().split(/\r?\n/)) {
      try {
        const value = JSON.parse(line)
        if (value && value.type === 'bilibili-cli-bridge-docker-container-run') entry = value
      } catch {}
    }
    const infra = Boolean(run.error || run.timedOut || entry === null)
    const entryPassed = entry !== null && entry.status === 'passed' && entry.classification === 'passed' && run.code === 0
    const testFailed = !infra && !entryPassed
    const status = entryPassed ? 'passed' : 'failed'
    const classification = infra
      ? 'infrastructure-failure'
      : entryPassed
        ? 'passed'
        : entry?.classification === 'infrastructure-failure'
          ? 'infrastructure-failure'
          : 'test-failure'
    const report = {
      schemaVersion: 1,
      type: 'bilibili-cli-bridge-docker-e2e',
      mode: 'docker',
      status,
      classification,
      at: startedAt,
      durationMs: Date.now() - started,
      nodeVersion: options.nodeVersion,
      docker,
      context: {
        fileCount: context.fileCount,
        bytes: context.bytes,
        topLevel: context.topLevel,
        manifestSha256: context.manifestSha256,
        kept: options.keepContext,
        root: options.keepContext ? context.root : null,
      },
      image: { tag: imageTag, kept: options.keepImage },
      commands: { build: buildArgs, run: runArgs },
      checks,
      container: {
        name: containerName,
        exitCode: run.code,
        signal: run.signal,
        timedOut: run.timedOut,
        stdoutTail: run.stdout.slice(-6000),
        stderrTail: run.stderr.slice(-6000),
      },
      suite: entry,
      evidenceBoundary: '容器内真实安装的 CLI + 同一套 offline.mjs build；运行阶段 --network none，无宿主挂载；regressions 红灯按测试失败保留，不当作基础设施失败。真实 B 站只读/写/双账号往返未执行，接口受理不等于送达。',
      notes: [
        testFailed ? '容器内同一套件存在红灯（可能是 tdd-review 已确认的产品缺陷）；这是测试结果，不是基础设施失败，未被跳过或改写成通过。' : '容器内同一套件通过。',
        '未挂载宿主 HOME、凭证、状态目录或 Docker socket；未向容器传宿主环境变量。',
      ],
    }
    // --rm normally removed it; also remove by the exact generated name in case
    // the docker client was killed on timeout and the container outlived it.
    await runProcess('docker', ['rm', '-f', containerName], { cwd: context.root, env: process.env, timeoutMs: 120000 })
    if (!options.keepImage) await runProcess('docker', ['image', 'rm', '-f', imageTag], { cwd: context.root, env: process.env, timeoutMs: 120000 })
    if (!options.keepContext) rmSync(context.root, { recursive: true, force: true })
    await emit(report, status === 'passed' ? EXIT.PASS : EXIT.FAIL)
  } catch (error) {
    await runProcess('docker', ['rm', '-f', containerName], { cwd: REPO_ROOT, env: process.env, timeoutMs: 120000 })
    if (context && !options.keepContext) rmSync(context.root, { recursive: true, force: true })
    if (!options.keepImage) await runProcess('docker', ['image', 'rm', '-f', imageTag], { cwd: REPO_ROOT, env: process.env, timeoutMs: 120000 })
    await emit({
      schemaVersion: 1,
      type: 'bilibili-cli-bridge-docker-e2e',
      mode: 'docker',
      status: 'failed',
      classification: 'infrastructure-failure',
      at: startedAt,
      durationMs: Date.now() - started,
      docker,
      error: error.message,
      evidenceBoundary: '容器 E2E 基础设施失败；未访问 B 站、未读取凭证。',
    }, EXIT.FAIL)
  }
}

await main()
