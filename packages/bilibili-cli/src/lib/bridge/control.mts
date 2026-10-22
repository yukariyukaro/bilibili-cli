import { BridgeControlError, inspectBridgeStatus, requestBridgeStop } from './control-plane.mjs'
import { isPlainObject } from './guards.mjs'
import { resolveBridgeStatePath } from './state-path.mjs'

export { BridgeControlError } from './control-plane.mjs'

function readStatePath(input: Record<string, unknown>): string {
  const raw = input.statePath
  if (raw === undefined) return resolveBridgeStatePath()
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BridgeControlError('CONTROL_ARGS', 'statePath 必须是非空字符串')
  }
  return resolveBridgeStatePath(raw)
}

interface ControlRunArgs {
  statePath: string
  ownerUids?: string
  url?: string
  pollMs?: number
}

function readRunArgs(input: Record<string, unknown>, statePath: string): ControlRunArgs {
  const result: ControlRunArgs = { statePath }
  const ownerUids = input.ownerUids
  if (ownerUids !== undefined) {
    if (typeof ownerUids !== 'string') throw new BridgeControlError('CONTROL_ARGS', 'ownerUids 必须是字符串')
    result.ownerUids = ownerUids
  }
  const url = input.url
  if (url !== undefined) {
    if (typeof url !== 'string') throw new BridgeControlError('CONTROL_ARGS', 'url 必须是字符串')
    result.url = url
  }
  const pollMs = input.pollMs
  if (pollMs !== undefined) {
    if (typeof pollMs !== 'number') throw new BridgeControlError('CONTROL_ARGS', 'pollMs 必须是数字')
    result.pollMs = pollMs
  }
  return result
}

/**
 * CLI 有限控制入口。
 * - status/stop 只做有限请求，不启动长期进程；
 * - run 兼容委托 runBridge（CLI 的 bridge run 可直接 import runBridge，JSONL 拒绝由 CLI 处理）。
 */
export async function executeBridgeControl(
  name: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const input = isPlainObject(args) ? args : {}
  const statePath = readStatePath(input)
  if (name === 'status') return inspectBridgeStatus(statePath)
  if (name === 'stop') return requestBridgeStop(statePath)
  if (name === 'run') {
    const { runBridge } = await import('./main.mjs')
    return runBridge(readRunArgs(input, statePath))
  }
  throw new BridgeControlError('CONTROL_UNKNOWN', '未知 bridge 控制命令：' + name)
}