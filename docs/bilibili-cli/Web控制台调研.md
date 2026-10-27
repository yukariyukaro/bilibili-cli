# Web 控制台调研

> 调研范围：cc-connect、dsh-bili-scroll、dsh-bili-whale、bili-cli，以及目标仓库 Issue/PR #26。
> 证据口径：带 URL 的“事实”来自公开仓库源码、配置模板或 Issue；“建议”是面向本仓库的设计映射，不表示外部项目已经实现。
> 本文为只读调研记录，不代表本仓库已经完成所有外部项目的能力。

## 1. 结论摘要

- **事实**：cc-connect 已形成“本机 Web 前端 + HTTP 管理 API + WebSocket Bridge + 可嵌入静态资源”的产品形态；但其 Bridge 协议文档仍标记为 Draft。
- **事实**：dsh-bili-scroll 已验证 DSH 设置页 slot、本地 API、状态轮询、二维码 start/poll、配置草稿与插件家目录模式；它是宿主插件设置交互的直接参考。
- **事实**：dsh-bili-whale 将用户可调参数集中到单一 JSON，并将作息、监听、风险间隔、分享策略和主人信息显式化；设置保存后即时生效，凭据不回显。
- **事实**：kukemc/bili-cli 面向 Agent 提供统一 JSON envelope、schema、自描述错误、profile 隔离，以及推送 WebSocket + fallback poll 的私信监听；本次不要与同名的 public-clis/bilibili-cli 混淆。
- **事实**：目标 [Issue #26](https://github.com/yukariyukaro/bilibili-cli/issues/26) 是 Open Issue，不是 PR；[Pull Request #26](https://github.com/yukariyukaro/bilibili-cli/pulls/26) 当前返回 404。
- **本实现现状**：当前已经新增 bridge web、web-config.mts、web-server.mts、web-supervisor.mts、web-assets.mts，但路线图仍将阶段 3–4 标为未完成；因此只能称为当前已落地的最小 Web 控制面，不应声称已经具备 cc-connect 的完整分层、agent 会话绑定或所有插件能力。

## 2. 外部项目事实

### 2.1 cc-connect：Bridge、管理 API 与 Web

仓库：[chenhg5/cc-connect](https://github.com/chenhg5/cc-connect)

**事实**

- 配置模板区分 [bridge]、[management]、[webhook]、日志、限流、heartbeat 等边界；Bridge 示例监听 9810，Management API 示例监听 9820：[config.example.toml](https://github.com/chenhg5/cc-connect/blob/main/config.example.toml)。
- Bridge 协议使用 WebSocket /bridge/ws，适配器先 register，再交换 message/reply，另有 card_action、ping/pong、流式回复等帧；支持 query token、Authorization Bearer 或 X-Bridge-Token 鉴权：[bridge-protocol.md](https://github.com/chenhg5/cc-connect/blob/main/docs/bridge-protocol.md)。该文档明确写有 Status: Draft，只能作为协议形状参考。
- Management API 使用统一 {ok,data} 与 {ok:false,error} envelope，覆盖状态、项目、会话、消息发送、provider、cron、heartbeat、bridge adapter：[management-api.md](https://github.com/chenhg5/cc-connect/blob/main/docs/management-api.md)。
- Web 前端使用 Bearer token 调用 /api/v1，有 Dashboard、Projects、Chat、Cron、System、Providers、Skills 等路由；状态页面展示版本、运行时间、连接平台、项目和最近会话：[API client](https://github.com/chenhg5/cc-connect/blob/main/web/src/api/client.ts)、[App.tsx](https://github.com/chenhg5/cc-connect/blob/main/web/src/App.tsx)、[Dashboard.tsx](https://github.com/chenhg5/cc-connect/blob/main/web/src/pages/Dashboard.tsx)。
- Web 静态资源可由 Go embed 嵌入：[embed.go](https://github.com/chenhg5/cc-connect/blob/main/web/embed.go)。

**对本实现的建议**

- 可以保留 Web 静态页、HTTP 控制面、Bridge 长连接三层职责，但只复用已存在的本地 CLI/bridge 契约，不照搬 cc-connect 的项目、provider、平台管理范围。
- 状态接口应区分服务进程、传输连接、注册、ready、监听、Agent 会话和写入许可，而不是一个笼统的 online。
- 可借鉴 cc-connect 的 Web token client、REST envelope 和 embed 方式；Bridge Draft 不能直接作为本仓库的稳定兼容承诺。

### 2.2 dsh-bili-scroll：DSH 设置页与插件内 API

仓库：[c1overzz/dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll)

**事实**

- 插件通过 DSH settings.section slot 注册设置页，并以 /api/bili-duty 提供状态、配置、登录、运行、报告和 watched 数据；设置页包含每日运行、关键词、日报、互动、转写、依赖和诊断入口：[client.js](https://github.com/c1overzz/dsh-bili-scroll/blob/main/client.js)。
- 登录是两阶段：/login/start 返回 key 与二维码，随后轮询 /login/poll；组件卸载时清理登录 timer，状态约每 5 秒刷新。
- 输入框使用本地 draft，避免周期性状态刷新覆盖用户正在输入的内容：[client.js](https://github.com/c1overzz/dsh-bili-scroll/blob/main/client.js)。
- 配置、凭证、报告和日志放在插件独立家目录；vendored MCP 脚本也铺到家目录：[state.mjs](https://github.com/c1overzz/dsh-bili-scroll/blob/main/lib/state.mjs)。
- 插件内部 MCP 使用 stdio JSON-RPC，顺序为 initialize、notifications/initialized、tools/call，一行一个 JSON：[mcp.mjs](https://github.com/c1overzz/dsh-bili-scroll/blob/main/lib/mcp.mjs)。

**与本实现的事实映射**

- 本实现的 web-assets.mts 提供包内静态 HTML/CSS/JS；web-server.mts 在 127.0.0.1 提供页面和 API。这与“进程托管本地设置页”方向一致，但不是 DSH slot 插件，不能声称已复刻 DSH 设置页。
- 本实现的 web-config.mts 已有 connection/reply/scroll/schedule/notification/agent 配置，并校验未知字段、UID、URL、时区、范围和策略。
- 本实现的 web-server.mts 已有 GET /api/state、PUT /api/config、POST /api/control，使用 Bearer token、Host/Origin 校验、本机监听和安全响应头。
- 本实现的 web-supervisor.mts 已有子进程所有权、状态阶段、事件日志和 start/stop/run-now 控制；只停止自己启动的 child。

### 2.3 dsh-bili-whale：集中配置、作息与监听保护

仓库：[Alterssss/dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale)

**事实**

- 配置查找顺序是 $BILI_WHALE_CONFIG、~/.dsh/bili-whale.config.json、内置默认值：[config.mjs](https://github.com/Alterssss/dsh-bili-whale/blob/main/tools/lib/config.mjs)。
- 配置模板显式包含 persona、owner、share、risk、listen 和 night；包括主人 UID/名称、分享渠道与最低评分、读取/写入间隔、评论/私信/直播监听开关与间隔、作息窗口、每日唤醒与视频上限：[config.example.json](https://github.com/Alterssss/dsh-bili-whale/blob/main/tools/templates/config.example.json)。
- README 声明评论监听默认关闭，私信监听默认开启且 60 秒一轮；失败才退避；设置保存后生效；配置与凭据分离且凭据不回显：[README.md](https://github.com/Alterssss/dsh-bili-whale/blob/main/README.md)。
- README 说明作息依赖带 Web 能力的宿主服务，如 sessionController、webServer、connection；headless 不提供这些服务：[README.md](https://github.com/Alterssss/dsh-bili-whale/blob/main/README.md)。

**与本实现的事实映射及边界**

- 本实现已有 scroll.enabled/source/keywords/numVideos/readComments/commentsPerVideo/readSubtitles/preferTags/avoidTags/reportDirectory，以及 schedule、notification、agent 配置。这些是相似配置域，不等于已经实现 whale 的直播监听、私信双向监听、AI 评论闸门或完整作息调度。
- 本实现 schedule 只表达单一 HH:mm、IANA 时区和星期集合，并由 journal 防止同一日期静默重复触发；与 whale 的多窗口 night.windows 不是同一能力。

### 2.4 bili-cli：Agent 友好 CLI、profile 与事件流

主要参考：[kukemc/bili-cli](https://github.com/kukemc/bili-cli)；同名项目：[public-clis/bilibili-cli](https://github.com/public-clis/bilibili-cli)。本文以下事实均指 kukemc 版本。

**事实**

- CLI 统一成功/失败 JSON envelope，失败包含 code、message、hint；schema 提供机器可读命令定义；登录拆成二维码开始与等待确认：[README.md](https://github.com/kukemc/bili-cli/blob/main/README.md)。
- BILI_CLI_HOME 可隔离 profile；credential、pending login、owner、device 分文件；写入采用临时文件后 replace，POSIX 下设置 600：[config.py](https://github.com/kukemc/bili-cli/blob/main/src/bili_cli/config.py)。
- dm watch 使用推送 WebSocket 加 20 秒 fallback poll，输出 ready、message、最终 summary 逐行 JSON；支持时长、最大事件数、UID、mark-read、no-push，并在断线后退避重连：[dm_watch.py](https://github.com/kukemc/bili-cli/blob/main/src/bili_cli/commands/dm_watch.py)。
- MCP server 通过子进程调用真实 CLI，让 MCP 与 CLI 共用 JSON、限流、白名单和审计；读写工具分开标注：[mcp_server.py](https://github.com/kukemc/bili-cli/blob/main/src/bili_cli/mcp_server.py)。

**与本实现的事实映射**

- 本实现 CLI 已通过 contract.mts 共用命令、帮助、schema、JSON/JSONL envelope；bridge run 是长期事件流，bridge status/stop 是有限控制请求。
- 本实现的 web-supervisor.mts 将一次 run-now 组织为带 task/session key 的子进程任务，并在状态/事件中报告过程；但它不是 bili-cli 的 dm watch 实现，也没有宣称支持 B站推送 WebSocket。
- 本实现 web-config.mts 和 web-server.mts 使用原子配置写、revision 冲突检测和配置/状态路径隔离；这与 bili-cli 的 profile 与原子写方向相容。

## 3. 目标 Issue/PR #26

### 3.1 事实

- [Issue #26](https://github.com/yukariyukaro/bilibili-cli/issues/26) 当前为公开 Open Issue，标题为“[运行与运维] 生命周期、可靠存储、消息策略、控制台、性能与跨平台交付”，comments 为 0。
- [Pull Request #26](https://github.com/yukariyukaro/bilibili-cli/pulls/26) 当前返回 404；因此本文不把 #26 称为 PR。
- Issue body 要求关注：启动失败/注册超时/断连/子进程崩溃/停止超时/并发停止的明确终态；入站事件持久化先于游标推进；同步游标与 Agent 消费确认分离；at-least-once、重启恢复、容量与裁剪；撤回/图片/自身/系统消息策略；本机鉴权 Web 控制台；启动、暂停、取消、解绑、退出的区分；性能测量；真实 Linux Docker/CI 证据。

### 3.2 与当前实现的映射

| Issue 关注点 | 当前实现可确认内容 | 仍不能声称已覆盖 |
| --- | --- | --- |
| 本机控制台 | bridge web；仅 127.0.0.1；Bearer token；Host/Origin/跨站校验；包内 assets | 完整账号/Agent/绑定/审批中心；普通网页冷启动本地进程 |
| 配置 | 版本化 JSON；结构化字段；未知字段拒绝；revision 冲突；临时文件 + rename；配置/状态路径互斥 | 多客户端合并、配置迁移链、任意插件配置兼容 |
| 生命周期 | supervisor 区分 stopped/running、phase、paused、registered、ready；只管理自己启动的 child；有 start/stop/run-now | 全部故障注入矩阵、崩溃恢复、stop 超时/锁损坏的端到端证据 |
| 调度 | 单时间点 + 时区 + 星期；15 秒检查；日期 journal 先 claim，失败不静默重试 | whale 多作息窗口、复杂调度、跨平台服务管理 |
| 消息与写保护 | 任务提示远端文本不可信；回复策略 off/owner/draft；写入继续交给 CLI 的确认、写开关与审计 | 完整 durable inbox、consumer ack、撤回/图片/系统消息保留策略 |
| bridge | 已有 cc-connect WebSocket URL、register/ready、B站私信轮询及 owner 白名单 | cc-connect 全部 card/media/platform 能力；稳定兼容 Draft 协议 |
| 交付证据 | 本地源码/构建/离线 E2E 记录在 [路线图](bridge实施路线图.md) 与 [维护规则](AGENTS.md) | 真实 B站收发、真实 Linux Docker 运行、性能报告；不能把静态 Docker check 当容器 E2E |

## 4. 面向本实现的建议

以下均为建议，不是已实现事实：

1. **保留三层边界**：本机静态 Web 只做视图；HTTP API 只做受鉴权的控制与状态；bridge/CLI 负责事件流和 B站能力。CLI、控制台和未来 Skill 应共用 contract 与机器可读状态。
2. **把状态拆开显示**：至少区分服务进程、bridge 传输连接、注册、ready、监听、Agent 会话、写入许可、任务运行中。
3. **持久化语义先于 UI 丰富度**：继续扩展长期监听前，定义 durable inbound event、sync cursor、consumer ack、seen/dedupe、保留期与上限；WebSocket 写成功不能等同 Agent 已消费。
4. **配置交互采用 revision + draft**：保留 web-config.mts 的 revision 冲突检测与原子写，前端继续采用 dsh-bili-scroll 的本地 draft；保存失败必须显示结构化错误。
5. **控制动作保持窄而明确**：当前 start、stop、run-now 可扩展为 pause/resume/cancel/unbind/exit，但每个动作都应有明确终态及是否影响 bridge 进程的说明；关闭页面不应默认 stop。
6. **安全边界不跟随外部项目无限扩张**：owner 白名单、off/owner/draft、CLI 写确认与审计优先；不要把外部项目支持的评论、直播、媒体卡片、投稿或私信自动回复写成当前已支持。
7. **补证据再宣称完成**：Issue #26 要求真实生命周期、存储恢复、跨平台和性能证据；协议夹具不能替代真实 B站或真实容器验证。

## 5. 未覆盖项清单

### 外部项目中本文未做实现性承诺的能力

- cc-connect 的完整多平台适配器、Card 2.0、provider 管理、聊天历史 UI、cron/heartbeat 全部行为。
- dsh-bili-scroll 的完整 DSH 宿主 slot 兼容、依赖安装、二维码绘制、报告卡片墙、收藏夹操作和本地转写运行时。
- dsh-bili-whale 的直播监听、私信双向监听、AI 评论闸门、完整多窗口作息、通知后端和专用会话机制。
- bili-cli 的完整命令集、17 个 MCP 工具、B站推送协议、媒体抽帧/ASR、自动回复和创作能力。

### 本实现当前仍未覆盖或未证明的事项

- 账号绑定、Agent 类型/工作区/原生会话选择与恢复。
- 完整审批队列、人工确认 UI、任务取消语义和多客户端租约。
- durable inbox 与 Agent consumer ack 的完整分离、断电恢复和 at-least-once 证明。
- 撤回、图片、非文本、自身消息、系统消息、保留期与隐私裁剪策略的完整控制台展示。
- 真实 B站只读/写收发、真实 cc-connect 兼容性、真实 Linux Docker/CI 运行。
- 性能报告（CPU、内存、请求数、进程数、空闲/轮询/任务/控制台场景及波动）。
- Codex/Claude Code 官方插件、hook、会话关闭语义和跨客户端租约。
- WebSocket 协议版本协商、完整媒体帧、重连/幂等/顺序语义的公开稳定承诺。

## 6. 参考链接索引

- [cc-connect 仓库](https://github.com/chenhg5/cc-connect) · [配置模板](https://github.com/chenhg5/cc-connect/blob/main/config.example.toml) · [Bridge 协议](https://github.com/chenhg5/cc-connect/blob/main/docs/bridge-protocol.md) · [Management API](https://github.com/chenhg5/cc-connect/blob/main/docs/management-api.md) · [Web API client](https://github.com/chenhg5/cc-connect/blob/main/web/src/api/client.ts)
- [dsh-bili-scroll](https://github.com/c1overzz/dsh-bili-scroll) · [client.js](https://github.com/c1overzz/dsh-bili-scroll/blob/main/client.js) · [state.mjs](https://github.com/c1overzz/dsh-bili-scroll/blob/main/lib/state.mjs) · [mcp.mjs](https://github.com/c1overzz/dsh-bili-scroll/blob/main/lib/mcp.mjs)
- [dsh-bili-whale](https://github.com/Alterssss/dsh-bili-whale) · [config.mjs](https://github.com/Alterssss/dsh-bili-whale/blob/main/tools/lib/config.mjs) · [config.example.json](https://github.com/Alterssss/dsh-bili-whale/blob/main/tools/templates/config.example.json) · [README](https://github.com/Alterssss/dsh-bili-whale/blob/main/README.md)
- [kukemc/bili-cli](https://github.com/kukemc/bili-cli) · [config.py](https://github.com/kukemc/bili-cli/blob/main/src/bili_cli/config.py) · [dm_watch.py](https://github.com/kukemc/bili-cli/blob/main/src/bili_cli/commands/dm_watch.py) · [mcp_server.py](https://github.com/kukemc/bili-cli/blob/main/src/bili_cli/mcp_server.py)
- [同名 public-clis/bilibili-cli](https://github.com/public-clis/bilibili-cli)
- [目标 Issue #26](https://github.com/yukariyukaro/bilibili-cli/issues/26) · [目标 PR 查询](https://github.com/yukariyukaro/bilibili-cli/pulls/26)

## 7. 本次文档验证边界

- 已读取 docs/bilibili-cli/AGENTS.md、当前 Web 配置、Web server、supervisor、assets、bridge 命令契约及路线图。
- 本次只新增本文档；未运行构建或测试，因为没有修改运行时代码。
- 文中“已实现”仅指源码中可直接核对的当前能力；外部项目 README、协议 Draft、路线图和建议均未被当作已验收事实。
