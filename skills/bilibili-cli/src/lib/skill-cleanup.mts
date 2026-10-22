import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, readdir, realpath, mkdir, open, rename, rmdir } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { errorCode } from './bridge/guards.mjs'
import { CliError } from './contract.mjs'
import {
  LEGACY_DIRECTORY_PATHS,
  LEGACY_FILE_PATHS,
  candidateSnapshots,
  type LegacySnapshot,
} from './legacy-skills.mjs'

const REFUSED_CODE = 'SKILL_CLEANUP_REFUSED'
const BACKUP_PREFIX = '.bilibili-cli-backup-'
const OFFICIAL_REMOVE = 'npx skills remove bilibili-cli [-g]'
const RUNNING_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const READ_FLAGS = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0)

export interface CleanupLegacySkillOptions {
  path: string
  confirm?: boolean
}

export interface SkillCleanupResult {
  action: 'preview' | 'quarantined'
  path: string
  version: string
  backupPath?: string
}

interface StatFingerprint {
  ino: number
  mode: number
  nlink: number
  size: number
  mtimeMs: number
  ctimeMs: number
  isFile: boolean
  isDirectory: boolean
}

interface TraversalEntry {
  kind: 'file' | 'directory'
  size: number
  fingerprint: StatFingerprint
}

interface Traversal {
  target: string
  root: StatFingerprint
  entries: Map<string, TraversalEntry>
  children: Map<string, Set<string>>
}

function refuse(message: string): never {
  throw new CliError(REFUSED_CODE, message, 2)
}

function refuseManagedLayout(): never {
  refuse('检测到 npx skills 管理布局；请使用官方命令 ' + OFFICIAL_REMOVE + '，本命令不处理')
}

function refuseUnknown(): never {
  refuse('目标路径包含未知文件或目录，拒绝处理')
}

function fingerprint(stats: Stats): StatFingerprint {
  return {
    ino: stats.ino,
    mode: stats.mode,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
  }
}

function sameFingerprint(left: StatFingerprint, right: StatFingerprint): boolean {
  return (
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.isFile === right.isFile &&
    left.isDirectory === right.isDirectory
  )
}

async function lstatOrRefuse(path: string, missingMessage: string): Promise<Stats> {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') refuse(missingMessage)
    refuse('目标路径不可访问，拒绝处理')
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    refuse('无法确认路径状态，拒绝处理')
  }
}

function validatePosixPath(raw: string): void {
  if (raw.startsWith('//')) refuse('拒绝 UNC 风格路径')
}

function validateWindowsPath(raw: string): void {
  if (/^[\\/]{2}/.test(raw)) refuse('拒绝 UNC/device 路径')
  if (!/^[A-Za-z]:[\\/]/.test(raw)) refuse('path 必须是带盘符的绝对路径')
  const withoutDrive = raw.slice(2)
  if (/:/.test(withoutDrive)) refuse('拒绝含 ADS/冒号歧义的路径')
  if (/[\\/]{2}/.test(withoutDrive)) refuse('拒绝重复分隔符路径')
  for (const segment of raw.split(/[\\/]+/)) {
    if (!segment) continue
    if (segment === '.' || segment === '..') refuse('path 不能包含 . 或 .. 段')
    if (/[. ]$/.test(segment)) refuse('拒绝尾点/尾空格路径')
  }
}

function isCanonicalAgentSkillsPath(target: string): boolean {
  const parent = basename(dirname(target))
  const grandparent = basename(dirname(dirname(target)))
  if (process.platform === 'win32') {
    return parent.toLowerCase() === 'skills' && grandparent.toLowerCase() === '.agents'
  }
  return parent === 'skills' && grandparent === '.agents'
}

function validatePath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0) refuse('path 必须是非空字符串')
  if (raw.includes(String.fromCharCode(0))) refuse('path 包含非法字符')
  if (!isAbsolute(raw)) refuse('path 必须是绝对路径')
  if (/[\\/]$/.test(raw)) refuse('path 不能以分隔符结尾')
  for (const segment of raw.split(/[\\/]+/)) {
    if (segment === '.' || segment === '..') refuse('path 不能包含 . 或 .. 段')
  }
  if (process.platform === 'win32') validateWindowsPath(raw)
  else validatePosixPath(raw)
  const target = resolve(raw)
  if (basename(target) !== 'bilibili-cli') refuse('path 的 basename 必须是 bilibili-cli')
  if (isCanonicalAgentSkillsPath(target)) refuseManagedLayout()
  return target
}

function comparablePath(value: string): string {
  const absolute = resolve(value)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function isWithinOrEqual(child: string, parent: string): boolean {
  const childPath = comparablePath(child)
  const parentPath = comparablePath(parent)
  const rel = relative(parentPath, childPath)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

function assertProtected(target: string): void {
  if (isWithinOrEqual(target, RUNNING_PACKAGE_ROOT) || isWithinOrEqual(RUNNING_PACKAGE_ROOT, target)) {
    refuse('拒绝处理当前运行的 package root 及其祖先/后代')
  }
  const stateHome = process.env.BILIBILI_SKILL_HOME
  if (typeof stateHome === 'string' && stateHome.trim()) {
    const stateDir = resolve(stateHome)
    if (isWithinOrEqual(target, stateDir) || isWithinOrEqual(stateDir, target)) {
      refuse('拒绝处理 BILIBILI_SKILL_HOME 状态目录及其祖先/后代')
    }
  }
}

async function assertNoManagedLock(dir: string): Promise<void> {
  for (const name of ['skills-lock.json', '.skill-lock.json']) {
    let exists = false
    try {
      await lstat(join(dir, name))
      exists = true
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') refuse('无法确认 npx skills 管理状态，拒绝处理')
    }
    if (exists) refuseManagedLayout()
  }
}

async function assertSafeAncestors(target: string): Promise<void> {
  let current = target
  for (;;) {
    const stats = await lstatOrRefuse(current, '目标路径不存在')
    if (stats.isSymbolicLink()) refuse('目标路径包含符号链接或 junction，拒绝处理')
    await assertNoManagedLock(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  let real: string
  try {
    real = await realpath(target)
  } catch {
    refuse('目标路径不可访问，拒绝处理')
  }
  if (comparablePath(real) !== comparablePath(target)) {
    refuse('目标路径包含符号链接或 junction，拒绝处理')
  }
}

function addChild(traversal: Traversal, parent: string, name: string): void {
  let children = traversal.children.get(parent)
  if (!children) {
    children = new Set<string>()
    traversal.children.set(parent, children)
  }
  children.add(name)
}

async function walk(traversal: Traversal, relDir: string): Promise<void> {
  const absoluteDir = relDir ? join(traversal.target, ...relDir.split('/')) : traversal.target
  let entries
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true })
  } catch {
    refuse('目标路径不可访问，拒绝处理')
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))

  for (const entry of entries) {
    const relPath = relDir ? relDir + '/' + entry.name : entry.name
    const absolutePath = join(absoluteDir, entry.name)
    const stats = await lstatOrRefuse(absolutePath, '目标路径在校验过程中发生变化，拒绝处理')
    if (stats.isSymbolicLink()) refuse('目标路径包含符号链接或 junction，拒绝处理')
    addChild(traversal, relDir, entry.name)

    if (stats.isDirectory()) {
      if (!LEGACY_DIRECTORY_PATHS.has(relPath)) refuseUnknown()
      traversal.entries.set(relPath, { kind: 'directory', size: stats.size, fingerprint: fingerprint(stats) })
      await walk(traversal, relPath)
      continue
    }
    if (stats.isFile()) {
      if (!LEGACY_FILE_PATHS.has(relPath)) refuseUnknown()
      if (stats.nlink > 1) refuse('目标路径包含硬链接文件，拒绝处理')
      traversal.entries.set(relPath, { kind: 'file', size: stats.size, fingerprint: fingerprint(stats) })
      continue
    }
    refuse('目标路径包含不支持的文件类型，拒绝处理')
  }
}

async function inspectStructure(target: string): Promise<Traversal> {
  const rootStats = await lstatOrRefuse(target, '目标路径不存在')
  if (rootStats.isSymbolicLink()) refuse('目标路径包含符号链接或 junction，拒绝处理')
  if (!rootStats.isDirectory()) refuse('目标路径必须是目录')
  const traversal: Traversal = {
    target,
    root: fingerprint(rootStats),
    entries: new Map(),
    children: new Map(),
  }
  traversal.children.set('', new Set())
  await walk(traversal, '')
  return traversal
}

async function readKnownFile(path: string, expected: StatFingerprint): Promise<Buffer> {
  const beforePath = await lstatOrRefuse(path, '目标路径在校验过程中发生变化，拒绝处理')
  if (
    beforePath.isSymbolicLink() ||
    !beforePath.isFile() ||
    beforePath.nlink !== 1 ||
    !sameFingerprint(expected, fingerprint(beforePath))
  ) {
    refuse('目标路径在校验过程中发生变化，拒绝处理')
  }

  let handle: Awaited<ReturnType<typeof open>> | null = null
  let data: Buffer | null = null
  try {
    try {
      handle = await open(path, READ_FLAGS)
    } catch (error) {
      if (errorCode(error) === 'ELOOP') refuse('目标路径包含符号链接或 junction，拒绝处理')
      refuse('目标路径的文件内容不可读取，拒绝处理')
    }
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || !sameFingerprint(expected, fingerprint(before))) {
      refuse('目标路径在校验过程中发生变化，拒绝处理')
    }
    data = await handle.readFile()
    const after = await handle.stat()
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      !sameFingerprint(expected, fingerprint(after)) ||
      !sameFingerprint(fingerprint(before), fingerprint(after))
    ) {
      refuse('目标路径在校验过程中发生变化，拒绝处理')
    }
  } catch (error) {
    if (error instanceof CliError) throw error
    refuse('目标路径的文件内容不可读取，拒绝处理')
  } finally {
    if (handle) await handle.close().catch(() => undefined)
  }

  const afterPath = await lstatOrRefuse(path, '目标路径在校验过程中发生变化，拒绝处理')
  if (
    afterPath.isSymbolicLink() ||
    !afterPath.isFile() ||
    afterPath.nlink !== 1 ||
    !sameFingerprint(expected, fingerprint(afterPath))
  ) {
    refuse('目标路径在校验过程中发生变化，拒绝处理')
  }
  if (!data) refuse('目标路径的文件内容不可读取，拒绝处理')
  return data
}

async function hashesMatch(target: string, traversal: Traversal, snapshot: LegacySnapshot): Promise<boolean> {
  for (const fileEntry of snapshot.files) {
    const entry = traversal.entries.get(fileEntry.path)
    if (!entry) {
      if (fileEntry.optional) continue
      return false
    }
    if (entry.kind !== 'file' || entry.size !== fileEntry.size) return false
    const data = await readKnownFile(join(target, ...fileEntry.path.split('/')), entry.fingerprint)
    if (data.length !== fileEntry.size) return false
    const digest = createHash('sha256').update(data).digest('hex')
    if (digest !== fileEntry.sha256) return false
  }
  return true
}

async function identifySnapshot(target: string, traversal: Traversal): Promise<LegacySnapshot> {
  const files: string[] = []
  const directories: string[] = []
  for (const [path, entry] of traversal.entries) {
    if (entry.kind === 'file') files.push(path)
    else directories.push(path)
  }

  const candidates = candidateSnapshots(files, directories)
  if (!candidates.length) refuse('目标路径不是完整的已知旧版 skill 文件清单')

  const sizeCandidates = candidates.filter((snapshot) =>
    snapshot.files.every((fileEntry) => {
      const entry = traversal.entries.get(fileEntry.path)
      if (!entry) return fileEntry.optional === true
      return entry.kind === 'file' && entry.size === fileEntry.size
    }),
  )
  if (!sizeCandidates.length) refuse('目标路径的文件内容不匹配已知旧版 skill')

  for (const snapshot of sizeCandidates) {
    if (await hashesMatch(target, traversal, snapshot)) return snapshot
  }
  refuse('目标路径的文件内容不匹配已知旧版 skill')
}

async function assertUnchanged(traversal: Traversal): Promise<void> {
  const rootStats = await lstatOrRefuse(traversal.target, '目标路径在校验过程中发生变化，拒绝处理')
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    refuse('目标路径在校验过程中发生变化，拒绝处理')
  }
  if (!sameFingerprint(traversal.root, fingerprint(rootStats))) {
    refuse('目标路径在校验过程中发生变化，拒绝处理')
  }

  for (const [relPath, entry] of traversal.entries) {
    const absolutePath = join(traversal.target, ...relPath.split('/'))
    const stats = await lstatOrRefuse(absolutePath, '目标路径在校验过程中发生变化，拒绝处理')
    if (stats.isSymbolicLink()) refuse('目标路径包含符号链接或 junction，拒绝处理')
    const kindMatches = entry.kind === 'file' ? stats.isFile() : stats.isDirectory()
    if (!kindMatches || !sameFingerprint(entry.fingerprint, fingerprint(stats))) {
      refuse('目标路径在校验过程中发生变化，拒绝处理')
    }
  }

  for (const [relDir, children] of traversal.children) {
    const absoluteDir = relDir ? join(traversal.target, ...relDir.split('/')) : traversal.target
    let entries
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true })
    } catch {
      refuse('目标路径在校验过程中发生变化，拒绝处理')
    }
    const names = new Set(entries.map((entry) => entry.name))
    if (names.size !== children.size) refuse('目标路径在校验过程中发生变化，拒绝处理')
    for (const name of children) {
      if (!names.has(name)) refuse('目标路径在校验过程中发生变化，拒绝处理')
    }
  }
}

async function createBackupDir(parent: string): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const backupDir = join(parent, BACKUP_PREFIX + randomUUID())
    try {
      await mkdir(backupDir, { mode: 0o700 })
      return backupDir
    } catch (error) {
      if (errorCode(error) === 'EEXIST') continue
      refuse('无法创建隔离备份目录，未删除任何内容')
    }
  }
  refuse('无法创建隔离备份目录，未删除任何内容')
}

async function removeEmptyBackupDir(backupDir: string): Promise<void> {
  try {
    await rmdir(backupDir)
  } catch {
    // 只清理空目录；非空/失败则保留，绝不递归删除。
  }
}

async function quarantine(target: string, traversal: Traversal, version: string): Promise<SkillCleanupResult> {
  const backupDir = await createBackupDir(dirname(target))
  const backupPath = join(backupDir, 'skill')
  try {
    if (await pathExists(backupPath)) refuse('隔离目标已存在，拒绝覆盖')
    await assertUnchanged(traversal)
    await rename(target, backupPath)
  } catch (error) {
    await removeEmptyBackupDir(backupDir)
    throw error
  }
  return {
    action: 'quarantined',
    path: target,
    version,
    backupPath,
  }
}

/**
 * 显式清理一个 unmanaged、pristine 的旧版 bilibili-cli Skill 目录。
 *
 * 默认只预览；confirm=true 时在同级创建 700 权限的随机备份目录，并把目标
 * rename 到 backup/skill，不递归删除、不自动恢复覆盖。回滚由用户手动把
 * backupPath 移回 path。npx skills 管理的 .agents/skills canonical 布局、
 * 带 skills-lock.json/.skill-lock.json 的目录、symlink/junction、未知内容一律拒绝。
 */
export async function cleanupLegacySkill(options: CleanupLegacySkillOptions): Promise<SkillCleanupResult> {
  if (typeof options !== 'object' || options === null) refuse('参数无效')
  const rawPath: unknown = options.path
  if (typeof rawPath !== 'string') refuse('path 必须是非空字符串')
  if (options.confirm !== undefined && typeof options.confirm !== 'boolean') refuse('confirm 必须是布尔值')

  const target = validatePath(rawPath)
  assertProtected(target)
  await assertSafeAncestors(target)
  const traversal = await inspectStructure(target)
  const snapshot = await identifySnapshot(target, traversal)
  await assertUnchanged(traversal)

  if (options.confirm !== true) {
    return { action: 'preview', path: target, version: snapshot.version }
  }
  return quarantine(target, traversal, snapshot.version)
}