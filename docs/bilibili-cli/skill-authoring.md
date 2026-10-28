# Agent Skill 编写与演进规范（Harness Engineering）

本文是 `skills/bilibili-cli/` 的维护者编写规范。它定义**信息放在哪一层、以什么句式写、如何通过真实失败驱动迭代、以及哪些检查由脚本自动门禁**，避免 AI 在缺乏规范时生成「字段名齐全但不可达、禁令完备但缺正向配方」的半成品 Skill。

> **分发边界**：本文件属于 `docs/bilibili-cli/` 维护者文档，**不进入** `skills/bilibili-cli/` 安装包或 npm tarball（`npx skills add` 与 `packages/bilibili-cli/scripts/closure.mjs` 只复制 `SKILL.md` 与 `references/`）。

---

## 1. 参考基准与源码锚点

本规范提炼自以下高星开源仓库的源码与开放标准文档（均附固定 commit SHA 与行号，便于后续核验）：

| 来源仓库 / 站点 | 星标与定位 | 核心采纳内容与源码链接 |
| --- | --- | --- |
| [**obra/superpowers**](https://github.com/obra/superpowers) | ★ 306k · Agent TDD 方法论 | **Iron Law（先看裸跑失败再写 Skill）**、**按失败类型选句式（正向配方 vs 禁令）**、**机械规则必须自动化**。<br>• [`skills/writing-skills/SKILL.md#L10-L46`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/SKILL.md#L10-L46)（Skill 即流程文档的 TDD）<br>• [`skills/writing-skills/SKILL.md#L59`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/SKILL.md#L59)（能用正则/脚本校验的绝不靠文档叮嘱）<br>• [`skills/writing-skills/SKILL.md#L163-L183`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/SKILL.md#L163-L183)（`NO SKILL WITHOUT A FAILING TEST FIRST`）<br>• [`skills/writing-skills/SKILL.md#L248-L264`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/SKILL.md#L248-L264)（Match the Form to the Failure：为什么纯禁令在塑形问题上比不给指导还差）<br>• [`skills/writing-skills/references/discovery.md#L53-L145`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/references/discovery.md#L53-L145)（SDO：description 禁写流程概括、参数细节下沉 `--help`） |
| [**anthropics/skills**](https://github.com/anthropics/skills) | ★ 184k · 官方 Skill 实践与评测器 | **三级渐进披露（Progressive Disclosure）**、**主动型（pushy）触发描述**、**用解释原因（why）替代生硬全大写 MUST**。<br>• [`skills/skill-creator/SKILL.md#L66-L109`](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md#L66-L109)（Anatomy & 三级加载系统、`<500` 行上限、`>300` 行 reference 附目录）<br>• [`skills/skill-creator/SKILL.md#L296-L305`](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md#L296-L305)（从反馈中泛化而非过拟合、保持精简、Explain the why、跨用例重复脚本打包）<br>• [`skills/skill-creator/SKILL.md#L333-L406`](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md#L333-L406)（Description 触发优化循环） |
| [**agentskills/agentskills**](https://github.com/agentskills/agentskills) & [**agentskills.io**](https://agentskills.io) | ★ 26.7k · Agent Skills 开放标准 | **Frontmatter 硬契约**、**Gotchas 错题本模式**、**给默认路径而非并列菜单**、**20 条触发评测集（含近邻负例）**。<br>• [规范全文 `docs/specification.mdx`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx)（同步发布于 [agentskills.io/specification](https://agentskills.io/specification)）<br>• [编写最佳实践 `docs/skill-creation/best-practices.mdx`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/best-practices.mdx)（L50 只写 Agent 不知道的事、L86 明确何时加载哪个 reference、L125 Provide defaults not menus、L165 Gotchas 留在 `SKILL.md`）<br>• [触发描述优化 `docs/skill-creation/optimizing-descriptions.mdx`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/optimizing-descriptions.mdx)（L39 8–10 正例 + 8–10 近邻负例 `near-misses`）<br>• [质量评测 `docs/skill-creation/evaluating-skills.mdx`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/evaluating-skills.mdx)（`with_skill` vs `without_skill` 双跑对照） |
| [**larksuite/cli**](https://github.com/larksuite/cli) | ★ 17.9k · 标杆级 CLI + Skills 工程 | **四层职责切分（WHAT / 命令级 WHEN / 领域路由与安全 / 条件 HOW）**、**场景化路由**、**Reference 强触发索引**、**返回信封判定契约**。<br>• [`AGENTS.md#L55-L70`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/AGENTS.md#L55-L70) & [`#L141-L158`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/AGENTS.md#L141-L158)（Surface 分工表与 Affordance/Skills 边界）<br>• [`affordance/README.md#L1-L78`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/affordance/README.md#L1-L78)（每条命令的 `When` / `Avoid when` / `Prerequisites` / `Tips`）<br>• [`skills/lark-shared/SKILL.md#L14-L48`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/skills/lark-shared/SKILL.md#L14-L48)（通用准则、退出码门禁与「强触发索引」表）<br>• [`skills/lark-doc/SKILL.md#L13-L49`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/skills/lark-doc/SKILL.md#L13-L49)（按场景路由 + 禁止开局一次性全读 reference +「不在本 Skill 范围」）<br>• [`skills/lark-im/references/lark-im-messages-send.md#L23-L70`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/skills/lark-im/references/lark-im-messages-send.md#L23-L70)（Reference 内部决策表 + 真实转换形状示例） |
| [**jackwener/OpenCLI**](https://github.com/jackwener/OpenCLI) | ★ 30.7k · 精简 CLI + Skill 实例 | **超短入口（66 行）+ 契约先行 + 禁止在 Skill 里硬编码全量命令目录**。<br>• [`skills/opencli-usage/SKILL.md#L1-L66`](https://github.com/jackwener/OpenCLI/blob/97dc0cd5214b9602bcda78d7422f231ee8a803e9/skills/opencli-usage/SKILL.md#L1-L66)（L20 `Do not hard-code the adapter catalog or dump all commands into context`） |

---

## 2. 四层职责切分（Single Source of Truth）

参照 [`larksuite/cli/AGENTS.md#L146-L148`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/AGENTS.md#L146-L148) 的分层法则，本仓库把 CLI 与 Skill 的知识严格切分为四层，**同一事实只在一处维护**：

| 层级 | 负责回答 | 本仓库承载位置 | 编写铁律 |
| --- | --- | --- | --- |
| **L1 · Schema / Help** | **WHAT**（有哪些命令、参数类型、必填/默认、正则约束） | `packages/bilibili-cli/src/lib/contract.mts` → `bilibili schema --json` 与 `bilibili <cmd> --help` | 参数定义唯一权威源。Skill 正文不手抄参数列表（见 [`discovery.md#L137-L144`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/references/discovery.md#L137-L144)）。 |
| **L2 · 命令契约与 Affordance** | **命令级 WHEN & RETURNS**（何时用、何时别用而改用 `[[另一命令]]`、前置 ID 从哪来、**返回结构的关键子字段形状与单位**） | `skills/bilibili-cli/references/cli-contract.md`（后续可演进注入 `schema` 的 affordance 字段） | 绝不只列裸字段名（如仅写 `result`）；嵌套结构、数组对应关系、单位（秒 vs 毫秒、分P vs 6 分钟段）必须写清。 |
| **L3 · 主入口 `SKILL.md`** | **意图路由、降级链、Gotchas、全局安全边界、Reference 强触发索引** | `skills/bilibili-cli/SKILL.md`（建议 `<150` 行，硬上限 `<500` 行 / `5000` tokens） | **每次激活都会全量进入上下文**。只放所有任务都需要的决策与高频踩坑；按**用户意图**而非命令对象组织路由。 |
| **L4 · 按需参考 `references/*.md`** | **条件性 HOW**（多步编排工作流、Bridge 长期进程、安装升级、专用测试账号准备） | `skills/bilibili-cli/references/{feature-workflows,bridge,cli-contract,skill-upgrade,test-account-setup}.md` | 只有在命中特定阶段或触发条件时才由 Agent 按需读取；超过 300 行的文件顶部必须带目录。 |

**反模式警示（本仓库曾踩过的真实缺陷）**：
- 在路由表里只写「快照、官方 AI 总结 → `video snapshot`」，缺少「**看这条视频（没字幕 / 想知道画面）**」的用户意图入口；
- 在 `cli-contract.md` 只写 `返回 bvid/page/cid/images/index/result`，未展开 `result.{pvdata, img_x_len, img_y_len, img_x_size, img_y_size, image[], index[]}`（10×10 缩略图网格 + 每格秒数）；
- 四处强调「快照 URL 不等于已看懂画面」，却没有一处写出「如何用 `video snapshot` 的网格拼图交给视觉模型读画面」。
结果：Agent 严格遵守了防幻觉禁令，却把 CLI 唯一能看到画面的正路当成死路放弃。

---

## 3. Frontmatter 与 Description 触发设计

遵循 [Agent Skills Specification](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L23-L175)、[`optimizing-descriptions.mdx`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/optimizing-descriptions.mdx#L11-L27) 与 [`superpowers/discovery.md#L57-L119`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/references/discovery.md#L57-L119)：

1. **硬格式约束**：
   - `name`：1–64 字符，仅允许小写字母、数字与单连字符（`bilibili-cli`），与父目录同名。
   - `description`：1–1024 字符，非空。启动时只有 `name` + `description` 常驻系统提示词，**它承担 100% 的触发责任**。
   - `metadata`：维护 `version`（必须等于 `packages/bilibili-cli/package.json` 的 `version`）、`requiresCli`（主次版本 `X.Y`）与 `requires.bins: ["bilibili"]`，由 `verify.mjs` 自动断言对齐。
2. **Description 的「WHAT + WHEN + NOT」三段式，且禁写工作流步骤**：
   - **写清覆盖范围（WHAT）与用户口吻触发词（WHEN）**：覆盖「看/总结 B 站视频或 BV 链接、查 UP 主、读字幕/快照网格/弹幕/评论/动态/收藏/合集、查通知私信与创作数据、三连/发评/发动态/私信等受控写操作、bridge 长期监听」。
   - **适度主动（pushy）**：参照 [`skill-creator#L67`](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md#L67)，明确指出即便用户只甩了一个 `bilibili.com/video/BV...` 链接说「看看这个」也应触发本 Skill，而不是直接回退到通用网页抓取。
   - **绝不在 description 中概括执行步骤**：参照 [`superpowers/discovery.md#L63-L85`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/references/discovery.md#L63-L85)，一旦在 description 里写了操作步骤摘要，Agent 会直接照着摘要走而跳过阅读 `SKILL.md` 正文。

---

## 4. `SKILL.md` 正文的五要素结构

`SKILL.md` 必须保持紧凑，并包含以下五个核心模块：

### 4.1 准备与版本握手
- 先跑 `bilibili --version` 与 `bilibili doctor --json`，核对 `skill.updateAvailable` / `skill.matchesCli`。
- 明确「Skill 不含 CLI、不得用 `npx` 兜底运行 CLI、安装规则唯一入口在 `references/cli-contract.md#安装与运行`」。

### 4.2 按用户意图路由表（Intent-First Routing Table）
- **第一列必须是用户的真实意图或口吻**（如「看这条视频讲了什么（含无字幕兜底）」「搜视频 / 看热门」「看某个 UP 主最近发了什么」「看评论区和弹幕反响」），**不得**按 API 资源名词罗列。
- **第三列必须给出权限属性（公共读 / 登录读 / 逐次确认写）与下一步动作或 Reference 锚点**。
- **显式写出跨命令降级链（Degradation Chain）**：例如读视频内容时，按 `video info` + `video subtitle`（需登录）→ `video summary`（官方 AI 总结）→ `video snapshot`（取 `result` 里的 10×10 缩略图网格与 `index` 秒数，裁切拼图后交视觉模型识图）→ `danmaku list` / `comment list`（旁证，严禁冒充作者口述）的顺序降级，而不是在第一步没字幕时直接放弃。

### 4.3 Gotchas（高频踩坑错题本）
参照 [`best-practices.mdx#L165-L185`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/best-practices.mdx#L165-L185)，将违背直觉的平台/CLI 事实直接留在 `SKILL.md`，每当评估或真实对话中纠正了 Agent 的一次错误，就追加一条：
- 位置参数陷阱：所有参数必须带命名 flag（如 `--bvid BV...`），裸传位置参数会报 `USAGE: too many arguments`。
- ID 精度陷阱：`dynamic` ID 与弹幕 `dmid` 是最高 19 位十进制整数字符串，转 JS `Number` 会丢精度。
- 概念混淆陷阱：`video info` 的 `pages` 是分P数，不是 `danmaku list --segment` 的 6 分钟分段数；`video relation` 是「我是否已点赞/投币/收藏」，不是相关视频推荐；`video toview` 是添加/移除稍后再看的**远端写命令**，不是查询列表。
- 开关与门禁陷阱：`doctor` 显示 `writesEnabled=true` 只代表全局开关已开，**不是本次授权**；每次写调用仍须向用户展示准确目标与正文并拿到本次确认后加 `--confirm`。

### 4.4 写操作门禁与证据边界（正向配方 + 禁令配对）
- 写操作四步闭环：展示准确方案 → 明确硬币支出边界 → 取得本次确认 → 带 `--confirm --json` 调用并核验 `result.audited: true`。

### 4.5 Reference 强触发索引（Mandatory Trigger Index）
参照 [`lark-shared/SKILL.md#L38-L48`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/skills/lark-shared/SKILL.md#L38-L48) 与 [`lark-doc/SKILL.md#L15`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/skills/lark-doc/SKILL.md#L15)：
- 明确声明：**不要在任务开始时一次性读取全部 `references/*.md`**；只在首次进入对应场景时按表读取一次。
- 用表格列出「强触发条件（命中任一即必读）→ 对应 Reference 文件与章节锚点」，杜绝笼统的「详见 references/」。

---

## 5. 句式与行文准则（Match the Form to the Failure）

直接采纳 [`superpowers/writing-skills/SKILL.md#L248-L264`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/SKILL.md#L248-L264)、[`best-practices.mdx#L50-L160`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/best-practices.mdx#L50-L160) 与 [`skill-creator#L302`](https://github.com/anthropics/skills/blob/dbd4588f9e1033efb41dad4bef2f7947c8993d44/skills/skill-creator/SKILL.md#L302) 的实证结论：

1. **禁止孤立的否定句（No Naked Prohibitions）**：
   - 当你要防止 Agent 过度宣称（如「快照 URL 不等于已看懂画面」「无字幕不编造口述」）时，**每一句「X 不等于 Y / 禁止做 A」后面必须紧跟半句正向可执行动作「应当做 B」**。
   - ❌ 错误示范：`仅拿到快照 URL 不能说已看懂画面。`（Agent 读完直接放弃使用 `video snapshot`）
   - ✅ 正确示范：`仅拿到快照 URL 不算读过画面；但可读取 result 里的 10×10 缩略图网格（480×270/格）与 index 每格秒数，下载或裁切关键帧交视觉模型读取画面文字，并在结论中注明对应秒数。`
2. **给默认路径，不给平权菜单（Provide Defaults, Not Menus）**：
   - 存在多条路径时，指定唯一首选路径，再写清退化条件（如「读视频内容首选 `video subtitle`；返回空列表时依次退化到 `video summary` 和 `video snapshot` 网格识图」）。
3. **不带软化尾巴（No Nuance Clauses）**：
   - 不要写「不要自动重试，除非你觉得有必要」这类留出谈判空间的句子。真正的例外必须写成绑定在**可观测谓词**上的条件句（如「仅当 `auth status --json` 返回 `result.logged_in: false` 且任务需要本人权限时，才引导执行 `auth login start`」）。
4. **讲清原因（Explain the Why）**：
   - 说明为什么这样规定（如「按 300 字截断评论会生成 CLI 校验层必然拒绝的 151–300 字正文，因此评论上限从 `comment create` 契约读取为 150」），帮助模型在未覆盖的边界上做出一致判断。
5. **删掉模型本来就会的常识（Omit What the Agent Knows）**：
   - 每段话自问：「删掉这句，Agent 会做错吗？」不会就删。不要解释什么是 JSON、什么是 BV 号或如何使用命令行。

---

## 6. `references/` 编写规范

1. **返回形状必须写到可消费粒度**：
   - 在 `cli-contract.md` 与 `feature-workflows.md` 中，凡是包含嵌套对象或非直观数组对应的命令（如 `video snapshot` 的 `result.{pvdata, img_x_len, img_y_len, img_x_size, img_y_size, image[], index[]}`、`video relation` 的顶层 `liked/coins/favorited` 与嵌套 `result` 的关系、`danmaku list` 的 `count` vs `segmentTotal` vs `video info` 的 `stat.danmaku`），必须写明字段含义、单位与消费方式。
2. **包含最小可运行正例与错误恢复**：
   - 参考 [`lark-im-messages-send.md`](https://github.com/larksuite/cli/blob/a92db8779c0959bc14beb69d82fb262123cfb79b/skills/lark-im/references/lark-im-messages-send.md)，每个工作流给出精确的 CLI 调用块（含 `--json`），并指明遇到 `AUTH`（exit 3）、`RISK_CONTROL`（exit 4）、`available: false` 或空数组时的标准分支。
3. **单层引用与体积控制**：
   - 所有 reference 直接从 `SKILL.md` 一跳可达，禁止 `SKILL.md → ref A → ref B` 的深层链式跳转（见 [`specification.mdx#L237`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx#L237)）。单文件超过 300 行时在顶部提供章节锚点目录。

---

## 7. TDD 式演进流程（RED → GREEN → REFACTOR）

修改 `skills/bilibili-cli/`（尤其是路由表、工作流与安全规则）时，遵循 [`superpowers/writing-skills#L272-L312`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/SKILL.md#L272-L312) 与 [`evaluating-skills.mdx`](https://github.com/agentskills/agentskills/blob/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/skill-creation/evaluating-skills.mdx)：

1. **RED（基线复现）**：
   - 用自然语言用户口吻（**不提前在 prompt 里写出命令名**）向只加载了旧版 Skill 的 Agent 提问，观察其完整调用轨迹（trace），记录它在哪一步选错命令、猜错参数或过早放弃。
2. **GREEN（最小补丁）**：
   - 判断失败属于哪一层：找错命令改 `SKILL.md` 路由表；不知道返回结构改 `cli-contract.md` 与 `feature-workflows.md`；参数高频误用加 `SKILL.md` Gotchas；被禁令吓退则补齐「正向配方」。
3. **REFACTOR（堵漏与沉淀回归）**：
   - 用同一自然语言任务重跑验证，并把该用例加入 [Skill-only 真实只读评测协议](skill-eval.md) 的「意图路由与降级链回归集」，防止后续改写时回退。

---

## 8. 自动化门禁与提交前核对清单

依据 [`superpowers/writing-skills#L59`](https://github.com/obra/superpowers/blob/2ce8aa15d05bd57213e6f746f953aafb7ded7a8b/skills/writing-skills/SKILL.md#L59)（能自动化的绝不靠人眼审查），本仓库通过 `packages/bilibili-cli/scripts/verify.mjs` 与 `closure.mjs` 执行以下硬门禁（部分项随迭代持续扩充）：

- [ ] **目录纯净性**：`skills/bilibili-cli/` 只允许存在 `SKILL.md` 与 `references/`（及已登记的 5 个 reference 文件），不混入源码、脚本或临时产物。
- [ ] **版本对齐**：`SKILL.md` frontmatter 的 `metadata.version` 与 `metadata.requiresCli` 严格对齐 `packages/bilibili-cli/package.json`。
- [ ] **单一安装源与禁 npx**：全局安装命令只在 `references/cli-contract.md` 出现一次；任何文档不得把 `npx` 写成运行 `bilibili` CLI 的方式。
- [ ] **命令全覆盖**：`bilibili schema --json` 中的全部公开命令在 `references/cli-contract.md` 与产品 `README.md` 命令表中 100% 出现；`SKILL.md` 路由表覆盖全部高频用户意图。
- [ ] **体积与可达性**：`SKILL.md` 控制在 500 行以内；`references/` 下每个文件均在 `SKILL.md` 中带触发条件被链接，无死链或孤立文件。
- [ ] **禁令配对检查**：新增或修改任何「不等于 / 不得 / 禁止」条款时，同行或紧邻句已给出可执行替代动作或降级路径。
