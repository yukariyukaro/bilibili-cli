# 更新日志

遵循语义化版本。未验证、未发布的变更保留在 Unreleased，不用更新日志代替测试证据。

## 1.1.0 — Unreleased（尚未发布）

### 新增

- 将 bridge 合入同一 CLI 产品，新增 `bilibili bridge run/status/stop`；run 为独立长期事件流，status/stop 为有限请求。
- 严格 TypeScript 开发与编译检查；发布 JavaScript ESM，使用者不需要 TypeScript 工具链。
- `bilibili skills cleanup --path ...` 默认零副作用预览，明确 `--confirm` 后仅将已知完整历史副本移入同级可回滚备份，不永久删除；拒绝自定义/凭证/依赖/链接及 npx 管理布局。npx 升级文档优先使用官方 remove 维护 links/lock，不添加静默安装钩子。

### 修复

- 恢复 pending 时重新应用当前 owner 白名单，不转发旧配置残留的非授权会话。
- pending 达到容量上限时仍消费已有队列，而非永久停止消费。
- 审查TS迁移时恢复旧版出站JSON的null/原始标量投影，避免类型收窄顺便改变公开输出；非对象凭证哨兵明确AUTH拒绝，不因空记录转换继续匿名请求。

### 文档整理

- 将剩余路线图实际登记为 [GitHub 总追踪 #21](https://github.com/yukariyukaro/bilibili-cli/issues/21) 与 20 条执行 issues，回填依赖及 U01–U22 覆盖，并在 README/路线图/交接记录提供入口；本次仅文档，无新运行时行为或 npm 发布。
- 2026-10-22 提交检查点：保存既有严格 TS 迁移、bridge 控制命令、cleanup 与安装 E2E，并将阶段 2.5/3–5、真实验收与发布缺口转入 GitHub issues。本提交不是 AI 自动回复完成或 npm 发布声明，1.1.0 仍保留 Unreleased。
- npm 清单使用 `@yukariyukaro/bilibili-cli`，命令名仍为 `bilibili`、Skill 名仍为 `bilibili-cli`；无 scope 的同名 npm 包属于其他维护者。安装测试支持 scoped 布局并增加 tarball 的 npm exec 入口验证。未发布版本的 npx 示例已标明“发布后可用”，当前可用路径为可信本地 CLI 或维护者构建的 tarball。
- AI 自动发送仍未实现：用户选择外部 cc-connect/agent、自动回复及私信/评论两通道，但运行时绑定、权限/限范围/撤销策略与现有逐次确认规则尚需协调。当前代码默认拒绝与既有写保护不变。
- 将项目专属 AGENTS.md 与 bridge实施路线图.md 从多项目工作区根移入 skills/bilibili-cli，新增 CONTEXT.md 交接摘要并修正链接；规则仅作用于该产品目录。Git根、npm包装入口与运行时代码不变，本次不额外升版本。
- 在根 README 与 Skill README 明确标注「待做功能」：升级 Skill 后 CLI 同步到同版本、版本一致性检测、一键对齐等尚未实现的交付体验；对应开发项记录在路线图阶段 2.5 与任务台账 U20–U22。仅文档，不改运行时代码、不额外升版本、不构成能力声明。

### 兼容性

- 保持原23条命令名称、字段、默认值与 JSONL 信封，schemaVersion 仍为1；新增命令为兼容扩展。
- 保留文档曾公开的 `node cli/bili.mjs` 薄启动器，委托编译后的唯一实现；CLI 内部实现从 lib 迁至 src/dist，不承诺私有模块导入路径兼容。
- npm 包仍仅注册 `bilibili`；不恢复旧别名，不恢复 DSH/MCP。
- 从 Git 源码开发需 `npm ci` 后编译；源码 `npm pack` 会先编译，预编译发布包安装不执行编译。

### 验证与限制

- 2026-10-22 本次实际提交快照（scoped 包与 npm exec 回归）重新 `npm ci`、typecheck、npm test 均 exit 0：**14 顶层组通过、bridge 失败 0**；build/source 安装路径、生命周期 18/18、两路径协议各 10/10、原缺陷 2/2、cleanup 各 15/15；证据 Pd62uK。以下 13 组为更早历史记录，不覆盖本次结果。真实只读红灯仍保留，本次未访问 B 站或重发消息，不发布 npm。
- 2026-10-22 最终 `npm run typecheck` 与 `npm test` 均exit0：13顶层组通过；构建包bridge9组、源码包8组通过（1组不重复）；完整生命周期18/18、协议10/10、原缺陷2/2、清理双安装路径各15/15。离线进程/命令套件每路径15通过、7跳过、0失败。证据目录wm81Zo，详见测试台账；当前不是发布声明。
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
