import test from 'node:test'
import { manual } from './lib/env.mjs'

test('真实 bridge 多消息顺序（MANUAL：需真实入站消息与人工确认）', (t) => {
  manual(t, '真实顺序回归需要账号 B 主动发两条真实私信，且 bridge 必须能自动回复；自动发私信会越过用户逐次确认。真实 dm read 的字段与原始顺序证据由 01-dm-contract 只读契约记录，排序、去重和 pending 顺序由 test/protocol-driver.mjs 的独立子进程覆盖；本轮不发送真实私信')
})
