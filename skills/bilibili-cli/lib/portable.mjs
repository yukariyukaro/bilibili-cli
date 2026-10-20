import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function stateDir() {
  const custom = process.env.BILIBILI_SKILL_HOME
  if (custom) return mkdir(custom)
  if (process.platform === 'win32') return mkdir(join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'bilibili-skill'))
  return mkdir(join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'bilibili-skill'))
}

function mkdir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file, fallback = {}) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

export function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function credentialFile(dir) {
  return join(dir, 'bili_credential.json')
}

export function configFile(dir) {
  return join(dir, 'config.json')
}

export function auditFile(dir) {
  return join(dir, 'audit.jsonl')
}
