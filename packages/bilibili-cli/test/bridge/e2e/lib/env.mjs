import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CLI_ROOT,
  IS_WINDOWS,
  PATH_DELIMITER,
  REPO_ROOT,
  assertOutsideRepo,
  freshDir as sharedFreshDir,
  isInsideRepo,
  resolveInstalledPrefix as sharedResolveInstalledPrefix,
  resolveWorkdir,
  statOrNull,
  uniqueToken as sharedUniqueToken,
} from '../../lib/env.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))

export { CLI_ROOT, IS_WINDOWS, PATH_DELIMITER, REPO_ROOT, isInsideRepo, statOrNull }
export const E2E_DIR = resolve(here, '..')
export const BRIDGE_TEST_DIR = resolve(E2E_DIR, '..')

const env = process.env

/** 真实只读必须显式开启；不复用曾经可能代表“真实 E2E（含写）”的旧开关。 */
export const READONLY = env.BILIBILI_E2E_READONLY === '1'
/** 旧开关只记录，不让它开启任何真实动作。 */
export const LEGACY_E2E = env.BILIBILI_E2E === '1'
/** 真实写入口与只读入口分离；只读套件看到它会失败并拒绝继续。 */
export const WRITE_REQUESTED = env.BILIBILI_E2E_WRITE === '1'

export const INSTALLED_PREFIX = env.BILIBILI_E2E_INSTALLED_PREFIX || ''
export const AGENT_HOME = env.BILIBILI_E2E_AGENT_HOME || ''
export const OWNER_HOME = env.BILIBILI_E2E_OWNER_HOME || ''
export const OWNER_UID = env.BILIBILI_E2E_OWNER_UID || ''
export const AGENT_UID = env.BILIBILI_E2E_AGENT_UID || ''

/** 所有进程状态、日志和证据都放在仓库外的显式工作目录。 */
export const WORKDIR = resolveWorkdir(env)
export const ARTIFACTS = join(WORKDIR, 'artifacts')
mkdirSync(ARTIFACTS, { recursive: true })

export function freshDir(prefix = 'e2e-') {
  return sharedFreshDir(WORKDIR, prefix)
}

export function resolveInstalledPrefix() {
  return sharedResolveInstalledPrefix(env)
}

export function installedOrSkip(t) {
  if (!INSTALLED_PREFIX) {
    t.skip('缺少 BILIBILI_E2E_INSTALLED_PREFIX；请先构建、打包并临时安装 CLI，再在仓库外运行')
    return null
  }
  const installed = resolveInstalledPrefix()
  if (!installed.ok) throw new Error(installed.reason)
  return installed
}

function homeIssue(value, label, { required = false } = {}) {
  if (!value) return required ? '缺少 ' + label + '（只使用显式隔离目录，不读取默认凭证）' : null
  if (!isAbsolute(value)) return label + ' 必须是绝对路径：' + value
  if (isInsideRepo(value)) return label + ' 不能位于仓库内：' + value
  if (!existsSync(value)) return label + ' 不存在：' + value
  return null
}

function uidIssue(value, label, { required = false } = {}) {
  if (!value) return required ? '缺少 ' + label + '（真实只读必须显式指定目标 UID）' : null
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return label + ' 必须是安全正整数：' + value
  return null
}

export function readonlyConfigIssues() {
  const issues = []
  if (!READONLY) issues.push('BILIBILI_E2E_READONLY 未设为 1')
  if (!INSTALLED_PREFIX) issues.push('缺少 BILIBILI_E2E_INSTALLED_PREFIX')
  else {
    const installed = resolveInstalledPrefix()
    if (!installed.ok) issues.push(installed.reason)
  }
  for (const issue of [
    homeIssue(AGENT_HOME, 'BILIBILI_E2E_AGENT_HOME', { required: true }),
    homeIssue(OWNER_HOME, 'BILIBILI_E2E_OWNER_HOME'),
    uidIssue(OWNER_UID, 'BILIBILI_E2E_OWNER_UID', { required: true }),
    uidIssue(AGENT_UID, 'BILIBILI_E2E_AGENT_UID'),
  ]) {
    if (issue) issues.push(issue)
  }
  if (WRITE_REQUESTED) issues.push('BILIBILI_E2E_WRITE=1 不能与只读套件同时使用；真实写入口已分离')
  return issues
}

export function readonlyOrSkip(t) {
  if (!READONLY) {
    t.skip('真实只读未启用：设置 BILIBILI_E2E_READONLY=1、BILIBILI_E2E_INSTALLED_PREFIX、BILIBILI_E2E_AGENT_HOME、BILIBILI_E2E_OWNER_UID 后再运行')
    return null
  }
  // 显式开启只读后，配置不完整是调用方错误，不能降级成 skip 假绿。
  const issues = readonlyConfigIssues()
  if (issues.length) throw new Error('真实只读配置不完整：' + issues.join('；'))
  const installed = resolveInstalledPrefix()
  if (!installed.ok) throw new Error(installed.reason)
  return { installed, talkerUid: OWNER_UID }
}

export function manual(t, reason) {
  t.skip('MANUAL: ' + reason + '。本轮自动化不执行真实写、不复制凭证、不越过用户逐次确认。')
}

export function environmentSummary() {
  return {
    node: process.version,
    platform: process.platform,
    readOnly: READONLY,
    legacyE2EIgnored: LEGACY_E2E,
    writeRequested: WRITE_REQUESTED,
    installedPrefix: INSTALLED_PREFIX ? resolve(INSTALLED_PREFIX) : null,
    agentHomeConfigured: Boolean(AGENT_HOME),
    ownerHomeConfigured: Boolean(OWNER_HOME),
    talkerConfigured: Boolean(OWNER_UID),
    workdir: WORKDIR,
  }
}

export function uniqueToken(prefix = 'e2e') {
  return sharedUniqueToken(prefix)
}

export { assertOutsideRepo, existsSync, join, relative, resolve, sep, statSync, realpathSync, mkdirSync, fileURLToPath }
