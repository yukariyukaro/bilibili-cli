import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertClosure } from './closure.mjs'

const source = fileURLToPath(new URL('..', import.meta.url))
const target = resolve(process.argv[2] || join(source, '..', '..', 'release', 'bilibili-cli'))
assertClosure(source)
if (target.startsWith(source)) throw new Error('发布目录不能位于源码内部')
if (existsSync(target) && readdirSync(target).length) throw new Error('发布目标必须为空；请使用新的输出目录以避免残留副本')
mkdirSync(target, { recursive: true })
for (const name of ['cli', 'lib', 'package.json', 'package-lock.json', 'LICENSE', 'README.md']) cpSync(join(source, name), join(target, name), { recursive: true })
mkdirSync(join(target, 'skill'), { recursive: true })
for (const name of ['SKILL.md', 'references']) cpSync(join(source, name), join(target, 'skill', name), { recursive: true })
cpSync(join(source, 'SKILL.md'), join(target, 'SKILL.md'))
cpSync(join(source, 'references'), join(target, 'references'), { recursive: true })
process.stdout.write(`生成 CLI 和纯文档技能：${target}\n`)
