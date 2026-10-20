/**
 * 本地 npm 注册表（仅用于发布前验收）
 * ============================================================================
 * 把本地 npm pack 产物按真实注册表协议暴露给 npm：
 *   - GET /<pkg>            → packument
 *   - GET /<pkg>/-/<file>   → tarball
 * 配合 @scope:registry 的临时 .npmrc，npm 会像安装已发布包一样解析 semver、
 * 校验 integrity 并写入 lockfile。发布前用它验证“包能被装进 CLI”，
 * 不改动 package.json 中的正式版本范围。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'

export async function startLocalRegistry({ tarballPath, manifestPath }) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bytes = readFileSync(tarballPath)
  const filename = tarballPath.replace(/\\/g, '/').split('/').pop()
  const shasum = createHash('sha1').update(bytes).digest('hex')
  const integrity = 'sha512-' + createHash('sha512').update(bytes).digest('base64')
  const name = manifest.name
  const version = manifest.version
  let origin = ''

  const packument = () => ({
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...manifest,
        _id: `${name}@${version}`,
        dist: {
          tarball: `${origin}/${name}/-/${filename}`,
          shasum,
          integrity,
        },
      },
    },
    time: { created: new Date().toISOString(), modified: new Date().toISOString(), [version]: new Date().toISOString() },
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')
    const path = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const send = (status, headers, body) => {
      response.writeHead(status, headers)
      if (request.method === 'HEAD') response.end()
      else response.end(body)
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') return send(405, { 'content-type': 'application/json' }, JSON.stringify({ error: 'method not allowed' }))
    if (path === name) return send(200, { 'content-type': 'application/json' }, JSON.stringify(packument()))
    if (path === `${name}/-/${filename}`) return send(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) }, bytes)
    send(404, { 'content-type': 'application/json' }, JSON.stringify({ error: 'not found', path }))
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  origin = `http://127.0.0.1:${server.address().port}`
  return {
    url: origin,
    name,
    version,
    integrity,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
