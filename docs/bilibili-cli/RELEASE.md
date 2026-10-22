# 发布手册（维护者）

本文件面向本仓库维护者，不随 npm 包发布，也不属于使用者文档。使用者入口见 [README](../../packages/bilibili-cli/README.md) 与 [SKILL.md](../../skills/bilibili-cli/SKILL.md)。

## 身份与命名

| 项目 | 值 |
| --- | --- |
| npm 包名 | `@yukariyukaro/bilibili-cli` |
| 命令名（`bin`） | `bilibili` |
| Skill 名 | `bilibili-cli`（`skills list/read` 使用，不随 npm 包名改） |
| 默认 `latest` 范围 | 文档统一写 `@1`，跟随 1.x 最新版 |
| 当前	extbf{已发布}版本 | 以 `npm view @yukariyukaro/bilibili-cli dist-tags` 为准，不要在此处写死 |

无 scope 的 `bilibili-cli` 属于其他维护者（`danni6`，仓库 MunMunMiao/BilibiliVideoDownload），与本项目无关，**不要**占用、覆盖或安装它来替代本项目。

## 发版流程

在本目录执行（Node.js 22+）：

```bash
npm ci                 # 构建需要 devDependencies（TypeScript），不要用 --omit=dev
npm run typecheck
npm test               # 构建、打包、临时安装、仓库外 PATH 与 bridge 回归
node scripts/build.mjs "<空目录绝对路径>"   # 生成不含 scripts/devDependencies 的发布目录
```

正式发布**只从 build 目录产出的 tarball 发布**，不要直接 `npm publish` 源码目录（那会把 `prepack`、`devDependencies` 写进包清单，且与 build 产物不一致）。

```bash
npm pack "<build 输出目录>" --pack-destination "<输出目录>" --json   # 记下 filename 与 files 清单
npm exec --yes --package "<tarball 绝对路径>" -- bilibili --version   # 需在仓库外目录执行
```

发布前必须核对：

- tarball 含 `dist/cli/bili.mjs` 与 `dist/lib/**`，35 个文件；
- 不含 `src/`、`test/`、`scripts/`、`tsconfig.json`、`.mts`、用户状态或凭证；
- 包内 `package.json` 没有 `scripts` 与 `devDependencies`（安装期不编译）；
- `npm exec` 冒烟输出的版本等于 `package.json` 的 `version`。

然后发布**同一个已验收的 tarball**：

```bash
npm publish "<tarball 绝对路径>" --registry=https://registry.npmjs.org/ --access public
```

也可以走 [.github/workflows/bilibili-cli-release.yml](../../.github/workflows/bilibili-cli-release.yml)：push `bilibili-cli-v*.*.*` 标签或在 Actions 里手动触发，CI 会重复上述构建与验收步骤后再发布。

## 凭证策略

- **绝不在仓库、文档、issue、CI 日志或提交信息里放 token。** 本地凭据只放仓库根 `.env`（已被 `.gitignore` 忽略），或直接用环境变量。
- npm 对发布的强制要求是「真实 2FA」或「带 bypass 2FA 的 granular token」。邮件 OTP 只用于登录，**不能**用于 `PUT` 发布。
- 生成 granular token 时三个字段都要对：
  - Packages and scopes：**All packages**（表单摘要必须显示 `access to all packages`，显示 `0 packages and 0 scopes` 就是没选上）；
  - Permissions：**Read and write (publish and stage)**；
  - **Bypass two-factor authentication (2FA)**：勾选。
- npm 已停止提供 Classic 令牌，新建只有 granular；且 [bypass 2FA 令牌自 2027-01 起不能再用于直接发布](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)。长期方案是给账号开启 TOTP 2FA，或改用 **npm trusted publishing（GitHub OIDC）**，届时工作流里可以删掉 `NPM_TOKEN`。
- token 只授予发布所需的最小范围，用后撤销；一旦贴到聊天、日志或截图中就视为已泄露。

CI 侧只需要在仓库 Secrets 里配置 `NPM_TOKEN`（值为上述 granular token），工作流不会打印它。

## 发布后的验证

发布输出出现 `+ @yukariyukaro/bilibili-cli@x.y.z` 只代表请求被受理，还要检查：

```bash
npm view @yukariyukaro/bilibili-cli dist-tags --registry=https://registry.npmjs.org/
# 全新缓存、隔离状态目录，从公共源真装一次
npx --yes --package @yukariyukaro/bilibili-cli@1 bilibili --version
npx --yes --package @yukariyukaro/bilibili-cli@1 bilibili doctor --json
```

新版本可能进入 npm 自动审核，包页面显示 `Validating`，此时版本端点会 `404` 且 `dist-tags` 仍指向旧版本。这属于正常流程，等审核放行后再验证，不要当成发布失败反复重发（同版本号无法覆盖）。

## 常见故障对照

| 现象 | 实际原因 | 处理 |
| --- | --- | --- |
| `PUT` 返回 `403`，提示需要 2FA 或 bypass token | 用的是网页登录令牌，账号未开 2FA | 换带 bypass 的 granular token，或开 TOTP 后用 `--otp` |
| `PUT` 返回 `404` 且响应体为空 | token 没有该包写权限（范围为空即视作无权），npm 用 404 掩盖 | 重建 token，确认摘要显示 `all packages` |
| 发布成功但包页面 `Validating` | 自动审核未完成 | 等待；不要重发同版本 |
| `dist-tags` 仍指向旧版 | CDN/索引延迟 | 等几分钟再查，必要时 `npm dist-tag add` |
| 国内安装 `@yukariyukaro/bilibili-api-ts` 404 | npmmirror 只有元数据、tarball 未同步 | 安装时显式 `--registry https://registry.npmjs.org` |
| `npm publish` 报 `EPUBLISHCONFLICT`/`cannot publish over` | 版本号已存在 | 升版本号，禁止覆盖历史版本 |

## 版本与文档纪律

- 遵循 semver：兼容修复用 patch，兼容新增用 minor，破坏公开契约才评估 major。仅文档整理也可发 patch（本次 1.1.1 即为文档修正，运行时与 1.1.0 相同）。
- 发版前更新 [CHANGELOG.md](CHANGELOG.md)，区分已验证与未验证项；发版后把 `Unreleased` 改成实际日期与发布信息。
- 使用者文档只写「怎么用」；发布路径、凭证、故障排查写在本文件。
- 发布授权不等于 commit、push 或打标签授权，仍需维护者逐次确认。
