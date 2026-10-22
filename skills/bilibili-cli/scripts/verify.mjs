import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalRegistry } from './local-registry.mjs'

const source = fileURLToPath(new URL('..', import.meta.url))
const root = join(source, '..', '..')
const temp = mkdtempSync(join(tmpdir(), 'bilibili-cli-e2e-'))
const output = join(temp, '发布')
const prefix = join(temp, '安装 前缀')
const state = join(temp, '隔离状态')
const sourceManifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const env = { ...process.env, BILIBILI_SKILL_HOME: state, NODE_OPTIONS: '', NODE_PATH: '', npm_config_cache: join(temp, 'npm缓存'), npm_config_audit: 'false', npm_config_fund: 'false', npm_config_registry: 'https://registry.npmjs.org/' }
let checks = 0
const check = async (name, fn) => { await fn(); checks++; process.stdout.write(`通过：${name}\n`) }
const exec = (command, args, extra = {}) => {
  const result = spawnSync(command, args, { cwd: temp, env, encoding: 'utf8', timeout: 180000, ...extra })
  assert.ifError(result.error)
  return result
}
const npmCli = process.env.npm_execpath || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
const npm = (args) => {
  const result = exec(process.execPath, [npmCli, ...args])
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return result
}
// 安装走异步子进程：本地注册表跑在本进程里，同步 spawn 会阻塞事件循环导致请求超时。
const npmAsync = (args, { cwd = temp, environment = env, timeout = 240000, label = 'npm 安装' } = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [npmCli, ...args], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const timer = setTimeout(() => { child.kill(); reject(new Error(label + '超时')) }, timeout)
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('close', (status) => {
    clearTimeout(timer)
    if (status === 0) resolvePromise(stdout)
    else reject(new Error(stderr || stdout))
  })
})
// 默认从公共注册表安装；离线/预发布开发可显式设置 BILIBILI_LOCAL_API_TARBALL，
// 通过临时注册表按 semver + integrity 真实解析本地 tarball。
const localTarball = process.env.BILIBILI_LOCAL_API_TARBALL || ''
let registry
if (localTarball && existsSync(localTarball)) {
  registry = await startLocalRegistry({
    tarballPath: localTarball,
    manifestPath: join(root, 'bilibili-api-ts', 'bilibili-api-ts', 'package.json'),
  })
  const npmrc = join(temp, '.npmrc')
  writeFileSync(npmrc, `registry=https://registry.npmjs.org/\n@yukariyukaro:registry=${registry.url}/\n`, 'utf8')
  env.npm_config_userconfig = npmrc
  process.stdout.write(`信息：使用本地注册表 ${registry.url} 安装 ${registry.name}@${registry.version}\n`)
} else {
  process.stdout.write('信息：按已发布包从默认注册表安装\n')
}

// 所有行为测试都通过 PATH 上的 bilibili 命令入口，而不是包内脚本路径。
const isWin = process.platform === 'win32'
const quote = (value) => `"${String(value).replace(/"/g, '""')}"`
const cmdArg = (value) => /[\s"]/.test(String(value)) ? quote(value) : String(value)
const invoke = (args, input = '', extra = {}) => isWin
  ? exec(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', ['bilibili', ...args.map(cmdArg)].join(' ')], { input, ...extra })
  : exec('bilibili', args, { input, ...extra })
const json = (args, status = 0) => {
  const result = invoke([...args, '--json'])
  assert.equal(result.status, status, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
const request = (command, args = {}, id = '测试') => ({ id, command, args })
const batch = (rows, status = 0) => {
  const result = invoke(['--jsonl'], rows.map((row) => typeof row === 'string' ? row : JSON.stringify(row)).join('\n') + '\n')
  assert.equal(result.status, status, result.stderr || result.stdout)
  return result.stdout.trim().split('\n').map(JSON.parse)
}

await check('生成独立 CLI 与纯文档技能，无运行时代码副本', () => {
  assert.equal(exec(process.execPath, [join(source, 'scripts', 'build.mjs'), output]).status, 0)
  assert.equal(existsSync(join(output, 'skill', 'cli')), false)
  assert.equal(existsSync(join(output, 'skill', 'SKILL.md')), true)
  assert.equal(existsSync(join(output, 'scripts')), false)
  assert.equal(existsSync(join(output, 'dist', 'lib', 'service.mjs')), true)
  assert.equal(existsSync(join(output, 'lib', 'backend.mjs')), false)
  assert.equal(existsSync(join(output, 'vendor')), false, '发布物不应包含 Python 后端副本')
  assert.equal(existsSync(join(output, 'package-lock.json')), true)
  assert.equal(exec(process.execPath, [join(source, 'scripts', 'build.mjs'), output]).status, 1)
})

await check('仓库只保留独立 CLI 源码，无 DSH、MCP、Python 后端与模拟夹具', () => {
  for (const name of ['index.js', 'client.js', 'cordis.patch.yml', 'selfcheck.mjs', 'lib', 'prompts', 'tools', 'vendor', 'cli']) {
    assert.equal(existsSync(join(root, name)), false, `不应保留 ${name}`)
  }
  for (const name of ['scripts/fixtures', 'lib', 'vendor']) {
    assert.equal(existsSync(join(source, name)), false, `不应保留 ${name}`)
  }
  assert.equal(existsSync(join(root, 'bilibili-bridge')), false, '迁移后不保留独立demo实现')
  const service = readFileSync(join(source, 'src', 'lib', 'service.mts'), 'utf8')
  assert.match(service, /@yukariyukaro\/bilibili-api-ts/, '服务层必须通过 npm 包调用')
  assert.doesNotMatch(service, /child_process|spawn\(/, '服务层不应再启动子进程')
  const repo = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(repo.private, true)
  assert.equal(repo.bin, undefined)
  assert.equal(repo.dependencies, undefined)
  const skill = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  assert.equal(skill.dependencies['dsh-bili-scroll'], undefined)
  assert.equal(skill.dependencies.execa, undefined, '不应再依赖 execa')
  assert.ok(skill.dependencies.qrcode && skill.dependencies['@yukariyukaro/bilibili-api-ts'], '依赖应包含 API 包与 qrcode')
  assert.doesNotMatch(JSON.stringify(skill), /@deepseek-ai\//)
  assert.equal(skill.bin.bilibili, './dist/cli/bili.mjs')
  assert.ok(!skill.files.includes('vendor') && !skill.files.includes('scripts'), '发布文件列表不应包含后端或脚本目录')
  const login = readFileSync(join(source, 'src', 'lib', 'login.mts'), 'utf8')
  assert.doesNotMatch(login, /child_process|spawn\(|python3|uv run/i, '登录二维码不应再调用外部进程')
})

let builtTarball = ''

await check('真实 npm pack/install，中文空格路径与 PATH 命令入口', async () => {
  const packed = JSON.parse(npm(['pack', output, '--pack-destination', temp, '--json']).stdout)[0]
  assert.ok(packed.files.some((file) => file.path === 'cli/bili.mjs'))
  assert.ok(packed.files.some((file) => file.path === 'dist/lib/service.mjs'))
  assert.ok(packed.files.some((file) => file.path === 'dist/cli/bili.mjs'))
  assert.ok(packed.files.some((file) => file.path === 'dist/lib/bridge/main.mjs'))
  assert.ok(packed.files.some((file) => file.path === 'CHANGELOG.md'))
  assert.ok(packed.files.some((file) => file.path === 'dist/lib/skill-cleanup.mjs'))
  assert.ok(packed.files.some((file) => file.path === 'references/skill-upgrade.md'))
  assert.ok(!packed.files.some((file) => /^(?:src|test|scripts)\//.test(file.path) || /\.m?ts$/.test(file.path)))
  assert.ok(!packed.files.some((file) => file.path.startsWith('vendor/') || file.path === 'lib/backend.mjs'))
  builtTarball = join(temp, packed.filename)
  await npmAsync(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', builtTarball])
  const packageDir = [
    join(prefix, 'node_modules', '@yukariyukaro', 'bilibili-cli'),
    join(prefix, 'lib', 'node_modules', '@yukariyukaro', 'bilibili-cli'),
  ].find((candidate) => existsSync(candidate))
  assert.ok(packageDir, '安装前缀中找不到 scoped 包 @yukariyukaro/bilibili-cli')
  for (const legacyPath of [
    join(prefix, 'node_modules', 'bilibili-cli'),
    join(prefix, 'lib', 'node_modules', 'bilibili-cli'),
  ]) {
    assert.equal(existsSync(legacyPath), false, '不应再安装未 scoped 的 bilibili-cli 包：' + legacyPath)
  }
  const installed = [
    join(packageDir, 'node_modules', '@yukariyukaro', 'bilibili-api-ts'),
    join(dirname(dirname(packageDir)), '@yukariyukaro', 'bilibili-api-ts'),
  ].find((candidate) => existsSync(join(candidate, 'dist', 'index.js')))
  assert.ok(installed, 'CLI 依赖应由 npm 安装到前缀内')
  assert.equal(existsSync(join(installed, 'src')), false, '安装包不应包含源码目录')
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(installedManifest.name, '@yukariyukaro/bilibili-api-ts')
  env.PATH = (process.platform === 'win32' ? prefix : join(prefix, 'bin')) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH
  const smoke = invoke(['--version'])
  assert.equal(smoke.status, 0, smoke.stderr)
  assert.equal(smoke.stdout.trim(), sourceManifest.version)
  const legacy = exec(process.execPath, [join(packageDir, 'cli', 'bili.mjs'), '--version'])
  assert.equal(legacy.status, 0, legacy.stderr)
  assert.equal(legacy.stdout.trim(), smoke.stdout.trim(), '公开过的 cli/bili.mjs 薄入口必须兼容')
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@yukariyukaro/bilibili-cli')
  assert.equal(manifest.devDependencies, undefined, '构建发布闭包不包含开发工具链')
  assert.equal(manifest.scripts, undefined, '构建发布闭包不运行安装或编译脚本')
})

// 官方用法：npm exec/npx 直接运行已构建 tarball，不能在安装期依赖仓库源码或 TypeScript 编译。
await check('npm exec 在仓库外隔离目录直接运行已构建 tarball，不需要编译', async () => {
  assert.ok(builtTarball && existsSync(builtTarball), '需要上一步 npm pack 生成的真实 tarball')
  const isolated = join(temp, 'npm exec 隔离目录')
  const relToRoot = relative(root, isolated)
  assert.ok(relToRoot !== '' && (relToRoot.startsWith('..') || isAbsolute(relToRoot)), 'npm exec 必须在仓库外隔离目录运行：' + isolated)
  mkdirSync(isolated, { recursive: true })
  const cache = join(temp, 'npm exec 缓存')
  const isolatedHome = join(isolated, '隔离状态')
  const execEnv = {
    ...env,
    BILIBILI_SKILL_HOME: isolatedHome,
    npm_config_cache: cache,
    // 关闭安装脚本，证明运行只依赖 tarball 内的 dist，而不是安装期编译。
    npm_config_ignore_scripts: 'true',
  }
  // PATH 中移除任何外部 bilibili shim（包括本机全局/上一步安装前缀），避免掩盖 npm exec 的解析结果。
  const shimNames = isWin ? ['bilibili.cmd', 'bilibili.exe', 'bilibili.ps1'] : ['bilibili']
  const pathParts = String(env.PATH || process.env.PATH || process.env.Path || '').split(delimiter)
  const sanitizedPath = pathParts.filter((part) => part && !shimNames.some((name) => existsSync(join(part, name))))
  const nodeDir = dirname(process.execPath)
  if (!sanitizedPath.some((part) => resolve(part) === resolve(nodeDir))) sanitizedPath.unshift(nodeDir)
  execEnv.PATH = sanitizedPath.join(delimiter)
  if (isWin) execEnv.Path = execEnv.PATH
  const stdout = await npmAsync(['exec', '--yes', '--package', builtTarball, '--', 'bilibili', '--version'], {
    cwd: isolated, environment: execEnv, timeout: 300000, label: 'npm exec ',
  })
  assert.equal(stdout.trim(), sourceManifest.version)
  const npxRoot = join(cache, '_npx')
  assert.equal(existsSync(npxRoot), true, 'npm exec 应在隔离缓存目录安装 tarball')
  const cachedPackages = readdirSync(npxRoot)
    .map((entry) => join(npxRoot, entry, 'node_modules', '@yukariyukaro', 'bilibili-cli'))
    .filter((candidate) => existsSync(join(candidate, 'package.json')))
  assert.equal(cachedPackages.length, 1, 'npm exec 缓存中应恰有一个 @yukariyukaro/bilibili-cli')
  const cached = cachedPackages[0]
  const cachedManifest = JSON.parse(readFileSync(join(cached, 'package.json'), 'utf8'))
  assert.equal(cachedManifest.name, '@yukariyukaro/bilibili-cli')
  assert.equal(cachedManifest.version, sourceManifest.version)
  assert.equal(cachedManifest.scripts, undefined, 'npm exec 运行不应依赖编译/安装脚本')
  assert.equal(cachedManifest.devDependencies, undefined, 'npm exec 不应拉取开发工具链')
  assert.equal(cachedManifest.bin?.bilibili, './dist/cli/bili.mjs', 'npm exec 命令入口必须指向已构建产物')
  assert.equal(existsSync(join(cached, 'dist', 'cli', 'bili.mjs')), true, 'npm exec 必须直接运行已构建入口')
  assert.equal(existsSync(join(cached, 'src')), false, 'npm exec 不应包含 TypeScript 源码')
  assert.equal(existsSync(join(cached, 'scripts')), false, 'npm exec 不应包含仓库脚本')
  assert.equal(existsSync(join(cached, 'tsconfig.json')), false, 'npm exec 不应包含编译配置')
  assert.equal(existsSync(join(dirname(dirname(dirname(cached))), 'node_modules', 'typescript')), false, 'npm exec 不应安装 TypeScript 工具链')
  const cachedApi = readdirSync(npxRoot)
    .flatMap((entry) => [
      join(npxRoot, entry, 'node_modules', '@yukariyukaro', 'bilibili-api-ts'),
      join(npxRoot, entry, 'node_modules', '@yukariyukaro', 'bilibili-cli', 'node_modules', '@yukariyukaro', 'bilibili-api-ts'),
    ])
    .find((candidate) => existsSync(join(candidate, 'dist', 'index.js')))
  assert.ok(cachedApi, 'npm exec 安装应包含 @yukariyukaro/bilibili-api-ts 运行时依赖')
  assert.equal(existsSync(isolatedHome), false, 'npm exec --version 不应创建 BILIBILI_SKILL_HOME 状态目录')
  assert.equal(existsSync(join(isolatedHome, 'bili_credential.json')), false)
  assert.equal(existsSync(join(isolated, 'package.json')), false, 'npm exec 不应在隔离目录创建项目清单')
})

await check('真实分组帮助、schema 和技能发现均无用户状态副作用', () => {
  const schema = json(['schema']).result
  const originalNames = ['auth login start', 'auth login poll', 'auth status', 'video search', 'video info', 'video subtitle', 'video hot', 'comment list', 'comment thread', 'comment create', 'comment delete', 'user info', 'user relation', 'inbox', 'dm status', 'dm read', 'dm send', 'config get', 'config set', 'doctor', 'schema', 'skills list', 'skills read']
  assert.deepEqual(schema.commands.map((c) => c.name).sort(), [...originalNames, 'bridge run', 'bridge status', 'bridge stop', 'skills cleanup'].sort())
  assert.equal(schema.version, sourceManifest.version)
  const legacyContract = JSON.parse(readFileSync(join(source, 'test', 'contracts', 'commands-1.0.0.json'), 'utf8'))
  assert.deepEqual(schema.commands.filter((c) => originalNames.includes(c.name)), legacyContract, '原23命令的字段、顺序、描述、默认值与枚举必须保持兼容')
  assert.equal(schema.commands.find((c) => c.name === 'bridge run').stream, true)
  const cleanup = schema.commands.find((c) => c.name === 'skills cleanup')
  assert.deepEqual(Object.keys(cleanup.fields).sort(), ['confirm', 'path'])
  assert.equal(cleanup.fields.path.required, true)
  assert.equal(cleanup.fields.confirm.default, false)
  assert.equal(cleanup.stream, undefined)
  assert.equal(json(['skills', 'cleanup'], 2).error.code, 'VALIDATION')
  const cleanupInvalid = batch([request('skills cleanup', { path: 'ignored', confirm: 'true' }), request('schema', {}, 'after-cleanup-validation')], 2)
  assert.equal(cleanupInvalid[0].error.code, 'VALIDATION')
  assert.equal(cleanupInvalid[1].ok, true)
  for (const item of schema.commands) {
    assert.equal(invoke([...item.name.split(' '), '--help']).status, 0)
  }
  for (const group of ['auth', 'video', 'comment', 'user', 'inbox', 'dm', 'config', 'skills', 'bridge']) assert.equal(invoke([group, '--help']).status, 0)
  assert.equal(json(['skills', 'list']).result[0].name, 'bilibili-cli')
  assert.match(json(['skills', 'read']).result.content, /逐次/)
  assert.equal(existsSync(state), false)
  const doctor = json(['doctor']).result
  assert.equal(doctor.dependenciesInstalled, true)
  assert.equal(doctor.library, '@yukariyukaro/bilibili-api-ts')
  assert.match(String(doctor.libraryVersion), /^17\.4\./)
})

await check('bridge 流边界、环境回退与有限控制不启动服务', () => {
  const bridgeState = join(temp, '未运行的bridge', 'state.json')
  assert.equal(json(['bridge', 'status', '--state-path', bridgeState]).result.running, false)
  assert.equal(json(['bridge', 'stop', '--state-path', bridgeState]).result.stopped, true)
  const rows = batch([request('bridge run'), request('schema', {}, 'after-stream')], 2)
  assert.equal(rows[0].error.code, 'STREAM_ONLY')
  assert.equal(rows[1].id, 'after-stream')
  assert.equal(rows[1].ok, true)
  const invalid = json(['bridge', 'run', '--owner-uids', 'bad'], 2)
  assert.equal(invalid.error.code, 'VALIDATION')
  const envResult = invoke(['bridge', 'run'], '', { env: { ...env, CC_CONNECT_BRIDGE_TOKEN: 'test-only-no-network', BILIBILI_OWNER_UID: '42', BILIBILI_POLL_MS: '5999', CC_CONNECT_BRIDGE_URL: 'ws://127.0.0.1:1/bridge/ws' }, timeout: 5000 })
  assert.equal(envResult.status, 2, '未显式 --poll-ms 时必须沿用并校验 BILIBILI_POLL_MS，不能被 schema 默认值掩盖')
  const event = JSON.parse(envResult.stdout)
  assert.equal(event.type, 'error')
  assert.equal(event.code, 'CONFIG')
  assert.equal(existsSync(join(temp, '未运行的bridge')), false)
})

await check('拒绝旧命令、未知参数、多余位置参数及错误数值', () => {
  for (const args of [['whoami'], ['agent'], ['video', 'search', '--unknown'], ['video', 'search', '关键词'], ['video', 'hot', '--num', '1e2'], ['config', 'set', '--key', 'secret', '--value', 'x'], ['config', 'set', '--key', 'pythonPath', '--value', 'x'], ['comment', 'thread', '--bvid', 'BV1xxxxxxxxx', '--rpid', '0'], ['inbox', '--kind', 'unknown'], ['dm', 'status']]) {
    assert.equal(json(args, 2).ok, false, args.join(' '))
  }
  assert.equal(json(['video', 'info', '--bvid', '无效'], 2).error.code, 'VALIDATION')
})

await check('写保护、dry-run、配置校验与私信收件人允许列表', () => {
  const args = ['comment', 'create', '--bvid', 'BV1xxxxxxxxx', '--text', '测试']
  assert.equal(json([...args, '--confirm'], 3).error.code, 'WRITE_DISABLED')
  assert.equal(json([...args, '--dry-run']).result.dryRun, true)
  const dm = ['dm', 'send', '--uid', '946974', '--text', '测试']
  assert.equal(json([...dm, '--confirm'], 3).error.code, 'WRITE_DISABLED')
  assert.equal(json([...dm, '--dry-run']).result.dryRun, true)
  assert.equal(existsSync(join(state, 'audit.jsonl')), false)
  const invalid = [null, false, 'true', 1, [], {}].map((confirm) => request('comment create', { bvid: 'BV1xxxxxxxxx', text: '测试', confirm }))
  assert.ok(batch(invalid, 3).every((row) => !row.ok))
  json(['config', 'set', '--key', 'writesEnabled', '--value', 'true'])
  const ids = [0, -1, 1.5, '1', '01', 9007199254740992, false, null]
  assert.ok(batch(ids.map((rpid) => request('comment delete', { bvid: 'BV1xxxxxxxxx', rpid, confirm: true })), 2).every((row) => !row.ok))
  assert.equal(json(['config', 'set', '--key', 'writesEnabled', '--value', '1'], 2).ok, false)
  assert.equal(json(['config', 'set', '--key', 'dmRecipientUid', '--value', '0'], 2).ok, false)
  json(['config', 'set', '--key', 'dmRecipientUid', '--value', '946974'])
  assert.equal(json(['dm', 'send', '--uid', '946975', '--text', '测试', '--dry-run'], 2).error.code, 'VALIDATION')
  assert.equal(json(['config', 'get']).result.dmRecipientUid, '946974')
  assert.equal(existsSync(join(state, 'audit.jsonl')), false)
})

await check('损坏非对象凭证状态：真实CLI明确AUTH拒绝，不进入匿名请求', () => {
  const invalidHome = join(temp, '非对象凭证哨兵')
  mkdirSync(invalidHome, { recursive: true })
  for (const value of [null, [], 'not-a-credential', 42]) {
    writeFileSync(join(invalidHome, 'bili_credential.json'), JSON.stringify(value))
    const result = invoke(['dm', 'read', '--uid', '42', '--json'], '', { env: { ...env, BILIBILI_SKILL_HOME: invalidHome }, timeout: 5000 })
    assert.equal(result.status, 3, result.stdout || result.stderr)
    assert.equal(JSON.parse(result.stdout).error.code, 'AUTH')
    assert.equal(existsSync(join(invalidHome, 'audit.jsonl')), false)
  }
})

await check('JSONL BOM、错误隔离、超长行和无末尾换行', () => {
  const result = invoke(['--jsonl'], '\uFEFF' + JSON.stringify(request('schema')) + '\n坏JSON\n' + 'x'.repeat(70000) + '\n' + JSON.stringify(request('skills list')))
  assert.equal(result.status, 2)
  const rows = result.stdout.trim().split('\n').map(JSON.parse)
  assert.deepEqual(rows.map((row) => row.ok), [true, false, false, true])
})

await check('JSONL 完整行在 stdin EOF 前响应且支持中断', async () => {
  const child = isWin
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'bilibili --jsonl'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn('bilibili', ['--jsonl'], { cwd: temp, env, stdio: ['pipe', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('未即时响应')) }, 10000)
    child.stdout.once('data', (data) => {
      clearTimeout(timer)
      assert.equal(JSON.parse(data).id, '即时')
      child.stdin.end()
      resolve()
    })
    child.once('error', reject)
    child.stdin.write(JSON.stringify(request('schema', {}, '即时')) + '\n')
  })
})

// 同一份安装产物交付 CLI 与 bridge；离开仓库验证公开命令及包内传输协议。
let bridgeFailures = 0
const bridgeCheck = async (name, fn) => {
  try { await fn(); checks++; process.stdout.write('通过：' + name + '\n') }
  catch (error) { bridgeFailures++; process.stderr.write('失败：' + name + '\n' + error.message + '\n') }
}
const skillCleanupE2e = join(source, 'test', 'skill-cleanup.mjs')
const verifySkillCleanup = (installedPrefix) => {
  const result = exec(process.execPath, [skillCleanupE2e], { env: { ...env, BILIBILI_E2E_INSTALLED_PREFIX: installedPrefix }, timeout: 120000 })
  process.stdout.write(result.stdout)
  assert.equal(result.status, 0, result.stderr || result.stdout)
}
await bridgeCheck('旧Skill清理 × 构建产物：预览、隔离回滚和安全拒绝', () => verifySkillCleanup(prefix))
const bridgeOffline = join(source, 'test', 'bridge', 'offline.mjs')
assert.ok(existsSync(bridgeOffline), '统一 bridge E2E 入口必须存在，不能静默跳过')
if (existsSync(bridgeOffline)) {
  await bridgeCheck('bridge × 构建产物 CLI：真实安装、隔离状态、进程与协议基线', () => {
    const result = exec(process.execPath, [bridgeOffline, 'build'], {
      env: { ...env, BILIBILI_E2E_INSTALLED_PREFIX: prefix }, timeout: 360000,
    })
    process.stdout.write(result.stdout)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
  await bridgeCheck('bridge × 源码包 CLI：npm pack/install 后传输与写保护一致', async () => {
    const sourcePack = JSON.parse(npm(['pack', source, '--pack-destination', temp, '--json']).stdout)[0]
    const sourcePrefix = join(temp, '源码包 安装')
    await npmAsync(['install', '--global', '--prefix', sourcePrefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, sourcePack.filename)])
    verifySkillCleanup(sourcePrefix)
    const result = exec(process.execPath, [bridgeOffline, 'source'], {
      env: { ...env, BILIBILI_E2E_INSTALLED_PREFIX: sourcePrefix }, timeout: 240000,
    })
    process.stdout.write(result.stdout)
    assert.equal(result.status, 0, result.stderr || result.stdout)
  })
}

if (process.env.BILIBILI_E2E_READONLY === '1' || process.env.BILIBILI_E2E === '1') {
  await check('真实 B 站只读回归：登录态、热门、搜索、视频、字幕、评论、楼中楼、用户、通知、私信', () => {
    const realEnv = { ...process.env }
    delete realEnv.BILIBILI_SKILL_HOME
    delete realEnv.NODE_OPTIONS
    delete realEnv.NODE_PATH
    realEnv.PATH = env.PATH
    if (isWin) realEnv.Path = env.PATH
    const run = (args, retry = 0) => {
      for (let attempt = 0; ; attempt += 1) {
        const result = invoke(args, '', { env: realEnv })
        if (result.status === 0) {
          const parsed = JSON.parse(result.stdout)
          assert.equal(parsed.ok, true, result.stdout)
          return parsed.result
        }
        if (attempt >= retry) assert.equal(result.status, 0, result.stderr || result.stdout)
      }
    }
    const doctor = run(['doctor', '--setup', '--json'])
    assert.equal(doctor.dependenciesInstalled, true, '请先安装 npm 依赖')
    assert.equal(doctor.library, '@yukariyukaro/bilibili-api-ts')
    assert.match(String(doctor.libraryVersion), /^17\.4\./)
    run(['auth', 'status', '--json'])
    run(['video', 'hot', '--num', '1', '--json'])
    run(['video', 'search', '--keyword', 'B站', '--num', '1', '--json'], 1)
    const bvid = process.env.BILIBILI_E2E_BVID || 'BV1pGnn67EbB'
    run(['video', 'info', '--bvid', bvid, '--json'])
    run(['video', 'subtitle', '--bvid', bvid, '--json'])
    const comments = run(['comment', 'list', '--bvid', bvid, '--num', '2', '--json'])
    if (comments.comments?.length) {
      run(['comment', 'thread', '--bvid', bvid, '--rpid', String(comments.comments[0].rpid), '--num', '2', '--json'])
    }
    run(['user', 'info', '--uid', '946974', '--json'])
    run(['user', 'relation', '--uid', '946974', '--json'])
    for (const kind of ['reply', 'like', 'at']) run(['inbox', '--kind', kind, '--json'])
    const status = run(['dm', 'status', '--uid', '946974', '--json'])
    assert.equal(typeof status.mutual, 'boolean')
    if (process.env.BILIBILI_E2E_TALKER) run(['dm', 'read', '--uid', process.env.BILIBILI_E2E_TALKER, '--json'])
    else process.stdout.write('跳过：真实私信读取（未设置 BILIBILI_E2E_TALKER）\n')
    run(['dm', 'send', '--uid', '946974', '--text', 'dry-run不发送', '--dry-run', '--json'])
  })
} else {
  process.stdout.write('跳过：真实 B 站只读回归未启用（设置 BILIBILI_E2E=1 后运行）\n')
}

if (registry) await registry.close()
if (bridgeFailures) {
  process.stderr.write(`bridge 有 ${bridgeFailures} 组失败；保留红灯供 TDD 修复，不代表真实收发已验证。\n`)
  process.exitCode = 1
}
process.stdout.write(`通过 ${checks} 组端到端回归，bridge 失败 ${bridgeFailures} 组；产物与隔离状态保留于：${temp}\n`)
