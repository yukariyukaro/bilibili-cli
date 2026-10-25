import test from 'node:test'
import { manual } from './lib/env.mjs'

test('真实双账号往返（MANUAL：当前没有逐次人工确认入口）', (t) => {
  manual(t, '真实往返必须由人工确认准确目标和最终正文，并在 CLI writesEnabled 显式开启后执行；main 注入的 confirmSend 默认只允许白名单主人，但自动化不能替用户确认，也不能自动把 BILIBILI_BRIDGE_DRY_RUN 改成 false。离线确认门禁、白名单和 pending 恢复由 test/protocol-driver.mjs 的独立子进程覆盖；本轮不发送真实私信')
})
