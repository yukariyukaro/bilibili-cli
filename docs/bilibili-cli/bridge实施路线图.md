# bilibili-bridge 实施路线图

更新时间：2026-10-22

文档归属：本文件与 AGENTS.md 位于 `docs/bilibili-cli/`。2.0.0 起仓库结构为 `packages/bilibili-cli/`（CLI 源码、测试、构建）、`skills/bilibili-cli/`（仅 SKILL.md 与 references）、`docs/bilibili-cli/`（维护者文档）。下文带 `skills/bilibili-cli/src/`、`skills/bilibili-cli/test/` 等前缀的段落是 1.2.0 之前的历史状态记录，不代表当前布局；Markdown 链接按本文件当前位置解析。

> 2.0.0（2026-10-22）变更：公开命令移除 `skills cleanup`，改由维护脚本 `packages/bilibili-cli/scripts/skill-cleanup.mjs` 执行；bridge 改为自举当前 CLI 入口；`doctor` 与 `skills list` 报告 Skill 文档版本。下文“27 条命令”“cleanup 已落地”等描述是变更前的历史状态。

执行记录（2026-10-22 最终）：阶段 1 离线基线完成（真实账号 E2E 未验）；阶段 2 本轮迁移、清理与安装验收完成，尚未发布。Lead 执行 `npm run typecheck && npm test` 为 exit 0（wm81Zo）：13 个顶层组通过、bridge 失败 0；build bridge 9 pass/0 fail，source 8 pass/0 fail/1 skip；生命周期 18/18（root PID registered 后真实 Node），协议两路径 10/10，安装命令套件每路径 15 pass/7 skip/0 fail，原缺陷 2/2，cleanup 双路径各 15/15，非对象 credential 的 AUTH 哨兵通过；Docker `--check` exit 0（74 白名单/34 mjs），daemon 实际未运行。旧 `lib/*.mjs` 与 `bilibili-bridge/` demo 已删除，仅保留 `cli/bili.mjs` 薄 shim。阶段 3–5 未开始。远端仍为旧提交 `49c530e`，1.1.0 未 commit/push；literal npx 离线 wrapper 未验，不能宣称远端 npx 新版可验证。当前包版本 1.1.0 Unreleased，不是发布声明。测试入口、历史结果与证据缺口见 [测试台账](../../packages/bilibili-cli/test/bridge/BASELINE.md)；真实账号验收未执行时不宣称真实收发已验证。

## 一、本文范围

本文记录 bridge 与 CLI 的整合、端到端测试、架构改造和可选的 coding agent 插件适配计划。阶段 0–2 已进入实施：阶段 2 的产品源码、命令与构建流程已按严格 TypeScript 落地；阶段 3–5 仍是未完成的计划或提案，不能当作已实现。2026-10-22 新增阶段 2.5「升级 Skill 即同步 CLI」，与阶段 3–5 一样属于未开始的待做项，详见第七节。本文区分“已落地”“进行中”“未开始”，不把计划、原型或讨论结果记成验收通过。

总体目标：用户通过 Skill 或插件完成配置，选择绑定的 coding agent 与会话，在可视化界面中查看运行状态并启停监听；底层只有一套 B 站能力、一份账号同步状态和一套写保护。

## 二、任务顺序

| 顺序 | 阶段 | 当前状态 | 对应原始任务 | 原因 |
| --- | --- | --- | --- | --- |
| 0 | 固定边界和验收契约 | 部分完成：首版命令、有限/长流边界、退出码与 schema 已固化；会话绑定与审批契约属阶段 3–4 | 四项任务的前置 | 先确定包、命令、会话和权限边界，避免测试和重构各自假设不同的产品 |
| 1 | 建立 bridge × CLI 的 E2E 基线 | 完成（离线基线；真实业务未验）：最终全量测试 exit 0，原缺陷 2/2 | 任务 1 | 先建立能发现回归的保护网，不要求先把新架构实现完 |
| 2 | 迁入唯一 CLI 产品源码并统一交付 | 完成（本轮迁移/清理/安装验收；未发布）：27 命令、cleanup 与安装产物 E2E 已验；远端 npx 新版未验 | 任务 2 | 只做搬迁、入口整合和必要适配，用阶段 1 的基线证明没有额外行为变化 |
| 2.5 | 升级 Skill 即同步 CLI | 未开始（发布形态待裁决） | 任务 2 之后的交付体验 | 两套安装面互不感知，升级 Skill 后 `bilibili` 可能仍是旧版；先收敛升级闭环，避免「文档新版、命令旧版」的分叉 |
| 3 | 按 cc-connect 分层思想重构 bridge | 未开始 | 任务 3 | 在稳定安装产物和测试之上逐步替换 demo，而非一次性推倒后才验证 |
| 4 | 完成可视化控制台与 Skill 引导闭环 | 未开始 | 任务 3 的产品交付部分 | 让启停、绑定、审批和故障可见，不把长期维护终端当作正常使用方式 |
| 5 | 评估并交付 Codex、Claude Code 等薄插件 | 未开始（可选） | 任务 4，可选 | 依赖稳定的控制接口；先验证宿主真实能力，再决定插件、hook 或 Skill 的交付方式 |

执行主线：边界确认 → E2E 基线 → 代码迁移 → 分层重构 → 可视化与引导 → 插件适配。

E2E 不是做完一次就结束：先建立基线，迁移后复验，重构每一小步补充回归，最终再做发布验收。

## 三、当前事实与计划边界

- 唯一 CLI 与 bridge 产品源码位于 `packages/bilibili-cli/src/`，使用严格 TypeScript（`.mts`），编译到 `dist/`。旧 `skills/bilibili-cli/lib/*.mjs` 与 `bilibili-bridge/` demo 已删除，不再是第二份运行时实现；仅保留 `cli/bili.mjs` 兼容薄启动器。
- 当前公开命令 26 条：原 23 条 + `bridge run/status/stop`。run 是独立长期事件流，status/stop 是有限控制请求；`skills cleanup` 已移出公开 CLI，改由维护脚本执行。`run` 不能放进 `bilibili --jsonl`，会快速返回 STREAM_ONLY（退出码 2），后续行继续处理；原 23 条命令名称/字段/默认值/信封不变。
- bridge 默认用当前 node 可执行文件 + 包内 `dist/cli/bili.mjs` 自举子进程，并连接 cc-connect；不再要求 PATH 上存在 `bilibili`，也不打包 cc-connect 的 Go 引擎。不能把“仿照 cc-connect 架构”误解成“已经具备同等分层”。
- 发布包入口是 `dist/cli/bili.mjs`；`cli/bili.mjs` 仅保留为兼容薄启动器。版本由包根 `package.json` 单一来源驱动，当前 1.1.0 Unreleased。
- 最终回归（Lead，`npm run typecheck && npm test`）exit 0：13 个顶层组通过、bridge 失败 0；build bridge 9 pass/0 fail，source 8 pass/0 fail/1 skip；生命周期 18/18（root PID registered 后真实 Node），协议两路径 10/10，安装命令套件每路径 15 pass/7 skip/0 fail，原缺陷 2/2，cleanup 双路径各 15/15，非对象 credential 的 AUTH 哨兵通过。Docker `--check` exit 0（74 白名单/34 mjs），Docker daemon 实际未运行。typecheck 0，运行时源码已冻结。
- 阶段 1 离线基线完成；真实账号只读/写 E2E 未执行，不宣称真实收发通过。两条历史红灯（pending 白名单/顺序、饱和排空）已修复并由 2/2 回归覆盖。
- 清理边界：历史快照按 per-snapshot 返回版本（`57efd8d` = 0.1.5，`45cf9a4`/`49c530e` = 1.0.0）；仅处理 unmanaged pristine 真目录，`npm ci` 后含 node_modules 拒绝，canonical 或任意 ancestor lock 存在即拒（含空 lock，保守 false-negative）；`O_NOFOLLOW` 平台不跟随最终文件 link，Windows 用 `O_RDONLY` + 前后 `lstat/fstat` 的 inode/mode/nlink/size/mtime/ctime 复核，属非对抗恶意并发边界；纯文档 fixture 固定 LF（`.gitattributes`）。旧名 `bilibili-agent` 只有文字记录、无 hash，不自动清。官方 `npx skills remove` 是 managed 安装的主路径；literal npx 离线 wrapper 未验，直接安装 skills 1.7.4 的临时 local copy/remove 已验证。
- 回复策略默认 `owner`（仅白名单主人直回，`off` 可关闭），没有逐次确认交互；不能为了让往返测试通过而自动同意发送。写开关、互关限制、收件人锁定和审计继续有效。
- 本地 Python/TS API 目录属于独立兄弟仓库，不复制进 CLI，也不纳入本仓库的迁移任务。
- 阶段 3–5（分层重构、绑定与 agent、Web 控制台、宿主插件）未开始，不自动实现。远端仓库仍是旧提交 `49c530e`，1.1.0 未 commit/push；不能宣称远端 npx 新版可验证，也不能用本地 local copy 结果替代远端 npx 证据。

当前采用一个 npm 包、一个 `bilibili` 命令入口，bridge 作为包内独立子系统按需加载。源码位于 Skill 目录内不等于运行时代码写进 Skill 文档；产品源码在 `src/`，Skill 文档与运行时保持分离。

宿主插件代码不进入 CLI 产品依赖树，也不恢复已移除的 DSH 宿主和 MCP 层。未来独立插件的仓库位置和分发方式需单独确认。

## 四、阶段 0：固定边界和验收契约（部分完成）

### 工作项

- 明确首个闭环以私信为主，评论作为后续独立增量，不在一次重构中同时扩展直播等能力。
- 固定包内 bridge、B 站能力层、agent 适配器、可视化控制面的职责。
- 定义有限请求与长期事件流的区别，避免把无限事件流塞进现有 JSONL 请求/响应处理队列。
- 定义启动就绪、停止完成、连接失败、默认拒绝、接口受理、状态未知等机器可读状态。
- 定义绑定对象：B 站账号与会话、agent 类型、工作区、原生会话 ID、显示名称和在线状态。
- 原生会话恢复、列举和新建属于可选能力；不支持时明确说明，不伪造宿主 session ID。
- 区分共享已有会话与创建专用会话，默认建议使用专用桥接会话；不得并发写入同一个原生会话。

### 验收标准

- 首版 CLI 命令、`bridge run` 长期流与 `status/stop` 有限请求的边界已经固化，并与 schema/JSONL 共用契约。
- 会话绑定、agent 适配、逐次审批等跨阶段契约尚未完成，归入阶段 3–4；不能把首版命令契约当成全部阶段 0 已完成。
- 形成明确的接口与状态约定，测试预期和实现引用同一契约。
- 现有 `AGENTS.md` 与拟实施方案的冲突逐项确认；规则修改和代码变更一起审核，不为通过测试删除安全限制。

## 五、阶段 1：建立 bridge × CLI 的 E2E 基线（离线基线完成；真实业务未验）

### 工作项

- 审查并修正已有测试：事件格式、正文 JSON 解码、消息顺序、启动基线、就绪信号、状态目录传递和配置清理。
- 测试必须构建、打包并临时安装真实 CLI，离开仓库，通过 PATH 调用 `bilibili`；不能只导入源码函数验证。
- 迁移前测试当前 bridge 进程与安装后的 CLI；迁移后保持场景不变，替换为统一发布入口。
- 默认离线验证安装闭包、帮助/schema、参数拒绝、禁写和 dry-run、服务启停、单实例、进程退出、请求超时与状态恢复。
- 无后端条件下可验证本地控制面与传输协议，但不得用模拟 B 站后端证明真实收发成功；协议验证与真实业务验收分别报告。
- 真实只读回归必须显式启用；真实写回归另设入口，不能复用仅表示只读授权的开关。
- 每次真实写操作仍须用户确认准确目标和最终正文，不自动修改写开关，不迁移凭证，不自动重试未知写状态。
- 验收真实往返时区分发送方接口受理与接收方实际收件；无法独立核验时如实标注证据边界。

### 必测场景

| 范围 | 场景 |
| --- | --- |
| 消息正确性 | 真实字段解码、稳定去重、过滤自身消息、正序处理、大整数 ID 精度 |
| 生命周期 | 注册完成再消费、连接中断、子进程失败、停止清理、重复启动 |
| 持久化 | 首次基线、重启续读、写盘失败、状态损坏、待处理消息恢复 |
| 写保护 | 默认拒绝、取消确认、白名单、CLI 禁写、审计失败、状态未知不重发 |
| 交付 | 中文空格路径、PATH 调用、源码打包和构建产物打包一致性 |

### 验收标准

- 默认回归不连接 B 站、不产生真实消息副作用。
- 原有 CLI 回归不退化，bridge 测试纳入明确的统一测试入口。
- 已通过、已跳过、失败和待人工验证的场景分别输出；不以 mock 通过替代真实验收。
- 当前状态：历史基线结果与两条红灯记录在 [测试台账](../../packages/bilibili-cli/test/bridge/BASELINE.md)。最终 `npm run typecheck && npm test` exit 0：13 个顶层组通过、bridge 失败 0；build bridge 9/0，source 8/0 + 1 skip；生命周期 18/18，协议两路径 10/10，安装命令套件每路径 15 pass/7 skip/0 fail，原缺陷 2/2。离线基线据此关闭；真实账号只读/写 E2E 未执行，不宣称真实收发通过。

## 六、阶段 2：迁移进 CLI 产品源码（本轮迁移/清理/安装验收完成；未发布）

### 当前实际布局

```text
skills/bilibili-cli/
  src/
    cli/bili.mts
    lib/
      application.mts  command.mts  contract.mts  cli-types.mts
      version.mts      runtime.mts  portable.mts  login.mts
      service.mts      service-types.mts
      skill-cleanup.mts  legacy-skills.mts
      bridge/
        main.mts  control.mts  control-plane.mts  state.mts  state-path.mts
        adapter.mts  backend.mts  bridge.mts  guards.mts  ids.mts
        json.mts  orders.mts  types.mts
  cli/bili.mjs               # 兼容薄启动器：import ../dist/lib/command.mjs，不含业务实现
  dist/                       # 编译生成的 JavaScript ESM（忽略，不手工编辑）
  test/bridge/                # offline/e2e/lifecycle/regressions/docker 与统一入口
  scripts/                    # compile/build/closure/verify 等 Node 脚本
  tsconfig.json  package.json  SKILL.md  references/  CHANGELOG.md
```

说明：

- 运行时唯一实现是 `src/` 的严格 TypeScript，发布前编译到 `dist/`；安装产物不需要 TypeScript。
- 目录树中的 `web/` 尚未创建；阶段 4 的控制台仍属设计。
- 旧 `skills/bilibili-cli/lib/*.mjs` 与 `bilibili-bridge/` demo 已由 Lead 在迁移绿灯后删除；只保留 `cli/bili.mjs` 薄启动器。纯文档历史 fixture 以 LF 固定（`.gitattributes`）。

### 已实现的命令与入口

| 命令 | 类型 | 实际行为 |
| --- | --- | --- |
| `bilibili bridge run` | 长期事件流 | 前台运行，stdout 输出生命周期 JSON（`registered`/`ready`/`error`/`stopped`）；可选 `--state-path`、`--owner-uids`、`--url`、`--poll-ms`（6000–2147483647，schema 默认 6000）；token 仅从 `CC_CONNECT_BRIDGE_TOKEN` 读取；owner/url/poll 可由环境变量回退，显式参数优先；信号由 bridge 持有，CLI 映射 130/143；不能放进 `--jsonl` |
| `bilibili bridge status` | 有限请求 | 可选 `--state-path`；返回 `{running, pid?, statePath}`；不启动服务、不创建状态目录 |
| `bilibili bridge stop` | 有限请求 | 可选 `--state-path`；向同一状态路径实例写 stop 标记并等待优雅停止；未运行幂等；超时/坏锁抛结构化错误（如 `STOP_TIMEOUT`、`LOCK_UNREADABLE`），退出码 2 |
| `skills cleanup`（2.0.0 起维护脚本） | 本地隔离 | 已移出公开 CLI；改由 `node packages/bilibili-cli/scripts/skill-cleanup.mjs --path <绝对路径> [--confirm] --json` 执行，语义不变 |
| `bilibili schema` / `--help` / `--jsonl` | 契约共用 | 27 条命令共用同一份 contract；`run` 为 `stream:true`；JSONL 中 `bridge run` 先校验字段再返回 STREAM_ONLY，后续行继续 |

安装入口：`package.json` 的 `bin.bilibili` 指向 `dist/cli/bili.mjs`；`cli/bili.mjs` 仅为兼容启动器。版本、帮助、schema 与 `skills list` 均读取包根 `package.json`，不再散落硬编码。

### 工作项

- [x] 将 bridge 运行时迁入 `src/lib/bridge/`，同步迁移测试与资源，不保留第二份运行时实现。
- [x] 暴露统一的 `bilibili bridge ...` 命令组；run 为长流，status/stop 为有限请求；三者与旧命令共用 contract/help/schema/JSONL。
- [x] bridge 的 B 站读写继续通过已安装 CLI 的 `--jsonl` 应用执行层，保留参数校验、互关限制、写开关与审计。
- [x] `status/stop` 在获取应用 context 之前按需加载控制模块；帮助、schema、status 不创建凭证或状态目录。
- [x] 严格 TypeScript：`tsconfig.json`（NodeNext/strict）、`scripts/compile.mjs`、`dist/`、`prepack` 编译；源码与发布包均可安装。
- [x] 版本单源与 `CHANGELOG.md`：当前 1.1.0 Unreleased；原 23 条命令保持兼容，新增命令为 additive。
- [x] poll 配置语义：仅显式 `--poll-ms` 覆盖环境；未提供时由 bridge main 读取并校验 `BILIBILI_POLL_MS`。
- [x] 旧 `lib/*.mjs` 与 `bilibili-bridge/` demo 已由 Lead 在迁移绿灯后删除；仅保留薄 shim，无第二实现、无旧入口。
- [x] 包清单、锁文件、构建复制、发布文件列表、依赖闭包与构建产物路径已通过最终 build/source 双路径安装回归；`release/` 仍只由构建生成。
- [x] 实现旧版 Skill 清理 `skills cleanup`：官方 `npx skills remove` 为主路径；自制品只处理 unmanaged pristine 真目录；默认 preview、confirm 同级隔离、可手动回滚；本地双路径 15/15。
- [x] 最终全量 `npm run typecheck && npm test` exit 0（13 顶层组通过、bridge 失败 0）；离线阶段 1/2 据此收口。
- [ ] 远端 npx 新版验证（外部未验，不计入本轮阶段 2 本地验收）：当前远端仍为 `49c530e`、1.1.0 未 commit/push；literal npx 离线 wrapper 未验。需 push 后使用独立 scope、安装后 `npm ci`/`npm run compile`，不得用 local copy 结果替代。

### 旧版 Skill 清理：官方 remove 优先，自制品范围受限（本地验收完成；远端 npx 未验）

`skills cleanup --path <绝对路径> [--confirm]` 在 1.1.0 实现并纳入当时 27 条命令；2.0.0 起移出公开 CLI，改由维护脚本执行。默认预览；confirm 只把已知完整历史副本在同级 rename 到可回滚隔离位置，不永久删除。官方 `npx skills remove` 仍是 managed 安装的主路径。

#### 安装布局与主路径

- `npx skills add` 默认创建 `.agents/skills` canonical 副本，并维护 agent links 与 skill lock。canonical 目录与 lock 属于官方安装器的管理范围。
- 主路径优先使用官方移除命令：`npx skills remove bilibili-cli`；全局安装场景使用官方支持的 `-g` 形式。由官方工具负责 links/lock 的一致性，不能用自制逻辑替代。
- 自制 cleanup 必须拒绝 canonical 目录以及任何 ancestor skill lock（包含空 lock，保守 false-negative）：否则会留下 dangling agent links，或与官方安装器争用同一份状态。发现 managed 安装时提示改用官方 remove，不自行删除。

#### 自制 cleanup 的允许与拒绝范围

- **绝对显式 path / 显式 roots**：只接受调用方明确传入的绝对 Skill 安装路径；不扫描用户主目录、宿主全局配置或其他隐式 root。
- **仅 unmanaged pristine 真目录**：必须是真实目录（非符号链接、非 junction），不属于 `.agents/skills` canonical，祖先目录没有 skill lock；`npm ci` 后含 node_modules、自定义文件/内容、凭证/状态或任何 links 的一律拒绝。
- **精确已知历史版本**：只接受随包维护的已知历史精确清单与 SHA256；版本按 per-snapshot 返回：`57efd8d` = 0.1.5，`45cf9a4`/`49c530e` = 1.0.0。未知版本/内容、当前新版包目录拒绝。
- **旧名不能自动清**：历史 `bilibili-agent` 只有文字记录、没有可核对 hash，不能自动识别或删除；只报告并交用户/官方工具确认。
- **文件安全检查**：有 `O_NOFOLLOW` 常量的平台用 `open(O_RDONLY|O_NOFOLLOW)`，不跟随最终文件 link；Windows 无常量，使用 `O_RDONLY` 加前后 `lstat/fstat` 的 inode/mode/nlink/size/mtime/ctime 复核。该边界针对非对抗恶意并发，不宣称强对抗安全。
- **默认预览与可回滚隔离**：默认返回 `{action:"preview",path,version}`，不写入；confirm 时才同级 rename 到 quarantine，返回 `backupPath`。手动回滚步骤见 [升级说明](references/skill-upgrade.md)，原路径存在时不得覆盖。失败不永久删除；本次自建空备份目录仅尝试 rmdir 清理，失败保留供人工检查。
- **不读移凭证**：只处理代码/文档文件；不读取、复制、迁移、打印或删除 `bili_credential.json`、配置、审计、bridge 状态等用户数据。默认 state 与 symlink package edge 不作为 P1；文档明确需要显式 `BILIBILI_SKILL_HOME` 的隔离边界。
- **不安装钩子、不静默删除**：不通过 npm `postinstall` 等安装钩子自动清理；不隐藏输出，每一步有可核对结果。
- **严格 TypeScript**：清理实现位于 `src/lib/skill-cleanup.mts` 与 `src/lib/legacy-skills.mts`，编译后随 CLI 交付，不新增运行时依赖或宿主代码。
- **历史 fixture**：纯文档旧 Skill fixture 固定 LF，由 `.gitattributes` 锁定。

#### 本地验收证据

- cleanup 最终在 build 与 source 两条安装路径各 15/15 通过；早期12/12是增补链接/状态/0.1.5场景前的中间结果，不与最终数字重复相加。
- 覆盖已知 0.1.5 快照、links/硬链接、状态目录、canonical/ancestor lock、未知 hash、node_modules、symlink、自定义内容等允许/拒绝矩阵。
- 非对象 credential 的 AUTH 哨兵通过，确认拒绝路径不退化。

#### 远端 npx 验证边界

- 远端仓库仍是旧提交 `49c530e`；新的 1.1.0 未 commit/push。因此不能宣称“远端 npx 安装的新版”可验证，也不能用本地 local copy 结果证明远端 npx。
- literal npx 离线 wrapper 未验（此前失败）；直接安装 skills 1.7.4 后在临时 local copy 执行 remove 已验证，但这只证明本地/安装器路径，不是远端 npx 新版证据。
- 未来远端验证必须使用与现有安装不同的 scope/目录避免同名覆盖；安装后先 `npm ci` 与 `npm run compile` 生成可执行产物，再运行 cleanup；只有 commit/push 后使用独立 scope 的安装产物 E2E 才能记为已验证。

#### 安装产物 E2E 验收

- 自制 cleanup 已验证默认 preview、confirm 同级 quarantine、手动 rollback、canonical/ancestor lock/symlink/未知 hash/node_modules/自定义内容/凭证哨兵/links 的拒绝矩阵。官方 skills@1.7.4 remove 仅验证了TEMP本地copy目录与project lock entry清理，未验证真实用户多agent链接安装。旧名 `bilibili-agent` 不在允许清单，不自动识别清理；不把未覆盖场景报为通过。
- 凭证与状态文件不被读取或移动；失败不留下 half-state；所有测试在仓库外的真实安装产物上执行。
- 远端 npx 新版验证在 commit/push 与独立 scope 条件满足前保持“未验证”，不作为发布证据。

本轮本地/离线验收已完成；远端 npx 新版与真实 B 站业务验证仍不宣称。

### 验收标准

- 一次安装即可使用查询能力、bridge 控制命令与 `skills cleanup`；根目录仍不注册第二个 `bin`，发布目录仍由构建生成。
- 阶段 1 离线回归通过；最终 `npm test` exit 0；停止后无残留监听端口或桥接子进程。
- 原 23 条命令的名称、字段、默认值、`schemaVersion:1`、JSONL 信封保持兼容；`bridge run/status/stop` 与 `skills cleanup` 为 additive 增量；版本 1.1.0 Unreleased 的变更记录与实际产物一致。
- `poll` 语义可验证：未传 `--poll-ms` 时环境变量生效并被 bridge 校验；显式参数覆盖环境；token 不出现在 argv、schema、帮助或默认输出。
- build 与 source 两条安装路径均在仓库外用真实 PATH 通过；安装命令套件每路径 15 pass/7 skip/0 fail，原缺陷回归 2/2；旧 `lib`/demo 删除后无第二实现、无悬挂入口。
- cleanup 双路径各 15/15、默认 pristine 12/12、非对象 credential AUTH 哨兵通过；官方 remove 覆盖 managed 安装，自制品只处理 unmanaged pristine。
- Docker `--check` exit 0（74 白名单/34 mjs）；Docker daemon 实际未运行，不能据此宣称容器 E2E 通过。
- 远端仍为 `49c530e`，1.1.0 未 commit/push；literal npx 离线 wrapper 未验，直接 skills 1.7.4 临时 local copy/remove 已验证但不能替代远端 npx。真实 B 站读写未验，不宣称发布。

## 七、阶段 2.5：升级 Skill 即同步 CLI（未开始，发布形态待裁决）

本节是 2026-10-22 新增的待做需求与验收草案，**尚未实现**，不修改任何安装逻辑；读到本节不等于已批准动代码。

本节不改变 [AGENTS.md](AGENTS.md) 的现行要求（Skill 更新与已安装 CLI 更新须分别核验、常规升级优先用官方 skills update 或重新安装）；它是把「分别核验」做成可检测、可对齐的用户体验，而不是绕开官方安装器或降低核验标准。

### 用户要的体验

只做一次 Skill 升级（仍然走官方 `npx skills add` / 升级那一步），之后直接敲 `bilibili` 拿到的就是同一版本的新能力：不需要再手工 `npm install -g`、`npm ci`、`npm run compile`，也不需要手工改链接或换 scope。升级前后如果两面版本对不上，CLI 必须自己说出来，而不是静默用旧版去跑新文档。

### 当前缺口（2026-10-22 现场核验）

- **两面互不感知**：本机样本 `.agents/skills/bilibili-cli`（canonical，agent links 指向它）是 1.0.0；PATH 上的 `bilibili` 是 1.1.0，来自 `node_modules/bilibili-cli` junction → 本仓库 `skills/bilibili-cli`。同一用户的两套安装不是同一份东西，谁也不会警告。
- **源码 Skill 没有可执行产物**：`npx skills add` 不执行 `npm ci`/`npm run compile`，Skill 目录默认没有 `dist/`，所以"升级了 Skill"不等于"有了能跑的新 CLI"。
- **`doctor` 不回答版本一致性**：目前只报告 Node、状态目录、凭证存在性与 API 包版本，没有"CLI 与 Skill 是不是同一版"这个字段。
- **没有结构化信号也没有对齐动作**：缺 `VERSION_MISMATCH` 一类明确标识，也没有把 PATH 上的命令指到指定 Skill 的能力；旧 SKILL.md 于是继续教 agent 走旧布局（`node cli/bili.mjs`），新 CLI 其实在 `dist/`。

### 待交付项

| # | 项 | 期望行为 | 边界 |
| --- | --- | --- | --- |
| 2.5.1 | 版本一致性检测 | `doctor --json` 增加 `install` 段：`cli{version,path,onPath}`、`skill{path,version,distPresent}`、`consistent`、`actionRequired`；只读 `package.json` 与路径 | 不改现有字段、信封与退出码；不一致不报错退出，只如实标注 |
| 2.5.2 | `bilibili skills status --json` | 同一份信息作为 `skills` 组只读诊断命令；不写文件、不联网、不创建状态 | 有限请求，可进 `--jsonl` |
| 2.5.3 | 一键对齐 | `bilibili skills link --path <Skill 绝对路径> [--confirm]`：默认预览"会把 PATH 上的 `bilibili` 指向哪个版本、影响什么、怎么回滚"；`--confirm` 才执行可回滚的安装/链接 | 用户针对本次路径与 scope 明确确认；失败不改现状；不碰凭证/状态；不在安装钩子里隐式执行 |
| 2.5.4 | 升级后自检 | `doctor` 与 `skills status` 在升级后直接给出下一步（对齐命令，或 canonical/npx 管理安装改用官方 remove） | 不静默降级、不静默联网、不静默编译 |
| 2.5.5 | 发布形态裁决 | 见下表三选一，裁决后写入本节与本仓 CHANGELOG | 未裁决前不实现终态，也不宣称"升级即生效" |

### 发布形态：三选一（未裁决）

| 方案 | 做法 | 代价 | 现状 |
| --- | --- | --- | --- |
| A 预编译随 Skill 分发 | 发布时把 `dist/`（或单文件 bundle）放进 Skill 目录，装上即可执行 | 与"生成目录里的 `skill/` 只带 SKILL.md 与 references、不带运行时"的现行决策冲突；体积与源码可审计性要重新权衡 | 未开始 |
| B 首次调用自举 | Skill 内启动器发现 `dist/` 缺失或过期时受控执行 `npm ci` + `compile` | 需要网络与开发依赖，首次慢，离线必失败；默认不能静默 | 未开始 |
| C 显式对齐（建议先做） | 维持两面分离，用 `skills status` + `skills link` 把"升级 Skill → 一条命令对齐 CLI"做成文档化闭环 | 仍需一次显式确认，不是零步骤 | 未开始 |

建议顺序：先落 C（离线可实现、可回滚、不动发布形态），把 A 作为长期发布形态单独立项，B 仅在显式开关下提供。

### 验收标准

- 真实安装，不用源码导入、也不用本机 junction 冒充：旧 Skill + 旧 CLI → 升级 Skill → 对齐后 `bilibili --version` 与 Skill `package.json` 版本一致，`doctor` 的 `consistent` 为 true。
- 反向用例：只升级 CLI 或只升级 Skill 而没对齐 → `doctor`/`skills status` 明确报告不一致与下一步，不假报一致。
- 失败矩阵：离线、无写权限、目标路径不存在、目标是 canonical 或 npx 管理安装 → 结构化错误可操作，且不破坏现有安装。
- 检测与对齐全程不读、不写、不迁移凭证与状态目录；不自动开写权限；不新增 `postinstall` 钩子。
- `--json`/`--jsonl` 信封、退出码与原有 23 条命令字段不变，新增字段为 additive。

### 顺序

可与阶段 3 并行，但**不改变阶段 3 的排期事实**：阶段 3 仍未开始，读本节不代表已批准分层重构。

## 八、阶段 3：仿照 cc-connect 分层改造（未开始）

本节是目标设计，尚未实施。当前 bridge 只有已迁移的单进程装配与私信文本轮询，核心引擎、agent 适配器、会话绑定、受控回复和评论通道均未交付；不能把阶段 2 的命令与传输层等同为阶段 3 分层完成。

参考的是依赖方向、引擎与适配器分离，不是照搬它的全部平台、权限模式或技术栈。

### 目标职责

| 模块 | 职责 |
| --- | --- |
| 启动与配置 | 参数、状态目录、单实例、启动就绪、优雅退出 |
| 核心引擎 | 消息入队、路由、会话串行、任务关联、草稿与结果状态 |
| B 站通道 | 增量发现、消息归一化、通知上下文与回复目标；复用 CLI 能力层 |
| agent 适配器 | 可用性探测、新建/恢复会话、执行回合、取消与结果归一化 |
| 会话与存储 | 账号游标、去重、绑定、事件与任务状态、故障恢复 |
| 控制面 | CLI 与 Web 共用的启停、状态、绑定、审批接口 |

核心层依赖接口，不导入特定 agent 的实现；具体适配器由入口装配。现有 cc-connect 连接可以作为一种适配路径保留，但不应成为核心引擎的硬编码前提。

### 分步实施

1. 生命周期与后端调用收口：超时、进程异常、注册超时、停止清理和单实例。
2. 私信增量同步：会话基线、变化会话、按序号拉取、白名单、正序与自身消息过滤。
3. 可靠持久化：先将事件持久化再提交同步游标；同步游标与 agent 消费确认分开维护。
4. 任务与绑定：按 B 站会话路由到 agent 会话，按任务/回合关联结果，避免同一会话并发执行。
5. 受控回复：草稿、逐次确认、统一写入执行、受理与未知状态区分；不自动重发未知写操作。
6. 评论通道增量：接入回复/@通知，定位视频、根评论与目标评论；无法确定目标时拒绝发送。

### 必须避免的旧建议问题

- 未读数只能作为提示，不能作为唯一取数门禁；用户在官方客户端读消息后，不应导致 bridge 漏收。
- 六秒来自现有实现的经验值，不是平台承诺的安全阈值；需限速、退避并说明账号风险。
- ID 声明为字符串不等于无损解析；必须在原始 JSON 解析阶段解决超大整数精度，不能先丢精度再转字符串。
- 评论分页游标不等于本地消费确认，不能直接复用为统一事件的已处理游标。
- 进程运行、正在监听、agent 在线、允许写入是不同状态，不用单个“在线”字段掩盖差异。

### 验收标准

- 核心不硬编码 Codex、Claude Code 或 cc-connect 的实现细节。
- 每个账号同一时间仅一个同步执行者；重启不凭空丢弃已入队事件。
- 超过单页的积压处理方向经真实接口验证，不仅依据参数名推断。
- 只读、白名单、策略化回复（默认 `owner` 仅主人）、逐次授权和未知状态不重发等约束保持不变。

## 九、阶段 4：可视化与 Skill 引导（未开始）

当前没有 `web/` 控制台，也没有 Skill setup/operate 闭环；以下是设计要求，不是现有功能。

### 工作项

- 由现有 bridge 进程托管构建后的静态页面，不要求用户额外运行前端开发服务器，不默认引入 Electron 或独立 supervisor。
- 页面展示账号、监听状态、agent 可用性、绑定会话、任务、待审批和最近错误。
- 区分启动服务、开始监听、暂停监听、取消任务、解除绑定和退出程序。
- 页面只能控制已运行的本地服务；冷启动通过 CLI 启动器或宿主插件完成，不能声称普通网页可直接启动本地进程。
- 控制接口仅本机可用，实施鉴权、来源校验和最小权限；页面不取得 B 站凭证。
- Skill 提供 setup、登录预检、选择 agent/工作区/会话、启动、就绪检查、打开页面、暂停和停止的流程。
- 配置流程可重复执行且不覆盖已有绑定；启动成功必须由就绪信号和健康检查验证，不能只固定等待数秒。
- 开启写入、真实发言和修改宿主配置分别取得用户授权；Skill 不自动替用户批准回复。

### 验收标准

- 用户不需要长期维护独立终端即可查看并控制已经启动的 bridge。
- Skill 能引导首次接入，也能解释和修复未登录、未绑定、agent 不可用、端口占用与协议版本不兼容。
- 关闭页面不自动等于停止 bridge；界面清楚说明服务是否继续运行。
- CLI、Skill、页面使用同一控制契约，文档中没有虚构命令。

## 十、阶段 5：可选 coding agent 插件（未开始，可选）

当前没有 Codex/Claude Code 插件或 hook 实现；本节仅保留评估方向。

插件是用户入口，不是第二套 bridge。agent 执行适配器与宿主插件必须区分：前者让引擎调用 agent，后者提供安装、生命周期和交互入口。

### 先验证后承诺

| 目标 | 先核实的能力 | 可能的交付 |
| --- | --- | --- |
| Claude Code | 当前官方插件、hooks、会话标识和关闭语义 | 薄插件、命令与 Skill；需要时打开外部控制台 |
| Codex | 当前扩展入口、会话恢复、生命周期通知及其限制 | 原生支持的集成方式，或 Skill + CLI 启动器 |
| 其他 agent | 是否确有可用插件入口与可视化容器 | 按能力选择，不默认复制 IDE 扩展方案 |

### 工作项

- 各自做一个最小纵向验证：启动 bridge → 选择/新建专用会话 → 查看状态 → 暂停/停止 → 崩溃恢复。
- 只复用公共接口，插件不持有 Cookie，不复制轮询、去重、队列或审批逻辑。
- 用户授权启用之后才自动启动；是否监听、是否自动执行任务和是否允许发送分开控制。
- 多客户端共享服务时，通过租约或等价机制管理占用；关闭一个插件不得误停其他客户端正在使用的 bridge。
- 无可靠生命周期通知时允许手动启动或首次调用启动，并明确说明限制。
- 不默认增加 MCP；如确需新增传输层，单独讨论并修改仓库边界后再实施。

### 验收标准

- 插件安装体验确实比现有 Skill + CLI 更简单，且不用额外维护终端。
- 不宣称 Claude Code/Codex 必然支持任意自定义 Web 面板或接管当前正在运行的会话。
- 无插件用户仍能完整使用 CLI 和 Web 控制台。

## 十一、版本、变更日志与提交/发布纪律

### 单一版本源

- `package.json` 是唯一版本源；`src/lib/version.mts` 从包根读取并做字符串守卫。`--version`、`schema.version`、`skills list` 必须一致。
- 当前 `1.1.0 Unreleased`（尚未发布）：新增 bridge 命令与 `skills cleanup` 属于兼容 minor；最终 E2E 与安装产物验收已通过，但仍未 commit/push 或发布，不能称为已发布。未发布内容只保留在 `Unreleased`，不假造 tag、日期或发布记录。

### 语义化版本

| 变更 | 版本 | 约束 |
| --- | --- | --- |
| 兼容缺陷修复 | patch | 不改变公开命令、字段、输出或安装要求 |
| 兼容新增能力 | minor | 例如新增 `bridge run/status/stop`、`skills cleanup`；旧命令和 JSONL 不退化 |
| 破坏公开命令、参数、输出或安装要求 | major，须单独评审 | 必须给出理由、影响范围、迁移步骤和回滚说明；内部 TS 目录或 bin 内部路径变化不自动升级 major |

### 公开兼容边界

- 原 23 条命令的名称、字段、默认值、`schemaVersion:1` 与 JSONL 信封保持不变；bridge 三条命令与 `skills cleanup` 为 additive。
- 保留文档公开过的 `cli/bili.mjs` 兼容薄启动器；npm 包仍只注册 `bilibili` 一个命令，不恢复旧别名、DSH/MCP 或第二实现。
- CLI 内部实现从 `lib/*.mjs` 迁到 `src/*.mts`/`dist/*.mjs`；私有模块导入路径不承诺兼容，需在变更日志和迁移说明中写明。
- `files` 发布清单、`dist` 生成方式、Node.js 22+ 要求若变化，必须在 CHANGELOG 标注兼容影响。

### 提交、推送与证据

- 没有用户明确请求时，不 commit、不 push、不打 tag、不发布。
- 每次准备 commit/push 前更新 `packages/bilibili-cli/CHANGELOG.md`：记录用户可见变化、兼容影响、已验证项和未验证项；不以日志替代测试证据。
- 类型检查、构建、真实打包安装 E2E、变更审查未完成前，不把变更记录成“已验收”；未验证、未发布内容保留在 Unreleased。
- 旧版 Skill 清理已本地/离线验收（双路径 15/15），但远端 npx 新版未验；literal npx 离线 wrapper 未验、远端仍为 `49c530e`。未完成远端独立 scope 验证前，不写入“远端 npx 已支持”。

## 十二、任务台账

| 阶段 | 状态 | 证据或剩余工作 |
| --- | --- | --- |
| 0 固定边界和验收契约 | 部分完成 | 首版命令、有限/长流、退出码、schema 已固化；绑定/审批/agent 会话契约未完成 |
| 1 bridge × CLI E2E 基线 | 完成（离线基线；真实业务未验） | 最终 npm test exit 0：13 顶层组通过、bridge 失败 0；build 9/0、source 8/0+1 skip，生命周期 18/18，协议两路径 10/10，安装套件每路径 15/7/0，原缺陷 2/2；真实账号只读/写未执行 |
| 2 迁入唯一产品源码与统一交付 | 完成（本轮迁移/清理/安装验收；未发布） | 27 命令、版本单源、兼容 shim、旧 lib/demo 删除、cleanup 双路径 15/15、安装套件与 Docker check 已验；远端 npx 新版未验，未 commit/push |
| 2.5 升级 Skill 即同步 CLI | 未开始（发布形态待裁决） | 版本一致性检测、`skills status`、`skills link` 均未实现；现场样本 Skill 1.0.0 / CLI 1.1.0 即该分叉；A/B/C 发布形态待用户裁决 |
| 3.1 生命周期与异常收口 | 未开始 | 当前只有单进程装配；故障注入后的终态/无悬挂任务未按本阶段验收 |
| 3.2 私信增量同步与可靠事件存储 | 未开始 | sessions/new、序号分页、同步游标与消费确认未实现 |
| 3.3 agent 适配器、绑定与受控回复 | 未开始 | 无 agent 适配器、会话绑定、草稿/逐次审批闭环 |
| 3.4 评论通知与正确回复路由 | 完成（2026-10-27 双账号真实闭环） | 已实现并离线回归；真实闭环：账号 B 在 BV1qknH61EoH 下 @ 机器人 → bridge 轮询真实 `inbox at` → 成帧 → 注入回复 → 以账号 A 落楼中楼并 `comment thread` 可见；动态 @ 按 `unsupported_target:dynamic` 跳过；测试评论已全部删除（count=0） |
| 4 Web 控制台与 Skill setup/operate | 未开始 | 无 `web/`、控制台或 setup 闭环 |
| 5 Claude Code/Codex 薄插件 | 未开始（可选） | 未核实宿主能力，无插件/hook 实现 |

下一次工作顺序：阶段 2.5（需先裁决发布形态 A/B/C）可先行或与阶段 3.1 并行；阶段 3.1 从生命周期/异常收口开始；阶段 1/2 的本地/离线收尾已完成。真实 B 站只读/写、远端 npx 新版验证仍作为独立未验项保留，不与阶段 3 实现混在一起。不同时迁移、重构和开发插件；每阶段完成后记录实际命令、测试结果、跳过项与剩余风险。

## 十三、参考与证据边界

- [cc-connect 开发指南：核心、agent、平台与依赖方向](https://github.com/chenhg5/cc-connect/blob/main/AGENTS.md)
- [cc-connect 安装与会话操作](https://github.com/chenhg5/cc-connect/blob/main/INSTALL.md)
- [cc-connect 项目说明](https://github.com/chenhg5/cc-connect)
- [lark-cli：CLI 与 Agent Skill 分层交付](https://github.com/larksuite/cli)
- 本地依据：`AGENTS.md`、`packages/bilibili-cli/src/`、`packages/bilibili-cli/test/bridge/`、`packages/bilibili-cli/scripts/`、`skills/bilibili-cli/references/cli-contract.md`、`packages/bilibili-cli/CHANGELOG.md` 和 `bilibili-api-python/bilibili_api/session.py`。

阶段 1 的历史 E2E 结果、两条红灯和证据边界见 [测试台账](../../packages/bilibili-cli/test/bridge/BASELINE.md)。最终 Lead 执行 `npm run typecheck && npm test` 为 exit 0（wm81Zo）：13 个顶层组通过、bridge 失败 0；build bridge 9 pass/0 fail，source 8 pass/0 fail/1 skip；生命周期 18/18（root PID registered 后真实 Node），协议两路径 10/10，安装命令套件每路径 15 pass/7 skip/0 fail，原缺陷 2/2，cleanup 双路径各 15/15，非对象 credential 的 AUTH 哨兵通过。Docker `--check` exit 0（74 白名单/34 mjs），Docker daemon 实际未运行。ts-service review 原 P1 已解除：outbound nullish/raw 兼容、non-object credential 返回 AUTH(3)；mutual 判定仍严格 ===6。阶段 1 离线基线据此关闭；阶段 2 本轮迁移/清理/安装验收完成。真实 B 站只读/写往返未执行，没有发布或打 tag。远端仓库仍是旧提交 `49c530e`，1.1.0 未 commit/push；literal npx 离线 wrapper 未验，直接安装 skills 1.7.4 的临时 local copy/remove 已验证，但不能作为远端 npx 新版证据。

## 十四、本次对话交接摘要

### 用户真正关心的问题

- 目标不是提供一个必须长期盯着终端的机器人，而是让已有 coding agent 用户方便地安装、配置、查看、启动和关闭消息桥。
- 实时插话不是必要条件；需要显式绑定 agent 与会话，并允许用户选择、切换和查看绑定关系。
- Web 控制台是认可的可视化方向，但不能因此要求用户额外维护前端服务或另装重量级桌面应用。
- 对已有用户，宿主插件可能是最方便的入口；插件应隐藏启动细节，而不是要求每次手工启动后台命令。
- Skill 必须能引导 bridge 的 setup 和日常操作，不应只介绍 B 站搜索和发送命令。
- 本阶段用户已授权并实施：E2E 基线、严格 TS 迁移、bridge 命令融合、旧版 Skill 清理、版本单源与变更日志纪律；阶段 1 离线基线与阶段 2 本地验收已完成。会话绑定、Web 控制台、插件仍待实现；真实 B 站业务与远端 npx 新版仍未验证。

### 方向、提案与未决事项

| 类别 | 当前结论 | 后续处理 |
| --- | --- | --- |
| 已明确的目标 | 可视化、会话绑定、Skill 引导、统一能力和可靠 E2E | 作为各阶段验收要求 |
| 当前推荐方案 | 单 npm 包，`bilibili bridge run/status/stop` 已落地；包内 bridge 子系统按需加载；`skills cleanup` 改为维护脚本；静态 Web UI 尚未实现 | bridge 命令与版本单源已落地；Web 控制台属阶段 4，不能宣称已有 |
| 升级与清理 | `skills cleanup` 已移出公开 CLI，改维护脚本；历史验收双路径 15/15；官方 remove 为 managed 主路径 | 拒绝 canonical/ancestor skill lock/symlink/含 node_modules 或自定义内容/凭证/links；绝对显式 path、默认 preview、已知历史精确清单+SHA256、confirm 同级 quarantine/手动回滚、无安装钩子；旧名 `bilibili-agent` 无 hash 不自动清；远端 `49c530e` 未 push，literal npx 离线 wrapper 未验，npx 新版需独立 scope+npm ci/compile，当前不可验 |
| 插件定位 | 各宿主的薄入口，共用核心与账号同步状态 | 验证官方能力后选择插件、hook 或 Skill |
| cc-connect 关系 | 参考其分层；现有外部 cc-connect 路径是否长期保留尚待决定 | 不默认既重造完整 cc-connect，又强制用户安装它 |
| 自动执行 | 不实时插话不等于不能自动处理；可选择主动拉取或由引擎调度专用会话 | 明确“收消息、触发 agent、发出回复”三个独立开关 |
| 自动发送 | 当前仓库坚持逐次确认；会话绑定、写开关与 UID 白名单均不是长期发言授权 | 不通过插件或模型回调绕过；若需求变化需另行讨论规则 |
| 分包 | 独立 bridge npm 包曾讨论，当前不优先 | 若依赖、体积或发布节奏确有压力，再评估拆分 |

## 十五、有价值的源码上下文

### 阶段 2 迁移后的源码职责（实际）

| 文件 | 当前职责 | 后续关注 |
| --- | --- | --- |
| `src/lib/contract.mts` | 27 条命令的共享契约（原 23 条 + bridge 3 条 + cleanup 1 条）、字段校验与版本化信封 | help/schema/JSONL 必须继续同源；新增命令遵守 stream/有限请求边界 |
| `src/lib/command.mts` | Commander 注册、help/schema 输出、JSONL 逐行处理、stream 生命周期与信号映射 | 参数错误与长流错误路径分开；不把 run 塞进有限请求队列 |
| `src/lib/application.mts` | 有限命令执行、配置/凭证 context、写开关与审计、bridge status/stop 与 skills 版本信息 | bridge 不绕过校验/互关/审计；status/stop 不创建凭证状态；清理已迁到维护脚本 |
| `src/lib/skill-cleanup.mts` / `legacy-skills.mts` | 已知历史 Skill 快照清单/哈希、清理 preview、canonical/lock/symlink/node_modules 拒绝、confirm 同级隔离与回滚 | per-snapshot 版本、SHA256、O_NOFOLLOW/Windows 复核；只支持 unmanaged pristine |
| `src/lib/version.mts` | 读取包根 `package.json` 并校验版本字符串，供 `--version`/schema/skills list 共用 | 版本只改 package，不在源码散落硬编码 |
| `src/lib/bridge/main.mts` | bridge 配置、单实例、状态/基线、轮询与连接生命周期、信号与 stop 收尾 | 当前为单进程装配；阶段 3 才拆分核心/适配器 |
| `src/lib/bridge/control.mts` / `control-plane.mts` | status/stop 有限控制；锁/stop 标记；`LOCK_UNREADABLE`、`STOP_TIMEOUT` 等结构化错误 | 不强杀任意 PID；错误 code/exit 保留但消息不泄漏路径或 token |
| `src/lib/bridge/state.mts` / `state-path.mts` | 持久化状态、实例锁、默认账号目录 `bridge/state.json` | 状态目录受保护；不迁移其他工具凭证 |
| `src/lib/bridge/adapter.mts` / `backend.mts` / `bridge.mts` | 私信轮询、消息归一化、已安装 CLI 后端、cc-connect WebSocket | 顺序/去重/白名单/失败清理的离线回归已绿；真实账号只读/写证据仍需单独验收 |
| `scripts/verify.mjs` + `test/bridge/` | 构建、真实安装、仓库外 PATH、bridge 离线/生命周期/回归与可选 Docker | 默认不连 B 站；真实只读/写分开授权；失败不得静默变绿 |
| `cli/bili.mjs` | 兼容薄启动器，导入 `dist/lib/command.mjs` | 不含业务实现；旧 `lib/*.mjs` 删除后仍可用 |
| `dist/` | 编译生成的 JavaScript ESM | 忽略且不手工编辑；发布前由 `compile`/prepack 生成 |

历史文件 `bilibili-bridge/src/*.mjs` 与旧 `skills/bilibili-cli/lib/*.mjs` 已在迁移绿灯后删除，仅保留 `cli/bili.mjs` 薄 shim。后续实现必须读取当前 `src/` 文件，不能假设旧路径仍存在。

### Python Session 提供的关键启示

本地 `bilibili-api-python/bilibili_api/session.py` 的 `Session` 不是推送服务，而是把增量 HTTP 轮询包装成异步事件：

1. `get_sessions()` 建立会话序号基线。
2. `new_sessions(begin_ts)` 查找变化的会话。
3. `fetch_session_msgs(talker_id, begin_seqno)` 获取消息。
4. `Event` 解析文本、图片、撤回、分享视频等类型。
5. 默认排除自身发送消息，再分发事件。

相较原始 demo（已删除）逐 UID 拉最近 30 条的做法，这更适合统一账号同步。但不能照搬其提前推进游标、仅内存保存状态、异步分发不等待消费完成等行为。

额外待验证点：`new_sessions`、消息分页的时间单位、方向、边界和 `has_more` 语义；首次建基线与启动期间新消息之间的竞态；超过 30 条的积压如何完整获取。参数名和文档示例不足以证明恢复算法正确。

### B 站能力与平台限制

- 本次公开资料调研未找到面向普通个人账号、可供外部 AI 使用的私信/评论消息 webhook；当前方案以轮询为现实基础，不等于断言不存在任何内部或合作方能力。
- B 站开放平台有 Webhooks，但本次看到的公开事件列表主要是授权与投稿状态，不能据此接收个人私信或评论。
- 直播消息 WebSocket 与站内私信、视频评论不是同一个通道，不能互相替代。
- B 站原生固定文案/关键词自动回复不等于开放给外部模型的回调接口。
- 未读计数和官方客户端已读状态可能变化；不要把它们当作持久事件日志，也不要默认代用户标记已读。
- 评论需要区分通知 ID、评论 ID、根评论和目标资源；只取通知列表第一条或直接发顶层评论都不可靠。
- 接口受理、发送方回读可见、匿名查询可见、接收方实际收件是不同证据，不能合并成“送达成功”。

## 十六、参考项目与可复用经验

| 项目 | 本次得到的启示 | 不能直接推导的结论 |
| --- | --- | --- |
| [cc-connect](https://github.com/chenhg5/cc-connect) | 核心引擎、agent/platform 接口、会话管理、统一配置与内嵌 Web 管理 | 它不是“给每个 agent 装插件”的同一种架构；具体进程存活策略需按各适配器源码确认 |
| [lark-cli](https://github.com/larksuite/cli) | CLI 与 Skill 分层交付、内置文档、schema、结构化错误、事件消费与就绪信号 | 不照搬无限流到现有 JSONL 请求队列，也不照搬任意原始 API 能力 |
| [Koishi B 站适配器](https://github.com/bilibili-plugins/koishi-plugin-adapter-bilibili-dm) | 私信/评论分通道、通知归一化、回复目标校验、生命周期清理 | `msg_key: string` 类型声明本身不证明无损解析；服务端 ack 不能替代本地可靠游标 |
| [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) | 工具白名单、发后复核、行为提示词升级与判重 | 定时内容推荐/私信投递不等于私信双向会话桥；不复制其宿主/MCP 实现 |
| [dsh-bili-models](https://github.com/ShingStars/dsh-bili-models) | 宿主内固定会话和会话连续性 | 一条固定会话不适合不加隔离地承接多个陌生用户 |
| [dsh-bilibili-reply](https://github.com/bronyacccxz/dsh-bilibili-reply) | 低模型成本发现事件、身份核对、评论原位回复 | 浏览器常开和失败后推进游标不是理想主链路 |
| [bilibili-deepseek](https://github.com/keller-52/bilibili-deepseek) | 可视化、白名单、草稿与人工审批分离 | 本地审批接口不是操作系统级安全沙箱；不采用读取浏览器凭证的路线 |
| [dsh-im](https://github.com/xmanrui/dsh-im) / [dsh-qq-relay](https://github.com/HDHKVT/dsh-qq-relay) | 会话绑定、按回合关联回复、超时结果与未知发送状态区分 | QQ/飞书官方机器人能力不能直接移植到 B 站 |
| [langup-ai](https://github.com/jiran214/langup-ai) / [bilibili_learning_bot](https://github.com/xiaoyaya191/bilibili_learning_bot) | B 站机器人应用形态、上下文和独立监听的参考 | 本次部分结论来自 README/文档，不代表已经审查所有源码或验证当前可用性 |

前几轮关于“没有现成双向 B 站机器人”的表述过强，后续已找到 Koishi 等收发实现。应保留的结论是：有可参考的 B 站 bot，但没有经本次验证、可以直接无缝替代当前产品全部需求的方案。

## 十七、尚未完成的细项与待决策问题

以下事项归入前面的阶段台账，不代表额外扩大范围。

| 编号 | 待完成事项 | 归属 | 完成证据 |
| --- | --- | --- | --- |
| U01 | 固定首版命令、控制接口、事件格式和错误契约 | 阶段 0 | 命令清单与 schema 对齐，标明有限请求和长期流 |
| U02 | 决定继续兼容外部 cc-connect，还是先聚焦直接 agent 适配 | 阶段 0 | 明确默认路径和可选路径，避免两套引擎同时建设 |
| U03 | 修正现有真实 E2E 的日志等待、排序、状态目录及接收方证据断言 | 阶段 1 | 可重复的通过/失败/跳过报告 |
| U04 | 分开真实只读与逐次授权的真实写回归，保证配置恢复和进程清理 | 阶段 1 | 不扩大原有授权，不残留写权限变更或测试进程 |
| U05 | 核对源码直接打包与构建后打包的发布闭包 | 阶段 1–2 | 已完成：build/source 两条安装路径在仓库外 PATH 回归通过（各 15 pass/7 skip/0 fail） |
| U06 | 迁移唯一源码、测试、资源及 Skill 指引，清除旧目录 | 阶段 2 | 已完成：旧 lib/demo 已删除，仅保留薄 shim，无第二实现 |
| U07 | 修复子进程 pending、启动错误、注册超时与断线消费 | 阶段 3.1 | 故障注入后的明确终态，无悬挂任务 |
| U08 | 验证并补充 sessions/new/序号读取原语和大整数无损解析 | 阶段 3.2 | 真实只读字段证据，分页不漏消息 |
| U09 | 选择最小持久化方案，定义去重、同步提交、消费确认和恢复策略 | 阶段 3.2 | 重启、写盘失败、状态损坏回归 |
| U10 | 决定离线积压、过期消息、撤回与自身/系统消息的处理策略 | 阶段 3.2 | 配置和行为一致，跳过原因可见 |
| U11 | 实现用户可选择的绑定与原生会话能力探测 | 阶段 3.3 | 绑定列表、新建/恢复/切换的实际验证 |
| U12 | 确定自动调度与手动 inbox 的边界，避免“无需插话”被实现成“必须人来取消息” | 阶段 3.3 | 后台任务能按配置运行，人工发送授权仍保留 |
| U13 | 实现草稿、准确正文确认、编辑后重新确认、受理/未知状态和审计 | 阶段 3.3 | 未授权不发送，未知不重发 |
| U14 | 实现评论通知上下文、正确楼中楼回复和可见性证据 | 阶段 3.4 | 已验：真实通知目标可核对（BV1qknH61EoH / rpid 322101393024），回复落为楼中楼 rpid 322101403984 并在 `comment thread` 可见，无退化顶层评论 |
| U15 | 交付控制台、冷启动入口、可视化停机和结构化故障提示 | 阶段 4 | 用户无需长期维护终端 |
| U16 | 补齐 Skill 的渐进式文档与 setup/操作流程，检测版本或能力不匹配 | 阶段 4 | 新安装用户可完成闭环，重复 setup 不破坏已有配置 |
| U17 | 核实 Codex/Claude Code 官方插件与 hook 能力，试点一个薄入口 | 阶段 5 | 实际安装、生命周期、会话和多客户端测试 |
| U18 | 以实测而非猜测比较空闲、轮询、任务执行与页面打开时的资源占用 | 阶段 4–5 | 记录 CPU、内存、请求数量和进程数量；不承诺“只有几 MB” |
| U19 | 旧版 Skill 清理：官方 `npx skills remove` 为主路径；自制品仅 unmanaged pristine | 阶段 2 | 本地完成：双路径各 15/15、默认 pristine 12/12、非对象 credential AUTH 哨兵通过；拒绝 canonical/ancestor lock（含空）/symlink/links/node_modules/自定义内容/凭证；per-snapshot 0.1.5/1.0.0、SHA256、O_NOFOLLOW/Windows 复核、LF fixture。未完成：远端 `49c530e` 未 push，literal npx 离线 wrapper 未验，npx 新版需独立 scope+npm ci/compile |
| U20 | 版本一致性检测与结构化信号：`doctor.install`、`skills status`、不一致时的明确标识 | 阶段 2.5 | 真实安装下能报出 CLI 与 Skill 的版本/路径/是否一致，且不假报一致 |
| U21 | 一键对齐命令：默认预览、用户确认后执行、失败不改现状、可回滚 | 阶段 2.5 | 升级 Skill 后一条命令让 `bilibili` 用上同版本 |
| U22 | 发布形态裁决：A 预编译随 Skill / B 首次调用自举 / C 显式对齐 | 阶段 2.5 | 用户裁决后写入路线图与 CHANGELOG，再实现终态 |

仍需选择：首个 agent 的优先级；绑定到专用会话还是允许选择已有会话；无人连接时暂停、退出还是常驻；是否标记 B 站已读；队列保留时长与正文隐私策略。浏览器插件、托盘、系统服务、ACP 和计划任务均为候选增强，不是本轮必做交付。

## 十八、后续对话的操作提示

- 先读取本文件和当前 `AGENTS.md`，重新核对源码与测试，不把对话中的伪代码当作现有 API。
- 不将本文的推荐方案视为已批准全部实现；逐项推进，按当前用户请求决定本轮范围。
- 不擅自恢复 DSH/MCP 层，不复制浏览器 Cookie，不自动开写权限或启动常驻监听。
- 当前已落地：严格 TypeScript 源码与构建、`bridge run/status/stop`、版本单源与 Skill 文档版本报告、`cli/bili.mjs` 兼容启动器、poll 环境变量语义；`skills cleanup` 已改为维护脚本。阶段 1 离线基线与阶段 2 本地迁移/安装验收完成；旧 `lib`/demo 已删除。
- 仍未验证：真实 B 站账号只读/写往返；远端 npx 新版（远端仍 `49c530e`，未 commit/push，literal npx 离线 wrapper 未验）。直接 skills 1.7.4 临时 local copy/remove 已验，但不能替代远端证据。
- 阶段 3–5（分层重构、绑定与 agent、Web 控制台、宿主插件）均未开始；不能把命令/传输层伪装成分层或产品闭环已完成。
- 版本当前为 1.1.0 Unreleased；未获用户明确请求不 commit、不 push、不打 tag、不发布。每次准备提交前更新 `CHANGELOG.md`，并区分已验证与未验证项。
- 2026-10-22 新增待做：阶段 2.5「升级 Skill 即同步 CLI」（版本一致性检测、`skills status`、`skills link`、发布形态 A/B/C）。它只是记录下来的开发项，尚未实现；不要在回复里宣称升级后 CLI 已自动跟进。
- 后续完成一项后同步更新阶段台账及实际证据，避免“讨论过”被误记成“已经实现”。
