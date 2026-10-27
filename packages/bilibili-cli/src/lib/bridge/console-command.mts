/**
 * bridge console get/set —— 让 Agent 不依赖浏览器也能读取和修改本机控制台配置。
 *
 * 只读写控制台配置文件（0600 原子写 + revision 乐观并发），不启动、不重启 bridge；
 * 配置在下次 bridge 启动时生效。这里不读凭证，也不接触 cc-connect token。
 */
import { dirname, join, resolve } from 'node:path'
import { CliError } from '../contract.mjs'
import {
  configRevision,
  nextScheduledRun,
  readConsoleConfig,
  scheduleSlot,
  writeConsoleConfig,
} from './web-config.mjs'
import type { ConsoleConfig } from './web-config.mjs'

type Args = Record<string, unknown>

function invalid(message: string): never {
  throw new CliError('VALIDATION', message, 2)
}

/** 与 bridge run/web 一致：显式 --config-path 优先，否则落在 bridge 状态文件同目录。 */
export function consoleConfigPath(args: Args, stateDir: string): string {
  const explicit = args.configPath
  if (typeof explicit === 'string' && explicit.trim()) return resolve(explicit)
  const statePath = typeof args.statePath === 'string' && args.statePath.trim() ? resolve(args.statePath) : join(stateDir, 'bridge', 'state.json')
  return join(dirname(statePath), 'console.json')
}

function fail(error: unknown): never {
  if (error instanceof CliError) throw error
  const code = (error as { code?: unknown }).code
  const message = error instanceof Error ? error.message : String(error)
  if (code === 'CONFLICT') throw new CliError('CONFLICT', '配置已被其他页面或进程修改；重新读取 revision 后再写入', 2)
  throw new CliError('VALIDATION', '控制台配置不可用：' + message, 2)
}

function view(configPath: string, config: ConsoleConfig, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    configPath,
    revision: configRevision(config),
    checkedAt: new Date().toISOString(),
    // 定时任务要生效，schedule 与 scroll 必须同时开启。
    active: config.schedule.enabled && config.scroll.enabled,
    nextRun: nextScheduledRun(config),
    slot: scheduleSlot(config),
    restartRequired: true,
    config,
    ...extra,
  }
}

function weekdaysOf(value: string): number[] {
  const parts = value.split(',').map((item) => Number.parseInt(item.trim(), 10))
  if (parts.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) invalid('scheduleWeekdays 必须是 1–7 的数字，逗号分隔')
  return [...new Set(parts)].sort((a, b) => a - b)
}

export async function consoleGet(args: Args, stateDir: string): Promise<unknown> {
  const configPath = consoleConfigPath(args, stateDir)
  try {
    const config = await readConsoleConfig(configPath)
    return view(configPath, config)
  } catch (error) {
    fail(error)
  }
}

export async function consoleSet(args: Args, stateDir: string): Promise<unknown> {
  const configPath = consoleConfigPath(args, stateDir)
  try {
    const current = await readConsoleConfig(configPath)
    const previousRevision = configRevision(current)
    const expect = args.expectRevision
    if (typeof expect === 'string' && expect.trim() && expect !== previousRevision) {
      throw new CliError('CONFLICT', 'revision 不一致：配置已被其他页面修改，重新读取后再写入', 2)
    }
    const next: ConsoleConfig = structuredClone(current)
    let touched = 0
    const flag = (key: string): boolean | undefined => {
      const value = args[key]
      if (value === undefined) return undefined
      touched++
      return value === true
    }
    const scheduleEnabled = flag('scheduleEnabled')
    if (scheduleEnabled !== undefined) next.schedule.enabled = scheduleEnabled
    const scrollEnabled = flag('scrollEnabled')
    if (scrollEnabled !== undefined) next.scroll.enabled = scrollEnabled
    const time = args.scheduleTime
    if (time !== undefined) {
      touched++
      if (typeof time !== 'string' || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) invalid('scheduleTime 必须是 24 小时制 HH:MM')
      next.schedule.time = time
    }
    const zone = args.scheduleTimeZone
    if (zone !== undefined) {
      touched++
      if (typeof zone !== 'string' || !zone.trim()) invalid('scheduleTimeZone 不能为空')
      try {
        new Intl.DateTimeFormat('en-CA', { timeZone: zone })
      } catch {
        invalid('scheduleTimeZone 不是有效的 IANA 时区：' + zone)
      }
      next.schedule.timeZone = zone.trim()
    }
    const weekdays = args.scheduleWeekdays
    if (weekdays !== undefined) {
      touched++
      if (typeof weekdays !== 'string') invalid('scheduleWeekdays 必须是逗号分隔字符串')
      next.schedule.weekdays = weekdaysOf(weekdays)
    }
    const prompt = args.agentPrompt
    if (prompt !== undefined) {
      touched++
      if (typeof prompt !== 'string' || !prompt.trim()) invalid('agentPrompt 不能为空')
      next.agent.prompt = prompt
    }
    const sessionKey = args.agentSessionKey
    if (sessionKey !== undefined) {
      touched++
      if (typeof sessionKey !== 'string' || !sessionKey.trim()) invalid('agentSessionKey 不能为空')
      next.agent.sessionKey = sessionKey.trim()
    }
    if (touched === 0) invalid('至少提供一个要修改的字段（scheduleEnabled/scheduleTime/scheduleTimeZone/scheduleWeekdays/scrollEnabled/agentPrompt/agentSessionKey）')
    const saved = await writeConsoleConfig(configPath, next, previousRevision)
    return view(configPath, saved, { previousRevision })
  } catch (error) {
    fail(error)
  }
}
