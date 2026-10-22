# bilibili-cli bridge Docker E2E（可选）

可选 Linux 隔离入口，用**真实打包安装**的 `bilibili` 运行与宿主相同的
`skills/bilibili-cli/test/bridge/offline.mjs build`。不另造 suite、不 mock B 站、
不读取凭证、不挂载宿主。

当前状态（本机实测）：`node skills/bilibili-cli/test/bridge/docker/run.mjs --check`
为 `static-checked` / exit 0（68 个 context 文件、32 个 `.mjs` 通过 `node --check`、12 项静态检查）；
默认 `node .../run.mjs` 为 `status=unavailable` / exit 2（Docker client 29.8.0，Server null，
`dockerDesktopLinuxEngine` pipe 不存在）。未构建镜像、未运行容器，不宣称容器通过。

## 用法

```bash
# 无 daemon 的静态校验：准备临时 context、校验 TS/发布闭包/凭证/参数/语法
node skills/bilibili-cli/test/bridge/docker/run.mjs --check

# 默认：探活 Docker -> build -> docker run
node skills/bilibili-cli/test/bridge/docker/run.mjs

# 根 package 入口（默认 Docker 模式）
npm run test:bridge:docker
```

可选 `--node-version 22|24`、`--keep-context`、`--keep-image`、`--verbose`。
注意 npm 11 下 `npm run ... -- --check` 可能把 `--check` 当 npm 配置吞掉；
静态校验请直接用上面的 `node ... --check`。

### 退出码

| 码 | 含义 |
| --- | --- |
| 0 | `--check` 通过（`static-checked`），或容器内同一套件全绿 |
| 1 | 静态/构建失败，或容器内同一套件红灯（test-failure，不归为基础设施失败） |
| 2 | Docker client/daemon 不可用；没有容器证据 |
| 64 | 参数错误 |

## Context 白名单

runner 只复制：

```text
skills/bilibili-cli/src/**/*.mts
skills/bilibili-cli/tsconfig.json
skills/bilibili-cli/scripts/{compile,build,closure}.mjs
skills/bilibili-cli/cli/bili.mjs         兼容 shim（只转 dist/lib/command.mjs）
skills/bilibili-cli/package.json
skills/bilibili-cli/package-lock.json
packages/bilibili-cli/{README.md,LICENSE,CHANGELOG.md} 与 skills/bilibili-cli/{SKILL.md,references/**}
skills/bilibili-cli/test/bridge/**        offline/e2e/regressions/backend/protocol/lifecycle/lib
Dockerfile / .dockerignore / context-manifest.json
```

明确排除：仓库根、`bilibili-api-ts`、`bilibili-api-python`、`node_modules`、`.git`、
`dist`、`release`、`.artifacts`、状态、凭证、HOME、审计、二维码、压缩包、日志。
`--check` 断言 context 顶层只有
`Dockerfile / .dockerignore / context-manifest.json / skills`。

## 容器构建与运行

1. builder：`npm ci`（含 TypeScript 开发依赖）→ `node scripts/compile.mjs`
   → `npm pack`（prepack 也会编译）→ 校验 tgz 含 `dist/cli/bili.mjs`、
   `dist/lib/bridge/main.mjs`、`cli/bili.mjs`、`CHANGELOG.md`，且不含
   `src/`、`test/`、`scripts/`、`tsconfig.json` → 全局安装到 `/opt/bilibili`。
2. runtime：`--network none`、`--read-only`、`/tmp` tmpfs、非 root、`procps`、
   无宿主挂载、无宿主环境变量；只复制已安装前缀 + 白名单后的 `test/bridge`。
3. entry 校验源码快照哈希、安装产物 `dist/lib/bridge/*`、loopback-only 网络、
   `ps`，然后以仓库外 cwd 运行 `test/bridge/offline.mjs build`。
4. 同一套件红灯按 test-failure 保留并 exit 1；不 skip、不改断言、不包装成通过。

### 依赖版本边界

- `npm ci` 按 `package-lock.json` 安装开发/构建依赖（含 TypeScript）。
- `npm pack` 生成真实 tgz；`npm install --global` 仍按包内 semver 解析运行时依赖。
- `--prefer-offline` 只优先缓存，不保证 global 安装严格锁在 lockfile 精确版本。
- 容器内 doctor/测试会报告实际安装版本；不要声称全局产物按 lock 精确锁定。

## 安全与 TDD 边界

- 不挂载宿主 HOME、凭证、状态目录或 Docker socket；不向容器传 `-e/--env-file`。
- 运行阶段无默认路由，仅容器内 loopback 本地 WS；不访问 B 站业务网络。
- 不读取/打印/复制真实凭证；只使用全新临时 `BILIBILI_SKILL_HOME`。
- 真实只读需独立显式入口；真实写仍需人工逐次确认，本 runner 不自动授权。
- `--check` 只是静态校验，不等于容器 E2E 通过；Docker 不可用不等于通过。
- 容器路径在 daemon 不可用时未实跑，不宣称容器通过。

## 文件

| 文件 | 作用 |
| --- | --- |
| `run.mjs` | `--check` 静态校验；默认 probe/build/run；unavailable exit 2 |
| `Dockerfile` | procps + npm ci + compile + pack + global install + runtime 白名单 |
| `.dockerignore` | 防御性排除凭证/状态/artifact/node_modules/日志 |
| `container/entry.mjs` | 快照/隔离/ps/dist 预检，运行同一套 offline build，保留红灯 |
