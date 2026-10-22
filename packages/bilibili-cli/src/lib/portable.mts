/**
 * src/lib/portable.mts —— 用户状态目录与 JSON 文件的最小读写。
 *
 * 只做路径与 JSON 边界处理，不校验业务字段；损坏或非对象 JSON 一律回落 fallback，
 * 由调用方决定“未登录/使用默认配置”，不把坏数据包装成成功。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isRecord } from './service-types.mjs'

export function stateDir(): string {
  const custom = process.env.BILIBILI_SKILL_HOME
  if (custom) return mkdir(custom)
  if (process.platform === 'win32') return mkdir(join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bilibili-skill'))
  return mkdir(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bilibili-skill'))
}

function mkdir(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return isRecord(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function credentialFile(dir: string): string {
  return join(dir, 'bili_credential.json')
}

export function configFile(dir: string): string {
  return join(dir, 'config.json')
}

export function auditFile(dir: string): string {
  return join(dir, 'audit.jsonl')
}
