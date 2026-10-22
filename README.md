# bilibili-cli

在终端里查 B 站，也让 Agent 帮你读字幕。命令统一叫 `bilibili`，脚本、CI 和 coding agent 用同一个入口。

<p>
<img src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white" alt="Node.js 22+">
<img src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white" alt="TypeScript strict">
<img src="https://img.shields.io/badge/license-MIT-22B5F5" alt="MIT">
</p>

- **CLI**：搜索、视频信息、字幕、评论、用户资料、私信，以及可选的 bridge 私信监听。
- **Skill**：给 coding agent 的使用指引；只安装文档，不复制 CLI 源码。
- **安全默认**：写操作默认关闭；发送或删除评论、发送私信前必须逐次确认。

需要 Node.js 22+。B 站接口由 npm 依赖 `@yukariyukaro/bilibili-api-ts` 提供，不依赖 Python 或任何插件宿主。

## 安装

先检查 `bilibili --version`。若命令不可用，告知用户并取得同意后安装官方 CLI：

```bash
npm install -g @yukariyukaro/bilibili-cli@^1
bilibili --version
bilibili doctor --json
```

安装后直接使用 PATH 上的 `bilibili` 命令。不同意全局安装或安装失败时，不要自动切换到 npx；说明 CLI 依赖尚未满足。只使用官方包名，不静默安装或升级。

安装 Agent Skill：

```bash
npx skills add yukariyukaro/bilibili-cli --skill bilibili-cli
```

> Skill 与 CLI 分开安装、分开升级；升级 Skill 不会自动升级 CLI。升级 CLI 前先取得用户同意，并核对 `bilibili --version` 与 `bilibili doctor --json`。

## 快速开始

```bash
bilibili doctor --json                                  # Node、状态目录、依赖与凭证自检
bilibili auth status --json
bilibili auth login start --json                        # 把二维码或 URL 交给用户扫码
bilibili auth login poll --key KEY --json               # 单次轮询，直到 state 为 ok

bilibili video search --keyword "AI Agent" --num 10 --json
bilibili video info --bvid BV1xxxxxxxxx --json
bilibili video subtitle --bvid BV1xxxxxxxxx --json
bilibili comment list --bvid BV1xxxxxxxxx --num 30 --json
```

多步调用可以用 `bilibili --jsonl`，一行一个请求；完整参数、输出信封与退出码见
[CLI 契约](skills/bilibili-cli/references/cli-contract.md)。

## 写入前请确认

评论、删除与私信默认关闭：

1. 用户明确要求后开启写权限：`bilibili config set --key writesEnabled --value true`；
2. 展示准确目标与最终正文，取得本次确认；
3. 本次调用带 `--confirm`。

`--dry-run` 只预览，不是授权；写开关也不是长期同意。

## 仓库结构

```text
.
├── packages/bilibili-cli/     # npm 包：src、test、scripts、构建与发布
├── skills/bilibili-cli/       # Agent Skill：SKILL.md + references（安装时只复制这些）
├── docs/bilibili-cli/         # 维护者文档：架构、路线图、发布、上下文
├── .github/workflows/         # CI 与发布
└── README.md
```

- `bilibili-api-ts/` 与 `bilibili-api-python/` 是独立仓库，多仓开发时嵌套在工作区，不纳入本仓库。
- `skills add` 只复制 Skill 目录；CLI 源码在 `packages/`，不会进入用户的技能目录。

## 开发

```bash
cd packages/bilibili-cli
npm ci                # 安装依赖与开发工具
npm run typecheck
npm run compile       # src/*.mts -> dist/*.mjs
npm test              # 构建、打包、临时安装与端到端回归
npm run build         # 生成独立发布目录（默认 <Git 根>/release/bilibili-cli/）
```

根目录的 `package.json` 只是快捷入口：`npm test`、`npm run build`、`npm run pack:cli` 都会转发到 `packages/bilibili-cli`。

## 文档

| 文档 | 读者 |
| --- | --- |
| [产品 README](packages/bilibili-cli/README.md) | 使用者：完整命令、安装、升级与安全边界 |
| [SKILL.md](skills/bilibili-cli/SKILL.md) | Agent：工作流、写授权、启动配置 |
| [维护规则](docs/bilibili-cli/AGENTS.md) | 维护者：开发与提交纪律 |
| [上下文](docs/bilibili-cli/CONTEXT.md) | 维护者：实现、验收证据与限制 |
| [路线图](docs/bilibili-cli/bridge实施路线图.md) | 维护者：后续阶段与验收边界 |
| [发布说明](docs/bilibili-cli/RELEASE.md) | 维护者：打包、发布与回滚 |

## 许可

MIT。B 站接口实现来自 [`@yukariyukaro/bilibili-api-ts`](https://github.com/yukariyukaro/bilibili-api-ts)（GPL-3.0-or-later），许可文本随 npm 包分发。
