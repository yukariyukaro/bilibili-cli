import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, renameSync, chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('..', import.meta.url))
const compiler = join(source, 'node_modules', 'typescript', 'bin', 'tsc')
if (!existsSync(compiler)) throw new Error('缺少开发期 TypeScript；先在技能目录 npm ci（发布安装不需要 TypeScript）')
const output = mkdtempSync(join(source, '.compile-'))
try {
  const result = spawnSync(process.execPath, [compiler, '--project', join(source, 'tsconfig.json'), '--outDir', output], { cwd: source, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('TypeScript 编译失败；旧 dist 未替换，禁止发布')
  const dist = resolve(source, 'dist')
  if (dist !== join(source, 'dist')) throw new Error('编译目标越界')
  rmSync(dist, { recursive: true, force: true })
  renameSync(output, dist)
  chmodSync(join(dist, 'cli', 'bili.mjs'), 0o755)
} finally {
  rmSync(output, { recursive: true, force: true })
}
