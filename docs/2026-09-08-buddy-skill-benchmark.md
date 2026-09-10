# 北森 / 腾讯电子签 技能包借鉴分析

> 目的：定位两个已上架技能包的本地路径，逐项对比与 CRM `connector/skills/` 的规格差距，产出可执行的改进清单。
> 生成脚本：`scripts/compare-skill-packs.mjs`（只读，不改任何文件）。
> 分析日期：2026-09-08

---

## §0 结论先行

| # | 结论 | 优先级 |
|---|---|---|
| 1 | 北森走 **CLI 连接器**模式（本地进程 + SSO），**不要求公网 HTTPS endpoint** —— 这直接绕开我们卡死的 ICP 备案阻塞 | **P0** |
| 2 | 北森有 **共享基座 Skill**（`beisen-shared`），我们 16 个技能各自重复红线、无公共层 | **P0** |
| 3 | 我们 frontmatter **缺 `version` 字段**，平台市场大概率要求 | **P0** |
| 4 | 我们 description 平均 **93 字**，对照样本 **183 字**，且缺口语化触发词 | P1 |
| 5 | 腾讯电子签「**常驻回复 + 引导优先于鉴权**」两条强制规则可复用为我们的报价红线提醒 | P1 |

---

## §1 本地路径

### 1.1 北森（beisen-cli · 连接器形态）

| 项 | 值 |
|---|---|
| 完整副本 | `C:\Users\wangchuan08\.workbuddy\connectors-marketplace\connectors\beisen-cli\` |
| 连接器配置 | 同目录 `cli.json` |
| 技能包 | 同目录 `skills/`（16 个业务域 + 1 个共享基座） |
| 专家 ID | `ex_JabRwu60p0Ua` → `beisen-hr-expert`；`ex_suQHAd2QMU0Z` → `beisen-recruitment-expert` |
| 专家 ID 源 | `C:\Users\wangchuan08\.workbuddy\app\cache\experts\expert-bundle-map.json` |
| 包体积 | 227,920 字节 |

技能清单：`beisen-shared`（基座）、`beisen-applicant-follow-up`、`beisen-approval`、`beisen-attendance-leave`、`beisen-data-query`、`beisen-employee-profile`、`beisen-interview`、`beisen-job-management`、`beisen-knowledge`、`beisen-organization`、`beisen-recruiting-insights`、`beisen-recruiting-todo`、`beisen-recruitment`、`beisen-recruitment-demand-management`、`beisen-service-portal`、`beisen-talent-sourcing`。

### 1.2 腾讯电子签（tencent-esign-contract · 纯 Skill 形态）

| 项 | 值 |
|---|---|
| 完整副本 | `C:\Users\wangchuan08\.workbuddy\skills-marketplace\skills\tencent-esign-contract\` |
| 结构 | `SKILL.md`(10.7KB) + `references/`(5 个) + `scripts/`(`tencent_esign.py` + `config.json`) |
| 专家条目 | `ContractLegalExpert`（市场 manifest `app/cache/experts/manifest.json`，446 条中的一条） |
| 专家提示词 | `/plugins/contract-legal-expert/agents/contract-legal-expert.md`（**本地无此插件包**，未下载） |
| 包体积 | 55,854 字节 |

### 1.3 ⚠ 关于「已安装」的准确说明

- `skills-marketplace/skills/` 是**市场全量镜像**（268 个目录全部带 `_skillhub_meta.json`，`installedAt` 同为 2026-06-04），**不等同于用户级安装**。
- 用户级真实安装目录 `~/.workbuddy/skills/`：**无** beisen / esign 相关条目。
- 已安装连接器 `~/.workbuddy/connectors/skills/`：仅 `connector-westock-mcp`、`fbs-connector`。

**结论**：两者均未落到用户级安装目录，但**市场镜像里有完整副本，足够学习**——本分析全部基于这些副本的真实内容。

---

## §2 规格对比

### 2.1 frontmatter 字段

| 字段 | 北森 | 腾讯电子签 | **CRM（我们）** |
|---|:---:|:---:|:---:|
| `name` | ✅ | ✅ | ✅ |
| `description` | ✅ | ✅ | ✅ |
| `version` | ✅ | ✅ | ❌ **缺失** |
| `category` | ✅ | — | ❌ |
| `author` | ✅ | — | ❌ |
| `agent_created` | ✅ | — | ❌ |
| `allowed-tools` | ✅ (`Bash, Read`) | — | ❌ |
| `requires-skills` | ✅ | — | ❌ |
| `requires-cli` | ✅ (`>=1.0.8`) | — | ❌ |
| `description_zh` / `description_en` | — | ✅ | ❌ |
| `homepage` / `metadata` | — | ✅ | ❌ |
| `environment` / `security` | — | — | ✅ **我们有而对方无** |

**判读**：`version` 缺失是硬伤（平台市场分发要求）。我方独有的 `environment` / `security` 声明（零信任、无外网访问）是加分项，应保留。

### 2.2 描述字段长度（决定路由命中率）

| 来源 | 技能 | 描述字数 | 正文总字数 |
|---|---|---:|---:|
| 北森 | beisen-shared | 240 | 11,520 |
| 北森 | beisen-data-query | 306 | 17,750 |
| 腾讯电子签 | tencent-esign-contract | 201 | 5,700 |
| **CRM** | **16 个平均** | **93** | ~2,400 |
| CRM | method-funnel-classification | 171（最长） | 1,369 |
| CRM | method-opportunity-matrix | 59（最短） | 1,995 |

**差距**：平均描述长度约为对照样本的 **1/2**，正文约为 **1/3**。

### 2.3 包结构

| 结构 | 北森 | 腾讯电子签 | CRM |
|---|---|---|---|
| `references/` 详细协议 | ✅（每个技能一个） | ✅（5 个指南） | ✅（15/16 有） |
| `scripts/` 可执行脚本 | — | ✅（Python） | ❌ |
| 共享基座技能 | ✅ `beisen-shared` | — | ❌ |
| 版本/CLI 依赖声明 | ✅ `requires-cli` | ✅ `requires.bins` | ❌ |

---

## §3 逐条借鉴点

### 🟢 P0-1｜认证路径：CLI 模式绕开 ICP 备案阻塞

**北森做法**（`cli.json` verbatim）：

```json
{
  "init":    { "win32": "npm install -g beisen-cli" },
  "auth":    { "win32": "beisen-cli auth login" },
  "unAuth":  { "win32": "beisen-cli auth logout" },
  "status":  { "win32": "beisen-cli auth status" },
  "statusMatchJson": { "status": "valid" },
  "authUrlDomain": "login.italent.cn",
  "authWaitForExit": true,
  "runtime": { "type": "node", "version": ">=22.20.0" },
  "versionCheck": { "command": { "win32": "beisen-cli version" },
                    "minVersion": "1.0.8",
                    "versionPattern": "(\\d+\\.\\d+\\.\\d+)" }
}
```

**为什么关键**：连接器认证由**本地 CLI 进程**发起 OAuth 到 `login.italent.cn`，平台侧不需要回调我们的公网 HTTPS 端点。

**对照我们的卡点**：`chiyuai.com` 未 ICP 备案 → SNI 级拦截 → 远程 MCP HTTPS 不可达 → `connector/` 提交审核也过不了（此前判定为"唯一根治路径是备案"）。

**可借鉴方案**：做 `crm-cli`（`npm install -g crm-cli` + `crm-cli auth login`），本地进程直连：
- 本地 `http://localhost:3001/mcp`
- 生产 `http://81.70.184.198/mcp`（**IP 直连不需要备案**，已有 Nginx + Basic Auth `admin/union998`）

认证不依赖域名解析，备案阻塞由此绕开。

> ⛔ 属架构级变更，**须先走 brainstorming 获批**再实施。本文只做方案记录。

### 🟢 P0-2｜共享基座 Skill

**北森做法**：`beisen-shared`（240 字描述 / 11,520 字正文）承载全部横切规则，每个业务 Skill 第一行强制声明：

```markdown
**CRITICAL — 开始前 MUST 读取 [../beisen-shared/SKILL.md](../beisen-shared/SKILL.md)**
```

基座内容：CLI 安装检查（**仅会话首次执行**，省 token）、SSO 认证（**由 CLI 返回 401 + `CLI_AUTH_005` 驱动**，不主动 status 检查）、身份与权限、高风险门禁（`exit 10`）、数据分级、JSON 输出契约、错误处理。

**我们的差距**：16 个技能各自重复写红线，无公共层；改动红线要改 16 处（易漂移）。

**建议**：抽 `crm-shared` 承载——租户隔离、决策第 0 闸 + HITL、禁 DELETE、`context-routing` 红线、报价走 `CRM_APPROVAL_FLOW` 带 `decision_id`、off-system 报价提醒。其余 16 个技能改为 `requires-skills: [crm-shared]`。

### 🟢 P0-3｜补全 `version` 与 frontmatter 字段

为每个 `connector/skills/*/SKILL.md` 补 `version`，并按需补 `category` / `author` / `agent_created` / `allowed-tools` / `requires-skills`。保留我方独有的 `environment` / `security`。

### 🟡 P1-1｜description 扩写 + 口语化触发词

**腾讯电子签做法**（verbatim 片段）：

> …当用户提到起草合同、写合同、生成合同、审查合同…**即使用户只是说「帮我写份合同」「这份合同有没有问题」「两版合同有什么区别」**等口语化表达，也应触发本技能。

显式要求模型识别口语表达，提高路由命中率。

**我们的现状**：描述偏术语化（如 `method-opportunity-matrix` 仅 59 字），用户说"这个单子还值得跟吗"未必命中。

**建议**：每个 description 扩到 150–200 字，末尾追加 3–5 个口语触发句。

### 🟡 P1-2｜常驻回复规则（报价红线）

**腾讯电子签做法**：SKILL.md 顶部`## ⚠️ 强制规则（每次回复都必须遵守）`，规定每次回复末尾必须附加指定内容；审查场景额外附加免责声明。

**可复用为**：凡回复涉及**报价/折扣**，末尾强制附加——
> 报价与折扣必须走 `CRM_APPROVAL_FLOW` 并带 `decision_id`；线下私下报价将形成治理缺口。

这条直接对应用户长期关注的 **off-system 私下报价红线**。

### 🟡 P1-3｜引导优先于鉴权

**腾讯电子签做法**（verbatim）：

> 收到用户消息后，**先判断是否命中以下关键词**，再决定是否进入业务流程…如果仅命中产品引导关键词而无合同业务意图，则**只回复对应引导内容 + 常驻回复，不执行鉴权，不调用任何 API**。

双收益：省 token/API 调用；避免误触发写链路。

**与我们的同构经验**：项目铁律「**安全判定的顺序即安全边界**——红线判定必须排在其他降级规则之前」。此处是同一原则的正面应用。

### ⚪ P2｜数据分级展示策略

**北森 L0–L3**（verbatim 摘要）：

| 级别 | 分类 | 数据示例 | 展示规则 |
|:---:|---|---|---|
| L0 | 公开 | 组织架构、部门名称、公司公告 | 正常完整展示 |
| L1 | 内部 | 员工姓名、职位、工号、部门 | 正常展示，批量查询默认摘要 |
| L2 | 敏感 | 考勤记录（他人）、绩效结果、候选人信息 | 仅本人可查全部，他人摘要；不回显原始 JSON |
| L3 | 机密 | 薪酬、工资条、身份证号、合同附件 | 二次身份验证；脱敏展示；**不写入任何持久化存储** |

可映射到 CRM：L3 ↔ 价格底线/折扣权限/成本毛利，要求二次确认 + 不落盘。

---

## §4 行动清单

| 优先级 | 任务 | 依据 | 状态 |
|---|---|---|:---:|
| P0 | 评估 `crm-cli` 方案替代远程 HTTPS MCP | §3 P0-1，绕开备案阻塞 | ⛔ 待 brainstorming 批准 |
| P0 | 抽 `crm-shared` 共享基座技能 | §3 P0-2 | ⛔ 待批准 |
| P0 | 补全 16 个 SKILL.md 的 `version` 等字段 | §3 P0-3 | ⛔ 待批准 |
| P1 | description 扩写至 150–200 字 + 口语触发词 | §3 P1-1 | ⛔ 待批准 |
| P1 | 报价场景常驻回复规则 | §3 P1-2 | ⛔ 待批准 |
| P2 | 数据分级 L0–L3 映射 | §3 P2 | ⛔ 待批准 |

> 按项目铁律：以上均为功能性/架构性变更，**未获显式批准前不实施**。本文仅为差距分析与方案记录。

---

## §5 复现命令

```powershell
# 重新对比（改了 connector/skills 后验证）
node scripts/compare-skill-packs.mjs
```
