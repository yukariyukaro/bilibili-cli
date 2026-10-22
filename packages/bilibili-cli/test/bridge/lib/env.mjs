import { existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** packages/bilibili-cli/test/bridge/lib -> packages/bilibili-cli */
export const CLI_ROOT = resolve(HERE, '..', '..', '..')
/** -> 仓库根 */
export const REPO_ROOT = resolve(CLI_ROOT, '..', '..')
export const BRIDGE_TEST_ROOT = resolve(HERE, '..')
export const IS_WINDOWS = process.platform === 'win32'
export const PATH_DELIMITER = IS_WINDOWS ? ';' : ':'

const compared = (value) => {
  const resolved = resolve(value)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

function realOrResolve(value) {
  try { return realpathSync(value) } catch { return resolve(value) }
}

export function isInsideRepo(value) {
  const realRepo = realOrResolve(REPO_ROOT)
  const realValue = realOrResolve(value)
  const rel = relative(compared(realRepo), compared(realValue))
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

export function assertOutsideRepo(value, label) {
  if (isInsideRepo(value)) {
    throw new Error(label + ' 必须离开仓库（当前解析到仓库内：' + realOrResolve(value) + '）；不能把仓库源码当作安装产物验收')
  }
}

/**
 * 所有进程状态、日志和证据都放在仓库外的显式工作目录。
 * 显式目录只创建、不删除；临时目录由系统管理。
 */
export function resolveWorkdir(env = process.env) {
  const configured = env.BILIBILI_E2E_WORKDIR || env.BILIBILI_BRIDGE_REGRESSIONS_WORKDIR
  if (configured) {
    const dir = resolve(configured)
    assertOutsideRepo(dir, 'BILIBILI_E2E_WORKDIR')
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const dir = mkdtempSync(join(tmpdir(), 'bilibili-bridge-e2e-'))
  assertOutsideRepo(dir, '临时工作目录')
  return dir
}

/**
 * 只认统一安装前缀；不构建、不安装、不回落全局未知版本或仓库源码。
 * Windows: <prefix>\bilibili.cmd | <prefix>\bilibili.exe | <prefix>\node_modules\.bin\bilibili.cmd
 * POSIX:   <prefix>/bin/bilibili | <prefix>/node_modules/.bin/bilibili
 */
export function resolveInstalledPrefix(env = process.env) {
  const configured = env.BILIBILI_E2E_INSTALLED_PREFIX
  if (!configured) {
    return { ok: false, reason: '缺少 BILIBILI_E2E_INSTALLED_PREFIX（必须来自统一构建/打包/临时安装，不能用全局未知版本或仓库源码）' }
  }
  const prefix = resolve(configured)
  if (!existsSync(prefix)) return { ok: false, reason: '安装前缀不存在：' + prefix }
  if (isInsideRepo(prefix)) return { ok: false, reason: '安装前缀位于仓库内，不能作为安装产物验收：' + prefix }

  const candidates = IS_WINDOWS
    ? [join(prefix, 'bilibili.cmd'), join(prefix, 'bilibili.exe'), join(prefix, 'node_modules', '.bin', 'bilibili.cmd')]
    : [join(prefix, 'bin', 'bilibili'), join(prefix, 'node_modules', '.bin', 'bilibili')]
  const bin = candidates.find((candidate) => existsSync(candidate))
  if (!bin) return { ok: false, reason: '安装前缀中找不到 bilibili 入口；期望 ' + candidates.join(' 或 ') }

  // Windows 全局前缀在 <prefix>/node_modules；POSIX npm --prefix 在 <prefix>/lib/node_modules。
  // 只按真实 npm 布局查找，不通过符号链接绕过，避免把非安装布局当成通过。
  const packageCandidates = [
    join(prefix, 'node_modules', '@yukariyukaro', 'bilibili-cli'),
    join(prefix, 'lib', 'node_modules', '@yukariyukaro', 'bilibili-cli'),
  ]
  const packageDir = packageCandidates.find((candidate) => existsSync(candidate))
  if (!packageDir) {
    return { ok: false, reason: '安装前缀中找不到 scoped 包 @yukariyukaro/bilibili-cli；期望 ' + packageCandidates.join(' 或 ') }
  }
  if (isInsideRepo(packageDir)) {
    return { ok: false, reason: '安装前缀里的 @yukariyukaro/bilibili-cli 指向仓库源码（junction/symlink）：' + packageDir }
  }
  if (isInsideRepo(bin)) return { ok: false, reason: 'CLI 入口实际指向仓库源码：' + bin }

  return { ok: true, prefix, bin, binDir: dirname(bin), packageDir: packageDir || '', realPrefix: realOrResolve(prefix) }
}

export function installedPackageDir(installed) {
  if (!installed?.ok) throw new Error(installed?.reason || '需要已解析的安装前缀')
  return installed.packageDir
}

/**
 * 安装产物中的 bridge 模块目录。协议/故障 driver 只能 import 这里，
 * 不能 import 仓库 src；缺失时直接失败，不回落到源码。
 */
export function installedBridgeDir(installed) {
  const dir = join(installedPackageDir(installed), 'dist', 'lib', 'bridge')
  if (!existsSync(dir)) {
    throw new Error('安装产物缺少 dist/lib/bridge：' + dir + '；协议测试必须 import 已安装模块，不能回落到仓库 src')
  }
  if (isInsideRepo(dir)) throw new Error('安装产物 bridge 目录实际指向仓库源码：' + dir)
  return dir
}

export function installedBridgeModule(installed, name) {
  const file = join(installedBridgeDir(installed), name)
  if (!existsSync(file)) throw new Error('安装产物缺少 bridge 模块：' + file)
  return file
}

export function stripRiskyEnv(baseEnv = process.env) {
  const env = { ...baseEnv }
  for (const key of [
    'BILIBILI_E2E_WRITE',
    'BILIBILI_E2E',
    'BILIBILI_E2E_READONLY',
    'NODE_OPTIONS',
    'NODE_PATH',
  ]) delete env[key]
  return env
}

/** 只用安装前缀的 PATH + 隔离状态目录；强制真实 CLI 命令名，避免外层环境注入另一实现。 */
export function buildChildEnv({ baseEnv = process.env, installed, home = '', extra = {} } = {}) {
  if (!installed?.ok) throw new Error('buildChildEnv 需要已解析的安装前缀')
  const env = stripRiskyEnv(baseEnv)
  if (home) env.BILIBILI_SKILL_HOME = home
  const currentPath = env.PATH || env.Path || process.env.PATH || process.env.Path || ''
  const merged = installed.binDir + PATH_DELIMITER + currentPath
  env.PATH = merged
  if (IS_WINDOWS) env.Path = merged
  return { ...env, ...extra }
}

export function assertNoCredential(home) {
  if (!home) return
  for (const name of ['bili_credential.json', 'credential.json']) {
    const file = join(home, name)
    if (existsSync(file)) throw new Error('隔离状态目录出现凭证文件，拒绝继续（不读取/不打印）：' + file)
  }
}

export function freshDir(workdir, prefix = 'e2e-') {
  mkdirSync(workdir, { recursive: true })
  return mkdtempSync(join(workdir, prefix))
}

export function freshCaseDir(workdir, name) {
  mkdirSync(workdir, { recursive: true })
  const dir = mkdtempSync(join(workdir, name + '-'))
  const home = join(dir, 'home')
  mkdirSync(home, { recursive: true })
  assertNoCredential(home)
  return { dir, home, statePath: join(dir, 'state.json') }
}

export function statOrNull(path) {
  try { return statSync(path) } catch { return null }
}

export function uniqueToken(prefix = 'e2e') {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

export function samePath(left, right) {
  return compared(left) === compared(right)
}

export const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

export async function waitFor(check, { timeout = 15000, interval = 150, description = '条件' } = {}) {
  const deadline = Date.now() + timeout
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(interval)
  }
  throw new Error('等待' + description + '超时（' + timeout + 'ms）' + (lastError ? '；最后一次错误：' + lastError.message : ''))
}

export function tail(text, limit = 1600) {
  const value = String(text ?? '')
  return value.length <= limit ? value : '…' + value.slice(-limit)
}