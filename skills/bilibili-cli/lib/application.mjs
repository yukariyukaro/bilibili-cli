import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { commands, validate, CliError } from './contract.mjs'
import { auditFile, configFile, credentialFile, readJson, stateDir, writeJson } from './portable.mjs'
import { createRuntime } from './runtime.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const defaults = { writesEnabled: false, mentionName: '', dmRecipientUid: '' }

export function createApplication(overrides = {}) {
  let context
  const getContext = () => {
    if (!context) {
      const dir = stateDir()
      const stored = readJson(configFile(dir))
      const cfg = Object.fromEntries(Object.keys(defaults).map((key) => [key, stored[key] ?? defaults[key]]))
      context = { dir, cfg, runtime: overrides.runtime || createRuntime(dir) }
    }
    return context
  }
  const audit = overrides.audit || ((entry) => appendFileSync(auditFile(getContext().dir), JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 }))
  async function execute(name, input = {}, cli = false) {
    const definition = commands.find((item) => item.name === name)
    if (!definition) throw new CliError('USAGE', `未知命令：${name}`, 2)
    const args = validate(definition, input, cli)
    if (name === 'schema') return { schemaVersion: 1, version: '1.0.0', commands, jsonl: { command: '完整分组命令，空格分隔', args: '与 CLI 共用字段', maxLineBytes: 65536 } }
    if (name === 'skills list') return [{ name: 'bilibili-cli', version: '1.0.0' }]
    if (name === 'skills read') return { name: args.name, content: readFileSync(join(root, 'SKILL.md'), 'utf8') }
    const { dir, cfg, runtime } = getContext()
    if (name === 'config get') return { ...cfg }
    if (name === 'config set') {
      let value = args.value
      if (args.key === 'writesEnabled') {
        if (!['true', 'false'].includes(value)) throw new CliError('VALIDATION', 'writesEnabled 仅接受 true 或 false', 2)
        value = value === 'true'
      }
      if (args.key === 'dmRecipientUid' && !/^[1-9]\d*$/.test(value)) throw new CliError('VALIDATION', 'dmRecipientUid 仅接受正整数', 2)
      cfg[args.key] = value
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
    if (name.startsWith('auth login ')) return runtime.login(name.endsWith('start') ? 'start' : 'poll', args.key)
    const params = { ...args }
    delete params.confirm
    delete params.dryRun
    if (name === 'video hot') {
      params.pn = params.page
      params.ps = params.num
      delete params.page
      delete params.num
    }
    if (name === 'comment create') params.rpid ??= 0
    if (name === 'dm send' && cfg.dmRecipientUid !== '' && String(cfg.dmRecipientUid) !== String(params.uid)) throw new CliError('VALIDATION', '收件人与已配置的 dmRecipientUid 不一致', 2)
    const call = async () => {
      let result
      try { result = await runtime.call(definition.tool, params) }
      catch (error) {
        if (error instanceof CliError) throw error
        throw new CliError('BACKEND', definition.write ? '后端调用失败或状态未知；不要自动重试写操作' : '后端调用失败；请检查登录状态或稍后重试')
      }
      if (result?.error || result?.ok === false || result?.success === false) throw new CliError('BUSINESS', definition.write ? '后端返回业务失败；不要自动重试写操作' : '后端返回业务失败')
      if (definition.write && result?.success !== true) throw new CliError('UNKNOWN_STATE', '接口未明确返回成功；请人工核对，不要自动重试')
      return result
    }
    if (!definition.write) return call()
    if (args.dryRun) return { dryRun: true, target: params, requires: ['writesEnabled=true', '本次用户确认', '--confirm'] }
    if (args.confirm !== true || cfg.writesEnabled !== true) throw new CliError('WRITE_DISABLED', '需要开启 writesEnabled 且获得本次确认后使用 --confirm', 3)
    const detail = { operationId: randomUUID(), command: name, bvid: params.bvid, rpid: params.rpid, uid: params.uid, ...(params.text ? { textSha256: createHash('sha256').update(params.text).digest('hex') } : {}) }
    const record = (status) => {
      try { audit({ at: new Date().toISOString(), ...detail, status }) }
      catch { throw new CliError('AUDIT', '审计写入失败；操作可能尚未执行或状态未知，请人工核对，不要自动重试', 4) }
    }
    record('attempt')
    let result
    try { result = await call() }
    catch (error) { record('failed_or_unknown'); throw error }
    record('accepted')
    return { ...result, audited: true, visibilityVerified: false, operationId: detail.operationId }
  }
  return { execute, close: () => context?.runtime.close() }
}
