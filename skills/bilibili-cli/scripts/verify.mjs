import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startLocalRegistry } from './local-registry.mjs'

const source = fileURLToPath(new URL('..', import.meta.url))
const root = join(source, '..', '..')
const temp = mkdtempSync(join(tmpdir(), 'bilibili-cli-e2e-'))
const output = join(temp, '发布')
const prefix = join(temp, '安装 前缀')
const state = join(temp, '隔离状态')
const env = { ...process.env, BILIBILI_SKILL_HOME: state, NODE_OPTIONS: '', NODE_PATH: '', npm_config_cache: join(temp, 'npm缓存'), npm_config_audit: 'false', npm_config_fund: 'false' }
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
const npmAsync = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [npmCli, ...args], { cwd: temp, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  const timer = setTimeout(() => { child.kill(); reject(new Error('npm 安装超时')) }, 240000)
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.once('error', reject)
  child.once('close', (status) => {
    clearTimeout(timer)
    if (status === 0) resolve(stdout)
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
  assert.equal(existsSync(join(output, 'lib', 'service.mjs')), true)
  assert.equal(existsSync(join(output, 'lib', 'backend.mjs')), false)
  assert.equal(existsSync(join(output, 'vendor')), false, '发布物不应包含 Python 后端副本')
  assert.equal(existsSync(join(output, 'package-lock.json')), true)
  assert.equal(exec(process.execPath, [join(source, 'scripts', 'build.mjs'), output]).status, 1)
})

await check('仓库只保留独立 CLI 源码，无 DSH、MCP、Python 后端与模拟夹具', () => {
  for (const name of ['index.js', 'client.js', 'cordis.patch.yml', 'selfcheck.mjs', 'lib', 'prompts', 'tools', 'vendor', 'cli']) {
    assert.equal(existsSync(join(root, name)), false, `不应保留 ${name}`)
  }
  for (const name of ['scripts/fixtures', 'lib/mcp.mjs', 'lib/backend.mjs', 'lib/uvfetch.mjs', 'vendor']) {
    assert.equal(existsSync(join(source, name)), false, `不应保留 ${name}`)
  }
  const service = readFileSync(join(source, 'lib', 'service.mjs'), 'utf8')
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
  assert.equal(skill.bin.bilibili, './cli/bili.mjs')
  assert.ok(!skill.files.includes('vendor') && !skill.files.includes('scripts'), '发布文件列表不应包含后端或脚本目录')
  const login = readFileSync(join(source, 'lib', 'login.mjs'), 'utf8')
  assert.doesNotMatch(login, /child_process|spawn\(|python3|uv run/i, '登录二维码不应再调用外部进程')
})

await check('真实 npm pack/install，中文空格路径与 PATH 命令入口', async () => {
  const packed = JSON.parse(npm(['pack', output, '--pack-destination', temp, '--json']).stdout)[0]
  assert.ok(packed.files.some((file) => file.path === 'cli/bili.mjs'))
  assert.ok(packed.files.some((file) => file.path === 'lib/service.mjs'))
  assert.ok(!packed.files.some((file) => file.path.startsWith('vendor/') || file.path === 'lib/backend.mjs'))
  await npmAsync(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', join(temp, packed.filename)])
  const installed = join(prefix, 'node_modules', 'bilibili-cli', 'node_modules', '@yukariyukaro', 'bilibili-api-ts')
  assert.equal(existsSync(join(installed, 'dist', 'index.js')), true, 'CLI 依赖应由 npm 安装到前缀内')
  assert.equal(existsSync(join(installed, 'src')), false, '安装包不应包含源码目录')
  const installedManifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  assert.equal(installedManifest.name, '@yukariyukaro/bilibili-api-ts')
  env.PATH = (process.platform === 'win32' ? prefix : join(prefix, 'bin')) + (process.platform === 'win32' ? ';' : ':') + process.env.PATH
  const smoke = invoke(['--version'])
  assert.equal(smoke.status, 0, smoke.stderr)
  assert.equal(smoke.stdout.trim(), '1.0.0')
})

await check('真实分组帮助、schema 和技能发现均无用户状态副作用', () => {
  const schema = json(['schema']).result
  assert.equal(schema.commands.length, 23)
  for (const item of schema.commands) {
    assert.equal(invoke([...item.name.split(' '), '--help']).status, 0)
  }
  for (const group of ['auth', 'video', 'comment', 'user', 'inbox', 'dm', 'config', 'skills']) assert.equal(invoke([group, '--help']).status, 0)
  assert.equal(json(['skills', 'list']).result[0].name, 'bilibili-cli')
  assert.match(json(['skills', 'read']).result.content, /逐次/)
  assert.equal(existsSync(state), false)
  const doctor = json(['doctor']).result
  assert.equal(doctor.dependenciesInstalled, true)
  assert.equal(doctor.library, '@yukariyukaro/bilibili-api-ts')
  assert.match(String(doctor.libraryVersion), /^17\.4\./)
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

if (process.env.BILIBILI_E2E === '1') {
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
process.stdout.write(`完成 ${checks} 组端到端回归；产物与隔离状态保留于：${temp}\n`)
