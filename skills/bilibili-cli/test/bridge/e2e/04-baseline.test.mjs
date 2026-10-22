import test from 'node:test'
import { manual } from './lib/env.mjs'

test('真实启动基线（MANUAL：需要真实新消息与人工确认）', (t) => {
  manual(t, '真实启动基线要求真实账号 B 在 bridge 启动后发消息，而自动化发送真实私信会越过逐次确认；本轮不运行常驻监听。首次 baseline、重启续读和保存失败不误消费由 test/protocol-driver.mjs 的独立子进程覆盖')
})
