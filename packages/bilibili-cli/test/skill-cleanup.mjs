#!/usr/bin/env node
/**
 * 旧版 Skill 清理安装产物 E2E（红灯优先）。
 *
 * 通过维护者脚本 node packages/bilibili-cli/scripts/skill-cleanup.mjs 调用
 * --path <ABS> [--confirm] --json 和 --jsonl；不 import 产品实现、不连接 B 站、
 * 不读取真实凭证。纯文档 fixture 为精确历史副本；完整目录从固定本仓库 git
 * blob 构建到临时沙盒。测试setup需要git与49c530e历史，缺失明确失败，不跳过。
 *
 * 用法：
 *   node packages/bilibili-cli/test/skill-cleanup.mjs
 *
 * stdout 只输出一行 JSON summary；进度/失败摘要写 stderr。
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI_ROOT, REPO_ROOT, isInsideRepo, resolveInstalledPrefix } from './bridge/lib/env.mjs'

const CLEANUP_SCRIPT = join(CLI_ROOT, 'scripts', 'skill-cleanup.mjs')

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'legacy-skill-1.0.0')
// full-source 不复制进 test（避免第二份旧实现）；从固定 commit/清单用 git blob 生成临时 fixture。
const SOURCE_COMMIT = '49c530e'
const SOURCE_MANIFEST = {
  '.gitignore': '78c569d9bab789861b9f8ac3c81dd335eef2065e',
  LICENSE: 'cbee0421bde11773866abfbd7fbdf0807c9346dd',
  'README.md': 'd869d129b4aa96c4b2ac83c8b1d84728bff46c4c',
  'SKILL.md': '3d673b24b9cce2fa9824fecf955bfe02e48081c5',
  'cli/bili.mjs': '31b223cbd5ea661f0062319014b000499fa077b7',
  'lib/application.mjs': 'c9045db587a654fe4bbeced8ad9df851faf13589',
  'lib/command.mjs': '491e582265965020e16a8f81a870aa55f6b06a5e',
  'lib/contract.mjs': '6973a0c69b3212045d6dfa785361539e9b6d3d9d',
  'lib/login.mjs': 'ad6138000a518f82bf05ce6ec0268603e8b142cf',
  'lib/portable.mjs': 'cb140aad392664d7e167f38e6eb45948ce0258a0',
  'lib/runtime.mjs': '158dcf5c6110af01035cfeaca1419d715ec03307',
  'lib/service.mjs': 'e171fe12c7c79abaabe1867a444355c6192aa5c9',
  'package-lock.json': '449fcca35deecd47b9fc2fd5305b50c9405841ae',
  'package.json': '4a9f71449d14be8fdfa62180c1a19400b5ff751c',
  'references/cli-contract.md': '42dc93273a390cb08ca3a3a63d238ef58453bbbf',
  'scripts/build.mjs': '3c5026e7508ddc875544cbe896d7824d83032377',
  'scripts/closure.mjs': '24aa1a7093acf588428ad9c3cfca4364b5886c20',
  'scripts/local-registry.mjs': '8b53a07357e6f8d805284070dd302b5bcce9c2bf',
  'scripts/verify.mjs': '51f42dee2f16bb69796ab29dc6676f4e51aeab0b',
}
const LEGACY_HASHES = {
  'SKILL.md': 'b9ee5c8799d4c0a2b098b8c406d0dd473475c8c47dc11df64d0796c50aca828e',
  'references/cli-contract.md': '7f457e28fae4546aae19fc952ceede094589d49c32181f5e31d5c393da12701e',
}
const BACKUP_PREFIX = '.bilibili-cli-backup-'
// ts-bridge 固定：所有路径/内容/链接拒绝统一 SKILL_CLEANUP_REFUSED + exit 2；
// 不把 USAGE 算作拒绝，否则旧安装缺 command/flag 会把负例误报为通过。
const EXPECTED_PATH_ERROR = ['SKILL_CLEANUP_REFUSED']
const KEEP = process.env.BILIBILI_E2E_KEEP_TEMP === '1'

const installed = resolveInstalledPrefix(process.env)
const workroot = mkdtempSync(join(tmpdir(), 'bilibili-skill-cleanup-'))
if (isInsideRepo(workroot)) throw new Error('临时沙盒不能位于仓库内：' + workroot)
const cwd = workroot

const results = []
function log(line) { process.stderr.write('[skill-cleanup] ' + line + '\n') }
function hashFile(file) { return createHash('sha256').update(readFileSync(file)).digest('hex') }

function snapshot(dir) {
  const entries = []
  const visit = (root, current = '') => {
    const folder = current ? join(root, current) : root
    for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = current ? join(current, entry.name) : entry.name
      const abs = join(root, rel)
      if (entry.isDirectory()) visit(root, rel)
      else entries.push({ path: rel.split(sep).join('/'), sha256: hashFile(abs) })
    }
  }
  visit(dir)
  return entries
}

function fixtureCopy(name, { mutateSkill = null, extraFiles = {}, source = FIXTURE } = {}) {
  const parent = join(workroot, name)
  const target = join(parent, 'bilibili-cli')
  mkdirSync(parent, { recursive: true })
  cpSync(source, target, { recursive: true })
  if (mutateSkill !== null) writeFileSync(join(target, 'SKILL.md'), mutateSkill, 'utf8')
  for (const [rel, content] of Object.entries(extraFiles)) {
    const file = join(target, rel)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, content, 'utf8')
  }
  return { parent, target }
}

function materializeFullSource(name) {
  const parent = join(workroot, name)
  const target = join(parent, 'bilibili-cli')
  mkdirSync(parent, { recursive: true })
  let tree
  try {
    tree = execFileSync('git', ['-C', REPO_ROOT, 'ls-tree', '-r', SOURCE_COMMIT + ':skills/bilibili-cli'], { encoding: 'utf8' })
  } catch (error) {
    throw new Error('full-source case 需要本地 git 历史 ' + SOURCE_COMMIT + '；不能 skip 或用复制源码替代：' + error.message)
  }
  const actual = new Map()
  for (const line of tree.trim().split(/\r?\n/)) {
    const [meta, path] = line.split('	')
    const hash = meta.split(/\s+/)[2]
    actual.set(path, hash)
  }
  assert.deepEqual([...actual.keys()].sort(), Object.keys(SOURCE_MANIFEST).sort(), '49c530e full-source 文件清单必须精确等于固定 19 个')
  for (const [path, expected] of Object.entries(SOURCE_MANIFEST)) {
    assert.equal(actual.get(path), expected, 'git blob 不匹配：' + path)
    let buf
    try {
      buf = execFileSync('git', ['-C', REPO_ROOT, 'show', SOURCE_COMMIT + ':skills/bilibili-cli/' + path], { maxBuffer: 10 * 1024 * 1024 })
    } catch (error) {
      throw new Error('无法读取 ' + SOURCE_COMMIT + ':' + path + '；不能 skip：' + error.message)
    }
    const out = join(target, path)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, buf)
  }
  return { parent, target }
}

function backupDirs(parent) {
  if (!existsSync(parent)) return []
  return readdirSync(parent).filter((name) => name.startsWith(BACKUP_PREFIX)).map((name) => join(parent, name))
}

function backupSkillOf(result) {
  assert.ok(typeof result?.backupPath === 'string' && result.backupPath.length > 0, '确认结果必须包含 backupPath')
  const backupPath = resolve(result.backupPath)
  assert.equal(isAbsolute(backupPath), true, 'backupPath 必须是绝对路径')
  assert.equal(basename(backupPath), 'skill', 'backupPath 必须指向 backup 目录下的 skill 本身')
  assert.ok(basename(dirname(backupPath)).startsWith(BACKUP_PREFIX), 'backupPath 的父目录必须是 .bilibili-cli-backup-*')
  assert.ok(existsSync(join(backupPath, 'SKILL.md')), 'backupPath 下找不到 SKILL.md：' + backupPath)
  return backupPath
}

function assertUnchanged(dir, expected, message) {
  assert.deepEqual(snapshot(dir), expected, message)
}

function cleanup(args, { home } = {}) {
  const result = spawnSync(process.execPath, [CLEANUP_SCRIPT, ...args, '--json'], {
    cwd,
    env: { ...process.env, BILIBILI_SKILL_HOME: home || '' },
    encoding: 'utf8',
    timeout: 120000,
  })
  let envelope
  try { envelope = JSON.parse(result.stdout) } catch {
    envelope = { ok: false, error: { code: 'NON_JSON', message: (result.stdout || '') + (result.stderr || '') } }
  }
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '', envelope }
}

function cleanupJsonl(rows, { home } = {}) {
  const result = spawnSync(process.execPath, [CLEANUP_SCRIPT, '--jsonl'], {
    cwd,
    input: rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
    env: { ...process.env, BILIBILI_SKILL_HOME: home || '' },
    encoding: 'utf8',
    timeout: 120000,
  })
  return {
    code: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    rows: (result.stdout || '').trim().split('\n').filter(Boolean).map(JSON.parse),
  }
}

function assertGuidance(result, label) {
  const text = JSON.stringify(result.envelope)
  assert.match(text, /npx skills remove bilibili-cli/, label + ' 必须引导 official npx skills remove，不执行：' + text.slice(0, 800))
}

function expectReject(result, label) {
  assert.equal(result.code, 2, label + ' 必须以 exit 2 拒绝：' + result.stdout)
  assert.equal(result.envelope.ok, false, label + ' 必须返回 ok:false')
  const code = result.envelope.error?.code
  assert.ok(EXPECTED_PATH_ERROR.includes(code), label + ' 错误码不在允许集合：' + code + '；允许 ' + EXPECTED_PATH_ERROR.join(','))
  return code
}

async function caseRun(name, fn) {
  const started = Date.now()
  log('开始：' + name)
  try {
    const evidence = await fn()
    results.push({ name, status: 'passed', durationMs: Date.now() - started, ...(evidence ? { evidence } : {}) })
    log('通过：' + name)
  } catch (error) {
    results.push({ name, status: 'failed', durationMs: Date.now() - started, error: error?.stack || error?.message || String(error) })
    log('失败：' + name + '：' + (error?.message || error))
  }
}

try {
  const home = join(workroot, 'home')
  mkdirSync(home, { recursive: true })

  await caseRun('fixture 与旧 1.0 历史文档 hash 精确一致', async () => {
    for (const [rel, expected] of Object.entries(LEGACY_HASHES)) {
      assert.equal(hashFile(join(FIXTURE, rel)), expected, 'fixture 漂移：' + rel + '；必须保持 49c530e 的纯文档字节')
    }
    return { hashes: LEGACY_HASHES }
  })

  const previewFixture = fixtureCopy('preview')
  await caseRun('默认预览零改动：action=preview、无 backup、源文件不变', async () => {
    const before = snapshot(previewFixture.target)
    const result = await cleanup(['--path', previewFixture.target], { home })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.envelope.ok, true)
    assert.equal(result.envelope.result.action, 'preview')
    assert.equal(result.envelope.result.version, '1.0.0')
    assert.equal(Object.hasOwn(result.envelope.result, 'backupPath'), false, 'preview 不应返回 backupPath')
    assert.equal(resolve(result.envelope.result.path), resolve(previewFixture.target))
    assert.deepEqual(backupDirs(previewFixture.parent), [], '预览不能创建 backup 目录')
    assertUnchanged(previewFixture.target, before, '预览不能修改源文件')
    return { result: result.envelope.result }
  })

  await caseRun('确认清理：源路径消失、backup 内容逐字节相同、可手动 rename 回滚', async () => {
    const fixture = fixtureCopy('confirm')
    const before = snapshot(fixture.target)
    const result = await cleanup(['--path', fixture.target, '--confirm'], { home })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.envelope.ok, true)
    const value = result.envelope.result
    assert.equal(value.action, 'quarantined')
    assert.equal(value.version, '1.0.0')
    assert.equal(resolve(value.path), resolve(fixture.target))
    assert.equal(existsSync(fixture.target), false, '确认后源路径必须消失')
    const backupSkill = backupSkillOf(value)
    assert.deepEqual(snapshot(backupSkill), before, 'backup 内容必须与源逐字节相同')
    assert.equal(backupDirs(fixture.parent).length, 1, '同级应恰好一个 backup 目录')

    renameSync(backupSkill, fixture.target)
    assert.deepEqual(snapshot(fixture.target), before, '手动 rename 回滚后内容必须一致')
    return { backupPath: value.backupPath, action: value.action }
  })

  await caseRun('重复清理已缺路径拒绝且不创建 backup', async () => {
    const fixture = fixtureCopy('missing')
    const first = await cleanup(['--path', fixture.target, '--confirm'], { home })
    assert.equal(first.code, 0, first.stderr)
    const backupCount = backupDirs(fixture.parent).length
    assert.equal(backupCount, 1)
    const again = await cleanup(['--path', fixture.target, '--confirm'], { home })
    const code = expectReject(again, '重复清理已缺路径')
    assert.equal(backupDirs(fixture.parent).length, backupCount, '重复拒绝不得创建新 backup')
    return { code }
  })

  await caseRun('未知自定义/凭证哨兵文件：拒绝、源与内容不动', async () => {
    const fixture = fixtureCopy('unknown', { extraFiles: {
      'custom.txt': '自定义文件不能被清理\n',
      'bili_credential.json': '{"SESSDATA":"sentinel-not-real"}\n',
    } })
    const before = snapshot(fixture.target)
    const result = await cleanup(['--path', fixture.target, '--confirm'], { home })
    const code = expectReject(result, '未知文件')
    assert.deepEqual(backupDirs(fixture.parent), [], '拒绝未知文件不得创建 backup')
    assertUnchanged(fixture.target, before, '未知文件必须原样保留')
    return { code }
  })

  await caseRun('新版 SKILL（hash 不匹配）：拒绝且不动', async () => {
    const fixture = fixtureCopy('new-version')
    const before = snapshot(fixture.target)
    writeFileSync(join(fixture.target, 'SKILL.md'), readFileSync(join(fixture.target, 'SKILL.md'), 'utf8') + '\n<!-- 1.1.0 新版，不是旧 1.0 清单 -->\n', 'utf8')
    const changed = snapshot(fixture.target)
    const result = await cleanup(['--path', fixture.target, '--confirm'], { home })
    const code = expectReject(result, '新版 SKILL')
    assert.deepEqual(backupDirs(fixture.parent), [], '新版 SKILL 不得创建 backup')
    assertUnchanged(fixture.target, changed, '新版 SKILL 必须原样保留')
    assert.notDeepEqual(changed, before, '测试确实修改了 SKILL（hash 已变）')
    return { code }
  })

  await caseRun('相对路径、错误 basename、受保护执行 package 路径拒绝', async () => {
    const relativeResult = await cleanup(['--path', 'bilibili-cli', '--confirm'], { home })
    const relativeCode = expectReject(relativeResult, '相对路径')

    const wrong = fixtureCopy('wrong-name')
    const wrongPath = join(wrong.parent, 'not-bilibili-cli')
    renameSync(wrong.target, wrongPath)
    const wrongBefore = snapshot(wrongPath)
    const wrongResult = await cleanup(['--path', wrongPath, '--confirm'], { home })
    const wrongCode = expectReject(wrongResult, '错误 basename')
    assertUnchanged(wrongPath, wrongBefore, '错误 basename 不得移动')

    const protectedDir = CLI_ROOT
    assert.ok(existsSync(protectedDir), 'CLI 包根不存在')
    const protectedBefore = snapshot(join(protectedDir, 'dist'))
    const protectedResult = await cleanup(['--path', protectedDir, '--confirm'], { home })
    const protectedCode = expectReject(protectedResult, '受保护执行 package 路径')
    assert.deepEqual(snapshot(join(protectedDir, 'dist')), protectedBefore, '受保护 package 内容不得变化')
    return { relativeCode, wrongCode, protectedCode }
  })

  await caseRun('symlink/junction：拒绝且目标内容不动', async () => {
    const target = fixtureCopy('symlink-target')
    const before = snapshot(target.target)
    const linkParent = join(workroot, 'symlink-link')
    mkdirSync(linkParent, { recursive: true })
    const linkPath = join(linkParent, 'bilibili-cli')
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    symlinkSync(target.target, linkPath, type)
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, '未创建可识别的 symlink/junction')
    const result = await cleanup(['--path', linkPath, '--confirm'], { home })
    const code = expectReject(result, 'symlink/junction')
    assert.equal(existsSync(linkPath), true, 'symlink/junction 必须保留')
    assertUnchanged(target.target, before, 'symlink/junction 目标内容不得变化')
    assert.deepEqual(backupDirs(linkParent), [], 'symlink/junction 不得创建 backup')
    return { code, linkType: type }
  })

  await caseRun('链接祖先、内部junction和硬链接：拒绝，不移动原目标', async () => {
    const type = process.platform === 'win32' ? 'junction' : 'dir'
    const ancestorFixture = fixtureCopy('ancestor-real')
    const before = snapshot(ancestorFixture.target)
    const linkParent = join(workroot, 'ancestor-link')
    symlinkSync(ancestorFixture.parent, linkParent, type)
    expectReject(await cleanup(['--path', join(linkParent, 'bilibili-cli'), '--confirm'], { home }), '链接祖先')
    assertUnchanged(ancestorFixture.target, before, '链接祖先不得移动真实目录')
    assert.deepEqual(backupDirs(ancestorFixture.parent), [])

    const internal = fixtureCopy('internal-link')
    const outside = join(workroot, 'reference-target')
    renameSync(join(internal.target, 'references'), outside)
    symlinkSync(outside, join(internal.target, 'references'), type)
    const outsideBefore = snapshot(outside)
    expectReject(await cleanup(['--path', internal.target, '--confirm'], { home }), '内部junction')
    assertUnchanged(outside, outsideBefore, '内部junction目标不得变化')
    assert.ok(existsSync(internal.target))
    assert.deepEqual(backupDirs(internal.parent), [])

    const hardlink = fixtureCopy('hardlink')
    const hardBefore = snapshot(hardlink.target)
    const hardPath = join(workroot, 'linked-skill.md')
    linkSync(join(hardlink.target, 'SKILL.md'), hardPath)
    expectReject(await cleanup(['--path', hardlink.target, '--confirm'], { home }), '硬链接')
    assertUnchanged(hardlink.target, hardBefore, '硬链接目录不得变化')
    assert.equal(hashFile(hardPath), LEGACY_HASHES['SKILL.md'])
    assert.deepEqual(backupDirs(hardlink.parent), [])
  })

  await caseRun('未知node_modules与空目录拒绝，状态目录不触碰', async () => {
    for (const name of ['node_modules', 'custom-empty']) {
      const fixture = fixtureCopy('unknown-directory-' + name)
      mkdirSync(join(fixture.target, name))
      expectReject(await cleanup(['--path', fixture.target, '--confirm'], { home }), name)
      assert.ok(existsSync(join(fixture.target, name)))
      assert.deepEqual(backupDirs(fixture.parent), [])
    }
    const state = fixtureCopy('state-protection')
    const before = snapshot(state.target)
    expectReject(await cleanup(['--path', state.target, '--confirm'], { home: state.target }), '状态目录')
    assertUnchanged(state.target, before, '状态目录不得搬迁')
    assert.deepEqual(backupDirs(state.parent), [])
  })

  await caseRun('full-source 49c530e 19 文件 pristine：preview/confirm/回滚', async () => {
    const fixture = materializeFullSource('full-source')
    const before = snapshot(fixture.target)
    assert.equal(before.length, 19, 'full-source fixture 必须包含 49c530e 的 19 个文件')
    const preview = await cleanup(['--path', fixture.target], { home })
    assert.equal(preview.code, 0, preview.stderr)
    assert.equal(preview.envelope.result.action, 'preview')
    assert.equal(preview.envelope.result.version, '1.0.0')
    assertUnchanged(fixture.target, before, 'full-source preview 不得改动')

    const confirmed = await cleanup(['--path', fixture.target, '--confirm'], { home })
    assert.equal(confirmed.code, 0, confirmed.stderr)
    assert.equal(confirmed.envelope.result.action, 'quarantined')
    assert.equal(existsSync(fixture.target), false, 'full-source 确认后源路径必须消失')
    const backupSkill = backupSkillOf(confirmed.envelope.result)
    assert.deepEqual(snapshot(backupSkill), before, 'full-source backup 必须逐字节一致')
    renameSync(backupSkill, fixture.target)
    assert.deepEqual(snapshot(fixture.target), before, 'full-source 手动回滚必须一致')
    return { files: before.length, backupPath: confirmed.envelope.result.backupPath }
  })

  await caseRun('历史0.1.5纯文档快照：版本识别准确，不伪报1.0.0', async () => {
    const fixture = fixtureCopy('version-0.1.5')
    for (const path of ['SKILL.md', 'references/cli-contract.md']) {
      const bytes = execFileSync('git', ['-C', REPO_ROOT, 'show', '57efd8d:' + path])
      writeFileSync(join(fixture.target, path), bytes)
    }
    const before = snapshot(fixture.target)
    const result = await cleanup(['--path', fixture.target], { home })
    assert.equal(result.code, 0, result.stdout + result.stderr)
    assert.equal(result.envelope.ok, true)
    assert.equal(result.envelope.result.version, '0.1.5')
    assert.equal(result.envelope.result.action, 'preview')
    assertUnchanged(fixture.target, before, '历史0.1.5预览不得修改')
    assert.deepEqual(backupDirs(fixture.parent), [])
  })

  await caseRun('canonical .agents/skills 目标：拒绝、不移动、给 npx 引导', async () => {
    const parent = join(workroot, 'canonical', '.agents', 'skills')
    const target = join(parent, 'bilibili-cli')
    mkdirSync(parent, { recursive: true })
    cpSync(FIXTURE, target, { recursive: true })
    const before = snapshot(target)
    const result = await cleanup(['--path', target, '--confirm'], { home })
    const code = expectReject(result, 'canonical .agents/skills')
    assertGuidance(result, 'canonical .agents/skills')
    assertUnchanged(target, before, 'canonical 目标必须原样保留')
    assert.deepEqual(backupDirs(parent), [], 'canonical 目标不得创建 backup')
    return { code, path: target }
  })

  await caseRun('祖先 skills-lock.json/.skill-lock.json：存在即拒绝、锁文件原样', async () => {
    const root = join(workroot, 'lock-root')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'skills-lock.json'), '{"sentinel":"do-not-read"}\\n', 'utf8')
    writeFileSync(join(root, '.skill-lock.json'), '{"sentinel":"do-not-read"}\\n', 'utf8')
    const target = join(root, 'bilibili-cli')
    cpSync(FIXTURE, target, { recursive: true })
    const before = snapshot(target)
    const result = await cleanup(['--path', target, '--confirm'], { home })
    const code = expectReject(result, '祖先 lock 文件')
    assertGuidance(result, '祖先 lock 文件')
    assertUnchanged(target, before, '有祖先 lock 时必须原样保留')
    assert.equal(readFileSync(join(root, 'skills-lock.json'), 'utf8'), '{"sentinel":"do-not-read"}\\n', '锁文件不能被读取/改写')
    assert.equal(readFileSync(join(root, '.skill-lock.json'), 'utf8'), '{"sentinel":"do-not-read"}\\n', '隐藏锁文件不能被读取/改写')
    assert.deepEqual(backupDirs(root), [], '有祖先 lock 时不得创建 backup')
    return { code, root }
  })

  await caseRun('JSONL 预览：ok:true、action=preview、源不变', async () => {
    const fixture = fixtureCopy('jsonl')
    const before = snapshot(fixture.target)
    const result = cleanupJsonl([{
      id: 'skills-cleanup-preview',
      command: 'skills cleanup',
      args: { path: fixture.target },
    }], { home })
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.rows.length, 1)
    const row = result.rows[0]
    assert.equal(row.id, 'skills-cleanup-preview')
    assert.equal(row.ok, true)
    assert.equal(row.result.action, 'preview')
    assert.equal(row.result.version, '1.0.0')
    assert.equal(Object.hasOwn(row.result, 'backupPath'), false, 'JSONL preview 不应返回 backupPath')
    assert.equal(resolve(row.result.path), resolve(fixture.target))
    assertUnchanged(fixture.target, before, 'JSONL 预览不能修改源文件')
    assert.deepEqual(backupDirs(fixture.parent), [], 'JSONL 预览不能创建 backup')
    return { result: row.result }
  })

  if (results.some((result) => result.name.startsWith('默认预览') && result.status !== 'passed')) log('维护脚本的预览用例未通过；请先 npm run compile')
} finally {
  if (KEEP) log('保留临时沙盒：' + workroot)
  else rmSync(workroot, { recursive: true, force: true })
}

const failed = results.filter((result) => result.status === 'failed')
const summary = {
  schemaVersion: 1,
  type: 'skill-cleanup-e2e-summary',
  scope: 'maintainer-skill-cleanup',
  at: new Date().toISOString(),
  installedPrefix: installed.ok ? installed.prefix : null,
  script: CLEANUP_SCRIPT,
  workdir: workroot,
  scriptAvailable: results.find((result) => result.name.startsWith('默认预览'))?.status === 'passed',
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  cases: results,
  evidenceBoundary: '维护脚本真实调用 + 静态历史纯文档 fixture；不连接 B 站、不读取真实凭证、不伪造 B 站业务成功。',
}
process.stdout.write(JSON.stringify(summary) + '\n')
process.exitCode = failed.length ? 1 : 0
