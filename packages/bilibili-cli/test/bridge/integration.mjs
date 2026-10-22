#!/usr/bin/env node
/**
 * 旧 FakeBackend 离线“集成测试”入口。
 *
 * 该测试曾用模拟 bridge/backend 断言私信去重和回复成功，容易把“模拟后端通过”
 * 当成真实业务验收。按仓库规则，真实回归必须显式启用、不得伪造成功，因此这里
 * 保留入口但改为安全拒绝和迁移提示；不在本文件新增任何假业务验收。
 */
const message = [
  'bilibili-cli/test/bridge integration: REFUSED (迁移提示)',
  '',
  '旧的 FakeBackend 集成测试已停用（迁移到 test/bridge）：它用模拟后端断言发送/去重成功，不能作为 B 站业务验收。',
  '本入口不执行任何 B 站读写，也不创建/复制凭证。真实能力请使用：',
  '',
  '1) 默认离线回归（真实安装 CLI + 本地控制面/故障协议）：',
  '   npm test',
  '   npm run test:bridge',
  '',
  '2) 真实只读（必须显式启用；不自动写、不自动开写权限）：',
  '   $env:BILIBILI_E2E_READONLY = "1"',
  '   $env:BILIBILI_E2E_INSTALLED_PREFIX = "<临时安装前缀>"',
  '   $env:BILIBILI_E2E_AGENT_HOME = "<账号 A 的隔离状态目录>"',
  '   $env:BILIBILI_E2E_OWNER_UID = "<只读目标会话的账号 B UID>"',
  '   # 可选：$env:BILIBILI_E2E_OWNER_HOME / BILIBILI_E2E_AGENT_UID',
  '   npm run test:bridge:readonly',
  '',
  '3) 真实写：',
  '   npm run test:bridge:write',
  '   当前 bridge 没有逐次人工确认入口，该入口会明确拒绝（返回码 3），',
  '   不会自动发送真实消息，也不会自动设置 confirmSend=true。',
  '',
  '安全边界：接口受理不等于接收方已读；未知写状态不得自动重试。',
  '退出码 3 = 明确拒绝，不是通过。',
].join('\n')
console.error(message)
console.log(JSON.stringify({
  type: 'bridge-integration-refusal',
  status: 'refused',
  exitCode: 3,
  reason: 'legacy fake business acceptance removed; use explicit offline/readonly entries',
  writesAttempted: 0,
  realBilibiliReads: 0,
  realBilibiliWrites: 0,
}))
process.exit(3)
