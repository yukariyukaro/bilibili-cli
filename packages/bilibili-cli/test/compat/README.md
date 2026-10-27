# Node / npm 兼容矩阵（可选套件）

回答一个问题：**同一份构建产物，在不同 Node 与 npm 版本上还能不能 pack、安装、运行公开命令？**

本套件**不参与默认 `npm test`**：默认套件（`scripts/verify.mjs`）固定跑当前 Node/npm，只证明一条路径可用；矩阵把版本维度显式拉出来，按需运行。两条入口都保留。

## 覆盖范围

| 模式 | Node | npm | 需要 |
| --- | --- | --- | --- |
| `--native`（默认） | 当前 Node，或 `--node-bin` 指定的 Node 可执行文件（必须满足 `engines.node`） | `current`、9、10、11 | 网络（安装 npm 版本、拉运行时依赖） |
| `--docker` | 22、24（官方 `node:<major>-bookworm-slim` 镜像） | 镜像自带 npm；`--npm` 可追加 9/10/11 | Docker daemon |
| `--check` | — | — | 无（不联网） |

默认矩阵的依据：`engines.node >= 22` 对应 npm >= 10，npm 9 是用户显式降级时真会遇到的边界，所以保留在默认 native 矩阵里；Docker 两个 Node 主版本覆盖当前 LTS 区间。要验证别的版本用 `--npm` / `--node` 显式传。

## 每个组合证明什么

一条组合 = 一个 Node 版本 × 一个 npm 版本，全部走真实交付路径，不读工作树 `src/`：

1. 发布目录 `npm pack` → tarball 清单断言（含 `dist/cli/bili.mjs`、`SKILL.md`、`references/`；不含 `src/`、`test/`、`scripts/`、`.mts`、`node_modules`、用户状态）。
2. `npm install --global --prefix <隔离前缀> --ignore-scripts` → 安装位置、bin 入口、包清单（无 `scripts`/`devDependencies`）。
3. PATH 调 `bilibili`：`--version`、`doctor --json`（运行时依赖与主版本、**CLI 自己的 `process.version` 必须等于目标 Node**）、`schema --json`（命令表）、`skills list --json`（随包文档版本），并断言只读命令不创建状态目录。
4. `npm exec --yes --package <tarball> -- bilibili --version`：直接运行 tarball，断言 `_npx` 缓存布局、以及不在运行目录写 `package.json`。

Docker 模式下第 1、2 步在镜像构建期用镜像内 npm 完成（构建期联网），第 3 步在 `--network none --read-only` 运行期执行；第 4 步在离线容器里无法联网取依赖，所以只在 native 模式覆盖。

## 用法

```bash
# 静态校验：不联网、不构建、不跑容器
npm run test:compat:check

# native：当前 Node × npm current,9,10,11（默认，需要网络）
npm run test:compat

# 只跑指定 npm 版本
npm run test:compat -- --npm 10,11

# 换 Node：用官方 Node 22 二进制跑同一套组合（无需 Docker，npm 跟随该发行版）
#   下载 https://nodejs.org/dist/latest-v22.x/ 的 win-x64.zip 并解压后：
npm run test:compat -- --node-bin "C:\path\node-v22.23.4-win-x64\node.exe" --npm current,10

# 复用已构建的发布目录，跳过 build（需要含 package.json 与 dist/cli/bili.mjs）
npm run test:compat -- --npm 11 --release-dir release/bilibili-cli

# Docker：Node 22/24 自带 npm，另外追加 npm 9 与 11
npm run test:compat:docker -- --npm current,9,11

# 保留工作目录/镜像取证
npm run test:compat -- --npm 11 --keep
```

输出：stdout 一份 JSON（`type: bilibili-cli-node-npm-compat`）；`BILIBILI_COMPAT_REPORT=<path>` 可另存文件。工作目录默认在系统临时目录，必须位于仓库外。

## 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 所有组合通过 |
| 1 | 有组合失败（含构建失败）；`checks`/`failures` 给出具体哪一步 |
| 2 | Docker daemon 不可达；没有容器证据，不是通过 |
| 64 | 参数错误 |

## 证据边界

- 能证明：给定 Node/npm 版本下，构建产物可 pack、可全局安装、公开命令（`--version`/`doctor`/`schema`/`skills list`）可用，`npm exec` 可直接运行。
- 不能证明：真实 B 站收发、真实私信/评论到达、bridge 真实会话；这些仍走各自的显式人工入口。
- 不替代 `test/release`：那个套件证明“registry 上已发布的交付物可下载且 integrity 一致”，本套件证明“版本维度上的安装与运行”。
- `--check` 只是静态校验（文件、脚本注册、Dockerfile、默认 `npm test` 未被改动），不能当作兼容性证据。
- 跳过（`skipped`）不算通过：`--node` 低于 `engines.node` 时该组合显式跳过并在 `summary.skipped` 计数，整体仍判定失败。

## 已知的版本敏感面

这些是矩阵真正盯着的行为，也是写死单版本断言会漏掉的地方：

- `npm exec` 的 `_npx` 缓存布局与去重（npm 9/10/11 并不完全一致）。
- `npm install --global --prefix` 的 bin 布局（POSIX `prefix/bin` vs Windows 直接放 `prefix`）。
- PATH 里的 `node` 覆盖目标版本：npm 生成的 Windows shim 优先用 `%dp0%\node.exe`，找不到就退回 PATH 的 `node`。矩阵把目标 Node 目录和本次安装的 `bilibili` 一起前置到 PATH，并用 `doctor.node` 反向确认 CLI 真跑在该 Node 上——否则「换 Node 版本」会静默变成「同一次 Node 24」。
- `npm pack --json` 的清单字段与 scoped 包命名。
- 各版本 npm 对 `--ignore-scripts`、registry 元数据与 integrity 的处理。

## 新增版本

`--npm` 接受 `current` / `X` / `X.Y` / `X.Y.Z`；`--node` 接受主版本号（仅 `--docker`，必须满足 `engines.node`）；`--node-bin` 接受任意 Node 可执行文件路径（仅 `--native`，其同级目录必须带 npm）。改默认矩阵就改 `run.mjs` 顶部的 `DEFAULT_NATIVE_NPM`、`DEFAULT_DOCKER_NODE`，并同步本文件与 `docs/bilibili-cli/RELEASE.md` 的说明。
