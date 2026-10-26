# AGENTS.md

本文件是**仓库级入口**，只做索引：具体规则与知识放在 `docs/` 与各交付目录，避免在根目录重复维护。

## 仓库结构

- `packages/bilibili-cli/`：npm 包源码（`src/`、`test/`、`scripts/`、构建与发布）。
- `skills/bilibili-cli/`：Agent Skill，只含 `SKILL.md` 与 `references/`；`npx skills add` 只复制这些文件。
- `docs/bilibili-cli/`：维护者文档（规则、上下文、发布、路线图）。
- `bilibili-api-ts/`、`bilibili-api-python/`：独立仓库，多仓开发时嵌套在工作区，**不纳入本仓库**，不要修改。

## 文档索引

| 目的 | 文档 |
| --- | --- |
| 开发规则、验证要求、安全边界与提交纪律 | [docs/bilibili-cli/AGENTS.md](docs/bilibili-cli/AGENTS.md) |
| 当前实现、验收证据、已知限制与交接 | [docs/bilibili-cli/CONTEXT.md](docs/bilibili-cli/CONTEXT.md) |
| 打包、发布、回滚与版本约定 | [docs/bilibili-cli/RELEASE.md](docs/bilibili-cli/RELEASE.md) |
| 后续阶段与验收边界 | [docs/bilibili-cli/bridge实施路线图.md](docs/bilibili-cli/bridge实施路线图.md) |
| 产品使用与开发入口 | [packages/bilibili-cli/README.md](packages/bilibili-cli/README.md) |
| Agent 使用指引（安装、启动、工作流、写授权） | [skills/bilibili-cli/SKILL.md](skills/bilibili-cli/SKILL.md) |
| 命令、输出与退出码契约 | [skills/bilibili-cli/references/cli-contract.md](skills/bilibili-cli/references/cli-contract.md) |

## 常用命令

在仓库根目录执行（转发到 `packages/bilibili-cli`）：

```bash
npm test          # 构建、打包、临时安装与端到端回归
npm run test:compat  # 可选：Node/npm 版本兼容矩阵（不参与默认 test）
npm run build     # 生成独立发布目录（默认 release/bilibili-cli/）
npm run pack:cli  # 生成 npm 包
```

修改运行时代码后至少运行 `npm run typecheck`；提交前更新 `packages/bilibili-cli/CHANGELOG.md`，不提交生成物、依赖目录、凭证或用户状态。未获明确授权不执行 commit、push 或发布。
