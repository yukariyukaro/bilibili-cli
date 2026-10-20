# 给 AI 助手看的（本仓库 = 独立 B 站 CLI 与 Skill）

`bilibili-cli`：用稳定的 `bilibili` 命令搜索 B 站、读取视频信息/字幕/评论，并在用户逐次确认后发送或删除评论。**不依赖 DSH，不包含插件宿主代码。**

## 仓库边界

- `skills/bilibili-cli` 是唯一 CLI 产品源码：CLI、内部适配层、Skill、测试和打包脚本都在这里。
- `bilibili-api-ts/` 与 `bilibili-api-python/` 是并列的独立仓库，仅在本地多仓开发时嵌套于工作区，不纳入本仓库版本控制，也不是 CLI 的第二份实现。
- 根目录只是仓库包装，不注册 `bin`，不保留第二份 CLI 实现。
- `release/` 是 `npm run build` 生成的发布目录，不手工编辑。
- 原 DSH 插件代码与远程仓库已经移除；不要再从其他插件复制宿主依赖或运行时代码。

## 开发规则

- 只使用 `bilibili` 命令名；不恢复 `bili`、`dsh-bili-scroll`、平铺子命令或 `agent` 别名，也不恢复 MCP 传输层。
- 命令、帮助、`schema` 和 JSONL 必须共用同一份参数契约与校验。
- 写操作默认关闭，统一要求写开关、逐次确认和审计；业务失败不得包装成成功，未知状态不得自动重试。
- 不读取、打印、复制或迁移真实凭证；测试默认只做离线校验，真实后端回归必须显式启用，不使用模拟后端伪造结果。
- 测试聚焦端到端回归：构建、打包、临时安装、离开仓库、通过 PATH 调用 `bilibili`。不新增孤立单元测试。
- 不提交生成物、用户状态、凭证或压缩包。

## 常用命令

```bash
npm test
npm run build
npm run pack:cli
```

详细介绍见 `README.md`，命令契约见 `skills/bilibili-cli/references/cli-contract.md`。
