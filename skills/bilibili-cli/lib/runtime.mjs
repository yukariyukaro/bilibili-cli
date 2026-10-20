import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { createService } from './service.mjs'
import { loginPoll, loginStart, renderQrPng, saveCredential } from './login.mjs'
import { CliError } from './contract.mjs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const library = '@yukariyukaro/bilibili-api-ts'
const require = createRequire(import.meta.url)

/** 已安装包的真实版本；解析失败时返回 null，不伪造版本号。 */
function installedVersion() {
  try {
    const entry = require.resolve(library)
    return JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

export function createRuntime(dir) {
  const service = createService(dir)
  return {
    close() {},
    async call(name, params) {
      return service.call(name, params)
    },
    async setup() {
      const version = installedVersion()
      return { installed: version !== null, library, spec: pkg.dependencies?.[library] ?? '', version }
    },
    async login(action, key) {
      if (action === 'start') {
        const result = await loginStart()
        return { ...result, state: 'qrcode_ready', png: await renderQrPng(dir, result.url) }
      }
      const result = await loginPoll(key)
      if (result.state === 'ok') {
        saveCredential(dir, result.credential)
        return { state: 'ok' }
      }
      if (['unknown', 'expired'].includes(result.state)) throw new CliError('AUTH', '二维码已过期或登录状态未知，请重新登录', 3)
      return { state: result.state }
    },
  }
}
