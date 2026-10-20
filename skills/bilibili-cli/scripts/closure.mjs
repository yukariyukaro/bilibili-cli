import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, isAbsolute } from 'node:path'

const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']
const allowed = ['@yukariyukaro/bilibili-api-ts', 'commander', 'qrcode']
const forbidden = /(?:dsh-bili-scroll|@deepseek-ai\/|^(?:file|link|workspace):|^\.{1,2}[\\/]|^[A-Za-z]:[\\/]|^\/)/

export function assertClosure(dir, { lock = true } = {}) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  assert.deepEqual(Object.keys(pkg.dependencies || {}).sort(), allowed, '独立 CLI 仅允许 API 包、commander 与 qrcode 直接依赖')
  const inspect = (entry) => {
    for (const section of sections) {
      for (const [name, value] of Object.entries(entry[section] || {})) {
        assert.ok(!forbidden.test(name) && !forbidden.test(String(value)), `禁止宿主或本地包依赖：${name}=${value}`)
      }
    }
  }
  inspect(pkg)
  if (lock) {
    const data = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'))
    assert.equal(data.name, pkg.name)
    assert.equal(data.version, pkg.version)
    assert.deepEqual(data.packages[''].dependencies, pkg.dependencies, '锁文件必须与清单一致')
    for (const [path, entry] of Object.entries(data.packages)) {
      assert.ok(path === '' || path.startsWith('node_modules/'), `锁文件不能指向包外：${path}`)
      assert.ok(!forbidden.test(path.replace(/^node_modules\//, '')) && !entry.link, `禁止宿主或符号链接：${path}`)
      if (entry.resolved) assert.match(entry.resolved, /^https:\/\//, `只允许 HTTPS 注册表依赖：${path}`)
      inspect(entry)
    }
  }
  const walk = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (path.endsWith('.mjs')) {
        const text = readFileSync(path, 'utf8')
        for (const [, specifier] of text.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
          if (specifier.startsWith('node:')) continue
          if (specifier.startsWith('.')) {
            const target = relative(dir, resolve(dirname(path), specifier))
            assert.ok(target && !target.startsWith('..') && !isAbsolute(target), `运行时导入越界：${specifier}`)
          } else assert.ok(allowed.includes(specifier), `未声明的运行时导入：${specifier}`)
        }
      }
    }
  }
  for (const folder of ['cli', 'lib']) walk(join(dir, folder))
}
