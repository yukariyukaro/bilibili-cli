# bridge 缺陷回归

2026-10-22 阶段二更新：两条历史红灯已在严格TS实现中修复，安装产物回归2/2通过，原正确行为断言不变。当前入口为 PATH 上的 `bilibili bridge run`，不再运行仓库内demo。下面保留阶段一历史症状和取证边界；“当前实际”指修复前历史时点。

本目录是 **E2E 暴露 bridge 缺陷** 的独立入口，不是产品源码，也不改 `src/`。
两个 case 都在**真实安装的 `bilibili bridge run` 子进程**上运行：通过 `BILIBILI_E2E_INSTALLED_PREFIX`
使用统一安装的真实 `bilibili` CLI，连接测试进程内启动的**最小本地控制面 WebSocket**
（cc-connect `register/register_ack/ping/pong/message` 协议子集），状态目录全部在仓库外。

**不是假后端业务验收**：不模拟 `dm read` / `dm send` 成功，不返回任何 B 站消息或发送回执，
不连接 B 站，不读取/复制/打印凭证，不打开写开关。CLI 在隔离空状态目录下真实执行
`dm read`，因无凭证返回 AUTH；本地 WebSocket 只证明 bridge 的控制面帧与队列/恢复语义。
种子状态是本轮测试生成的本地 v1 JSON，正文是 `allowed-*` / `pending-*` 等测试字符串。

## 运行

```powershell
# cwd 应在仓库外；前缀必须来自统一安装（不在这里构建/安装）
$env:BILIBILI_E2E_INSTALLED_PREFIX = "<统一安装前缀>"
$env:BILIBILI_E2E_WORKDIR = "<仓库外工作目录>"       # 可选；缺省用系统临时目录
node packages/bilibili-cli/test/bridge/regressions/run.mjs
```

- 可选：`--case=pending-allowlist-and-order`、`--filter=pending`。
- stdout **只有一行 JSON**：`{"scope":"bridge-regressions","cases":[...],"counts":{...}}`。
  每个 case 形如 `{name,status,error?,durationMs,evidence?}`，全部 case 都会执行，不首错退出。
- stderr 是进度和失败摘要；退出码：全部通过 0，有 failed 1，filter 未匹配 2。
- 可编程入口：`import { runner } from './run.mjs'; const { result, exitCode } = await runner({ env, cwd })`。
- 缺少 `BILIBILI_E2E_INSTALLED_PREFIX` 或前缀不可执行时，两个 case 都记 `failed`（不 skip、不假通过）。

## 红灯 1：`pending-allowlist-and-order`

**种子**（磁盘 state v1，合法结构）：owner `424242` 的 baseline/cursor 在 seqno 5；
pending 依次是 owner 的 `allowed-6`、`allowed-7`，以及 **另一个合法正安全整数 uid 424243**
的 `foreign-6`（不在 `BILIBILI_OWNER_UID` 白名单）。

这个残留不是只针对恶意磁盘输入：owner 先被加入 `BILIBILI_OWNER_UID` 并收到消息、pending 已落盘，
之后 owner 配置被移除并重启 bridge，磁盘 v1 state 结构仍然合法（uid 是正安全整数），
所以文件级 schema 校验不会拒绝；此时必须由 adapter 在 drain 时按**当前** `ownerUids` 过滤。

**期望**：磁盘 pending 恢复时仍要执行白名单：非 owner/非白名单 uid 的消息不得转发给 agent
（隔离/剔除，或启动时明确 fail closed）；白名单条目继续按 seqno 正序转发。

**当前实际**（`installedPrefix` 来自统一安装，真实 CLI 1.0.0）：

```text
[bilibili-bridge] poll attempt
[bilibili-bridge] poll failed uid=424242: 未登录，请先执行 bilibili auth login start
[bilibili-bridge] forwarded msg_id=dm:424242:mk:6 uid=424242
[bilibili-bridge] forwarded msg_id=dm:424243:mk:6 uid=424243     <-- 越权条目被转发
[bilibili-bridge] forwarded msg_id=dm:424242:mk:7 uid=424242
```

控制面实际收到 3 条 `message` 帧，含 `user_id=424243`、`content=foreign-6`；
case 失败信息会列出该帧。`src/adapter.mjs` 的 `_drainPending` 只检查 `skipReason` 和
bridge 是否 ready，没有校验 `entry.uid` 是否仍在 `ownerUids`。

## 红灯 2：`pending-saturation-drain`

**种子**：owner `424242` 的 baseline/cursor 在 seqno 5；pending 恰好 **1000 条**
（seqno 6..1005），即 `MAX_PENDING=1000` 饱和。

**期望**：队列饱和是正常背压状态，只应停止**接收新消息**（`pendingFull`）；
已持久化的 pending 在 bridge registered 后必须继续 drain，且从最旧 seqno 开始正序转发。

**当前实际**：main 正常启动、注册、发出 `ready`（持久化 baseline 已就绪），但 20s 内
**0 条 message 帧**，磁盘状态 `pending` 仍为 1000，stderr 没有 `poll attempt`：

```text
[bilibili-bridge] bridge registered
[bilibili-bridge] poller started
{"type":"registered",...}
{"type":"ready",...,"baselineReady":true}
(20s 后仍无任何 forwarded / poll attempt；pending=1000)
```

`src/adapter.mjs` 的 `_poll` 在 `allBaselined && pending.length >= MAX_PENDING` 时
**在 `_drainPending` 之前直接 return**，因此 pending 永远不再发送、游标不再前进，
后续入站消息也永远不会被接收（`_stageMessages` 同样在饱和处 break）。这是永久堵塞，
不是短暂背压。

## 证据边界

- 本地 WebSocket 不是真正的 cc-connect；当前 `test/e2e/` 也是本地 WS，**没有验证真实 cc-connect** 的注册/心跳/回复路由兼容性，本目录同样不验证。
- CLI 只执行 `--version` 与无凭证 `dm read`（AUTH 失败）；**没有任何 B 站网络成功、没有真实私信收发**。
- 不验证“接口受理/对方已读”，也不声称 bridge 已可用；红灯本身就是缺陷证据。
- 两个 case 在 历史 demo 修复前预期失败；TS迁移时仅更换安装入口/夹具适配，正确行为断言保持不变并转绿。修复方向必须同时满足：
  越权 pending 不外发（或明确 fail closed），饱和时继续 drain 既有 pending。

## 清理与范围

- 临时探针脚本 `_probe-*.mjs` 已删除；本目录只保留 `run.mjs`、`lib/harness.mjs`、本 README。
- 不改 `src/`、`test/e2e/**`、`test/protocol-driver.mjs`、`test/lifecycle.mjs` 或 `package.json`；
  统一回归入口由 lead 接入。
