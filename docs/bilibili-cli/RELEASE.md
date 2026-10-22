# 发布手册（维护者）

本文件面向本仓库维护者，不随 npm 包发布，也不属于使用者文档。使用者入口见 [README](../../packages/bilibili-cli/README.md) 与 [SKILL.md](../../skills/bilibili-cli/SKILL.md)。

## 身份与命名

| 项目 | 值 |
| --- | --- |
| npm 包名 | `@yukariyukaro/bilibili-cli` |
| 命令名（`bin`） | `bilibili` |
| Skill 名 | `bilibili-cli`（`skills list/read` 使用，不随 npm 包名改） |
| 默认 `latest` 范围 | 文档统一写 `@2`，跟随 2.x 最新版 |
| 当前**已发布**版本 | 以 `npm view @yukariyukaro/bilibili-cli dist-tags` 为准，不要在此处写死 |

无 scope 的 `bilibili-cli` 属于其他维护者（`danni6`，仓库 MunMunMiao/BilibiliVideoDownload），与本项目无关，**不要**占用、覆盖或安装它来替代本项目。

## 发版流程

在 `packages/bilibili-cli/` 执行（Node.js 22+）：

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

- tarball 含 `dist/cli/bili.mjs`、`dist/lib/**`、`SKILL.md` 与 `references/**`（文件数以 pack 清单为准）；
- 不含 `src/`、`test/`、`scripts/`、`tsconfig.json`、`.mts`、用户状态或凭证；
- 包内 `package.json` 没有 `scripts` 与 `devDependencies`（安装期不编译）；
- `npm exec` 冒烟输出的版本等于 `package.json` 的 `version`。

然后发布**同一个已验收的 tarball**：

```bash
npm publish "<tarball 绝对路径>" --registry=https://registry.npmjs.org/ --access public
```

也可以走 [.github/workflows/bilibili-cli-release.yml](../../.github/workflows/bilibili-cli-release.yml)：**main 每次提交都会触发**，只有 `package.json` 版本尚未发布时才真正发包。

1. 读取 `packages/bilibili-cli/package.json` 的版本；registry 已存在同版本 → 快速跳过（npm 同版本不可覆盖）。
2. 版本尚未发布 → 重复上面的 typecheck、`npm test`、build、pack、tarball 清单断言与 `npm exec` 冒烟。
3. 全部通过后发布同一个 tarball（带 provenance），并轮询 `npm view` 直到索引可解析。

因此**发版 = 在 PR 里提升 `package.json` 的 `version` 并更新 CHANGELOG**，合并到 main 即自动发布；不需要再打 tag。手动触发只用于 `dry_run` 复验（默认 false，若有未发布的新版本会直接发布）。

## 发布凭证：npm trusted publishing（OIDC）

发布**不需要 `NPM_TOKEN`**。npm 包绑定 GitHub OIDC 信任关系后，工作流里的 `npm publish` 会自动用短期 OIDC 凭证，工作流不带任何长期 token。

一次性配置（npm 网站，需要账号密码解锁 settings）：

1. 打开 `https://www.npmjs.com/package/@yukariyukaro/bilibili-cli/access`。
2. 在 **Trusted Publisher** 区域选择 **GitHub Actions**，填写：
   - Organization or user：`yukariyukaro`
   - Repository：`bilibili-cli`
   - Workflow filename：`bilibili-cli-release.yml`（只写文件名，必须与仓库内路径一致）
   - Environment name：留空
   - Allowed actions：勾选 `npm publish`（`npm stage publish` 默认允许）
3. 保存。每个包最多可配置 10 个 trusted publisher。

工作流要求（已满足）：

- `permissions: id-token: write`；
- Node >= 22.14、npm >= 11.5.1（工作流在发布前执行 `npm install -g npm@^11.15.0`）；
- 发布步骤**不设置** `NODE_AUTH_TOKEN`，否则 npm 会优先走 token 而不是 OIDC；
- workflow 文件名与 npm 侧配置完全一致。

回退方案（临时）：如果 OIDC 暂时不可用，仍可在仓库 Secrets 配 `NPM_TOKEN` 并在发布步骤注入 `NODE_AUTH_TOKEN`。但 [bypass 2FA 令牌从 2026-08 起限制账户变更、2027-01 起不能直接发布](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/)，只应作为短期兜底。

其它约定：

- **绝不在仓库、文档、issue、CI 日志或提交信息里放 token。**
- 发布步骤带 `--provenance`；provenance 与 trusted publishing 使用同一套 OIDC（`id-token: write`）。
- 轮换/撤销只影响 npm 侧信任关系，不需要改仓库 Secrets。

## CI 与真实只读 E2E

[.github/workflows/ci.yml](../../.github/workflows/ci.yml) 在 PR 与 main 上运行：

| 任务 | 触发 | 内容 | 登录态 |
| --- | --- | --- | --- |
| 离线 E2E | 所有 PR 与 main | `npm ci`、typecheck、`npm test`（构建→pack→安装→离线 CLI/bridge） | 不需要 |
| 真实只读 E2E | push main 与手动触发 | 注入隔离登录态后跑 CLI 与 bridge 的真实只读子集 | 需要仓库 Secret |

仓库配置：

- Secret `BILIBILI_E2E_CREDENTIAL`：**专用测试账号**的 `bili_credential.json` 内容，JSON 字段为 `sessdata`、`bili_jct`、`dedeuserid`，可选 `buvid3`。工作流只把它写进 runner 临时目录（0600），任务结束删除，不打印、不打包、不上传 artifact。
- 仓库变量 `BILIBILI_E2E_OWNER_UID`（可选）：bridge 真实只读使用的对话方 UID。未配置时 bridge 只跑离线安装与控制面用例。

边界与约定：

- `pull_request` 事件不会注入凭证；PR 代码无法读取 Secret。真实只读只在 push main / 手动触发时运行。
- 缺少或失效的登录态会输出 `live.status=skipped` 并继续跑离线用例，不会把“没登录”伪装成真实只读通过。需要“登录态失效即失败”时，给 bridge 入口设置 `BILIBILI_E2E_REQUIRE_LOGIN=1`。
- 使用专用测试账号，不要用主账号；轮换凭证只需更新 Secret。真实只读账号的 `writesEnabled` 保持 false，CI 不执行真实写。

## 发布后的验证

发布输出出现 `+ @yukariyukaro/bilibili-cli@x.y.z` 只代表请求被受理，还要检查：

```bash
npm view @yukariyukaro/bilibili-cli dist-tags --registry=https://registry.npmjs.org/
# 全新缓存、隔离状态目录，从公共源真装一次
npx --yes --package @yukariyukaro/bilibili-cli@2 bilibili --version
npx --yes --package @yukariyukaro/bilibili-cli@2 bilibili doctor --json
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

- 遵循 semver：兼容修复用 patch，兼容新增用 minor，破坏公开契约才评估 major。仅文档整理也可发 patch（例如 1.1.1 为文档修正，运行时与 1.1.0 相同）。
- 发版前更新 [CHANGELOG.md](../../packages/bilibili-cli/CHANGELOG.md)，区分已验证与未验证项；发版后把 `Unreleased` 改成实际日期与发布信息。
- 使用者文档只写「怎么用」；发布路径、凭证、故障排查写在本文件。
- 发布授权不等于 commit、push 或打标签授权，仍需维护者逐次确认。
