/**
 * Skill 文档元数据：从包内 SKILL.md 的 frontmatter 读取版本与所需 CLI 版本，
 * 让 skills list / doctor 能回答“文档和 CLI 是否同源”。只解析本文件实际使用的
 * 三个标量，不引入 YAML 依赖，也不信任 frontmatter 之外的任何内容。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface SkillMeta {
  name: string
  version: string
  requiresCli: string
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

function topLevel(front: string, key: string): string | null {
  const match = new RegExp('^' + key + ':\\s*(.+?)\\s*$', 'm').exec(front)
  return match ? match[1].replace(/^["']|["']$/g, '').trim() : null
}

function nested(front: string, key: string): string | null {
  const match = new RegExp('^\\s{2}' + key + ':\\s*(.+?)\\s*$', 'm').exec(front)
  return match ? match[1].replace(/^["']|["']$/g, '').trim() : null
}

/** 读取 Skill 文档元数据；缺失或格式不完整时返回 null，由调用方如实报告，不伪造版本。 */
export function readSkillMeta(dir: string): SkillMeta | null {
  try {
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    const front = FRONTMATTER.exec(text)?.[1]
    if (!front) return null
    const version = nested(front, 'version')
    const requiresCli = nested(front, 'requiresCli')
    if (!version || !requiresCli) return null
    return { name: topLevel(front, 'name') ?? 'bilibili-cli', version, requiresCli }
  } catch {
    return null
  }
}

/** 文档声明的 CLI 主次版本，例如 2.0.0 -> '2.0'。 */
export function cliSeries(version: string): string {
  const [major, minor] = version.split('.')
  return major && minor ? major + '.' + minor : version
}

/** 文档是否覆盖当前 CLI 的主次版本；patch 差异不算不一致。 */
export function skillMatchesCli(meta: SkillMeta | null, cliVersion: string): boolean {
  return meta !== null && meta.requiresCli === cliSeries(cliVersion)
}
