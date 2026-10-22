import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 账号目录；不创建目录，status/stop 可安全调用。 */
export function accountStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.BILIBILI_SKILL_HOME
  if (custom && custom.trim()) return resolve(custom)
  if (process.platform === 'win32') {
    const appData = env.APPDATA
    return join(appData && appData.trim() ? appData : join(homedir(), 'AppData', 'Roaming'), 'bilibili-skill')
  }
  const xdg = env.XDG_CONFIG_HOME
  return join(xdg && xdg.trim() ? xdg : join(homedir(), '.config'), 'bilibili-skill')
}

export function defaultBridgeStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(accountStateDir(env), 'bridge', 'state.json')
}

export interface ResolveStatePathOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/** 优先级：显式 statePath > BILIBILI_BRIDGE_STATE > 账号目录 bridge/state.json。不创建目录。 */
export function resolveBridgeStatePath(statePath?: string, options: ResolveStatePathOptions = {}): string {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()
  const configured = statePath && statePath.trim() ? statePath : env.BILIBILI_BRIDGE_STATE
  if (configured && configured.trim()) return resolve(cwd, configured)
  return defaultBridgeStatePath(env)
}

export function lockPathFor(statePath: string): string {
  return statePath + '.lock'
}

export function stopRequestPathFor(statePath: string): string {
  return statePath + '.stop'
}
