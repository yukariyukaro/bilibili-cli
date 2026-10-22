import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CliError, commands, validate } from './contract.mjs'
import { auditFile, configFile, credentialFile, readJson, stateDir, writeJson } from './portable.mjs'
import { createRuntime } from './runtime.mjs'
import type { Runtime } from './runtime.mjs'
import { VERSION } from './version.mjs'
import { isRecord } from './cli-types.mjs'
import type { Application, BridgeControlName, ValidatedArgs } from './cli-types.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const defaults = { writesEnabled: false, mentionName: '', dmRecipientUid: '' }

interface ApplicationContext {
  dir: string
  cfg: Record<string, unknown>
  runtime: Runtime
}

interface ApplicationOverrides {
  runtime?: Runtime
  audit?: (entry: Record<string, unknown>) => void
}

function readString(args: ValidatedArgs, key: string): string {
  const value = args[key]
  if (typeof value !== 'string') throw new CliError('INTERNAL', `内部参数缺失：${key}`, 1)
  return value
}

function bridgeControlArgs(args: ValidatedArgs): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const statePath = args.statePath
  if (typeof statePath === 'string') result.statePath = statePath
  return result
}

export function createApplication(overrides: ApplicationOverrides = {}): Application {
  let context: ApplicationContext | undefined
  const getContext = (): ApplicationContext => {
    if (!context) {
      const dir = stateDir()
      const stored = readJson(configFile(dir))
      const cfg: Record<string, unknown> = {}
      for (const [key, fallback] of Object.entries(defaults)) cfg[key] = stored[key] ?? fallback
      context = { dir, cfg, runtime: overrides.runtime ?? createRuntime(dir) }
    }
    return context
  }
  const audit = overrides.audit ?? ((entry: Record<string, unknown>) => appendFileSync(auditFile(getContext().dir), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }))
  async function execute(name: string, input: unknown = {}, cli = false): Promise<unknown> {
    const definition = commands.find((item) => item.name === name)
    if (!definition) throw new CliError('USAGE', `未知命令：${name}`, 2)
    const args = validate(definition, input, cli)
    if (definition.stream === true) throw new CliError('STREAM_ONLY', 'bridge run 是长期事件流，只能直接执行，不能通过 application 或 JSONL 调用', 2)
    if (name === 'schema') return { schemaVersion: 1, version: VERSION, commands, jsonl: { command: '完整分组命令，空格分隔', args: '与 CLI 共用字段', maxLineBytes: 65536 } }
    if (name === 'skills list') return [{ name: 'bilibili-cli', version: VERSION }]
    if (name === 'skills read') return { name: readString(args, 'name'), content: readFileSync(join(root, 'SKILL.md'), 'utf8') }
    if (name === 'skills cleanup') {
      const { cleanupLegacySkill } = await import('./skill-cleanup.mjs')
      return cleanupLegacySkill({ path: readString(args, 'path'), confirm: args.confirm === true })
    }
    if (name === 'bridge status' || name === 'bridge stop') {
      const control: BridgeControlName = name === 'bridge status' ? 'status' : 'stop'
      const { executeBridgeControl } = await import('./bridge/control.mjs')
      return executeBridgeControl(control, bridgeControlArgs(args))
    }
    const { dir, cfg, runtime } = getContext()
    if (name === 'config get') return { ...cfg }
    if (name === 'config set') {
      const key = readString(args, 'key')
      const raw = readString(args, 'value')
      let value: unknown = raw
      if (key === 'writesEnabled') {
        if (!['true', 'false'].includes(raw)) throw new CliError('VALIDATION', 'writesEnabled 仅接受 true 或 false', 2)
        value = raw === 'true'
      }
      if (key === 'dmRecipientUid' && !/^[1-9]\d*$/.test(raw)) throw new CliError('VALIDATION', 'dmRecipientUid 仅接受正整数', 2)
      cfg[key] = value
      writeJson(configFile(dir), cfg)
      return { ...cfg }
    }
    if (name === 'doctor') {
      const info = await runtime.setup()
      return {
        node: process.version,
        stateDir: dir,
        dependenciesInstalled: info.installed === true,
        library: info.library,
        libraryVersion: info.version,
        librarySpec: info.spec,
        credentialPresent: existsSync(credentialFile(dir)),
        writesEnabled: cfg.writesEnabled === true,
      }
    }
    if (name.startsWith('auth login ')) {
      const key = args.key
      return runtime.login(name.endsWith('start') ? 'start' : 'poll', typeof key === 'string' ? key : undefined)
    }
    const params: Record<string, unknown> = { ...args }
    delete params.confirm
    delete params.dryRun
    if (name === 'video hot') {
      params.pn = params.page
      params.ps = params.num
      delete params.page
      delete params.num
    }
    if (name === 'comment create' && params.rpid === undefined) params.rpid = 0
    if (name === 'dm send' && cfg.dmRecipientUid !== '' && String(cfg.dmRecipientUid) !== String(params.uid)) throw new CliError('VALIDATION', '收件人与已配置的 dmRecipientUid 不一致', 2)
    const call = async (): Promise<unknown> => {
      const tool = definition.tool
      if (tool === undefined) throw new CliError('USAGE', `未知后端命令：${name}`, 2)
      let result: unknown
      try { result = await runtime.call(tool, params) }
      catch (error: unknown) {
        if (error instanceof CliError) throw error
        throw new CliError('BACKEND', definition.write ? '后端调用失败或状态未知；不要自动重试写操作' : '后端调用失败；请检查登录状态或稍后重试')
      }
      const record = isRecord(result) ? result : {}
      if (record.error || record.ok === false || record.success === false) throw new CliError('BUSINESS', definition.write ? '后端返回业务失败；不要自动重试写操作' : '后端返回业务失败')
      if (definition.write && record.success !== true) throw new CliError('UNKNOWN_STATE', '接口未明确返回成功；请人工核对，不要自动重试')
      return result
    }
    if (!definition.write) return call()
    if (args.dryRun === true) return { dryRun: true, target: params, requires: ['writesEnabled=true', '本次用户确认', '--confirm'] }
    if (args.confirm !== true || cfg.writesEnabled !== true) throw new CliError('WRITE_DISABLED', '需要开启 writesEnabled 且获得本次确认后使用 --confirm', 3)
    const operationId = randomUUID()
    const detail: Record<string, unknown> = { operationId, command: name, bvid: params.bvid, rpid: params.rpid, uid: params.uid }
    const text = params.text
    if (typeof text === 'string' && text.length > 0) detail.textSha256 = createHash('sha256').update(text).digest('hex')
    const record = (status: string): void => {
      try { audit({ at: new Date().toISOString(), ...detail, status }) }
      catch { throw new CliError('AUDIT', '审计写入失败；操作可能尚未执行或状态未知，请人工核对，不要自动重试', 4) }
    }
    record('attempt')
    let result: unknown
    try { result = await call() }
    catch (error: unknown) { record('failed_or_unknown'); throw error }
    record('accepted')
    const base = isRecord(result) ? result : {}
    return { ...base, audited: true, visibilityVerified: false, operationId }
  }
  return { execute, close: () => { context?.runtime.close() } }
}
