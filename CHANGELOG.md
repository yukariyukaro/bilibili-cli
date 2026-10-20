# 更新日志

## 1.0.0 — 2026-10-20

**破坏性重构**

- 独立 CLI 与 Skill 取代原 DSH 插件实现；根目录的宿主、浏览器、设置页、调度、提示词和插件运行库已移除。
- 命令统一为 `bilibili`，采用 `auth / video / comment / user / inbox / dm / config / doctor / schema / skills` 分组；旧的 `bili`、`dsh-bili-scroll`、平铺命令和 `agent` 入口不再兼容。
- 命令注册、参数契约、业务服务、运行时适配、输出与错误分层；CLI 与 JSONL 共用校验和安全策略。
- 写操作默认关闭，统一要求写开关、逐次确认、dry-run 与尝试/结果审计；评论和私信业务失败、未知状态不再伪报成功。私信仅允许发给互关用户，可配置 dmRecipientUid 固定收件人。
- 移除 MCP 传输层与 Python 内部后端；B 站接口改由 npm 依赖 `@yukariyukaro/bilibili-api-ts` 直接调用，扫码二维码改用 `qrcode` 包，不再启动子进程或依赖 Python/uv。新增评论楼中楼、用户资料/关系、通知与私信读取。
- 测试改为真实打包、临时安装、PATH 命令入口和端到端回归；bilibili-api-ts 17.4.1 发布前通过只读本地注册表按 semver 与 integrity 验证，发布后用公共注册表复验。移除模拟后端与相关夹具，真实后端回归需显式启用。
- 移除原插件对应的 git 远程仓库，改用 `yukariyukaro/bilibili-cli` 的提交历史。
