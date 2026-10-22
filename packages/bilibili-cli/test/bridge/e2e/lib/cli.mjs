import { join } from 'node:path'
import {
  AGENT_HOME,
  IS_WINDOWS,
  PATH_DELIMITER,
  WORKDIR,
  readonlyOrSkip,
  resolveInstalledPrefix,
} from './env.mjs'
import {
  auditStat,
  authStatus,
  bilibiliOk,
  bridgeStatus,
  bridgeStop,
  configGet,
  dmRead,
  dmStatus,
  doctor,
  installedVersion,
  runBilibili,
  runBilibiliRaw,
  runJsonl,
  schema,
  skillsList,
} from '../../lib/cli.mjs'

export {
  auditStat,
  authStatus,
  bilibiliOk,
  bridgeStatus,
  bridgeStop,
  configGet,
  dmRead,
  dmStatus,
  doctor,
  installedVersion,
  runBilibili,
  runBilibiliRaw,
  runJsonl,
  schema,
  skillsList,
}

/** 登录态预检：只返回 logged_in/credentialPresent/message，不读取或打印凭证正文。 */
export async function loginStatus(home = AGENT_HOME, options = {}) {
  try {
    return await authStatus(home, options)
  } catch (error) {
    return { logged_in: false, credentialPresent: null, message: String(error?.message || error) }
  }
}

/** 真实只读用例的统一门禁：配置不完整是错误，登录态不可用是显式 skip。 */
export async function liveOrSkip(t, home = AGENT_HOME) {
  const config = readonlyOrSkip(t)
  if (!config) return null
  const login = await loginStatus(home)
  if (login.logged_in !== true) {
    t.skip('登录态不可用：' + (login.message || '未登录或凭证已过期') + '；真实只读用例跳过，离线用例不受影响')
    return null
  }
  return { ...config, login }
}

export { IS_WINDOWS, PATH_DELIMITER, WORKDIR, resolveInstalledPrefix, join }
