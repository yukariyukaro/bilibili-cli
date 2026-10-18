import { readFile } from 'node:fs/promises'

export async function load(url, context, nextLoad) {
  if (url.endsWith('/mcp_server.py')) return { format: 'module', source: await readFile(new URL(url), 'utf8'), shortCircuit: true }
  return nextLoad(url, context)
}
