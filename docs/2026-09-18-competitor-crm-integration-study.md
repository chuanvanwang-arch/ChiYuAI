# 竞品 CRM 集成方案研究（ROX / ATTIO / Lightfield）

> 日期：2026-09-18 · 性质：竞品一手文档研究（非推测）· 目的：对标「需求④ 与原 CRM 集成」的工业级做法
> 证据原则：全文事实均来自厂商官方文档/官网原文，来源 URL 随文标注；无来源的判断标注为「推断」。

---

## §0 结论先行

1. **ROX 把「回写客户侧 CRM」当作立身之本，而非可选项。** 官方原话：*"To earn that right, we meet customers in their existing stack—CRMs synced to a warehouse of choice—and we write back anything enriched or edited in Rox to their CRM."* 我方 `writeback.js:15` 红线③明文写着「本次**不回写客户侧 CRM**（属 S4 后续）」——**这是战略级差距，不是工程量差距**。
2. **但惊人地巧合**：我方回写通道已具备与 ROX 同构的三项机制（静态来源标记 / 字段级乐观并发 / 白名单字段映射），只是**方向是内向的**（落我方可客户粒子），且缺对账层。
3. **三家竞品没有一家做「我方网页收邮箱密码」。** ROX 只用 Google DWD/WIF 与 Microsoft Entra 管理员同意；ATTIO 只用 Gmail/Outlook OAuth；Lightfield 只用 Google/Microsoft 登录按钮。ATTIO 对非 Gmail/Outlook 的兜底是**邮件转发**，不是收密码。→ 我原设计的 IMAP 密码表单，**在竞品里不存在同类形态**。
4. **我方的 HITL 接入闸门是竞品没有的强项。** ROX 文档中接入配置由 admin 直配生效，未见评审闸门；我方 `gate.js` 对 first-connect / mapping-change / trust-elevate / enable-writeback 四类动作 fail-closed 且**无自动放行路径**。这条不该削，应作为合规差异化保留。
5. **中国市场是空窗**：ROX 只支持 Salesforce / HubSpot（*"designed to extend to other CRMs with configuration"*），ATTIO 官方承认**没有原生 HubSpot/Salesforce 双向同步**（必须走 Zapier/Stacksync/Polytomic 中间件）。用友 / 金蝶 / 纷享销客 / 销售易 无人覆盖。

---

## §1 ROX：集成架构全解

来源：`roxdemo.com/docs/engineering/docs/rox-enterprise-integrations/crm-integration`、`launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback`、`launch.rox.com/docs/engineering/rox-enterprise-integrations/google-org-wide-email-calendar-integration`、`docs.rox.com/development/how-to-use-rox/integrations/email`

### §1.1 定位：不做 CRM，做「喂给图」的数据源

| 概念 | ROX 原文 |
|---|---|
| SOR | *"System of Record (SOR) — a unified knowledge graph"*，横跨公共数据与私有数据做 **entity resolution** |
| CRM 的角色 | *"**Rox treats any CRM as just another data source feeding the SOR.**"* |
| 终局 | *"customers will graduate to a warehouse-native future where Rox writes directly to their warehouse (and let's be honest: in that future, **Rox is the CRM**)"* |

**关键判断**：ROX 承认 CRM 是客户的关键业务数据所在，先深度**适配**它（Ingest + Write-back 两个必备能力），再逐步迁移。**先共存、后替代**——与 ROX 的 `coexistence` 打法一致，也与我方 `docs/2026-09-15-final-design-coexistence-and-proactive.md` 的设计意图一致。

### §1.2 三层集成架构（可直接对标我方）

| 层 | 职责 | 关键机制（原文要点） |
|---|---|---|
| **Mappings Layer** | 字段映射 + 校验 + 同步方向 | 每个映射字段携带 **Sync Direction**（`Read-only in Rox → CRM` 单向 / `Bi-directional` 双向）+ **类型化校验**（`NUMBER` min/max、`TEXT` max length、`nullable`） |
| **Real-Time Layer** | 用户编辑的事务性回写 + 自动最新态 | **乐观并发**（见 §1.3②） |
| **Batch Layer** | 高吞吐单向回写 + 待写对账 | **CRON 每 15 分钟**；per-cell `last synced at` 检查点；CRM bulk API 压低限流；大 TEXT 列分批读防 OOM；**每次回写与审计记录同事务落 sharded Postgres** |

### §1.3 ROX 自陈的六个「非平凡问题」及解法 —— 这节最值钱

| # | ROX 提出的问题 | ROX 的解法 | 我方现状 |
|---|---|---|---|
| ① | **初始摄取归并**：CRM 数据需与公共/私有源及 Rox 原生实体对账 | entity resolution across public + private | 有 `external_id` 对齐，无公共源归并 |
| ② | **Agentic CRM 行为**：Rox 内编辑要双向同步；agent 生成的富集要自动落 CRM，不让用户「伺候」遗留 CRM | 双向映射 + batch 富集 | ⛔ 方向内向，不回客户侧 |
| ③ | **变更来源判定（Change-origin disambiguation）**：CRM 变更回流时，必须**确定性判定**这是「CRM 原生改动」还是「我方回写后被读回」，否则两侧重复 | 显式判定 + **ID mapping 存两侧** | ⛔ **完全没有**（无来源标记判定，无双向 ID 表） |
| ④ | **始终最新态**：销售与 agent 都要看到最新值，无需手动刷新 | 实时 fetch + 快照比对 | 有 CAS 但无自动最新态解析 |
| ⑤ | **只读洞察要写回**：希望把 Rox 只读列（Clever Columns/firmographics）物化进 CRM 字段以保证数仓一致 | Batch 单向回写 | ⛔ 无 |
| ⑥ | **CRM 无关映射**：管理员要能配 Rox↔CRM 字段，带单向/双向语义 | Mappings Layer | 有 mapping，无逐字段方向与类型校验 |

**②的完整算法（ROX 原文，值得逐句抄）**：

> *"**The clock problem.** CRM and Rox clocks are not guaranteed to be synchronized, so raw timestamps aren't a safe basis for 'who wins.' We avoid NTP-style clock alignment and instead implement an **optimistic concurrency strategy that does not depend on wall clocks**."*

写前检查（每次 UI 写入）：
1. **实时拉取 CRM 当前对象**（仅被改字段相关）
   - 拉取失败 → 视 Rox 为最新态，接受用户修改，立即尝试 CRM 写；仍失败 → 标记 **pending CRM write**
   - 拉取成功 → 比对「CRM 当前态」与「用户编辑基线（用户刚才在 Rox 页面上看到的值）」；**存快照或映射字段的稳定 hash**
2. **冲突处理**
   - 不匹配（用户看到后 CRM 变了）→ **中止写入**，展示刚拉到的 CRM 值，隐式提供 force-overwrite
   - 匹配 → 执行实时写
3. **提交语义**
   - 成功 → Rox 提交 + 记审计
   - 失败（校验/429/5xx/网络）→ **不丢弃用户意图**，落 Rox 并标 `pending CRM write`，连同编辑时的快照入 batch 对账队列

**Batch 对账（防止覆盖更新的值）**：
> 取当前 CRM 对象与存下来的快照比对：**不同 → 跳过该 pending 写**（等价于「当时写成功也会被后改覆盖」）；**相同 → 通过 bulk/标准 API 落盘并更新审计**。
> ROX 自评这是 *"exactly-once(ish) semantics for user edits without clock synchronization"*。

**这解决了什么问题**：分布式下没有统一时钟时，回写最容易出的两类事故——**丢用户意图**（写失败就丢）与**覆盖他人更新**（stale overwrite）。ROX 用一个「快照 + 比对 + 待写队列」同时解决两者。

### §1.4 接入侧真实步骤（Salesforce）—— 注意它的复杂度与前置要求

| 步 | 动作 | 关键细节 |
|---|---|---|
| 0 | **前置** | 需要一个 Salesforce 用户，具备：Salesforce/Integration 用户许可、**System Administrator profile**、**API access 打开**。建议复用已给 Gong/Outreach 用的那个账号 |
| 1 | Rox 侧连接 | Settings → Integrations → Salesforce → Connect → **重定向到 Salesforce 登录** → **经 Fivetran（第三方数据搬运服务）授权** |
| 2 | **在客户 CRM 内装包** | 安装 Rox 包（选择 `Install for All Users`）→ 自动创建权限集 **`Rox Integration`** |
| 3 | **在客户 CRM 内建字段** | Object Manager → Activity → 新建 **Text 字段 `RoxActivityId`，长度 100** |
| 4 | **逐对象授读写权限** | 在 `Rox Integration` 权限集里给下列对象 Read+Edit：Account（名称/网址/行业/营收/员工数/地址）、Contact、Opportunity、Opportunity Line Item、Product、Lead、Task（含新字段）、Event（含新字段）、以及任意自定义对象 |
| 5 | 配映射 | Settings → CRM → CRM Mappings；**五个 tab**（Accounts/Opportunities/Contacts/Activities/Leads），**逐对象**配频率与开关 |

**采到的可配置项**：
- **同步频率**：`5 / 10 / 15 / 30 / 60 / 180 / 360 / 720 / 1440` 分钟（即 5 分钟 ~ 1 天），**逐对象独立**，可 Pause 单个对象
- **字段级双向开关**：左拨 CRM→Rox（须先选 CRM 字段）、右拨 Rox→CRM writeback（**仅当左拨打开且 CRM 字段可写**）；行中显示 `Syncing / Not syncing` 徽标
- **锁图标 🔒**：基础/必填字段可改映射目标但不可删除；垃圾桶：自定义字段可移除
- **Activities tab 专属**：`LinkedIn Message Writeback`、`LinkedIn Connection Writeback`、`Lead Resolution`（回写时自动匹配 CRM 线索）、`Email-only`
- **Static value mappings**：给**每条**回写记录写固定值。官方推荐用法原文：*"Set a `Source = "Rox"` field on accounts or opportunities created via Rox writeback"*、*"Tag every Rox-written activity with `Subject = "Demo"` so you can filter on Rox-sourced activities in Salesforce reports"*

> **对照我方**：`connectorActions.js:192` 的 `Source: 'crm-ai-native'` 与 ROX 的 `Source="Rox"` 是**同一设计意图**（让「这条是本平台写的」在客户 CRM 里可过滤、可追溯）。我方已有此机制，**只是从未真正写到客户侧**。

### §1.5 邮箱/日历授权 —— 全 OAuth/联邦，零密码

**企业级两种架构**（Google Workspace，`google-org-wide-email-calendar-integration`）：

| 架构 | 机制 | 安全性说明 |
|---|---|---|
| A. **Domain-Wide Delegation (DWD)** | 客户授予 DWD 给 **Rox 拥有的服务账号**，Rox 以此**模拟（impersonate）每个已上线用户**读写其日历与邮件 | 凭据为服务账号密钥 |
| B. **Customer Workload Identity Federation + DWD**（推荐） | 客户在自己 GCP 项目建 WIF Pool + OIDC Provider、建**客户自有的** Service Account、授予 WIF principal `roles/iam.workloadIdentityUser`；Google Admin Console 配 DWD 并加该 SA 的 OAuth Client ID；Rox 侧提供 Project Number / WIF Pool ID / OIDC Provider ID / SA | **原文：*"Rox uses short-lived federated credentials; no long-lived keys are stored by Rox"*** |

**Scope 分档（邮箱与日历各自独立选）**：

| 目标 | 请求的权限 |
|---|---|
| Calendar 只读 | `.../auth/calendar.readonly` |
| Calendar 读写 | `calendar.readonly` + `calendar.events` |
| Gmail 只读 | `.../auth/gmail.readonly` |
| Gmail 读写 | `gmail.readonly` + `gmail.send` |

**安全声明原文**：*"Least-privilege by default (read-only scopes)."* / *"You can revoke access centrally (remove DWD, disable the WIF binding, or disconnect in Rox)."*
**同步节奏**：*"Rox fetches Calendar events (and Email, if enabled) **every 15 minutes**. Credentials are refreshed automatically before expiry. Syncs are **incremental**."*

**Microsoft 365 路径**（`granting-microsoft-integration-permissions-for-rox`）：完整走 **Entra 管理员同意**流程——
1. 用户在 Rox 点 Connect → 看 scopes → 跳 Microsoft
2. 租户要求 admin consent 时出现「Approval required」屏，列权限（`Calendars.Read`、`Calendars.ReadWrite`），**publisher 显示 `Rox Data Corp.`（带验证徽章）**，用户填理由 → Request approval
3. 管理员在 **Entra ID → Enterprise apps → Admin consent requests** 审批 → 验证发布者与理由 → Accept（**租户级授权，组织内其他人不再被弹窗**）
4. 用户回 Rox 再点 Connect 完成

**邮箱配置项**（`docs.rox.com/.../integrations/email`）：连接时可选 **Read Access / Write Access** 两个独立开关；**Restricted Domains**（*"specify any domains you don't want Rox to access or send emails to"*）；另有 Email Aliases、Email Signatures、Follow-Up Settings。

> **只支持 Google Workspace 与 Microsoft 365**；无 IMAP 密码入口。这与 ATTIO、Lightfield **三家高度一致**。

### §1.6 数据面与对外接口

| 项 | 事实 |
|---|---|
| 对外形态 | App Native / Web / Mobile / Desktop / **Chrome Extension** / Partner（Microsoft 365、Google Workspace、Slack）/ **Custom MCP** / API |
| 公开 REST API | **无**（apis.io 实测记录：*"Rox publishes no public REST API"*，docs 中无 OAuth/OIDC discovery 元数据）→ 对外能力面是 **MCP**，不是 REST |
| SSO | Auth0 经纪；email/password、Google、Microsoft（Entra）、企业 SSO（SAML/OIDC，Okta/Entra，2026-07-01 起自助配置） |
| 密钥托管 | 企业客户可在**组织级**存自己的第三方 enrichment provider key（*"Keys are held by Rox and used on the customer's behalf"*） |
| 合规 | SOC 2 Type I/II、GDPR、ISO 27001（官网）；Gartner Cool Vendor 2025；IDC MarketScape 2026 |

**ROX Tether（2026-07-29，其最新 Agent-UI 研究，对未来 MCP 设计有直接借鉴）**（`rox.com/articles/tether`）：

| 机制 | 原文要点 | 对我方 MCP 的启示 |
|---|---|---|
| **Server-side identity rendezvous** | *"An MCP server and a web app for the same product already share a backend and a user identity... Pairing them is a lookup."* | 我方 MCP 会话与网页会话可服务端配对，无需新协议 |
| **Authority follows the channel** | 下单确认必须来自浏览器会话；agent token 调 confirm → **`403 CHANNEL_REQUIRED`**；*"The agent's credentials cannot express confirmation."* | **与 Project 铁律「写操作走 HITL」同构**——敏感动作应在服务端按**通道**而非按**提示词**强制 |
| **Optimistic preconditions** | 写带 `expect: qty==1`；冲突 → **降级为建议**，在真实 UI 里给 Accept/Dismiss（引 Bayou '95 / DynamoDB conditional writes） | 我方 `cas_expect` 已是同族，可扩展到「冲突降级为建议」而非直接拒绝 |
| **Handles, not copies** | 服务端铸造的句柄（`view_42`）是引用单位，前端只渲染句柄不持有状态 | 与我方 `decision_id` / `particle_id` 用法一致 |
| **context_sync 单工具 + cursor delta** | 轮次开始用**一个**工具拉「实时状态 + 自上次以来的游标增量」，往返仅数十 token；*"Pull rather than push, because no chat host today accepts pushed context"* | 优于我方「多工具拼上下文」，可作为 MCP 工具面收敛的参考 |

---

## §2 ATTIO：per-user OAuth + 隐私三档（附其致命短板）

来源：`attio.com/help/reference/email-calendar/email-and-calendar-syncing`、`attio.com/help/reference/email-calendar/sharing-emails`、`attio.com/help/reference/how-to-guides/manage-email-and-calendar-privacy-across-your-workspace`、`automationjinn.com/blog/attio-integrations`

| 维度 | ATTIO 做法 |
|---|---|
| 授权 | **每个成员各自 OAuth 授权自己的邮箱**（"Attio does not get your password — it gets a scoped OAuth token"）；管理员**不能**代配 |
| 支持范围 | 仅 **Gmail / Google Calendar / Microsoft 365 Outlook / Outlook Calendar**；⚠ 仅 M365 托管的 Outlook，**本地 Exchange 与三方托管不支持**；共享邮箱不支持；只同步 **Inbox + Sent** |
| 非支持邮箱 | 走**邮件转发**（email forwarding）兜底——**不是收密码** |
| **未匹配邮件** | **默认不落库**：*"emails to/from addresses that do not match any Person are NOT logged — they stay private in your inbox"* |
| 可见性三档 | ① `Metadata only`（参与者+时间）② `Subject line and metadata`（**默认**）③ `Full access`（workspace 或 individuals，Pro/Enterprise） |
| 私有日历 | `Private calendar events are not synced` |
| 排除清单 | **mailbox-only blocklist**（个人邮箱地址加进去后该邮箱与该地址的往来不进 CRM）；workspace 级 **Protected / Blocked contacts** |
| 同步范围默认 | 建议起始值：*"Sync only emails where sender OR recipient matches an existing Person record"*；另可配**域名过滤**（排除本域内部邮件）与**关键词过滤**（排除 Receipt/Confirmation 等） |
| 单向性说明 | Full access 一旦开启**无法对单封邮件撤销**（只能靠 blocklist）——ATTIO 自己提示此风险 |
| **致命短板** | **没有原生 HubSpot/Salesforce 双向同步**：*"HubSpot and Salesforce connections always route through middleware or a sync platform, which is an extra subscription during any co-existence period."* 官方应用商店无 HubSpot app，迁移靠 Import2，同步靠 Zapier / Stacksync / Polytomic / Outfunnel |

> **ATTIO 与 ROX 合起来说明一件事**：AI 原生 CRM 的**通路上限**就在「与既有 CRM 共存」。ATTIO 选择不做深集成（留了缺口），ROX 选择把它做成核心竞争力（三层架构 + ID mapping + 对账）。**我方要做的正是 ROX 那一侧。**

---

## §3 Lightfield：捕获优先的替换型

来源：`support.lightfield.app/articles/7600587835-lightfield-setup-guide`、`lightfield.app/product/crm-data-capture`

| 维度 | 做法 |
|---|---|
| 定位 | **替换型 CRM**（"Primary system of record: Lightfield is the CRM — it replaces rather than layers over one"） |
| 首次设置 | **5 分钟**：①连邮箱+日历 ②配会议录制 ③试 Chat。总计引导 5min + 25min 个性化 + 1h 导入 |
| 授权 | `Continue with Google` / `Continue with Microsoft`（OAuth 按钮），**无密码表单** |
| 连接时可选项 | **Backsync range**（回溯同步多久）、**Visibility settings**（他人能否看我的邮件/会议）、**Account & contact creation**（新记录如何创建）、**Do not track**（指定不同步的邮箱或域名） |
| 会议 | 内置录制器**自动加入 Zoom / Google Meet / Teams**，产出转写+摘要+行动项 |
| 历史深度 | 最多 **2 年**邮件与日历 |
| 数据模型 | **Schema-less**；新增自定义字段后 *"the AI scans all past conversations and backfills that field automatically"*（**加字段即回填历史**） |
| 外部系统 | 通过 **Workflow Builder 配 Webhook 事件监听**（轻量，非深度集成） |
| 隐私 | 可排除内部会议录制；*"you review AI-suggested CRM updates before they're applied. Nothing changes in your CRM without your approval."* |

> **亮点**：把「加字段→自动回填历史」与「AI 建议→人工确认后才落库」做成默认。前者对应我方 `enrichment` 回填能力，后者与我方 HITL 一致。

---

## §4 三家横向对比

| 维度 | ROX | ATTIO | Lightfield | 我方现状 |
|---|---|---|---|---|
| 与既有 CRM 关系 | **深度共存 + 双向回写** | 弱：走中间件 | 不做：替换 | 读取骨架在，**回写未开** |
| 支持 CRM | Salesforce、HubSpot | **无原生** | 无 | **设计上 CRM 无关**（未验证真实租户） |
| 邮箱/日历授权 | Google DWD / **WIF+DWD**、Entra 管理员同意 | per-user OAuth | Google/Microsoft OAuth | ⚠ 原为 vault 收密码（改造中） |
| 是否收用户密码 | ⛔ 从不 | ⛔ 从不 | ⛔ 从不 | ⚠ 曾设计**是** |
| 长期密钥 | **不存**（WIF 短时凭据） | scoped token | scoped token | ⚠ vault 加密存 |
| 支持非 Gmail/Outlook | ⛔ 不支持 | 邮件转发兜底 | ⛔ 不支持 | ✅ IMAP 探针（**独有但方向需重估**） |
| 隐私排除清单 | Restricted Domains | blocklist + Protected/Blocked | Do not track | ⛔ 无 |
| 未匹配数据 | 建 SOR 时归并 | **不落库保持私密** | 自动建记录 | ⛔ 无此判定 |
| 字段级同步方向 | ✅ 逐字段单向/双向 | N/A | N/A | ⚠ 有映射无方向 |
| 冲突处理 | **快照比对 + pending 队列** | N/A | N/A | ⚠ 仅 CAS 拒绝 |
| 变更来源判定 | ✅ 显式判定 + **ID mapping** | N/A | N/A | ⛔ 无 |
| 同步频率 | 5–1440 min 逐对象可选；默认 15 min | 实时（webhook） | 实时 | ⚠ 有游标无频率配置，**零吞吐** |
| 接入评审闸门 | ⛔ 未见 | ⛔ 未见 | ⛔ 未见 | ✅ **四类动作 HITL fail-closed** |
| 信任分级 | 未见显式分级 | 分可见性档 | 无 | ✅ **L1/L2/L3 + 前 N 批人工** |
| 对外接口 | **MCP**（无公开 REST）+ 5 端 | REST API v2 + webhook | Workflow Builder | MCP 81 工具 |
| 中国市场 CRM | ⛔ 无 | ⛔ 无 | ⛔ 无 | 🟡 **潜在空窗** |

---

## §5 我方逐项差距定位（file:line）

### §5.1 已有且与 ROX 同构（**不要重造**）

| 机制 | ROX | 我方锚点 |
|---|---|---|
| 静态来源标记 | `Source = "Rox"` | `connectorActions.js:192` `Source: 'crm-ai-native'` |
| 乐观并发（防 stale overwrite） | 快照 + 比对 | `connectorActions.js:194` 字段级 CAS；`writeback.js:39-41` 透传 `cas_expect` |
| 字段白名单映射 | Mappings Layer | `writeback.js:28-37` 白名单 + 逐字段过滤（双保险） |
| 审计留痕 | 同事务落 sharded Postgres | 决策凭证 `decision_id`（`writeback.js:43`） |
| 最小权限默认 | read-only scopes 默认 | `trust.js:9-11` L1 默认只读 |

### §5.2 真实缺口（按紧要度）

| # | 缺口 | 我方锚点 | ROX 对应 |
|---|---|---|---|
| G1 | **不写客户侧 CRM** | `writeback.js:15` 红线③ | §1.3 ②：双向同步是核心能力 |
| G2 | **无 pending write 对账队列** | `engine.js:62-63` 写失败仅 `conflicted++` 后**丢失意图** | §1.3 Real-Time 第 3 步 + Batch 对账 |
| G3 | **无变更来源判定** | 无（无双向 ID 表） | §1.3 ③ Change-origin disambiguation |
| G4 | **无 per-cell 同步检查点** | `cursor.js:14-18` 仅对象级 `last_counts`（且当前全 0） | §1.2 Batch：per-cell `last synced at` |
| G5 | **无同步频率配置** | 无（无 5–1440 分钟档） | §1.4 逐对象频率 |
| G6 | **无逐字段同步方向** | `mapping.apply` 单向 | §1.2 Mappings：字段级单向/双向 |
| G7 | **无隐私排除清单** | 无 | ROX Restricted Domains / ATTIO blocklist / LF Do-not-track |
| G8 | **无「未匹配不落库」默认** | 无 | ATTIO：未匹配邮件不落库 |
| G9 | **接入凭据姿态** | vault 收密码（改造设计中） | ROX：WIF 短时凭据，**不存长期密钥** |
| G10 | **探针覆盖与竞品方向不一致** | `probes.js` IMAP/CalDAV 等 4 探针 | 三家**均不做 IMAP 密码**；我方探针能力可复用为 `local-bridge` 形态 |

### §5.3 我方独有（对齐 ROX 时**不得丢失**）

| 能力 | 锚点 | 价值 |
|---|---|---|
| 接入/映射/信任/回写四类动作 HITL 闸门 | `gate.js:5,16,19-20` | 竞品均未见；`未获人工放行一律拒绝`，**无 autoApprove** |
| 信任三级 + 无自动提权 | `trust.js:9-11,47` | L3 前 3 批强制人工；**`elevate()` 故意不存在** |
| 回写内部再受第 3 闸约束 | `writeback.js:44-45` | 默认 `approval_required`；仅显式配置 `writeback_auto_approved=true` 才放行 |
| 读失败必留痕（防假健康） | `engine.js:26-36` | ROX 未提此约束；我方明确区分「同步在跑」与「一条没读到」 |

---

## §6 该学什么 / 不学什么

**该学**
1. **把回写客户侧 CRM 从「S4 后续」提为**当前需求④的验收内容——ROX 证明这是这类产品的**准入线**，不是加分项。
2. **pending write + 快照对账**：解决「写失败丢意图」与「覆盖他人更新」这对矛盾，且**不依赖时钟**。这是我方 `conflicted++` 之后缺的那一步。
3. **变更来源判定 + 双向 ID mapping**：不做这个，双向同步必然产生重复与回环。
4. **per-cell 检查点**：批量回写的可重放基础（ROX：*"per-cell checkpoints and safe replays"*）。
5. **WIF / DWD 姿态**：`no long-lived keys are stored by Rox`——我方 vault 方案应至少让**企业客户可选用联邦凭据**，把「我方不持凭据」做成可交付能力而非口号。
6. **隐私排除清单**：Restricted Domains / blocklist / Do-not-track 三家都有，成本极低、信任收益极高。**应最先补**（低成本高信号）。
7. **Tether 的 `403 CHANNEL_REQUIRED`**：把「敏感动作必须来自人工通道」从**提示词约定**升为**服务端强制**。我方 HITL 可借此从「审批流」下沉到「通道级不可表达」。

**不该学**
1. **不要收用户密码**——三家一致规避；我方原设计应彻底降级为 `local-bridge`（凭据留用户本机）。
2. **不要以「替换客户 CRM」为目标**——Lightfield 路线需要客户承受高切换成本；我方应坚持共存。
3. **不要照抄「无公开 REST、只有 MCP」**——ROX 敢这么做是因为它不打算被集成；我方是平台方，仍需 REST 面。
4. **不要把 admin 直配生效当作默认**——ROX 接入无评审闸门是我方**不该对齐**之处。

---

## §7 建议动作

| 优先级 | 动作 | 依据 | 影响面 |
|---|---|---|---|
| **P0** | 隐私排除清单（域名/邮箱/关键词）落到 `sync-trust` 配置 + 前台可配 | §1.5 Restricted Domains、§2 blocklist、§3 Do-not-track | 前端 + 配置读取，**零内核改动** |
| **P0** | 明确「回写客户侧 CRM」为需求④验收项，重开 `writeback.js:15` 红线③的**范围界定**（需用户批准） | §0-1、§1.3 ② | 架构级，需走 brainstorming |
| **P1** | pending write 队列 + 快照对账（复用现有 `cas_expect` 快照；失败不丢意图） | §1.3 Real-Time/Batch | `engine.js` + 新表，中等 |
| **P1** | 逐对象同步频率（对齐 ROX 档位 5–1440 min），让 `sync_cursor` 从「有游标零吞吐」变为可调度 | §1.4 | 调度器 + 配置 |
| **P2** | 双向 ID mapping 表 + 变更来源判定 | §1.3 ③ | 新表 + 引擎分支，较大 |
| **P2** | per-cell 检查点与安全重放 | §1.2 Batch | 引擎改造 |
| **P2** | 接入形态改造 P1–P4（见 `docs/2026-09-18-channel-onboarding-connector-first-design.md`）；企业客户提供 WIF/DWD 等价能力 | §1.5、§5.2 G9 | 已设计待批 |
| **P3** | MCP 工具面收敛：参考 Tether 的 `context_sync` 单工具 + 游标增量；敏感动作加通道级不可表达 | §1.6 | MCP 层 |

---

## §8 对「需求④」的直接结论

> 用户需求④ = **一次性抽取历史数据 · 定时获取增量 · 经 MCP 回写**。
> ROX 的方案说明：这三个动作在工业级实现里**不是三个独立功能，而是一条带对账的双向管道**——摄取要有 entity resolution 与 ID mapping（否则重复），回写要有 pending 队列与快照比对（否则丢意图或覆盖），批量要有 per-cell 检查点（否则不可重放）。
> 我方当前实现了「摄取骨架 + MCP 回写工具 + HITL 闸门」，缺的正是**对账层**与**范围放开**。

---

### 来源清单
- ROX CRM 集成工程文档：https://www.roxdemo.com/docs/engineering/docs/rox-enterprise-integrations/crm-integration
- ROX CRM Writeback 配置手册：https://launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback
- ROX Google org-wide 邮箱/日历集成：https://launch.rox.com/docs/engineering/rox-enterprise-integrations/google-org-wide-email-calendar-integration
- ROX Microsoft 权限授予：https://launch.rox.com/docs/engineering/docs/rox-enterprise-integrations/granting-microsoft-integration-permissions-for-rox
- ROX 邮箱集成：https://docs.rox.com/development/how-to-use-rox/integrations/email
- ROX 日历集成：https://docs.rox.com/development/~/revisions/ly3EECv0m5CgC7806zES/product/integrations/calendar
- ROX Tether（MCP/Agent-UI）：https://www.rox.com/articles/tether
- ROX 官网：https://www.rox.com
- ROX 认证姿态分析：https://apis.io/security/rox/rox-authentication
- ATTIO 邮箱日历同步：https://www.attio.com/help/reference/email-calendar/email-and-calendar-syncing
- ATTIO 邮件共享：https://attio.com/help/reference/email-calendar/sharing-emails
- ATTIO 隐私管理：https://attio.com/help/reference/how-to-guides/manage-email-and-calendar-privacy-across-your-workspace
- ATTIO 集成现状（含短板）：https://www.automationjinn.com/blog/attio-integrations
- Lightfield 设置指南：https://support.lightfield.app/articles/7600587835-lightfield-setup-guide
- Lightfield 数据捕获：https://lightfield.app/product/crm-data-capture
