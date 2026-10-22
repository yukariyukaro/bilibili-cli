# CLI 1.x 契约

## 安装与破坏性升级

Node.js 22+；安装可信的 `bilibili-cli-1.0.0.tgz` 后仅使用 `bilibili`。不再注册 bili、dsh-bili-scroll 别名；不支持旧 setup、whoami、search、reply、delete、agent 和 action/params 别名。仓库只包含这一个 CLI 产品源码，不包含任何插件宿主、MCP 服务或第二份入口。

B 站接口由 npm 依赖 `@yukariyukaro/bilibili-api-ts` 提供（bilibili-api-python 17.4.1 移植），随包安装，不启动 Python、uv 或后端子进程。登录二维码由 `qrcode` 依赖在进程内生成 PNG。

## 命令树

| 命令 | 字段 |
| --- | --- |
| auth login start / auth login poll | poll 必须有 --key |
| auth status | 无 |
| video search | --keyword 必填；--num 1–50 默认 10；--order totalrank/click/pubdate/dm |
| video info / video subtitle | --bvid 必填 |
| video hot | --page 1–1000 默认 1；--num 1–50 默认 20 |
| comment list | --bvid；--num 1–100 默认 30；--order like/time |
| comment thread | --bvid、--rpid 必填；--page 默认 1；--num 1–20 默认 10 |
| comment create | --bvid、--text 必填；可选 --rpid、--root；--confirm 或 --dry-run |
| comment delete | --bvid、--rpid 必填；--confirm 或 --dry-run |
| user info / user relation | --uid 必填 |
| inbox | --kind reply/like/at 必填；可选 --cursor-id、--cursor-time，0 表示首页 |
| dm status | --uid 必填；返回互关关系与未读计数 |
| dm read | --uid 必填；单次最多 30 条 |
| dm send | --uid、--text 必填；仅互关用户；--confirm 或 --dry-run |
| config get / config set | set 必须 --key 和 --value |
| doctor | 报告 Node、状态目录、凭证存在性与 API 包实际版本 |
| schema | 返回与命令注册共用的完整参数契约 |
| skills list / skills read | read 可选 --name bilibili-cli |

所有未知命令、未知参数和多余位置参数都拒绝。BV 号为 BV 加 10 位字母数字；rpid 与 uid 为 1 至 9007199254740991 的正整数。CLI 接受十进制字符串，JSONL 要求 JSON 整数。评论正文上限 150 个 UTF-16 代码单元，私信正文上限 300。配置仅允许 writesEnabled、mentionName、dmRecipientUid；写开关只接受 true/false，dmRecipientUid 只接受正整数，非空时 `dm send` 的收件人必须与它一致。

## 输出与退出码

`--json` 输出单行 `{schemaVersion:1,command,ok,result}`；失败为 `{schemaVersion:1,command,ok:false,error:{code,message}}`。未指定 JSON 时成功输出缩进对象，错误写 stderr。帮助与版本是文本且不创建用户状态、不安装依赖。退出码：0 成功，1 后端/业务/内部失败，2 参数错误，3 写保护或认证失败，4 审计失败，130/143 中断。

`bilibili --jsonl` 从 stdin 按序处理，每个完整非空行立刻响应，不等待 EOF；最后一行可没有换行。请求为 `{id?,command,args?}`，command 为完整空格分隔命令，args 使用 schema 字段（dryRun 对应 CLI --dry-run）。仅首行容许 BOM；单行最多 65536 字节，超长行丢弃并报错，下一行继续。每行失败独立隔离，总退出码取最高错误码，必须检查每行 ok。输出逐行，不提供并发保证或任意后端命令调用。

## 安全与状态

写操作先统一校验、检查严格布尔开关与逐次确认，再记录 attempt 审计，接口返回后记录 accepted 或 failed_or_unknown。attempt 失败阻止调用；结果审计失败报告未知状态，不伪报成功。只有 success:true 才接受写操作成功；业务 error、ok:false、success:false 均为失败。审计只含操作 ID、目标、正文 SHA256 和阶段，不含正文、凭证或原始后端错误。网络失败可能已经产生副作用，不自动重试。

`--dry-run` 仅校验和返回目标，不调用后端、不写审计，不要求先开写权限，也不代替真实确认。写操作返回 visibilityVerified:false，不宣称公开可见或已验证消失。

`BILIBILI_SKILL_HOME` 可指定独立状态目录；默认仍沿用 Windows 的 %APPDATA%/bilibili-skill、其他系统的 $XDG_CONFIG_HOME/bilibili-skill 或 ~/.config/bilibili-skill。不迁移其他工具目录中的凭证。doctor 只检查凭证文件是否存在，不读取正文，环境存在性不等于网络和账号状态可用。

API 请求沿用包内 30 秒超时；扫码生成与轮询各自 30 秒。未知后端错误不透传原文，防止意外泄露敏感数据；这会限制诊断细节。搜索、热门等公开接口可能被风控拒绝，失败按结构化错误返回，不伪造空结果。
