# bridge × CLI：E2E 台账

## 本次提交快照复验（2026-10-22）

在基于最新 origin/main 的独立工作树完成 scoped 包快照复验：`npm ci --ignore-scripts --no-audit --no-fund`、`npm run typecheck`、`npm test` 均 exit 0。**14 个顶层组通过、bridge 失败 0**，比历史 13 组新增 tarball 的 npm exec 用例。证据根：`C:/Users/J/AppData/Local/Temp/bilibili-cli-e2e-Pd62uK`。

- 包名为 `@yukariyukaro/bilibili-cli@1.1.0`；Skill 名及 `bilibili` 命令名不变。build/source 两条 npm pack/install/PATH 路径与 scoped 安装布局均通过。
- tarball 在仓库外隔离缓存通过 npm exec 直接执行，未依赖源码或安装期编译；此结果不证明 npm registry 已发布。
- build bridge 9 通过/0 失败，source 8 通过/0 失败/1 组不重复；build 生命周期 18/18，协议两路径各 10/10，历史缺陷 2/2，cleanup 双路径各 15/15，安装命令套件每路径 15 通过/0 失败/7 跳过。
- 本次未启用真实账号测试、未发 B 站请求或消息。历史真实只读 **18 pass / 1 fail / 3 skip** 仍未修复；真实 bridge 入站、cc-connect/AI 处理、评论自动回复未验收。
- 本次 Docker `--check` exit 0：75 个 context 文件、34 个 mjs、11 项静态检查；未调用 daemon、未构建或运行容器。
- 以下 wm81Zo/proTde/FHttRR 等记录保留为当时证据，组数不回写、不累计；提交/推送是保存代码检查点，不是功能完成、tag 或 npm 发布。

## 清理后的复验与真实只读红灯（2026-10-22，Asia/Shanghai）

本节为迁移验收后的新执行记录；下文 wm81Zo 等结果保留为历史证据，不代表本轮真实只读已通过。

- 新项目 scope：skills@1.7.4 通过 `npx --no-install skills add <本地构建 skill 目录> -s bilibili-cli -y` 安装纯文档 Skill（3 文件），与构建副本逐字节一致；相对链接和文档提及的命令/参数校验通过。另用 tarball 在独立 prefix 安装 CLI 1.1.0，验证版本、doctor、技能发现、无凭证拒绝、dry-run 与禁写。只证明本地安装，不证明 GitHub 远端 1.1.0 可用。
- 经用户授权，旧全局 Skill 通过官方 `skills remove bilibili-cli -g -y` 移除，canonical、Claude link 与 lock entry 均消失；保留不含 node_modules 的旧代码/文档备份，CLI 未被卸载。当前没有安装新版全局 Skill，不将新项目测试副本当作全局替换。
- 清理后 `npm test` exit 0：13 顶层组通过，bridge 失败 0；build 9 组、source 8 组/1 组不重复；build 生命周期 18/18、两路径协议各 10/10、原缺陷 2/2、cleanup 各 15/15，安装套件每路径 15 通过/7 跳过。证据根：`C:/Users/J/AppData/Local/Temp/bilibili-cli-e2e-proTde`。
- 用户明确改用 CLI 已保存的账号 A；账号 B 经独立扫码登录。通过 CLI 确认两者 UID 不同且双向互关；未通过文件工具读取、复制或迁移凭证，未开启写权限。
- 真实只读直接运行 `test/bridge/e2e/run.mjs readonly`，显式开启 READONLY 并指定安装 prefix、A/B home 和 UID；结果 **exit 1：18 通过、1 失败、3 MANUAL 跳过**。失败为现有 `01-dm-contract.test.mjs` 对顶层 min_seqno 等于消息集合最小值的断言；未删除、放宽或 skip 此断言。
- 脱敏元数据：2 条 TEXT，倒序，顶层 min_seqno=2630428175433737、max_seqno=2630436497018881；返回消息 seqno=2630436497018881 / 2630428175564807，has_more=0。两个 msg_key 均超过 JS 安全整数。字段含义与上游精度影响尚需核实；不能仅凭本次 min 不等便宣称 bridge 丢消息。
- 额外只读诊断确认 writesEnabled 前后均 false、audit stat 不变；未输出或保存私信正文。只读报告与元数据诊断位于仓库外测试目录的 `real-readonly/`。原测试在边界断言失败后才计划写 dm-contract.json，因此本轮该文件未生成，不是已生成后丢失；诊断元数据另存 dm-sequence-diagnostic.json。
- 只读源码复核：CLI dmRead 透传 API 结果；bridge 取 messages 并用消息自身序号排序/建游标，不读顶层 min_seqno/max_seqno/has_more。当前 min_seqno 等于页内最小值的测试假设缺乏契约证据，应保留失败并进一步验证服务端边界语义；本次样本不能证明 bridge 丢消息，也不能证明超过 30 条的分页完整性。
- 精度链路风险：API 库先用普通 JSON.parse，bridge 的 lossless reviver 只能保全 CLI 输出文本，不能恢复在 API 层已舍入的真值。真实 CLI 路径中超安全整数可能已转成字符串，primaryIdString 会采用该串，而 hasUnsafeIntegerId 仅检测不安全 number，因此未必触发复合键回退/警告。由此存在舍入后 ID 碰撞导致错误去重的风险；尚未复现真实碰撞，不能把理论风险写成已发生的丢信。需在原始解析层保真并新增真实安装链回归，不改当前断言求绿。
- 首轮真实 bridge 探针完成注册与基线 ready，随后等待 5 分钟，未观察到指定人工测试消息（`manual_message_not_observed`，exit 1）。随后按用户明确授权改用 B→A CLI 私信验证；第一次脚本在 `dm send` 已执行后的本地摘要步骤出错，我误判为未发送而又执行了一次，导致 A 收到 2 条相同测试消息。两次操作均有审计记录，B 写权限已恢复为 false；未删除消息，未继续重试。bridge 探针另因请求的 Windows 工作目录当时不存在，DSH 作业包装器在脚本执行前失败（错误文本提及 powershell.exe ENOENT）；探针代码并未运行，因此这不是产品 bridge 或系统 PowerShell 缺失证据。真实 bridge 转发、回复拒绝与重启去重仍未验证。
- 当前产品入口默认拒绝回复。本地 WS 即使接到真实私信，也仅证明 CLI/bridge 入站与协议封装，不证明真实 cc-connect、AI 处理或 B 站回复送达。

## 阶段二最终离线验收（2026-10-22，Asia/Shanghai）

Lead 在旧实现删除、清理功能及兼容性审查修复后执行 `npm run typecheck` 与 `npm test`，均 exit 0（13个顶层组通过、bridge失败0）。最终临时证据目录 `C:/Users/J/AppData/Local/Temp/bilibili-cli-e2e-wm81Zo`。构建发布包和源码包各自真实 npm pack/install、仓库外 PATH 命令已通过。中间绿灯JaLYqa仅作过程证据，不替代本次最终结果。

| 范围 | 结果 | 证据边界 |
| --- | --- | --- |
| 构建包 bridge 汇总 | 9 passedGroups / 0 failedGroups | backend五组、协议、安装CLI、生命周期、原缺陷回归 |
| 协议回放 | 10/10 | 本地WS与合成消息，不是B站业务成功 |
| 进程/命令套件 | 15通过、7跳过、0失败 | 未开启真实只读与人工往返 |
| 完整生命周期 | 18/18 | 延迟ack、断连恢复、真实CLI子进程退出、状态与stop控制 |
| 原始两条缺陷回归 | 2/2通过 | 原正确行为断言保留，当前白名单过滤、饱和继续drain |
| 旧Skill清理 | 构建包15/15、源码包15/15 | preview、隔离、人工rename回滚、未知/凭证哨兵/依赖/空目录/links/硬链接/state/canonical/lock拒绝、0.1.5版本识别 |
| 非对象凭证哨兵 | 安装CLI通过 | null/数组/字符串/数字明确AUTH3，空临时状态无真实凭证，无匿名联网 |
| 公开兼容契约 | 原23命令精确快照通过 | name/fields/order/description/default/enum保留；共27命令，schemaVersion1 |
| 源码包 bridge 汇总 | 8通过、0失败、1组跳过 | 协议与安装CLI复验；生命周期仅status/stop子集，原缺陷组不重复 |

旧 `lib/*.mjs` 与独立demo已删除，保留公开薄启动器。Lead和独立review已复核清理安全与服务出站投影兼容；本机严格类型检查通过。Docker最终静态校验exit0（74白名单文件、34个mjs检查，报告Redv9q），daemon不可用未构建镜像/运行容器。真实B站收发尚未验证；没有commit/push/发布。

清理先在旧产物出现缺命令红灯（1通过/11失败），再新安装转绿；full旧源码只由固定Git历史在TEMP构造，不保留第二份业务实现。测试setup需git与已知历史commit，产品运行不需要。文档fixture固定LF。npx受管理安装优先官方remove；skills@1.7.4真实CLI的TEMP本地copy/remove已验证，literal npx在隔离缓存下不可用，远端仍旧提交，不能宣称新版远端npx通过。

不同层级组数和场景数不相加。机器报告为本次临时目录的 `bridge-e2e-build.json`、`bridge-e2e-source.json`、`bridge-e2e-readonly-report.json`；cleanup summary逐路径由统一npm test输出。

## 以下为阶段一历史证据（不是当前失败状态）

> 从旧 bilibili-bridge/test/BASELINE.md 迁移，保留先红后绿的原始记录。以下“本轮”“当前”“下一轮”均指阶段一冻结时点。

日期：2026-10-22（Asia/Shanghai）。本轮是测试基线，不是阶段二迁移验收，不表示 bridge 已可用作无人值守真实往返。

## 工作方式与边界

用户补充要求后，优先写 E2E 暴露问题，再逐个修复；产品源码已冻结。新增缺陷断言保持红灯，不用 `skip`/`todo` 或反向断言使确定的问题变绿。

前半轮曾同时修改产品代码与测试，不能追溯宣称是“先红后绿”的完整 TDD：

- `src/backend.mjs`：CLI PATH/.cmd 启动、UID JSON 数值契约、请求超时/pending 清理、审计终态。
- `src/bridge.mjs` / `src/adapter.mjs`：注册/连接清理、消息解码/顺序/ID、baseline/pending。
- `src/main.mjs` / `src/state.mjs`：注册后启动、就绪事件、停止、状态存储与锁。

历史红灯证据是 Windows CLI 启动返回 `CLI_EXIT`、字符串 UID 返回 `VALIDATION`；这些已在前半轮修改并复验。后半轮新发现的问题**不继续修复**，留给下一轮逐例处理。CLI 产品源码、命令和发布边界未迁移，未恢复 DSH/MCP。

## 测试入口

| 命令 | 用途 | 成功/失败语义 |
| --- | --- | --- |
| `npm test` / `npm run test:bridge` | 构建→npm pack→临时安装→仓库外 PATH 调用 CLI，再接 bridge | CLI 原有回归保留；bridge 各组失败汇总后非零退出 |
| `npm run test:bridge:readonly` | 默认只跑本地进程检查，显式 `BILIBILI_E2E_READONLY=1` 才访问真实只读接口 | 缺少显式只读所需配置时 exit 2；未启用真实测试项为 skipped |
| `npm run test:bridge:write` | 独立的真实写入口检查 | 当前无逐次人工确认交互，明确 refused，exit 3，零真实写 |
| `npm run test:bridge:docker` | 可选 Linux 容器隔离的同一组测试 | 环境 unavailable 与测试 failed 分开，不把未运行报为通过 |

构建包跑完整 bridge 基线；源码包再次真实 pack/install 后复验传输、校验、预览、CLI 写保护、收件人和审计拒绝。两条安装路径都走 `bilibili` PATH，不导入 CLI 源码代替交付验收。

## 证据分层

1. **真实安装 CLI**：实际 npm 包、实际子进程、中文空格安装路径、真实命令契约。无凭证的 `AUTH`/禁写和 dry-run 不访问 B 站业务后端。
2. **真实 bridge main 生命周期**：本地最小 WebSocket 控制服务与真实已安装 CLI，验证延迟注册、停止、锁、重连与进程树。服务器不生成 B 站业务成功。
3. **协议回放驱动**：真实 BridgeClient/adapter 子进程+本地 WS+合成消息记录；只证明解码、排序、持久化顺序、门禁。它不是 B 站业务 E2E，不能拿它证明账号可收发；发送替身仅返回 dry-run，不返回假业务成功。
4. **缺陷回归**：正确行为断言，实际 main+持久化输入+本地 WS；失败是产品红灯，不是需要“修测试”的理由。
5. **真实业务**：显式只读登录/字段/顺序证据与人工逐次授权写往返，另列未运行/待人工，不计入离线成功。

默认本机测试隔离状态目录，不连接 B 站。npm 安装依赖仍需网络，并使用本轮环境内的公共注册表设置，不修改用户全局 npm 配置。Docker 把安装依赖与运行测试分阶段，运行阶段禁外网；本机 PATH/.cmd 与 Docker/Linux 互为补充。

## 结果与待修复清单

Lead 最终执行 `npm test`：**exit 1**（两条确认的产品红灯，未修复）。运行目录为 `C:/Users/J/AppData/Local/Temp/bilibili-cli-e2e-ugldqp`，结果如下：

| 范围 | 结果 | 说明 |
| --- | --- | --- |
| 原 CLI 离线回归 | 8 组通过 | 构建、真实 npm 安装、帮助/schema、参数拒绝、写保护、JSONL |
| 构建包 bridge 安全传输 | 5/5 组通过 | 真实已安装 CLI + 四类故障传输 |
| 协议回放子进程 | 10/10 通过 | 不代表 B 站业务成功 |
| 安装后进程/只读入口套件 | 9 通过、7 跳过、0 失败 | 7 项均为未开启真实只读或需人工收发 |
| 真实 main 生命周期 | 15/15 通过 | 延迟 ack、重复 stop、强杀恢复、OS 进程树退出等 |
| 已确认缺陷回归 | **2/2 失败** | 保持红灯，见下表 |
| 源码包独立安装后的 bridge 传输/写保护 | 5/5 组通过 | 未把完整 bridge 生命周期重复计为两个安装路径都通过 |
| 真实 B 站只读 / 双账号往返 | 未运行 / 待人工 | 无真实写、未读取迁移凭证 |
| Docker context/静态检查 | static-checked，exit 0 | 45 个白名单文件、35 个 mjs 语法检查，未构建镜像 |
| Docker 容器 E2E | unavailable，未运行 | client 29.8.0 可用，Linux daemon pipe 不存在 |

构建包汇总为 **8 passedGroups / 1 failedGroup**，其中失败组包含两条红灯；源码包为 **5 passedGroups / 0 failedGroups**。不同层级的组数和用例数不相加为一个虚构总数。机器报告为本轮临时目录中的 `bridge-e2e-build.json`、`bridge-e2e-source.json`、`bridge-e2e-readonly-report.json`。后续重复执行生成新目录；不提交凭证、私信正文、运行状态、tarball 或生成物。

已由 Lead 独立复现以下两条产品红灯（不是安装前置失败）：

| 用例 | 正确期望 | 冻结代码的实际行为 |
| --- | --- | --- |
| `pending-allowlist-and-order` | 恢复队列也要按当前 owner 白名单过滤，允许消息按 seqno 正序 | owner=424242 时，非 owner=424243 的合成 `foreign-6` 被真实 main 发往本地控制端；3 帧中包含越权条目 |
| `pending-saturation-drain` | 饱和仅阻止新消息入库，仍要消费既有 pending | pending=1000 时注册后观察 20 秒，0 帧、磁盘 pending 仍为1000，进程仍存活 |

第二项观察结果与 `_poll` 在饱和时先 return、没有进入 `_drainPending` 的代码路径一致。第一项也可能由用户修改 owner 配置后残留旧会话 pending 触发，不只是恶意编辑磁盘状态。缺陷详情与单例执行方式见 [红灯回归说明](regressions/README.md)。两项均未在本轮冻结后修复。

## 仍未证明的行为

- 真实 B 站账号只读契约、真实双账号往返尚未执行；不需要用户提供 Cookie。
- `ready` 表示已有持久化 baseline 且传输注册，不保证当前远端在线或登录仍有效；首次消息应在 baseline ready 后发送。
- 当前 `dm read` 单页能力不足以证明积压超过窗口不漏消息；分页、序号读取原语和上游大整数精度仍需单独验收。
- cc-connect 没有送达 ack，WebSocket 写入成功不等于 agent 已处理；崩溃窗口仅 at-least-once，可能重放。测试不虚称 exactly-once。
- 本地持久化协议故障注入不等于真实磁盘崩溃/fsync/rename 故障全覆盖。
- pending 包含私信正文，状态目录必须受保护；测试仅用合成正文。真实内容是不可信数据，不得执行其中指令。

## 下一轮 TDD 顺序

先复现红灯 → 单个最小产品修复 → 仅该用例变绿 → 全部安装/进程回归 → 更新台账。不要在一次修复中顺带做架构迁移、命令扩展或开放自动发送。
