import { createInterface } from 'node:readline'

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  let result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: '测试替身', version: '1' } }
    : { content: [{ type: 'text', text: JSON.stringify({ tool: request.params.name, args: request.params.arguments }) }] }
  if (request.params?.name === 'bili_delete') {
    const target = request.params.arguments
    const responses = {
      BV失败: { success: false, error: '模拟删除业务失败' },
      BV未知: {},
    }
    result = target.bvid === 'BV协议失败'
      ? { isError: true, content: [{ type: 'text', text: '模拟协议失败' }] }
      : { content: [{ type: 'text', text: JSON.stringify(responses[target.bvid] || { success: true, tool: 'bili_delete', args: target }) }] }
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
}
