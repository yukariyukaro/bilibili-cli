import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const source = fileURLToPath(new URL('..', import.meta.url))
const temp = mkdtempSync(join(tmpdir(), 'bilibili-cli-验证-'))
const skill = join(temp, '独立技能')
const state = join(temp, '独立状态')
let checks = 0

function check(name, fn) {
  fn()
  checks++
  process.stdout.write(`通过：${name}\n`)
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const file = join(dir, name)
    return statSync(file).isDirectory() ? files(file) : [file]
  })
}

cpSync(source, skill, { recursive: true, filter: (file) => !relative(source, file).split(/[\\/]/).some((part) => ['.git', '__pycache__'].includes(part)) })
const cli = join(skill, 'cli', 'bili.mjs')
const env = { ...process.env, BILIBILI_SKILL_HOME: state, NODE_PATH: '', NODE_OPTIONS: '', DSH_HOME: join(temp, '禁止使用的宿主目录') }
const run = (args, input = '', preload = false) => {
  const result = spawnSync(process.execPath, [...(preload ? ['--import', pathToFileURL(join(skill, 'scripts', 'fixtures', 'login.mjs')).href] : []), cli, ...args], { cwd: temp, env, input, encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  return result
}
const json = (args, status = 0, preload = false) => {
  const result = run([...args, '--json'], '', preload)
  assert.equal(result.status, status, result.stderr || result.stdout)
  return JSON.parse(result.stdout)
}
const batch = (requests) => {
  const result = run(['agent'], requests.map((item) => typeof item === 'string' ? item : JSON.stringify(item)).join('\n') + '\n')
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim().split('\n').map((line) => JSON.parse(line))
}

check('独立依赖清单与技能中文格式', () => {
  const pkg = JSON.parse(readFileSync(join(skill, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'bilibili-cli')
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['commander', 'execa'])
  assert.equal(pkg.peerDependencies, undefined)
  const lock = readFileSync(join(skill, 'package-lock.json'), 'utf8')
  assert.doesNotMatch(lock, /@deepseek-ai|dsh-bili-scroll|file:\.\.\//)
  assert.deepEqual(JSON.parse(lock).packages[''].dependencies, pkg.dependencies)
  assert.equal(JSON.parse(lock).name, pkg.name)
  assert.equal(JSON.parse(lock).packages[''].name, pkg.name)
  const doc = readFileSync(join(skill, 'SKILL.md'), 'utf8')
  assert.match(doc, /^---\r?\nname: bilibili-cli\r?\ndescription: [^\r\n]+\r?\n---/)
  assert.match(doc, /绝对路径/)
  assert.match(doc, /CLI 契约/)
  assert.ok(existsSync(join(skill, 'references', 'cli-contract.md')))
  for (const dependency of Object.keys(pkg.dependencies)) assert.ok(existsSync(join(skill, 'node_modules', dependency, 'package.json')))
})

check('中英文说明、来源许可与 MCP 品牌一致', () => {
  for (const name of ['README.md', 'README.en.md']) {
    const doc = readFileSync(join(skill, name), 'utf8')
    for (const text of ['bilibili-cli', 'deepseek-ai/deepseek-harness', 'c1overzz/dsh-bili-scroll', 'adoresever/bilibili-mcp', 'AGI_Ananas', 'MIT', 'BILIBILI_SKILL_HOME', 'bilibili-skill']) assert.ok(doc.includes(text), `${name}: ${text}`)
    for (const [, target] of doc.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g)) {
      if (!target.includes('://')) assert.ok(existsSync(resolve(skill, target)), target)
    }
  }
  assert.match(readFileSync(join(skill, 'lib', 'mcp.mjs'), 'utf8'), /clientInfo: \{ name: 'bilibili-cli'/)
})

check('重命名后沿用旧状态目录、配置与凭证，不接触真实用户目录', () => {
  const portable = pathToFileURL(join(skill, 'lib', 'portable.mjs')).href
  const base = join(temp, '兼容状态根目录')
  const legacy = join(base, 'bilibili-skill')
  const script = `
    import assert from 'node:assert/strict'
    import { stateDir, configFile, credentialFile, auditFile, writeJson, readJson } from ${JSON.stringify(portable)}
    const expected = ${JSON.stringify(legacy)}
    assert.equal(stateDir(), expected)
    writeJson(configFile(expected), { writesEnabled: false, marker: '旧配置' })
    writeJson(credentialFile(expected), { marker: '模拟凭证' })
    assert.equal(readJson(configFile(stateDir())).marker, '旧配置')
    assert.equal(readJson(credentialFile(stateDir())).marker, '模拟凭证')
    assert.ok(auditFile(stateDir()).endsWith('audit.jsonl'))
    process.env.BILIBILI_SKILL_HOME = ${JSON.stringify(state)}
    assert.equal(stateDir(), ${JSON.stringify(state)})
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: temp,
    env: { ...env, BILIBILI_SKILL_HOME: '', APPDATA: base, XDG_CONFIG_HOME: base },
    encoding: 'utf8',
    timeout: 15000,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(existsSync(join(base, 'bilibili-cli')), false)
})

check('运行文件依赖闭包和语法检查', () => {
  for (const file of files(skill).filter((file) => !file.includes(`${join(skill, 'node_modules')}`) && file.endsWith('.mjs'))) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    if (!relative(skill, file).match(/^(cli|lib)[\\/]/)) continue
    const content = readFileSync(file, 'utf8')
    for (const [, specifier] of content.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('node:')) continue
      if (specifier.startsWith('.')) {
        const target = resolve(dirname(file), specifier)
        assert.ok(relative(skill, target) && !relative(skill, target).startsWith('..'))
        assert.ok(existsSync(target), target)
      } else assert.ok(['commander', 'execa'].includes(specifier), specifier)
    }
  }
  for (const file of ['mcp_server.py', 'requirements.txt', 'LICENSE']) {
    assert.deepEqual(readFileSync(join(skill, 'vendor', 'bilibili-mcp', file)), readFileSync(join(source, 'vendor', 'bilibili-mcp', file)))
  }
})

check('仓库外绝对路径启动、帮助和命令列表', () => {
  assert.equal(run(['--help']).status, 0)
  assert.ok(json([]).commands.includes('agent'))
  assert.equal(json(['config']).writesEnabled, false)
})

check('默认关闭写操作且拒绝缺少确认', () => {
  assert.match(json(['reply', '--bvid', 'BV测试', '--text', '测试'], 1).error, /--confirm/)
  assert.match(json(['reply', '--bvid', 'BV测试', '--text', '测试', '--confirm'], 1).error, /开关/)
  assert.equal(batch([{ command: 'reply', args: { bvid: 'BV测试', text: '测试', confirm: true } }])[0].ok, false)
  assert.equal(existsSync(join(state, 'audit.jsonl')), false)
})

check('模拟扫码与凭证不进入输出', () => {
  json(['config', '--set', `pythonPath=${process.execPath}`])
  assert.equal(json(['login', 'start'], 0, true).state, 'qrcode_ready')
  assert.equal(json(['login', 'poll', '--key', 'waiting'], 0, true).state, 'waiting')
  const result = json(['login', 'poll', '--key', 'ok'], 0, true)
  assert.equal(result.state, 'ok')
  assert.ok(!JSON.stringify(result).includes('仅限测试的凭证'))
  assert.equal(json(['login', 'start'], 0, true).state, 'already_logged_in')
  assert.match(json(['login', 'poll'], 1).error, /--key/)
})

cpSync(join(skill, 'scripts', 'fixtures', 'mcp.mjs'), join(skill, 'vendor', 'bilibili-mcp', 'mcp_server.py'))
env.NODE_OPTIONS = `--import=${pathToFileURL(join(skill, 'scripts', 'fixtures', 'python-loader.mjs')).href}`

check('全部只读 CLI 命令通过实际 MCP 协议映射', () => {
  const cases = [
    [['whoami'], 'bili_check_credential', {}],
    [['search', '中文关键词', '--num', '5', '--order', 'pubdate'], 'bili_search', { keyword: '中文关键词', num: 5, order: 'pubdate' }],
    [['search', '--keyword', '中文关键词', '--num', '5', '--order', 'pubdate'], 'bili_search', { keyword: '中文关键词', num: 5, order: 'pubdate' }],
    [['subtitle', 'BV测试'], 'bili_subtitle', { bvid: 'BV测试' }],
    [['subtitle', '--bvid', 'BV测试'], 'bili_subtitle', { bvid: 'BV测试' }],
    [['comments', 'BV测试', '--num', '2'], 'bili_comments', { bvid: 'BV测试', num: 2, order: 'like' }],
    [['comments', '--bvid', 'BV测试', '--num', '2'], 'bili_comments', { bvid: 'BV测试', num: 2, order: 'like' }],
    [['comments', 'BV测试', '--num', '2', '--order', 'time'], 'bili_comments', { bvid: 'BV测试', num: 2, order: 'time' }],
    [['video-info', 'BV测试'], 'bili_video_info', { bvid: 'BV测试' }],
    [['video-info', '--bvid', 'BV测试'], 'bili_video_info', { bvid: 'BV测试' }],
    [['hot', '--page', '2', '--num', '3'], 'bili_hot_videos', { pn: 2, ps: 3 }],
  ]
  for (const [args, tool, params] of cases) assert.deepEqual(json(args), { tool, args: params })
  assert.equal(existsSync(env.DSH_HOME), false)
})

check('JSONL 全部只读命令、别名及逐行错误隔离', () => {
  const names = ['whoami', 'search', 'subtitle', 'comments', 'video-info', 'hot']
  const tools = ['bili_check_credential', 'bili_search', 'bili_subtitle', 'bili_comments', 'bili_video_info', 'bili_hot_videos']
  const result = batch(['非 JSON', { command: '任意工具' }, ...names.map((command) => ({ command, args: { bvid: 'BV测试' } })), { action: 'hot', params: { pn: 2, ps: 3 } }])
  assert.equal(result.length, 9)
  assert.equal(result[0].ok, false)
  assert.equal(result[1].ok, false)
  for (let i = 0; i < names.length; i++) {
    assert.equal(result[i + 2].command, names[i])
    assert.equal(result[i + 2].result.tool, tools[i])
  }
  assert.deepEqual(result[8].result.args, { pn: 2, ps: 3 })
  const bom = run(['agent'], '\uFEFF' + JSON.stringify({ command: 'whoami' }) + '\n')
  assert.equal(bom.status, 0, bom.stderr)
  assert.equal(JSON.parse(bom.stdout.trim()).ok, true)
})

check('严格布尔开关与确认、必填及正文上限', () => {
  writeFileSync(join(state, 'config.json'), JSON.stringify({ pythonPath: process.execPath, writesEnabled: 'false' }))
  assert.match(json(['reply', '--bvid', 'BV测试', '--text', '测试', '--confirm'], 1).error, /开关/)
  json(['config', '--set', 'writesEnabled=true'])
  assert.match(json(['reply', '--bvid', 'BV测试', '--confirm'], 1).error, /--text/)
  assert.match(json(['reply', '--bvid', 'BV测试', '--text', '字'.repeat(151), '--confirm'], 1).error, /150/)
  const requests = [false, 'false', 'true', 1, null].map((confirm) => ({ command: 'reply', args: { bvid: 'BV测试', text: '测试', confirm } }))
  requests.push({ command: 'reply', args: { bvid: 'BV测试', confirm: true } }, { command: 'reply', args: { bvid: 'BV测试', text: '字'.repeat(151), confirm: true } })
  assert.ok(batch(requests).every((item) => item.ok === false))
  assert.equal(existsSync(join(state, 'audit.jsonl')), false)
})

check('确认后模拟评论、回复与审计，关闭开关后再次拒绝', () => {
  const result = json(['reply', '--bvid', 'BV测试', '--text', '字'.repeat(150), '--rpid', '123', '--confirm'])
  assert.equal(result.audited, true)
  assert.equal(result.result.args.rpid, 123)
  assert.equal(batch([{ command: 'reply', args: { bvid: 'BV测试', text: '批量测试', confirm: true } }])[0].ok, true)
  const audit = readFileSync(join(state, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(audit.length, 2)
  assert.equal(audit[0].text.length, 20)
  assert.equal(audit[0].action, 'reply')
  json(['config', '--set', 'writesEnabled=false'])
  assert.match(json(['reply', '--bvid', 'BV测试', '--text', '测试', '--confirm'], 1).error, /开关/)
})

const deletion = ['delete', '--bvid', 'BV测试', '--rpid', '123']
const readAudit = () => readFileSync(join(state, 'audit.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter((item) => item.action === 'delete')

check('删除严格写开关、逐次确认与正整数参数校验', () => {
  assert.ok(json([]).commands.some((item) => item.startsWith('delete ')))
  for (const writesEnabled of [false, 'true', 'false', 1]) {
    writeFileSync(join(state, 'config.json'), JSON.stringify({ pythonPath: process.execPath, writesEnabled }))
    assert.match(json([...deletion, '--confirm'], 1).error, /开关/)
    assert.equal(batch([{ command: 'delete', args: { bvid: 'BV测试', rpid: 123, confirm: true } }])[0].ok, false)
  }
  json(['config', '--set', 'writesEnabled=true'])
  assert.match(json(deletion, 1).error, /确认/)
  const invalid = [undefined, null, false, true, 0, -1, 1.5, '', ' ', '01', '1e2', '0x10', 'NaN', 'Infinity', '9007199254740992', [], {}]
  for (const rpid of invalid.filter((item) => typeof item === 'string')) {
    assert.match(json(['delete', '--bvid', 'BV测试', '--rpid', rpid, '--confirm'], 1).error, /正整数/)
  }
  assert.match(json(['delete', '--rpid', '123', '--confirm'], 1).error, /bvid/)
  assert.match(json(['delete', '--bvid', 'BV测试', '--confirm'], 1).error, /正整数/)
  const requests = invalid.map((rpid) => ({ command: 'delete', args: { bvid: 'BV测试', rpid, confirm: true } }))
  requests.push(...[undefined, false, 'true', 1, null].map((confirm) => ({ command: 'delete', args: { bvid: 'BV测试', rpid: 123, confirm } })))
  requests.push({ command: 'delete', args: { bvid: ' ', rpid: 123, confirm: true } })
  assert.ok(batch(requests).every((item) => item.ok === false))
  assert.equal(readAudit().length, 0)
})

check('模拟删除 CLI 和 JSONL 映射、审计及每条重新确认', () => {
  const result = json([...deletion, '--confirm'])
  assert.equal(result.ok, true)
  assert.equal(result.audited, true)
  assert.deepEqual(result.result.args, { bvid: 'BV测试', rpid: 123 })
  const rows = batch([
    { action: 'delete', params: { bvid: 'BV测试', rpid: '9007199254740991', confirm: true } },
    { command: 'delete', args: { bvid: 'BV另一目标', rpid: 456 } },
  ])
  assert.equal(rows[0].audited, true)
  assert.equal(rows[0].result.args.rpid, Number.MAX_SAFE_INTEGER)
  assert.equal(rows[1].ok, false)
  assert.deepEqual(readAudit().map((item) => item.status), ['attempt', 'success', 'attempt', 'success'])
  assert.ok(readAudit().every((item) => item.at && item.bvid && item.rpid))
})

check('删除业务失败、未知结果与 MCP 错误不伪成功且逐行隔离', () => {
  for (const bvid of ['BV失败', 'BV未知', 'BV协议失败']) {
    assert.equal(json(['delete', '--bvid', bvid, '--rpid', '123', '--confirm'], 1).ok, false)
  }
  const rows = batch([
    ...['BV失败', 'BV未知', 'BV协议失败'].map((bvid) => ({ command: 'delete', args: { bvid, rpid: 123, confirm: true } })),
    { command: 'whoami' },
  ])
  assert.ok(rows.slice(0, 3).every((item) => item.ok === false && !item.audited))
  assert.equal(rows[3].ok, true)
  assert.equal(readAudit().filter((item) => item.status === 'failed').length, 6)
})

check('删除前后审计失败均失败关闭且不自动重试', () => {
  const options = env.NODE_OPTIONS
  env.NODE_OPTIONS += ` --import=${pathToFileURL(join(skill, 'scripts', 'fixtures', 'audit.mjs')).href}`
  try {
    const before = readAudit().length
    env.TEST_AUDIT_FAIL_AT = '1'
    assert.match(json([...deletion, '--confirm'], 1).error, /模拟审计失败/)
    assert.equal(readAudit().length, before)
    env.TEST_AUDIT_FAIL_AT = '2'
    const result = json([...deletion, '--confirm'], 1)
    assert.equal(result.ok, false)
    assert.match(result.error, /接口已返回成功.*审计写入失败/)
    assert.equal(readAudit().length, before + 1)
    assert.equal(readAudit().at(-1).status, 'attempt')
    assert.equal(batch([{ command: 'delete', args: { bvid: 'BV测试', rpid: 123, confirm: true } }])[0].ok, false)
  } finally {
    env.NODE_OPTIONS = options
    delete env.TEST_AUDIT_FAIL_AT
  }
  json(['config', '--set', 'writesEnabled=false'])
  assert.match(json([...deletion, '--confirm'], 1).error, /开关/)
})

check('Python MCP 删除函数参数、aid 映射和失败路径隔离验证', () => {
  const result = spawnSync('python', [join(skill, 'scripts', 'fixtures', 'delete_test.py'), join(source, 'vendor', 'bilibili-mcp', 'mcp_server.py')], { encoding: 'utf8', timeout: 15000 })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr || result.stdout)
})

process.stdout.write(`共 ${checks} 组验证通过；临时测试数据保留于 ${temp}\n`)
