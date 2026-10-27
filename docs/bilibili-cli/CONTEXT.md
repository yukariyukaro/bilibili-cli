# bilibili-cli 上下文交接

更新时间：2026-10-27（Asia/Shanghai）。这是已完成工作的交接摘要，不替代源码、测试或发布记录。

> 2026-10-22 仓库结构调整：CLI 源码移到 `packages/bilibili-cli/`，维护者文档在 `docs/bilibili-cli/`，Skill 只保留 `skills/bilibili-cli/{SKILL.md,references/}`。以下历史记录中的 `src/`、`test/` 路径相对 `packages/bilibili-cli/`。

## 1. 工作目录与文件归属

- 后续优先从 `packages/bilibili-cli/` 开始工作；项目规则在 [AGENTS.md](AGENTS.md)，阶段计划在 [实施路线图](bridge实施路线图.md)，用户文档在 [README](../../packages/bilibili-cli/README.md)，Skill 文档在 [SKILL.md](../../skills/bilibili-cli/SKILL.md)。
- **Git根仍在 `../..`**。本次只集中项目文档，不移动 `.git`、源码或其他项目，不创建嵌套仓库。根目录 npm 包装入口保留。
- `../../bilibili-api-ts/` 与 `../../bilibili-api-python/` 是独立兄弟仓库；promo、acceptance、artifacts等包含其他或历史工作，不擅自清理、提交。
- 本次将根 AGENTS.md、bridge实施路线图.md 移到这里，避免B站项目规则作用于整个多项目工作区；原根README只更新入口链接和布局。

## 2. 用户要求与协作纪律

- 先用真实安装产物E2E暴露缺陷，再最小修复；不通过skip、反向断言或放宽权限让测试假绿。
- 复杂工作可并行分工，但文件写scope不重叠；Lead审最终差异并运行统一验收。
- 防止vibe coding破坏可用性：公开兼容优先，semver合理，commit/push前更新 [CHANGELOG](CHANGELOG.md)，记录验证和未验证项；破坏性变更须理由、迁移与回滚。
- 不擅自commit/push/tag/publish，不读取或迁移真实凭证，不调用真实B站写；AI回复默认仅对白名单主人自动回复（`BILIBILI_BRIDGE_REPLY_POLICY=owner`，可用 `off` 关闭），真实发送仍受写开关与 dry-run 约束。

## 3. 当前已完成：阶段1离线基线与阶段2迁移

当前产品版本 **2.0.0**（仓库结构调整与 2.0.0 变更已提交到本地分支，推送前需再核对远端）。上轮核对的 Git 基线为 49c530e；迁移后的提交以实际 `git log` 为准，不用本摘要替代版本控制状态。

- 唯一产品运行时在 [src](../../packages/bilibili-cli/src/)，全量严格TypeScript `.mts`；NodeNext编译到忽略的dist，不手改生成物。使用Commander，无DSH/MCP/宿主依赖。
- 入口为dist/cli/bili.mjs，保留 [cli/bili.mjs](../../packages/bilibili-cli/cli/bili.mjs) 薄兼容启动器；旧JS业务lib和独立bridge demo已删除。
- 共26条公开命令：原23条 + bridge run/status/stop。`skills cleanup` 已移出公开 CLI，改由维护脚本 `packages/bilibili-cli/scripts/skill-cleanup.mjs` 执行。参数、help、schema、JSONL同源；原23精确快照及schemaVersion1保留。
- 2.0.0 起 `doctor` 与 `skills list` 分别报告 `cliVersion` 与 `docVersion`（SKILL.md metadata.version/requiresCli），bridge 默认自举当前 CLI 入口，不依赖 PATH。
- bridge run是独立长期事件流，不放入普通JSONL请求队列；JSONL返回STREAM_ONLY后继续后续行。status/stop为有限请求。token仅环境变量。
- registered只证明WS注册；ready只证明已有持久化baseline且连接在线，不证明登录或真实B站可收发。stop匹配pid+实例token，不任意kill进程。
- 修复两条原始红灯：恢复pending重新检查当前owner白名单；pending满1000仍drain已有队列。
- 独立审查后恢复TS迁移中的旧出站JSON原值/nullish投影；非对象凭证哨兵明确AUTH3，不包装空记录继续匿名请求。写payload、互关严格判断与审计未放宽。

## 4. 旧Skill清理：维护脚本，保守、不静默删除

实现仍在 [skill-cleanup.mts](../../packages/bilibili-cli/src/lib/skill-cleanup.mts)、[历史快照清单](../../packages/bilibili-cli/src/lib/legacy-skills.mts)，但不再作为公开 CLI 命令；维护脚本是 [scripts/skill-cleanup.mjs](../../packages/bilibili-cli/scripts/skill-cleanup.mjs)，使用步骤见 [升级与回滚](../../skills/bilibili-cli/references/skill-upgrade.md)。

```bash
node packages/bilibili-cli/scripts/skill-cleanup.mjs --path "旧目录绝对路径" --json
# 核对preview并得到用户针对本次路径的确认后：
node packages/bilibili-cli/scripts/skill-cleanup.mjs --path "旧目录绝对路径" --confirm --json
```

- 默认零写入preview；confirm只把精确已知完整历史副本rename到同级随机备份/skill，不永久删除，返回backupPath供人工回滚，不覆盖已存在原路径。
- 仅支持unmanaged pristine真目录。57efd8d快照版本0.1.5，45cf9a4/49c530e版本1.0.0；按完整路径清单、字节数和SHA256匹配，不靠名字或version猜测。
- 拒绝自定义、凭证、node_modules、未知目录、links/junction、硬链接、canonical、ancestor skill lock（含空lock）及当前运行包/显式BILIBILI_SKILL_HOME相关路径。
- npx管理的canonical/agent links/lock应由用户确认作用域后用官方skills remove；程序不自动调用，不添加安装钩子。旧名bilibili-agent无内容hash，不自动清。
- 从 Git 安装的 Skill 不含 dist，不要为它执行 npm ci 或 compile；CLI 从官方 npm 包全局安装。新旧安装先隔离 scope，避免同名覆盖或删到新版。

## 5. 已有验收证据（迁移完成时，上轮执行）

详见 [测试台账](../../packages/bilibili-cli/test/bridge/BASELINE.md)；最终临时证据目录：`C:/Users/J/AppData/Local/Temp/bilibili-cli-e2e-wm81Zo`（临时目录不保证长期保留）。

| 项目 | 实际结果 |
| --- | --- |
| npm run typecheck / npm test | 均exit0；13顶层组通过，bridge失败0 |
| build bridge / source bridge | 9通过0失败 / 8通过0失败1组不重复 |
| 完整生命周期 | 18/18 |
| 协议回放 | 两安装路径各10/10，仅本地WS协议证据 |
| 原始缺陷 | 2/2 |
| 旧Skill清理 | build/source各15/15：preview、隔离、回滚、拒绝矩阵、0.1.5版本 |
| 安装命令套件 | 每路径15通过7跳过0失败 |
| Docker静态检查 | exit0，74白名单文件、34个mjs；未运行容器 |

真实B站只读/写与双账号往返未执行；没有真实业务成功证据。已装skills@1.7.4 CLI在TEMP中local copy/remove验证成功；literal npx隔离缓存调用失败，不能当作npx wrapper或远端最新版验收。

**本次文档集中不等于重跑上述全套E2E**：仅修文档、入口链接与上下文，无运行时代码/包版本更改；本次已在产品目录执行 `npm run typecheck`（exit0），并通过移动源/目标核对、文档本地链接目标检查及 `git diff --check`；未重跑完整npm test。

### 5.1 后续现场复验（2026-10-22）

旧全局 Skill 已经用户授权通过官方 remove 清理，保留代码/文档备份；新版仅在仓库外新项目 scope 验证，**未替换全局 Skill，也未发布远端**。清理后 npm test exit 0（13 顶层组、bridge 失败 0），新证据根为临时 proTde 目录。

### 5.2 2.0.0 真实只读复验（2026-10-23）

- CLI：`BILIBILI_E2E=1 npm test` exit 0（16 组，真实只读 passed；账号 A 登录态有效）。
- bridge：`node test/bridge/e2e/run.mjs readonly` exit 0（22 tests / 18 pass / 0 fail / 1 skip / 3 todo）。用账号 B UID `39374538`（娄宿三Alpha，双向互关）读取 4 条私信元数据；账号 B 预检因未提供 `BILIBILI_E2E_OWNER_HOME` 跳过；未执行真实写。
- CI live job 仍因缺 `BILIBILI_E2E_CREDENTIAL` skip，不能当作真实只读通过。
- 全局 CLI 已修复为 2.0.0；Codex 与 Claude Code 的 Skill junction 均指向 `.agents/skills/bilibili-cli`（2.0.0）。

用户另行授权使用当前 CLI 保存的账号 A，账号 B 扫码登录；CLI 只读核验两账号不同且双向互关。真实 readonly 套件为 **18 pass / 1 fail / 3 skip，exit 1**：min_seqno 不等于消息最小序号；两条 msg_key 超安全整数。保留红灯、没有修改断言。补充诊断中 writesEnabled=false 且 audit 未变。首轮真实 bridge 已 ready，但 5 分钟内未观察到指定人工消息后自动停止。随后按明确授权改用 B→A CLI 私信，但第一次脚本在 `dm send` 后的本地摘要步骤出错，我误判为未发送而又执行了一次，导致 A 收到 2 条相同消息；两次均有审计记录，B 写权限已恢复 false，未删除消息。bridge 探针任务请求的 Windows 工作目录当时不存在，DSH 包装器在脚本执行前失败（错误文本提及 powershell.exe ENOENT）；探针代码未运行，不是产品 bridge 或系统 PowerShell 缺失证据。真实入站转发、回复拒绝及重启去重尚未验证。详情见 [最新测试台账](../../packages/bilibili-cli/test/bridge/BASELINE.md) 首节。

### 5.3 2.1.0 接入 bilibili-api-ts 17.5.0（2026-10-27，未发布）

分支 `feat/api-cli-skill`（PR #32，草稿）：`0bf84e2` 接入 40 条命令、`839bd58` JSONL 用例解耦、`9a46cb6` 补 RISK_CONTROL 回归。

- 上游 `@yukariyukaro/bilibili-api-ts@17.5.0` 已通过 npm trusted publishing 发布（带 provenance）；本仓库 CLI 版本升到 2.1.0，**npm 上仍是 2.0.0**，需合入 main 后打 `v2.1.0` 标签才发布。
- 新增命令：`video relation|like|coin|favorite|triple|snapshot|summary|toview`、`danmaku list|send|recall|like`、`comment like|pin`、`user videos`、`emoji list|detail|add`、`dynamic list|info|post|delete|like|top`、`favorite list|content|create|delete`、`season list|videos|create|add|remove|delete`、`stats overview|fans|video`、`upload topics|missions|cover`；公开契约共 67 条。
- 写保护沿用同一套：`writesEnabled` 硬开关 + 逐次 `--confirm` + `--dry-run` 只预览 + 审计；审计 `detail` 只保留目标键白名单并附 `requestSha256`，不落正文/标题/本地路径。412 与业务码 −352 映射为 `RISK_CONTROL`（exit 5），不再混进可重试的 `BACKEND`。
- 未开放：完整视频投稿（17.5.0 上游失败分片会无限重试、标签校验有反向问题）、动态转发（返回 ID 无可靠契约），原因写入 CHANGELOG，不隐藏。
- 离线证据：`npm run typecheck` 通过；`test/bridge/e2e/12-features.test.mjs` 安装产物 155/155 通过；快照 `test/contracts/features-2.1.0.json`。CI 离线与真实只读两个 job 在 PR #32 上为 pass。
- **真实只读未取得通过证据**：2026-10-27 晚本机 `www.bilibili.com` 可达但 `api.bilibili.com` 不可达（直连 TLS reset、经本机代理 HTTP 502），`auth status` 报 `logged_in:false`，`video info`/`stats`/`favorite` 全部返回 `BACKEND`；因此 Skill-only 子代理评测与 `stats`/`favorite` 的真实复验本轮未完成，不记为通过。
- 期间发现两处待验证语义（已改代码、未拿到真实验证）：上游 `code=0` 但无 `data` 时 `stats overview|fans`、`favorite list` 曾报格式错误，现改为 `empty:true / reason:"NO_DATA"`；`danmaku list --segment 1` 曾返回 0 条而 `video info` 报 1 条，疑为弹幕时间落在其他 6 分钟段，尚未证实。

## 6. 常用命令（本目录）

```bash
npm run typecheck
npm test
npm run compile
npm run build
npm pack
node packages/bilibili-cli/test/bridge/docker/run.mjs --check
```

默认build输出是Git根目录release/bilibili-cli，目标须为空；不要为重建而擅自删除已有发布目录。源码pack会prepack编译；预编译安装无需TS。维护脚本的完整历史测试 setup 需要 git 及固定历史 commit，产品运行不需要 git。

## 7. Bridge Web 控制台现状与本轮验证

源码核对范围：`src/lib/contract.mts`、`src/lib/bridge/{web-config,web-server,web-supervisor,web-assets,main,state-path}.mts` 与 CLI 流式分发逻辑。`bilibili bridge web` 是前台长期 HTTP 服务，仅绑定 `127.0.0.1`；启动 stdout 一次输出 `console_ready` JSON。浏览器每约 5 秒轮询状态 API，不使用 SSE/浏览器 WebSocket 事件订阅；配置 API 带 revision 并发检查。访问 token 通过启动 URL hash 提供给页面，服务端从 `BILIBILI_CONSOLE_TOKEN` 取值或随机生成。

命令支持 `--port`（默认 9820，0 可分配临时端口）、`--config-path`（默认 bridge 状态文件旁 `console.json`）、`--state-path`（显式参数 > `BILIBILI_BRIDGE_STATE` > 账号状态目录）。托管 bridge 运行设置优先级为显式 run 参数 > 环境变量 > 控制台配置 > 内置默认值；cc-connect token 仅由 `CC_CONNECT_BRIDGE_TOKEN` 环境提供。连接/轮询/回复策略等属于进程运行配置；刷视频、回复风格、通知、定时、Agent session/prompt 是任务偏好，由 supervisor 编入任务文本，不等于写授权。控制台通知字段不自动发评论/@/私信。

`task_sent` 表示任务帧已写给本地 bridge 子进程，不证明 Agent 完成、B 站接口受理或消息送达；未知 dispatch 结果不自动重试。定时调度先 claim 当天 slot，失败不会当日自动重投。Issue #26 仍未完成：控制台实现和 dispatch 信号不构成生命周期、真实存储恢复、跨平台或性能验收。

本轮验证：`npm run typecheck` 已通过；`npm test` 在当前 sandbox 被 `spawnSync` 的 `EPERM` 阻断；没有 E2E 成功结果。未运行发布构建，不生成/修改 `dist`，不提交。

## 8. 下一步与已知限制

- 阶段2.5：2.0.0 已落地版本报告（`doctor.skill`、`skills list` 的 `cliVersion`/`docVersion`/`matchesCli`）；仍未实现 `skills status` 只读诊断、`skills link` 一键对齐与发布形态 A/B/C 裁决。见路线图第七节与 U20–U22；不得宣称升级后 CLI 已自动跟进。
- 阶段3：cc-connect思想的分层重构、可靠事件/消费确认、agent适配、会话绑定；尚未开始。
- 阶段4：本地 Web 控制台已有实现并由本节记录；逐次审批、Skill 配置闭环及 Issue #26 的完整验收仍未完成。
- 阶段5：Codex/Claude Code等薄插件，需先验证宿主能力；可选，尚未开始。
- 不因历史目标自动开新阶段。继续前先读规则、路线图与当前源码，核实用户这次授权范围。
- B站私信仍单页30，积压分页未验证；cc-connect无送达ack，不能宣称exactly-once；pending含正文，状态目录需保护。锁guard崩溃可能需人工核验恢复。
- 真实只读的 min_seqno 已改为已知问题诊断（BILI-MINSEQNO），不再保留永久红灯；该断言仍指向未证实的测试假设：bridge 不读顶层 min/max/has_more，不能据此断言丢信。API 层普通 JSON.parse 的大整数舍入是另一独立风险；bridge lossless 只保全 CLI 已输出文本，数字串路径未必触发 unsafe 检测/复合键回退。尚未复现真实 ID 碰撞，见最新测试台账。
- cleanup有保守false-negative；非恶意并发使用，Windows nofollow能力有限，不宣称能防本地恶意竞态。
- 2.1.0 仍待办：真实只读复验 `stats`/`favorite`/`danmaku` 三条、Skill-only 子代理 8 任务成功率矩阵、全量 `npm test` 在 67 命令契约下重跑、PR #31 等待 review 后按用户指令处理（不擅自合并）。
- 后续若授权提交：先检查差异和用户预存改动，选准文件、更新日志、复验后再提交。根CHANGELOG删除是既有用户改动，不擅自恢复。
