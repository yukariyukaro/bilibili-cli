# 测试账号准备

本页说明如何为真实只读验证、bridge 联调和控制台验收准备一个**专用测试账号**与其**隔离状态目录**。目标是：验证过程不接触主人的真实账号、不误开写开关、不把凭证带进仓库或对话。

不含真实写测试。真实写必须由用户对准确目标与最终正文逐次确认，见 [CLI 契约](cli-contract.md)。

## 为什么必须专用

- 真实只读会调用 B 站接口，可能留下阅读痕迹或触发风控；主账号不应承担这类风险。
- 测试需要反复扫码、切换登录态、制造"未登录/已过期"分支；主账号无法安全地这样折腾。
- 隔离目录能把凭证、baseline、审计与草稿限制在一个可随时删除的位置，避免污染日常使用的状态目录。

因此：**一个专用账号 + 一个仓库外的空目录**，两者都可在验证结束后丢弃。

## 1. 准备账号

1. 注册或在已有小号中选定一个**专用账号**；B 站注册通常需要手机号验证，请在用户本人可控的号码下完成，不要借用他人身份。
2. 不要使用主人日常使用的主账号；也不要把测试账号加入任何会自动点赞、投币、转发的配置。
3. 若验证涉及私信类用例，还需要一个第二账号与被测账号**互相关注**，否则 `dm read`/`dm send` 会因非互关被拒。
4. 不要在测试账号上绑定支付、实名重要权益或长期业务数据；这些会限制后续清理。
5. 记录账号 UID：登录后用 `bilibili auth status --json` 的 `result.uid` 读取，不要靠昵称猜。

## 2. 创建隔离状态目录

状态目录由 `BILIBILI_SKILL_HOME` 指定；未设置时 CLI 回落到账号级默认目录，**测试时不要使用默认目录**。

```powershell
# 仓库外、可随时删除的空目录
$testHome = Join-Path $env:TEMP 'dsh-bili-test-account'
New-Item -ItemType Directory -Force -Path $testHome | Out-Null
$env:BILIBILI_SKILL_HOME = $testHome
```

```bash
# POSIX
export BILIBILI_SKILL_HOME="$HOME/tmp/dsh-bili-test-account"
mkdir -p "$BILIBILI_SKILL_HOME"
```

要求：

- 必须是**绝对路径**、已存在、且**不在仓库内**；真实只读入口会校验这三点。
- 每次验证优先新建空目录，便于把"未登录"分支也跑一遍。
- 该目录会存放凭证、bridge 状态、baseline 与草稿，权限应按凭证对待。

## 3. 扫码登录

```bash
bilibili auth login start --json
```

- 返回 `result.url`（登录页）、`result.key`（一次性二维码 key）与 `result.png`（PNG 路径，通常在状态目录内）。
- 把二维码图片或 `result.url` 交给用户，由用户用**测试账号**扫码确认。
- 二维码约 3 分钟内有效；过期后重新执行 `auth login start`，不要复用旧 key。

扫码后单次轮询：

```bash
bilibili auth login poll --key <result.key> --json
```

`result.state` 的取值：`waiting`（未扫）、`scanned`（已扫待确认）、`ok`（成功并落盘凭证）、`expired`/`unknown`（需重新开始）。只有 `ok` 才代表凭证已写入状态目录。

## 4. 登录态自检

```bash
bilibili auth status --json
```

看两个字段而不是一个：

- `credentialPresent`：状态目录里有可解析的凭证文件。
- `logged_in`：B 站接口实际可用。

`credentialPresent:true` + `logged_in:false` 表示凭证过期、被风控或网络不可用——这不是登录成功。同时用 `bilibili doctor --json` 核对 CLI 版本、Skill 文档版本与 API 依赖。

## 5. 配置真实只读验证入口

`test/bridge/e2e/run.mjs readonly` 的必需门禁（缺失或非法会以退出码 2 明确报配置错误，不会伪装成通过）：

| 变量 | 要求 |
| --- | --- |
| `BILIBILI_E2E_READONLY` | 设为 `1` 才允许真实只读 |
| `BILIBILI_E2E_INSTALLED_PREFIX` | 仓库外的真实安装前缀，且含 `bilibili.cmd`（Windows）或 `bin/bilibili`（POSIX）；也可含 `node_modules/.bin/bilibili*` |
| `BILIBILI_E2E_AGENT_HOME` | 绝对路径、存在、不在仓库内的隔离状态目录 |
| `BILIBILI_E2E_OWNER_UID` | 只读目标账号的正整数 UID |

可选：

- `BILIBILI_E2E_OWNER_HOME`：第二账号的隔离目录，用于跨账号只读预检。
- `BILIBILI_E2E_AGENT_UID`：第二账号 UID。
- `BILIBILI_E2E_REQUIRE_LOGIN=1`：登录态不可用时直接判失败，而不是跳过真实用例。
- `BILIBILI_E2E_WORKDIR`：报告与产物目录，必须在仓库外；不设置时使用临时目录。

```powershell
$env:BILIBILI_E2E_READONLY = '1'
$env:BILIBILI_E2E_INSTALLED_PREFIX = 'C:\temp\bilibili-install'
$env:BILIBILI_E2E_AGENT_HOME = $testHome
$env:BILIBILI_E2E_OWNER_UID = '<测试账号 UID>'
Remove-Item Env:BILIBILI_E2E_WRITE -ErrorAction SilentlyContinue
```

安装前缀应由 `npm run build` 或 `npm pack` + 真实安装产生；入口会拒绝指向仓库源码的链接，这是防止"用源码冒充已安装 CLI"的护栏。

## 6. 必须避免的设置

- `BILIBILI_E2E_WRITE=1`：只读入口会直接报错拒绝，不会执行写测试。
- `BILIBILI_BRIDGE_DRY_RUN=false`：真实只读不需要关闭 dry-run；不要为了让某个用例"通过"而改动它。
- 把 `writesEnabled` 设为 `true`：写入开关只服务于用户当场确认的单次操作。
- 把真实主账号目录复制成测试目录：不要把凭证搬来搬去，使用新扫码得到的测试凭证。

## 7. 清理

1. 结束验证后删除整个隔离目录（凭证、状态、baseline、草稿都在里面）。
2. 若测试账号曾被用于私信或评论联调，确认没有开启自动回复策略，或在配置中设为 `off`。
3. 不要提交任何状态目录、报告或二维码图片；`result.png` 与令牌都不应进入版本库。
4. 如需保留证据，只保留脱敏后的 `bridge-e2e-*-report.json` 计数与结论，不保留凭证或原文。

## 8. 边界

- 本页描述的是**测试准备**，不是写授权；任何写操作仍需逐次确认与审计。
- 真实只读通过只证明接口可用与字段可读，不证明写入、通知送达或控制台任务执行完成。
- 协议夹具与离线用例不能替代真实只读证据，两者要分别报告。
