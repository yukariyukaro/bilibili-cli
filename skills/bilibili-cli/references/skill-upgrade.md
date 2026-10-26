# Skill 安装与升级

Skill 提供操作指引，CLI 提供 `bilibili` 命令，两者独立安装和更新。缺少命令或需要更新 CLI 时，按 [安装与运行](cli-contract.md#安装与运行) 取得用户同意后处理；不要在 Skill 目录执行依赖安装或源码构建。

## 安装 Skill

```bash
npx skills add yukariyukaro/bilibili-cli --skill bilibili-cli
```

由用户选择目标 agent 与项目或全局 scope；需要全局安装时加 `-g`。重装前确认目标 scope，保留用户修改过的文档，不把安装器当备份工具。

## 更新 Skill

```bash
npx skills check
npx skills update bilibili-cli
```

按需用 `-g` 限定全局、`-p` 限定当前项目。执行前确认更新范围，不顺带移除其他安装或修改安装器的链接、锁文件。

## 核验版本

1. 检查实际加载目录中 `SKILL.md` 的 `metadata.version` 与 `metadata.requiresCli`。
2. 运行 `bilibili --version` 与 `bilibili doctor --json`，核对 CLI 版本及依赖。`requiresCli` 按主次版本匹配，patch 差异不影响兼容。
3. 注意 `doctor` 的 `skill.docVersion`、`skill.requiresCli`、`skill.matchesCli` 检查的是 CLI 随包文档，不会自动检查另行安装的 Skill 副本。当前加载的文档也需单独核对。

## 验收边界

更新 Skill 不代表已更新 CLI，修改本地文件也不代表已经发布到 Git 或 npm。仅报告实际执行和验证的结果；版本不兼容时说明差异，不自动升降级。安装与更新不需要读取或迁移凭证。
