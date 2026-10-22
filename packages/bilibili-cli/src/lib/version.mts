import { readFileSync } from 'node:fs'
import { isRecord } from './cli-types.mjs'

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

/** 包版本的最小类型守卫：只接受字符串形式的 semver。 */
export function isVersionString(value: unknown): value is string {
  return typeof value === 'string' && semver.test(value)
}

function readVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
  if (!isRecord(parsed)) throw new Error('package.json 必须是对象')
  const version = parsed.version
  if (!isVersionString(version)) throw new Error('package.json version 无效')
  return version
}

/** 包根 package.json 是唯一版本源；dist/lib/version.mjs 到包根是 ../../。 */
export const VERSION: string = readVersion()
