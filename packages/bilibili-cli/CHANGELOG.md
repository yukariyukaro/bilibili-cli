# 更新日志

遵循语义化版本。未验证、未发布的变更保留在 Unreleased，不用更新日志代替测试证据。

## Unreleased

### 破坏性变更

- bridge 默认回复策略从“全拒绝”改为 `owner`：白名单主人会收到自动回复。真实发送仍需
  `writesEnabled=true` 且 `BILIBILI_BRIDGE_DRY_RUN=false`；升级后如不希望自动回复，设
  `BILIBILI_BRIDGE_REPLY_POLICY=off`。回滚：删除该变量或回退本版本，行为回到全拒绝。

### 新增与变更

- bridge 回复策略改为可配置：`BILIBILI_BRIDGE_REPLY_POLICY=off|owner|draft`（默认 `owner`，
  白名单主人直回、数量不限；非白名单对端在 adapter 入口拒绝；`draft` 写入 state 同目录
  `drafts.jsonl` 供审阅、不投递）。
  超长回复按 `BILIBILI_BRIDGE_REPLY_MAX`（默认 300，可调 1–300，与 CLI `dm send` 契约上限一致；超出会以 CONFIG 拒绝启动）截断并加省略号，不再整条拒绝。
  thinking 与最终文本由 agent adapter 分离；bridge 不改写正文，检测到混入 content 的带标签思考块时 fail-closed 拒绝并告警。
- bridge 转发私信时在 `content` 前加一行来源头（`[B站网友私信 sender=<昵称> untrusted=true]`），
  并在帧上新增 `source:{platform,surface,untrusted:true}`。做法对齐 cc-connect 的 `injectSender`，
  只说明来源与不可信，不写人设或回复规则；本地 pending 与去重仍保存原文。自定义人物仍由
  cc-connect 的 `system_prompt`/`append_system_prompt` 负责。

## 2.0.0 — 2026-10-22

### 破坏性变更

- 公开命令 `skills cleanup` 移除（公开命令 27 → 26）；旧 Skill 清理改为仓库维护脚本
  `scripts/skill-cleanup.mjs`，不随 npm 包发布，JSONL 也不再接受该命令。
- 包版本进入 2.x，文档安装范围改为 `@^2`；原有 23 条 B 站内容命令、字段、默认值与
  `schemaVersion:1` 不变。

### 新增与变更

- SKILL.md frontmatter 增加 `metadata.version` 与 `metadata.requiresCli`；`doctor` 增加 `skill` 段，
  `skills list`/`skills read` 返回 `cliVersion`、`docVersion`、`docPath`、`requiresCli`、`matchesCli`。
  `skills list` 保留 `version` 作为 CLI 版本兼容字段。
- `doctor --setup` 真正返回精简运行时装配视图，不再是空开关。
- `schema --json` 为 `bridge run` 的 `pollMs`、`ownerUids`、`url` 标注 `env`/`defaultSource`。
- bridge 默认以当前 node + 包内 `dist/cli/bili.mjs` 自举；移除 PATH `bilibili` 依赖、
  Windows `.cmd` shim 与 `BILIBILI_CLI_COMMAND`。
- 用户文档统一为“检测 → 征得同意 → 全局安装 → 核验”；不做 CLI 的 npx 兜底；
  安装命令只保留在 CLI 契约一处。
- 构建不再生成不会进入 tarball 的 `skill/` 子目录；包描述只描述 CLI；
  状态目录兼容命名写入契约。
- 仓库结构：CLI 源码/测试/脚本移入 `packages/bilibili-cli/`，Skill 只保留
  `skills/bilibili-cli/{SKILL.md,references}`，维护者文档移入 `docs/bilibili-cli/`。

### 修复

- bridge 单实例 recovery guard 改为“临时文件写满后 link 发布”，避免并发启动时读到
  尚未写入内容的空 guard 而误报 `LOCK_RECOVERY`；等待存活 guard 的上限从 150ms
  放宽到 3s，减少慢 runner 上的 `LOCK_BUSY` 误报。损坏、跨主机与 stale guard
  仍然 fail closed，不自动回收。

### 测试

- 新增 test/release/：真实从 npm registry 下载发布包、从 GitHub 下载固定 commit 的 Skill 归档，校验
  shasum/integrity 与逐文件 sha256 后安装，再验证 doctor/schema/skills 契约，并可运行既有 bridge 离线套件。
  支持宿主机（--native，默认）、容器（--docker，fetch 阶段联网、运行阶段 --network none）与 --check 静态校验；
  Docker 不可用报 unavailable，受限环境无法起子进程报 environment-blocked，都不算通过。
- 新增包内脚本 test:release、test:release:check、test:release:docker；不改变已发布命令与输出。
- 文档门禁：安装命令只允许一处、用户文档不得把 npx 当作 CLI 运行方式、命令表与 schema 对齐。
- Docker 验收：bridge/release Dockerfile 同步新布局；release 静态检查新增 COPY 源存在断言。
- MANUAL 用例改 TODO 并与 skip 分开统计；min_seqno 改为已知问题诊断；合并两个单行 re-export；
  清理 E2E 改测维护脚本。
- 新增 `.github/workflows/ci.yml`：PR 与 main 跑 typecheck + 离线 `npm test`；仅在 push main /
  手动触发且配置 `BILIBILI_E2E_CREDENTIAL` 时，把专用测试账号凭证写入 runner 临时隔离目录，
  再跑 CLI 与 bridge 的真实只读 E2E。
- `auth status --json` 增加 `credentialPresent` 与 `stateDir`：自动化据此区分“没有登录态”和
  “凭证可能过期”，不需要读取凭证正文。真实只读 E2E 在登录态缺失/失效时输出
  `live.status=skipped` 并继续跑离线用例，不再把缺登录当成真实只读通过或直接失败。
- skills 刷新工作流改用重构后的 `skills/bilibili-cli/SKILL.md` 与 `skills.sh.json` 引用校验，
  只监听 `skills/**` 与 `skills.sh.json`，不再吞掉 skills CLI 的失败。
- DSH review 的 `@dsh` 触发限定 OWNER/MEMBER/COLLABORATOR，避免任意评论者消耗 API key。
- 发布工作流改为 main 推送触发 + npm trusted publishing（OIDC）：版本未发布时构建、验收并发布，
  已存在则跳过；不再依赖 tag 或 `NPM_TOKEN`。

### 验证

- 本轮收尾验证（2026-10-22）：`npm run typecheck` exit 0；完整离线 `npm test` exit 0（15 个顶层组通过，bridge 失败 0 组，真实只读 `disabled`）。
- 真实只读（账号 A，2.0.0 本地构建）：`BILIBILI_E2E=1 npm test` exit 0（16 组，真实只读 passed；热门、搜索、视频、字幕、评论、用户、通知、私信状态与 `dm send --dry-run` 均通过）。
- `npm test` 内嵌的 bridge 离线 E2E（`node test/bridge/e2e/run.mjs readonly`，exit 0）：22 tests / 15 pass / 4 skip / 0 fail / 3 todo，`status=partial`；同轮 lifecycle 18 项中 1 pass / 17 skip。跳过项为登录态或真实双账号人工确认未提供，不计为通过。
- CI 的 live job 因未配置 `BILIBILI_E2E_CREDENTIAL` 仍 skip，不能当作真实只读通过；本机已用账号 A 跑通真实只读。
- bridge 真实只读（账号 A + 互关账号 B `39374538`）：`node test/bridge/e2e/run.mjs readonly` exit 0，22 tests / 18 pass / 0 fail / 1 skip / 3 todo；用 B 的会话读取 4 条私信元数据。账号 B 预检因未提供 `BILIBILI_E2E_OWNER_HOME` 跳过；未执行真实写。

## 1.1.2 — 2026-10-22

仅文档修正，运行时代码与 1.1.0/1.1.1 相同（同一 `dist/`，命令、参数、输出与 `schemaVersion:1` 不变）。

- 修正 1.1.1 漏发：SKILL.md 与 README 的 npx 示例实际仍写死 `@1.1.1`，本版本统一改为主版本范围 `@1`。
- 补充 npmmirror 说明：`@yukariyukaro/bilibili-api-ts` 在镜像端 tarball 未同步时会 404，安装时加 `--registry https://registry.npmjs.org`。

## 1.1.1 — 2026-10-22

仅文档与安装说明修正，运行时代码与 1.1.0 相同（同一 `dist/`，命令、参数、输出与 `schemaVersion:1` 不变）。

- 技能文档明确入口判定顺序：优先使用已安装的 `bilibili`（全局或本地均可），没有再 `npx`，两者都不可用才如实报告无法运行；不再暗示必须重新安装。
- README 的 npx 示例补充 `--registry https://registry.npmjs.org`：国内默认 npmmirror 时，`@yukariyukaro/bilibili-api-ts` 的 tarball 可能尚未同步，直接安装会 404。
- 更新日志补齐 1.1.0 的实际发布信息（包名、tarball 校验值、npx 验证结果）；文档中的 npx 示例改用主版本范围 `@1`，避免每次发版都留下失效的精确版本。

## 1.1.0 — 2026-10-22

已发布到公共 npm：`@yukariyukaro/bilibili-cli@1.1.0`（`latest`）。发布物是 `npm run build` 生成的独立目录所打的 tarball：35 个文件、含 `dist/cli/bili.mjs`，不含源码、测试或 TypeScript 工具链；SHA-256 `0B256A691E34AF2A1F3D1A1D4F8A2435D0B6F6A14F38631EB8CB6BC12C9F3D47`，`dist.integrity` 为 `sha512-6pHxs5zy5RycMwyA1GlAJx5XQZOxoejq4IKySvBQE5WruchILn4QbAZVlpFSqGQU+nJMy2/dKD3OUAqLfJUNig==`。在全新缓存下执行 `npx --package @yukariyukaro/bilibili-cli@1.1.0 bilibili --version` 返回 `1.1.0`，`doctor --json` 返回 `ok:true`。

### 包名与安装方式

- npm 包名从无 scope 的 `bilibili-cli` 改为 `@yukariyukaro/bilibili-cli`：无 scope 的同名包由其他维护者发布，不是本项目；Skill 名仍为 `bilibili-cli`，命令名仍为 `bilibili`。
- 默认入口改为 `npx --package @yukariyukaro/bilibili-cli@1.1.0 bilibili ...`，全局安装为可选项；使用者不再需要 clone 源码、执行 `npm ci` 或编译。
- 国内默认使用 npmmirror 时，API 依赖的 tarball 可能尚未同步，安装应显式指定 `--registry https://registry.npmjs.org`。

### 新增

- 将 bridge 合入同一 CLI 产品，新增 `bilibili bridge run/status/stop`；run 为独立长期事件流，status/stop 为有限请求。
- 严格 TypeScript 开发与编译检查；发布 JavaScript ESM，使用者不需要 TypeScript 工具链。
- `bilibili skills cleanup --path ...` 默认零副作用预览，明确 `--confirm` 后仅将已知完整历史副本移入同级可回滚备份，不永久删除；拒绝自定义/凭证/依赖/链接及 npx 管理布局。npx 升级文档优先使用官方 remove 维护 links/lock，不添加静默安装钩子。

### 修复

- 恢复 pending 时重新应用当前 owner 白名单，不转发旧配置残留的非授权会话。
- pending 达到容量上限时仍消费已有队列，而非永久停止消费。
- 审查TS迁移时恢复旧版出站JSON的null/原始标量投影，避免类型收窄顺便改变公开输出；非对象凭证哨兵明确AUTH拒绝，不因空记录转换继续匿名请求。

### 文档整理

- 将项目专属 AGENTS.md 与 bridge实施路线图.md 从多项目工作区根移入 skills/bilibili-cli，新增 CONTEXT.md 交接摘要并修正链接；规则仅作用于该产品目录。Git根、npm包装入口与运行时代码不变，本次不额外升版本。
- 在根 README 与 Skill README 明确标注「待做功能」：升级 Skill 后 CLI 同步到同版本、版本一致性检测、一键对齐等尚未实现的交付体验；对应开发项记录在路线图阶段 2.5 与任务台账 U20–U22。仅文档，不改运行时代码、不额外升版本、不构成能力声明。

### 兼容性

- 保持原23条命令名称、字段、默认值与 JSONL 信封，schemaVersion 仍为1；新增命令为兼容扩展。
- 保留文档曾公开的 `node cli/bili.mjs` 薄启动器，委托编译后的唯一实现；CLI 内部实现从 lib 迁至 src/dist，不承诺私有模块导入路径兼容。
- npm 包仍仅注册 `bilibili`；不恢复旧别名，不恢复 DSH/MCP。
- 从 Git 源码开发需 `npm ci` 后编译；源码 `npm pack` 会先编译，预编译发布包安装不执行编译。

### 验证与限制

- 2026-10-22 最终 `npm run typecheck` 与 `npm test` 均exit0：13顶层组通过；构建包bridge9组、源码包8组通过（1组不重复）；完整生命周期18/18、协议10/10、原缺陷2/2、清理双安装路径各15/15。离线进程/命令套件每路径15通过、7跳过、0失败。证据目录wm81Zo，详见测试台账；该轮验证先于本次 npm 发布，发布物由同一构建与打包流程产出。
- 清理先在旧安装暴露缺命令红灯，再在新安装转绿；原23命令精确兼容快照、公开薄启动器、非对象凭证拒绝均通过。旧JS业务实现与独立bridge demo已删除。
- 不自动发送 AI 回复，写开关、逐次确认、互关限制及审计不放宽。
- 只读审查补充：min_seqno 页内最小值断言缺乏服务端契约证据；保留红灯，不视为已确认 bridge 丢信。API 层大整数舍入可能沿数字串进入 bridge 主键去重，现有 lossless 不等于端到端真值保真；记录风险，未宣称已修复或真实碰撞已发生。
- 本机 skills@1.7.4 CLI 在 TEMP 中的本地纯文档 copy 安装/remove 已验证；literal npx wrapper 在隔离缓存下不可用，远端新版尚未提交推送，不能宣称新版远端安装通过。
- 后续现场复验：本地新项目 Skill 安装、旧全局 Skill 官方 remove 与清理后 npm test 已执行（proTde，13 顶层组通过）；未安装新版全局 Skill，远端新版仍未验证。
- 真实双账号只读已执行：18 通过、1 失败、3 MANUAL 跳过，exit 1；保留 min_seqno 边界断言红灯，另发现 msg_key 超安全整数。账号配置未改。真实 bridge 首轮 ready 后等待人工消息超时，已停机；未验证回复拒绝/重启去重。随后按明确授权执行 B→A CLI 私信，但第一次脚本在 `dm send` 后的本地摘要步骤出错，我误判为未发送而再次执行，造成 2 条相同测试消息；B 写权限已恢复 false，未删除消息。bridge 探针请求的工作目录不存在，DSH 包装器在脚本执行前失败（错误文本提及 powershell.exe ENOENT），非产品缺陷；Docker daemon 不可用时仅做静态校验，不计容器通过。

## 1.0.0 — 2026-10-20

- 独立 CLI 与 Skill，统一 `bilibili` 分组命令，采用 TypeScript API npm 包。
- 写操作默认关闭，要求逐次确认并记录尝试和结果审计。
- 构建、打包、临时安装、仓库外 PATH 调用组成发布回归。
- 这是相对于已移除 DSH 插件/旧命令的历史破坏性版本，不是本轮新增的破坏性升级。
