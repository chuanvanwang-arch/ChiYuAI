# ATTIO × Lightfield 安全功能深度研究：产品安全 / 数据安全 / 信息安全

> 整理时间：2026-09-05 ｜ 性质：学习借鉴研究报告（**仅学习文档，不进入实施**；任何落地需先过 brainstorming → 设计文档 → 批准）
> 目的：① 系统梳理两个 AI 原生 CRM 标杆（ATTIO 柔性数据底座 / Lightfield 客户记忆世界模型）在**产品安全、数据安全、信息安全**三维度的具体举措；② 对照 CRM-ai-native 现有安全能力，逐项标注「已对齐 / 部分 / 待补 / 不适用」，形成安全维度差距清单，作为后续 brainstorming 的输入素材。
> 资料来源：
> - ATTIO：官方 Help Center（Security / Manage members / Workspace settings / AI Policy / Back up your workspace）、官方 Legal（Privacy / DPA Annex B / Vulnerability Disclosure Policy）、官网 Trust Center 说明、本地 `attio_extract` 抽取实证
> - Lightfield：官方安全页（lightfield.stldocs.app/security）、隐私政策（lightfield.app/privacy）、官方博客（SSO / 会议录制控制 / HIPAA / API keys）、第三方调研（Contrary Research 等）
> - CRM-ai-native：`src/` 现状代码证据链（见 §5）

---

## §0 结论先行

**两个标杆在安全上的共同主旋律是「AI 原生的安全 = 权限即架构」：Agent 与人类走同一权限通道，Agent 能做的不超过驱动它的人。** 具体可归纳为 5 大共性举措：

| # | 共性举措 | ATTIO | Lightfield | CRM-ai-native 现状 |
|---|---|---|---|---|
| 1 | **权限即架构**（Agent 与 UI/API 同通道、权限继承） | 六准则「AI 代理原生沙箱隔离」+ 分水岭「人工前端只读」 | "The agent can't do what the human couldn't"（API 单一通道强制权限） | ✅ 决策第 0 闸 + autonomyEngine + actionExecutor 五闸 |
| 2 | **最小权限 + 角色分层**（Admin/Member/Limited + 对象级 ACL） | Admin/Member/Limited Member + 对象级访问 + Teams 级联覆盖 | Admin/Member + per-object privacy | ✅ RBAC 角色×data_scope + 租户隔离（待补：字段级/记录级 ACL） |
| 3 | **不可篡改审计**（链式/加密日志，前后值） | 7 年不可篡改加密日志 + 双轨工作流留痕 | 字段值历史（Field value history）+ 每字段版本历史 | ✅ auditHook 链式 SHA-256 + decision provenance 哈希链 |
| 4 | **数据不训练模型**（客户数据承诺） | AI Policy 明示「不训练、第三方亦不训练」 | "We never train models on customer data" | 🟡 无云 LLM 训练（自有 LLM 网关 + 双源兜底） |
| 5 | **合规认证 + 透明披露**（SOC2/DPA/VDP/Trust Center） | DPA Annex B 详细安全措施 + Trust Center + VDP | SOC 2 Type II + HIPAA + GDPR + VDP | ❌ 无对外合规认证（内部产品） |

**一句话定位差异**：ATTIO 的安全护城河是「合规透明 + 强企业管控（SCIM/SSO/对象级 ACL）」，Lightfield 的安全护城河是「Agent 权限继承 + 世界模型可追溯」，CRM-ai-native 的安全护城河是「决策问责 + 零信任 HITL + 审计链」。**学习方向不是照抄，而是①补「权限即架构」的最后一公里（Agent 上下文裁剪）②补「对象/字段级 ACL」③把既有审计链外显为合规可解释资产。**

---

## §1 产品安全（Product Security）

> 定义：产品自身的安全机制——认证、授权、权限模型、Agent 沙箱、审批/复核、防注入/越权、会话管理。

### 1.1 ATTIO

#### A. 认证（Authentication）
- **SSO/SAML 单点登录**：Enterprise 计划支持；官方 Security 页提供 SSO 设置（`attio.com/help/reference/workspace-settings-billing/security/single-sign-on`）。
- **SCIM 用户自动开通**（Enterprise 计划）：Okta / Microsoft Entra 双 IdP；支持 Create/Update/Deactivate/Import/Push Groups；组映射 Attio Teams，角色随组（Admin/Member）；**不活跃用户自动禁用**（deactivate 同步）。
- **域名验证（Domain verification）**：确认公司域名所有权后才可见/保留该域邮箱数据（与 suspend 保留邮箱策略联动）。
- **强制 MFA**：内部员工（DPA §3.1.2）访问生产环境**强制多因素认证** + **时间受限**（time-bound）访问。
- **远程结束会话**（Enterprise）：Admin 可远程踢出用户所有会话（`End workspace sessions`）。

#### B. 授权与权限模型（Authorization & Permissions）
- **Workspace 角色三级**：
  - **Admin**：工作区级全权（设置/计费/成员/团队/应用集成/全工作区导出/Enterprise 安全控制/查看全部对象）。
  - **Member**：数据操作权，无工作区级设置权；数据可见性取决于被授予的对象权限。
  - **Limited Member**：受限访问——只读/仅显式授权的对象（由第三方教程佐证，官方文档目前仅 Admin/Member 两档 + 对象级细分）。
- **对象级访问控制**（Plus/Pro/Enterprise）：每个对象（People/Companies/Deals/自定义对象）可设 **Read only / Read and write / Full access**。
- **Team 级联覆盖**：Teams 对 对象/列表/工作流/Dashboard/序列 统一授权，一个成员可属多团队；workspace→team→individual 级联覆盖（higher-tier）。
- **数据源归属**：最佳实践要求指定「数据 owner」，追踪每条记录来源（防越权写与重复）。
- **邮件隐私**：默认邮件内容对 admin 与 member **都不可见**（可显式按记录或工作区共享）——这是「最小可见」的强默认。

#### C. Agent 沙箱（AI-Agent 隔离）
- **六大强制准则 #5「AI 代理原生沙箱隔离」**：每类 Agent 独立读写权限、上下文可见范围、算力配额。
- **分水岭设计**：人工前端**只读**，所有变更经摄入引擎/Universal Context/AI Agent 运行时（写通道强制审计）；**人工界面禁直改粒子元数据**。
- **上下文裁剪**：Universal Context 上层为 Agent 裁剪专属可见上下文，**过滤无权限数据**，防泄露与上下文过载（`attio-lightfield-study.md §2.4`）。

#### D. 审批/复核（双轨工作流）
- **双轨工作流**：全自动轨道（低风险，无人工）→ 人工复核轨道（大额变更/敏感修改/批量删/权限调整 → **强制拦截 → 管理员确认 → 留复核日志**）。
- **操作审计**：写入/Agent 推理/权限变更/工作流全量加密日志（操作主体、时间、粒子 ID、**变更前后值**、访问 IP），留存 7 年，适配 GDPR。

### 1.2 Lightfield

#### A. 认证
- **SSO 单点登录**（Pro 计划）："access follows the same controls you manage everywhere else"（2026-05-29 博客）。
- **API Key 认证**：Bearer token（`sk_lf_...`）+ `Lightfield-Version` 头；**仅 Admin 可创建/吊销**；吊销即时永久生效。
- **MFA**：官网「Encrypted in transit and at rest, with role-based access and MFA」。

#### B. 授权与权限模型
- **Admin/Member 双角色**（Contrary Research 实证）+ **每对象隐私（per-object privacy）**：LLM 与用户**只能访问他们有显式权限的对象**。
- **API Key scope 机制**（26 个 OAuth 2.0 scopes，apis.io 实证）：粒度到 `accounts:read / contacts:write / opportunities:read` 等；**默认继承创建者（Admin）角色**；最佳实践 = 最窄 scope + 独立 key/集成 + 定期轮换。
- **Member API**：`$role` 字段暴露 workspace 角色（实证）。
- **角色即权限继承**（架构级）：**Agent、外部系统、UI 全部走同一个 Lightfield API**；"An AE executing code is bound to the exact same permissions an AE already has. **The agent can't do what the human couldn't.**"（这是 AI 原生安全的核心宣言）

#### C. Agent 沙箱与上下文
- **上下文即隔离**：世界模型按对象权限裁剪——LLM 只看到有权对象（"both LLMs and users can only access objects they have explicit permission to view"）。
- **会议录制控制**（Meeting recording controls，2026-05-29）：**默认关闭特定邮箱/域名的自动录制**——内部会议、敏感客户、禁止自动录制的域（防敏感通话被 AI 摄入）。

#### D. 审批/复核
- **"nothing moves without you" 哲学**：AI 起草（跟进/邮件/会议准备）→ 人类审阅/编辑 → 才发送；**建议/草稿默认需要人批准**（不是全自动执行）。
- **自动化（Automations）+ 工作流**：自动化仍处于 open beta（Pro 计划），与 agent 同权限、同工具。

### 1.3 产品安全小结表

| 举措 | ATTIO | Lightfield | 我们的现状 | 差距等级 |
|---|---|---|---|---|
| SSO | ✅ Enterprise | ✅ Pro | 🟡 mcp 网关 + crm_login 自有认证，无 SSO/SAML | P2（企业采购时才需要） |
| MFA/2FA | ✅ 内部强制 + 建议用户 | ✅ 宣传有 | 🟡 密码 crypt() + 令牌；无强制 MFA | P2 |
| SCIM 自动开通 | ✅ Enterprise | ❌ 未提及 | ❌ 无 | P2 |
| 远程会话结束 | ✅ Enterprise | ❌ | ❌ 无 | P2 |
| 角色分层 | ✅ Admin/Member/Limited | ✅ Admin/Member | ✅ crm.rbac 角色×data_scope | ✅ 已对齐 |
| 对象级 ACL | ✅ Read/Write/Full | ✅ per-object | 🟡 租户隔离有；对象粒度无 | **P1 待补** |
| 字段/记录级权限 | 🟡 部分（列表/报告） | 🟡 每对象 | ❌ 无字段级脱敏 | **P1 待补** |
| Agent 权限继承 | ✅ 沙箱+裁剪 | ✅ **同通道同权限（宣言）** | ✅ 决策第 0 闸 + 写通道审计 | ✅ 已对齐 |
| 审批/复核双轨 | ✅ 强强制 | ✅ nothing moves without you | ✅ CRM_APPROVAL_FLOW + decision gate | ✅ 已对齐 |
| 会议录制控制 | 🟡 有调用智能 | ✅ **默认关闭特定域录制** | ❌ 无录制（也无会议摄入） | P1（连带⑤摄入） |

---

## §2 数据安全（Data Security）

> 定义：数据生命周期安全——加密、备份、多租户隔离、脱敏、留存、删除、导出、可携带性。

### 2.1 ATTIO

#### A. 加密
- **传输 + 静态全加密**（DPA §3.2）："All data is encrypted at rest and in transit using well known symmetric encryption algorithms"。
- 依赖 GCP 物理安全（分层安全模型）+ Google 数据中心。

#### B. 多租户隔离
- **记录 ID 三元组**：`{ workspace_id, object_id, record_id }`（实证：`workspace_id=95c0c8c7-...`）——**租户即 workspace_id，行级隔离固化在 ID 层**。
- 三级隔离：工作空间→团队→成员，行级隔离。
- **敏感脱敏**：个人隐私字段（手机/邮箱/证件）对外 API 与低权限界面**自动脱敏**；商业敏感（估值/底价/提成）仅高管可见；**AI 上下文敏感片段自动屏蔽**。

#### C. 备份与可用性
- 自动备份到**异区域**（DPA §3.4："backup customer data to a different geographical region"）。
- 高可用多区域部署（DPA §3.5）。
- 全工作区导出（Admin-only）：CSV zip（Lists/Attributes/Objects/Files/Tasks/成员等）；**不含邮件、会议、录音**（录音可经 API 程序化导出）。

#### D. 留存与删除
- 留存：客户上传数据按客户指示；法定数据按法定要求；匿名化后可无限期。
- 删除权：EEA/UK/CH 用户（数据主体）适用；处理者场景需经客户（控制者）。
- **成员 suspend 数据策略**（关键细节）：suspend 可「保留邮箱数据」开关（Plus/Pro/Enterprise）——仅已验真域邮箱可保留 → 指定 **Email access handler**（访问请求处理人）→ 声明合法依据；不保留则邮箱/日历数据删除（录音关联的除外）。**「保留用户数据」需要显式合法依据 + 责任人**——这是数据治理的强纪律。

### 2.2 Lightfield

#### A. 加密
- 官网：「**Encrypted in transit and at rest**」。

#### B. 多租户隔离
- **Workspace 边界**（VDP 焦点领域 #2：跨 workspace 越权访问）。
- **per-object privacy**：LLM 与用户只能见有权对象（同产品安全）。
- 数据归属承诺："**You should own your data, since it's your customer data**"（Peiris，Contrary Research）。

#### C. 备份、导出、可携带性
- CSV 导入/导出始终可用；「your data exports cleanly」。
- **REST API 公开 beta**（2026-03-20）：read/write Accounts、Opportunities、Contacts + read Members；TS/Go/Python SDK + CLI + MCP。
- 「数据移出自由」= 反锁定：支持导出 + API + MCP，降低迁移成本（与 ATTIO「migration is the moat」反向策略）。

#### D. 留存与删除
- Terms：授权用户（Authorized User）规则——账号凭证私密、不可共用（单人多账号纪律）。
- 机密数据捕获（email/通话转录）是核心业务——**对数据处理安全要求最高**（这也是 HIPAA 布局的原因）。
- Bulk delete（2026-03-06 博客）支持表批量删除。

### 2.3 数据安全小结表

| 举措 | ATTIO | Lightfield | 我们的现状 | 差距等级 |
|---|---|---|---|---|
| 静态加密 | ✅（对称算法） | ✅ 宣称 | 🟡 PG 无显式列加密；TLS 有 | P2（本地部署，环境问题） |
| 传输加密 | ✅ TLS | ✅ | ✅ HTTPS/TLS | ✅ 已对齐 |
| 多租户隔离 | ✅ ID 三元组 + 三级 | ✅ workspace/per-object | ✅ `tenant_id` 全表 + tenantScope | ✅ 已对齐 |
| 数据不训练模型 | ✅ 明文承诺 | ✅ 明文承诺 | ✅ 无云训练；LLM 网关双源 | ✅ 已对齐 |
| 敏感字段脱敏 | ✅ 强（自动脱敏+上下文屏蔽） | 🟡 权限控制仅 | ❌ 无字段级脱敏 | **P1 待补** |
| 备份 | ✅ 异区域自动 | 🟡 未披露 | 🟡 PG 备份策略 + 导出 | 🟡 部分 |
| 导出 | ✅ Admin-only CSV zip | ✅ CSV/API/SDK | ✅ 决策审计导出 `exportAudit` + `exportTurtle`（W3C PROV-O，`routes.js:2261/2522`） | ✅ 已对齐（决策层），业务层导出视需 | 
| 留存/删除权 | ✅ GDPR 完整 | ✅ 可导出/删除 | 🟡 软删除铁律（禁 DELETE） | ✅ 设计一致（软删更严） |
| 数据可携带性 | ✅ API + 导出 | ✅ API + MCP | ✅ MCP 双传输 | ✅ 已对齐 |

---

## §3 信息安全（Information Security）

> 定义：组织层面与基础设施——合规认证、漏洞披露、渗透测试、事件响应、基础设施、第三方治理、员工培训。

### 3.1 ATTIO

| 维度 | 具体措施 | 来源 |
|---|---|---|
| **逻辑访问** | 员工访问生产环境：**最小权限（least privilege）+ 时间受限 + 强制 MFA** | DPA §3.1.2 |
| **物理访问** | GCP 分层物理安全模型 | DPA §3.1.1 |
| **监控与测试** | 自动化监控/测试；**第三方渗透测试 ≥1 次/年**；Trust Center 公开渗透测试报告 | DPA §3.3 + Security at Attio |
| **漏洞披露** | 官方 VDP：范围内（app/api/attio/cdn）+ 范围外（Google/FullContact/Intercom/MixPanel/Segment/Sentry/Zapier 等第三方托管）；90 天保密期；72 小时初步确认；Safe Harbor 承诺 | Disclosure Policy |
| **事件响应** | 个人数据泄露**书面通知客户**；数据泄露通知机制（隐私政策） | Privacy Policy |
| **第三方治理** | 供应商尽调（含 AI 供应商）；子处理者列表更新于 DPA；**AI 供应商需评估**（Google/OpenAI/Anthropic 均为第三方模型） | AI Policy §2/§4 |
| **员工培训** | AI 使用培训 ≥1 次/年 + 记录留档 | AI Policy §3 |
| **AI 治理** | 不用于「法律或类似重大影响」的自动决策；不用于 EU AI Act 高风险场景（**明确的产品边界声明**） | AI Policy §1 |
| **合规认证** | SOC 2 Type I/II（Trust Center）；GDPR（DPA + SCC + UK Addendum）；欧盟代表（EU-REP）；跨境传输（SCC/IDTA） | Trust Center + Privacy |
| **AI 记录** | 记录 AI 工具使用情况（可应要求提供） | AI Policy §7 |

### 3.2 Lightfield

| 维度 | 具体措施 | 来源 |
|---|---|---|
| **合规认证** | **SOC 2 Type II**（Security & Availability）；**HIPAA**（可签 BAA，PHI 存储合规）；**GDPR**（DPA + SCC）；**ISO 27001 "Coming soon"** | Security 页 + 官网 |
| **漏洞披露** | 完整 VDP：焦点（认证绕过/提权/**跨 workspace 越权**/注入与 RCE）；范围（Web 应用/API/SDKs）；Safe Harbor；security@lightfield.app | Security 页 |
| **事件响应** | 「我们会调查并保持更新」；团队背景（Meta 工程背景，规模安全经验） | Security 页/第三方 |
| **数据所有权** | 不训练模型于客户数据（显式承诺）；数据导出自由 | AI assistant 页/Contrary |
| **认证状态追踪** | 2025-11 完成 SOC 2 Type I；Type II/HIPAA 进行中（Contrary 实证）→ 官网现已 Type II | Contrary + 官网 |

### 3.3 信息安全小结表

| 维度 | ATTIO | Lightfield | 我们的现状 | 差距等级 |
|---|---|---|---|---|
| SOC 2 | ✅（报告公开） | ✅ Type II | ❌ 无认证（内部产品） | N/A（对外销售时才需要） |
| GDP R/DPA | ✅ 完整 | ✅ | ❌ 无 DPA | N/A |
| HIPAA | ❌ 未宣称 | ✅ BAA | ❌ | N/A |
| 渗透测试 | ✅ 年度第三方 + 报告公开 | 🟡 未披露频次 | ❌ 无 | P1（质量保障） |
| 漏洞披露 | ✅ 官方 VDP | ✅ 官方 VDP | ❌ 无公开 VDP | P2（内部） |
| 第三方治理 | ✅ 子处理器列表 | 🟡 部分 | 🟡 LLM 供应商双源 + secret 明文刻意 | 🟡 部分 |
| 事件响应 | ✅ 书面通知 | 🟡 调查保持更新 | 🟡 decision trace + retro | 🟡 部分 |
| 员工安全培训 | ✅ 年度 AI 培训 | 🟡 未披露 | ❌ 无 | P2 |
| 基础设施 | GCP 托管 | 未披露（早期） | 自托管/本地 | N/A |

---

## §4 三维度整合：AI 原生安全的关键架构启示

### 4.1 核心启示一：**权限即架构（Permissions are the unlock）**
Lightfield 的原话最有张力："Permissions are the unlock for letting agents run. Because the agent, the UI, and external systems all share one API, an agent inherits the exact access of the person running it."

- 对应代码：`src/http/auth.js`（认证统一）→ `src/http/middleware/rbac.js`（RBAC 统一）→ `src/action/executor.js`（写通道五闸 + 决策第 0 闸）。
- **我们的差距**：Agent 上下文注入（`src/context/assembler.js`）是否**与用户权限同源裁剪**？目前知识层 `knowledgeScope.layers` 是降级契约，但**对象级权限裁剪未接入上下文注入**——这是「权限即架构」的最后一公里。

### 4.2 核心启示二：**Agent 能做的不超过驱动它的人（The agent can't do what the human couldn't）**
- 我们已有：决策第 0 闸（`executor.js` 缺 decision_id 拒）+ autonomyEngine 分级（HIGH/EXCEPTION 升级）+ HITL 零信任。
- **对照差距**：我们的 Agent 决策闸更强（决策问责），但**Agent 数据可见范围**（沙箱）未显式裁剪——目前靠租户隔离兜底，**未到对象/字段粒度**。

### 4.3 核心启示三：**「默认最小可见」强默认（Privacy by default）**
- ATTIO：邮件默认对所有人不可见（需显式共享）。
- Lightfield：会议录制默认关闭特定域；"nothing moves without you"。
- 我们的对照：报价/底价/提成敏感字段**无脱敏层**（差距 P1）；前端可见性靠菜单 `layoutMenu.js` 功能隐藏（非数据层脱敏）。

### 4.4 核心启示四：**审计链要「外显为可解释资产」**
- ATTIO 7 年不可篡改日志 + Trust Center 公开报告；Lightfield 字段值历史（每字段版本可回溯）。
- 我们已：auditHook 链式 SHA-256 + decision provenance 哈希链 + audit_event 前后值（**内部完整，优于多数 SaaS**）。
- **差距**：未外显为「字段级时间线」产品视图（P0-③ gap 已在 `lightfield-attio-gap-study.md` 列出）。

---

## §5 与 CRM-ai-native 现状对照（证据链）

| 我们的安全资产 | 代码证据 | 对照的标杆举措 |
|---|---|---|
| 决策第 0 闸（写前强制 decision_id） | `src/action/executor.js:28` | ATTIO/ LF Agent 写通道强制 |
| 自主决策分级（HIGH/EXCEPTION 升级 + 阈值配置化） | `src/decision/autonomyEngine.js`（threshold 0.7 配置化） | ATTIO 双轨工作流 |
| 审批流（状态机 + HITL + 复核日志） | `src/approval/stateMachine.js` / `engine.js` / `compensation.js` | ATTIO 人工复核轨道 / LF nothing moves without you |
| 链式 SHA-256 审计（前后值 + 防篡改校验 + fail-open） | `src/action/auditHook.js:38-82` | ATTIO 7 年加密日志 / LF 字段值历史 |
| 决策哈希链（provenance） | `src/decision/provenance.js`（v2 + verifyTail） | LF 每字段版本历史 |
| 多租户隔离（tenant_id 全表 + 写强制自身租户） | `src/tenant/` + `routes.js:424/487` | ATTIO ID 三元组 / LF workspace 边界 |
| RBAC 角色×data_scope | `crm.rbac`（sysadmin/admin/sales） | ATTIO Admin/Member / LF roles |
| 认证（crm_login + MCP 网关 + 密码 crypt()） | `src/http/auth.js` / `src/mcp/auth.js` | ATTIO SSO / LF API Key |
| 写通道五闸 + HITL | `src/action/executor.js` + `src/mcp/tools.js:43`（只暴露 active） | LF 单 API 通道 + 权限继承 |
| 敏感数据明文留存（api_key 刻意设计） | `src/llm/secret.js:24` | —（对照：ATTIO 明文承诺不训练但留存需加密） |
| 软删除铁律（禁 DELETE，去重走 merged_into） | `src/particles/dedup.js:31-37` | ATTIO 软删除 / LF bulk delete |

---

## §6 差距清单与建议（P0/P1/P2，仅学习输出，不进入实施）

| 优先级 | 差距项 | 借鉴标的 | 建议落地形态 | 备注 |
|---|---|---|---|---|
| **P0** | ① 上下文注入未做对象级权限裁剪（权限即架构最后一公里） | LF 单 API 通道权限继承 / ATTIO 上下文裁剪 | `src/context/assembler.js` 注入前按用户 data_scope 过滤可引用粒子 | 架构级，直接支撑零信任 |
| **P0** | ② 敏感字段无脱敏层（报价/底价/提成/手机/邮箱） | ATTIO 自动脱敏 + AI 上下文屏蔽 | 出参脱敏中间件（按角色分级展示） | 与①同批 |
| **P1** | ③ 审计链未外显为字段级时间线产品视图 | LF Field value history | 复用 timelineSource + audit_event 渲染「字段 旧→新 谁改 为什么」 | P0-③ gap 已在另一文档 |
| **P1** | ④ 对象级/记录级 ACL | ATTIO 对象级 Read/Write/Full + Teams | 粒子「可见范围」配置化 + 数据源归属 | 租户之上再加一层 |
| **P1** | ⑤ 会议/邮件摄入的录制控制（default-off 语义） | LF Meeting recording controls | 摄入开关配置化（默认关，白名单开） | 与「原始痕迹捕获」gap 同链 |
| **P2** | ⑥ SSO/SCIM（企业采购时） | ATTIO Enterprise | 预留 SAML/OIDC 网关 | 视产品化阶段 |
| **P2** | ⑦ 远程会话管理 + 认证策略 | ATTIO Enterprise | 会话强制下线 / 活跃会话视图 | 视产品化阶段 |
| **P2** | ⑧ 公开 VDP + 渗透测试节奏 | 双方 VDP | security 邮箱 + 年度第三方测试 | 对外商业化时 |

---

## §7 与既有文档的关系

- `docs/2026-09-03-attio-lightfield-study.md`：前两轮深度学习底稿（ATTIO 六准则 / LF 四维度 / 三方映射）——本文档是其「安全维度」专项深化。
- `docs/2026-09-03-lightfield-attio-gap-study.md`：10 项差距清单（P0①embedding / P0②Knowledge / P0③字段历史 / P1④-⑥ / P2⑦-⑩）——本文档与之互补：**那份是「能力/记忆层」，这份是「安全/信任层」**。
- 本文档聚焦三维度安全举措 + 现状对照，不重复已有能力差距。

---

## §8 下一步建议

1. 本文档为**学习输出**，不进入实施。若你认为 P0 ①（上下文对象级权限裁剪）或 P0 ②（敏感字段脱敏）值得做，可触发对应 brainstorming（一次一问），按设计先行流程出方案。
2. 建议阅读顺序：先 §0 结论 → §4 架构启示 → §6 差距清单 → 需要细节再看 §1-§2-§3。
3. 若要把 ATTIO/Lightfield 安全方法论沉淀为 SKILL：只取**跨域通用**部分（权限即架构 / 最小可见 / 审计外显 / 数据不训练承诺），不写入任何 CRM/P2P 领域专有内容。

---

*整理：CRM-ai-native 学习系列 · 第三辑（ATTIO × Lightfield 安全功能）| 2026-09-05*
