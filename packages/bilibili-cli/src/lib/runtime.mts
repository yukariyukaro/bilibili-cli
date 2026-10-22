/**
 * src/lib/runtime.mts —— 运行时装配层：服务调用、依赖探测与扫码登录。
 *
 * src 不直接执行。编译后位于 dist/lib/runtime.mjs，因此包根固定是 ../../package.json；
 * 库版本从实际安装位置解析，解析失败返回 null，绝不伪造版本号。
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { CliError } from './contract.mjs'
import { loginPoll, loginStart, renderQrPng, saveCredential } from './login.mjs'
import { createService } from './service.mjs'
import type { Runtime, SetupInfo } from './service-types.mjs'
import { toRecord } from './service-types.mjs'

export type { Runtime, SetupInfo } from './service-types.mjs'

const pkg: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
const library = '@yukariyukaro/bilibili-api-ts'
const require = createRequire(import.meta.url)

/** 已安装包的真实版本；解析失败时返回 null，不伪造版本号。 */
function installedVersion(): string | null {
  try {
    const entry = require.resolve(library)
    const parsed: unknown = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8'))
    const version = toRecord(parsed).version
    return typeof version === 'string' ? version : null
  } catch {
    return null
  }
}

function dependencySpec(): string {
  const spec = toRecord(toRecord(pkg).dependencies)[library]
  return typeof spec === 'string' ? spec : ''
}

export function createRuntime(dir: string): Runtime {
  const service = createService(dir)
  return {
    close(): void {},
    async call(name: string, params: Record<string, unknown>): Promise<unknown> {
      return service.call(name, params)
    },
    async setup(): Promise<SetupInfo> {
      const version = installedVersion()
      return { installed: version !== null, library, spec: dependencySpec(), version }
    },
    async login(action, key): Promise<unknown> {
      if (action === 'start') {
        const result = await loginStart()
        return { ...result, state: 'qrcode_ready', png: await renderQrPng(dir, result.url) }
      }
      if (typeof key !== 'string') throw new CliError('VALIDATION', '缺少二维码 key', 2)
      const result = await loginPoll(key)
      if (result.state === 'ok') {
        saveCredential(dir, result.credential)
        return { state: 'ok' }
      }
      if (result.state === 'unknown' || result.state === 'expired') throw new CliError('AUTH', '二维码已过期或登录状态未知，请重新登录', 3)
      return { state: result.state }
    },
  }
}
