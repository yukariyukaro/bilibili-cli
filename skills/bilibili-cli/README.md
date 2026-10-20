# 独立 B 站 CLI

本目录是 CLI 唯一源码。Node.js 22+，B 站接口由 npm 依赖 `@yukariyukaro/bilibili-api-ts` 提供，不依赖任何插件宿主，也不启动 MCP 或 Python 后端。版本 1.0.0 是破坏性升级，只使用 `bilibili` 分组命令。

## 构建和安装

在本目录执行 `npm ci`、`npm pack`，再执行 `npm install --global "生成的压缩包绝对路径"`。安装后：

```powershell
bilibili --help
bilibili doctor --json
bilibili auth login start --json
bilibili auth login poll --key KEY --json
bilibili video search --keyword "AI Agent" --json
```

`doctor` 报告 Node、状态目录、凭证是否存在和实际安装的 API 包版本；没有需要额外安装的 Python 运行时。

## 技能和发布

`npm run build` 从本目录生成 `release/bilibili-cli`；目标必须为空，避免旧文件残留。CLI 代码与技能指导分开交付：生成目录中的 `skill/` 只有 SKILL.md 和 references，不带运行时、依赖或 CLI 副本。技能只调用已安装的 `bilibili`，可通过 `bilibili skills read --json` 发现。不要编辑 release；它是忽略的生成产物。更换输出位置可执行 `node scripts/build.mjs "空目录绝对路径"`。

`npm test` 在中文空格临时路径打包安装，通过 PATH 运行产物，并执行分组帮助、schema、JSONL、写保护与配置校验。默认不调用 B 站；设置 `BILIBILI_E2E=1` 后追加真实只读回归（需先完成登录），可配合 `BILIBILI_E2E_BVID` 与 `BILIBILI_E2E_TALKER` 指定视频和私信会话。测试不读取或输出凭证正文，不使用模拟后端冒充真实接口。

依赖 `@yukariyukaro/bilibili-api-ts@17.4.1` 已发布到公共 npm，正常安装会从 registry 解析。离线或预发布开发时，可设置 `BILIBILI_LOCAL_API_TARBALL` 指向本地 tarball，测试会启动只读本地注册表，让 npm 按 `^17.4.1`、integrity 和 lockfile 规则安装本地包。状态路径用 BILIBILI_SKILL_HOME 隔离，默认兼容 bilibili-skill，详见 [契约](references/cli-contract.md)。

## 来源与许可

本目录是独立实现，不依赖任何插件宿主，也不运行 MCP 服务。B 站接口实现来自 [`@yukariyukaro/bilibili-api-ts`](https://github.com/yukariyukaro/bilibili-api-ts)，它是 [Nemo2011/bilibili-api](https://github.com/Nemo2011/bilibili-api) 17.4.1 的 TypeScript 移植，以 GPL-3.0-or-later 发布；许可文本随 npm 包分发。CLI 不提供任意后端命令逃生口，账号写操作仍须逐次确认。
