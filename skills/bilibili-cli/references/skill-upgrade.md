# Skill 安装、升级与旧版清理

本页只讲 Skill 的安装、升级与可选的历史副本清理；CLI 怎么运行见 [CLI 契约](cli-contract.md)，bridge 见 [Bridge 监听](bridge.md)。远端 Git 内容与 npm 版本以其实际状态为准，本页不声称发布或推送已经完成。

## 原则

1. **先常规升级或重装，再考虑清理**：历史副本清理不是升级的必经步骤，也不自动执行。
2. 不自动删除用户文件；每步清理都需要用户对准确 scope、准确路径的确认，优先预览和可回滚方案。
3. Skill 与已安装的 CLI 分别核验：升级 Skill 不会自动同步 `bilibili` 命令。
4. 不读取、迁移或复制凭证；不扫描整个 HOME；不手工编辑安装器维护的 links/lock。

## 常规升级（首选）

```bash
npx skills check                         # 查看已装 Skill 的可用更新
npx skills update bilibili-cli           # 按名称更新已装 Skill
npx skills update bilibili-cli -g        # 仅全局 scope
npx skills update bilibili-cli -p        # 仅当前项目 scope
```

`-y` 只跳过 scope 提示（自动判断项目/全局），不改变要更新的目标 scope；执行前仍须确认 scope。更新后检查安装目录中的 `SKILL.md`、`references/`，并单独核验 CLI：

```bash
bilibili --version
bilibili doctor --json
```

从 Git 安装的 Skill 不带 npm 包生成的 `dist/`，因此不要指望在 Skill 目录直接运行包内 CLI，也**不需要也不应当**为此执行 `npm ci` 或编译：CLI 从官方 npm 包获取（npx 或全局安装）。只有维护者需要源码构建，见 [README](../README.md)。

## 重新安装与 scope 隔离

需要重装或换 scope 时：

```bash
npx skills add yukariyukaro/bilibili-cli --skill bilibili-cli
```

交互选择目标 agent 与安装模式；可用 `-g` 安装到全局。安装前先确认旧版属于哪个项目或全局 scope、被哪些 agent 引用，并保留用户改过的 Skill 文档与自定义文件。

避免同名同 scope 直接覆盖：旧版为全局时，可先在一个新项目安装新版；旧版为项目级时，可选择不同项目或全局。`skills add` 可能重建同名目标，不是备份工具。安装后进入**新安装的真实 Skill 目录**核验文档，并确认 CLI 版本与 Skill 预期一致。

## npx 管理的旧安装：官方 remove

npx 安装可能维护 `.agents/skills/bilibili-cli` canonical 副本、多个 agent 的符号链接/junction 及 lock。单独移动 canonical 会留下失效链接；自制清理程序因此拒绝 canonical 或有 ancestor skill lock 的目录。需要移除旧安装时，先检查 scope 与待移除目标，取得用户确认后使用官方命令：

```bash
# 旧项目安装：必须先进入旧项目根目录
npx skills remove bilibili-cli
# 旧全局安装
npx skills remove bilibili-cli -g
```

不要加 `-y` 跳过确认；不要在刚安装新版的同一 scope 执行，否则可能移除新版；不要由 agent 自动执行。官方 remove 维护 links/lock，但**不是可回滚备份**，也不会按旧版哈希区分新旧同名目录。`bilibili-agent` 只有历史名称文字记录，无可核验内容，清理程序不能自动识别；若确实安装，先由用户核实，再通过官方工具处理。

## 可选：未受安装器管理的历史副本

只有确认某个完整旧副本不受安装器（npx、agent links、lock）管理时，才使用 CLI 的单目录清理程序。所有参数与 help/schema/JSONL 共用契约：

```bash
bilibili skills cleanup --path "/绝对路径/旧副本/bilibili-cli" --json
# 检查 preview 后，用户明确确认本次路径，再运行
bilibili skills cleanup --path "/绝对路径/旧副本/bilibili-cli" --confirm --json
```

使用 npx 入口时同样在前面补 `npx --package @yukariyukaro/bilibili-cli@1`。Windows 使用完整盘符路径；不能使用相对路径、UNC、设备路径或含 `..` 的路径。

- 默认只返回 `{action:"preview",path,version}`，不创建状态、不备份、不移动内容。
- 确认后返回 `{action:"quarantined",path,version,backupPath}`；仅把目录 rename 到同级 `.bilibili-cli-backup-<UUID>/skill`，不永久删除。
- 只接受本仓库三个已知历史提交的完整文件清单和逐文件字节 SHA-256，或对应的纯文档子集（`SKILL.md` 与 `references/cli-contract.md`）。它们是 Git 历史快照，不声称这些 npm 版本都发布过。
- 只支持 pristine 副本；CRLF 改写、自定义文件、`node_modules`、未知空目录、缺文件、修改过的文档或凭证哨兵均拒绝。即使版本号相同，也不推断安全。
- 拒绝 symlink/junction、链接祖先、硬链接、canonical、ancestor skill lock、当前运行包及显式 `BILIBILI_SKILL_HOME` 目录（含相关祖先/后代）。不泛扫 agent 目录，不编辑锁文件，不执行官方 remove，不读取或搬走凭证。
- 每次只处理一个显式路径；多份副本逐一预览确认。操作期间不要并发编辑目标或其祖先。本工具不是对抗本地恶意文件系统竞态的安全边界。
- 拒绝时 `ok:false`、`SKILL_CLEANUP_REFUSED`、exit 2；不为了覆盖更多安装类型而放宽安全规则。按旧文档执行过 `npm ci` 的目录通常含 `node_modules`，应走官方 remove 或人工审查，不自行删依赖后强行匹配。

### 手动回滚

保留输出中的 `path` 与 `backupPath`。确认旧路径不存在、备份内容正确、无新安装或 links/lock 需要协调后，将 **backupPath 指向的 skill 目录** rename 回原 path；不要把整个 UUID 父目录移回。原路径存在时停止，绝不覆盖或合并。恢复后核验 Skill 文档与命令，不自动开启写权限。备份由用户保留或自行处理，程序不自动清空。

## 验收边界

清理工具由真实 pack/install/PATH 离线 E2E 验证 preview、隔离、回滚及拒绝路径，不触碰用户已安装的 Skill；测试 setup 需要 git 及本仓库固定历史提交，缺失即失败而非跳过，安装后运行产品不需要 git。精确文档 fixture 以 `.gitattributes` 固定 LF 字节，不随 Windows autocrlf 改写。安装器层面的升级与远端版本安装以实际执行的命令结果为准；未运行或未通过的检查须明确说明，不以本地工作树验收替代远端发布验证。
