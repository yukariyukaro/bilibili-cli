import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { resolve, join, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertClosure } from './closure.mjs'

const source = fileURLToPath(new URL('..', import.meta.url))
const repository = resolve(source, '..', '..')
const skillRoot = process.env.BILIBILI_SKILL_ROOT ? resolve(process.env.BILIBILI_SKILL_ROOT) : join(repository, 'skills', 'bilibili-cli')
const target = resolve(process.argv[2] || join(source, '..', '..', 'release', 'bilibili-cli'))
const rel = relative(source, target)
if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new Error('发布目录不能位于源码内部')
if (existsSync(target) && readdirSync(target).length) throw new Error('发布目标必须为空；请使用新的输出目录以避免残留副本')
const result = spawnSync(process.execPath, [join(source, 'scripts', 'compile.mjs')], { stdio: 'inherit', cwd: source })
if (result.error) throw result.error
if (result.status !== 0) throw new Error('TypeScript 编译失败，未生成发布目录')
assertClosure(source, { skillRoot })
mkdirSync(target, { recursive: true })
for (const name of ['dist', 'cli', 'LICENSE', 'CHANGELOG.md', 'README.md']) cpSync(join(source, name), join(target, name), { recursive: true })
for (const name of ['SKILL.md', 'references']) cpSync(join(skillRoot, name), join(target, name), { recursive: true })
const pkg = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
delete pkg.scripts
delete pkg.devDependencies
writeFileSync(join(target, 'package.json'), JSON.stringify(pkg, null, 2) + '\n')
const lock = JSON.parse(readFileSync(join(source, 'package-lock.json'), 'utf8'))
lock.packages[''] = { ...pkg }
for (const [path, entry] of Object.entries(lock.packages)) if (path && entry.dev === true) delete lock.packages[path]
writeFileSync(join(target, 'package-lock.json'), JSON.stringify(lock, null, 2) + '\n')
assertClosure(target)
process.stdout.write('生成编译后的 CLI、bridge 与纯文档技能：' + target + '\n')
