# 外部集成统一设计 v2（合并版：竞品研究 + 统一设计 + P0 立即借鉴）

> 日期：2026-09-18 · 性质：**概要设计（未批准不写实现）** · 合并来源：
> ① `2026-09-18-competitor-crm-integration-study.md`（ROX / ATTIO / Lightfield 一手工程文档研究）
> ② `2026-09-18-unified-integration-design-v2.md`（接入三形态 + 回写对账设计）
> 本文为两文档的**去重合并版**，竞品证据与设计方案合一，并新增 §13 P0 立即借鉴方案。
> 覆盖需求：**② 通道打通**（邮箱/日历/会议/微信）+ **④ 与原 CRM 集成**（一次性抽取 · 定时增量 · MCP 回写）。

---

## §0 结论先行（合并去重）

1. **ROX 把「回写客户侧 CRM」当立身之本**：*"we write back anything enriched or edited in Rox to their CRM"*。我方 `writeback.js` 红线③原写「本次不回写（属 S4 后续）」——**战略级差距**。用户已裁决 Q1-B：**单向白名单回写（只出不进）**，v1 仍默认 `target=internal`，`target='crm'` 须经 §5.1 三前置 + 人工闸（P3 已接线）。
2. **三家竞品没有一家收用户密码**：ROX 只走 Google DWD/WIF 与 Microsoft Entra 管理员同意；ATTIO 只走 Gmail/Outlook OAuth；Lightfield 只走 Google/Microsoft 登录按钮。ATTIO 对非 Gmail/Outlook 的兜底是**邮件转发**，不是收密码。→ 我方原 IMAP 密码表单在竞品里不存在同类形态；应以 **B 本机桥（凭据留用户本机）** 为默认，C vault 仅兜底且显式声明。
3. **我方 HITL 接入/评审闸是竞品没有的强项**：四类动作 fail-closed、无 autoApprove。P3 已把 `enable-writeback` 真接入生产路径（此前为纸面闸门）；`mapping-change`/`trust-elevate` 的 gate 路由已真、生产调用点待 P4/P7。
4. **已落地的借鉴（非假绿，已源码核实）**：隐私排除清单（G7/P1 ✅ `privacyFilter.js` 真实存在）、接入三形态（P2 ✅ `sourceKinds.js` 真实存在）、用户侧确认回写（P2.5 ✅ `confirm-user-side` 端点）、评审闸接线（P3 ✅）、红线③改写（Q1-B ✅）、matched_only 裁决（Q2 ✅）、target 参数化（Q3 ✅）。
5. **仍待落地的借鉴（本文 §13 P0 聚焦）**：不保存密码的「本机桥真正接线」、ROX 待写队列+快照对账、ROX 变更来源判定（防回环）、ATTIO「未匹配不落库」。这四项是从 ATTIO/ROX 真正该「马上借鉴」而代码未做的核心。
6. **一条红线保持不变**：SaaS 多租户下我方平台**不得持有客户邮箱/IM 凭据**（承接接入形态设计 §2.2 红线）。

---

## §1 竞品一手事实（借鉴源 · 证据随文标注）

### §1.1 ROX：集成架构全解
来源：`roxdemo.com/docs/engineering/.../crm-integration`、`launch.rox.com/docs/.../configuring-crm-writeback`、`docs.rox.com/.../integrations/email`

| 概念 | ROX 原文 |
|---|---|
| SOR | *"System of Record (SOR) — a unified knowledge graph"*，跨公共/私有数据做 entity resolution |
| CRM 角色 | *"Rox treats any CRM as just another data source feeding the SOR."* |
| 终局 | *"in that future, Rox is the CRM"* —— **先共存、后替代**，与我方共存设计一致 |

**三层集成架构（直接对标我方）**：
| 层 | 职责 | 关键机制 |
|---|---|---|
| Mappings Layer | 字段映射 + 方向 + 校验 | 每字段带 **Sync Direction**（`Read-only in Rox → CRM` 单向 / `Bi-directional`）+ 类型化校验 |
| Real-Time Layer | 编辑的事务性回写 | **乐观并发**（不依赖 wall clock） |
| Batch Layer | 高吞吐单向回写 + 对账 | **CRON 每 15 分钟**；per-cell `last synced at`；bulk API 压限流；**每次回写与审计同事务落库** |

### §1.2 ROX 自陈的六个「非平凡问题」及解法（最值钱部分）
| # | ROX 提出的问题 | ROX 解法 | 我方现状 |
|---|---|---|---|
| ① | 初始摄取归并 | entity resolution 跨公共+私有 | 有 external_id 对齐，无公共源归并 |
| ② | Agentic CRM 行为（编辑/富集要双向落 CRM） | 双向映射 + batch 富集 | ⛔ 方向内向，不回客户侧（Q1-B 已决单向 outbound） |
| ③ | 变更来源判定（CRM 回流是原生改动还是我方回写被读回） | 显式判定 + **ID mapping 存两侧** | ⛔ 表已有 external_ref，但 last_direction 硬编码 'in'（P7 待修） |
| ④ | 始终最新态 | 实时 fetch + 快照比对 | 有 CAS 无自动最新态解析 |
| ⑤ | 只读洞察要物化进 CRM | Batch 单向回写 | ⛔ 无 |
| ⑥ | CRM 无关映射（单/双向语义） | Mappings Layer | 有 mapping 无逐字段方向（P4 待做） |

**②的完整算法（ROX 原文，值得逐句抄）**：
> *"The clock problem. CRM and Rox clocks are not guaranteed to be synchronized, so raw timestamps aren't a safe basis for 'who wins.' We avoid NTP-style clock alignment and instead implement an optimistic concurrency strategy that does not depend on wall clocks."*

写前检查：① 实时拉取 CRM 当前对象（仅改字段）→ 失败视 Rox 为最新、标 `pending CRM write`；成功则比对「CRM 当前态」与「用户编辑基线（快照/稳定 hash）」。② 冲突→中止并展示刚拉到的值；匹配→实时写。③ 提交：成功落 Rox+审计；失败（429/5xx/网络）→ **不丢弃意图**，落 Rox 并标 `pending CRM write` 入 batch 对账。Batch 对账：取当前 CRM 对象与快照比对，**不同→跳过 pending 写**（等价于当时写也会被后改覆盖），**相同→bulk 落盘**。ROX 自评 *"exactly-once(ish) semantics for user edits without clock synchronization"*。

### §1.3 ROX 邮箱/日历授权 —— 全 OAuth/联邦，零密码
| 架构 | 机制 | 安全性 |
|---|---|---|
| A. DWD | 客户授予 DWD 给 Rox 服务账号，Rox 模拟每个用户 | 凭据为服务账号密钥 |
| B. WIF + DWD（推荐） | 客户自建 WIF Pool + 自有 SA，授予 WIF principal | 原文：*"Rox uses short-lived federated credentials; no long-lived keys are stored by Rox"* |

Scope 分档各自独立：Calendar `readonly`/`events`；Gmail `readonly`/`send`。安全声明：*"Least-privilege by default (read-only scopes)."* / *"You can revoke access centrally."* 同步节奏：*"every 15 minutes ... incremental."* Microsoft 365 走 **Entra 管理员同意**（租户级授权，组织内其他人不再弹窗）。**只支持 Google Workspace 与 Microsoft 365，无 IMAP 密码入口。**

### §1.4 ATTIO：per-user OAuth + 隐私三档（附致命短板）
| 维度 | ATTIO 做法 |
|---|---|
| 授权 | **每个成员各自 OAuth 授权自己的邮箱**（"Attio does not get your password — it gets a scoped OAuth token"）；管理员**不能**代配 |
| 支持范围 | 仅 Gmail / Google Calendar / M365 Outlook；本地 Exchange 与三方托管不支持；只同步 Inbox + Sent |
| 非支持邮箱 | 走**邮件转发**兜底——**不是收密码** |
| **未匹配邮件** | **默认不落库**：*"emails to/from addresses that do not match any Person are NOT logged — they stay private in your inbox"* |
| 可见性三档 | ① Metadata only ② Subject line + metadata（**默认**）③ Full access |
| 排除清单 | mailbox-only blocklist + workspace Protected/Blocked contacts |
| 同步范围默认 | *"Sync only emails where sender OR recipient matches an existing Person record"*；可配域名/关键词过滤 |
| **致命短板** | **无原生 HubSpot/Salesforce 双向同步**，必须走 Zapier/Stacksync/Polytomic 中间件 |

> ATTIO + ROX 合起来说明：AI 原生 CRM 的通路上限在「与既有 CRM 共存」。ATTIO 选不做深集成（留缺口），ROX 选做成核心竞争力（三层架构+ID mapping+对账）。**我方应做 ROX 那一侧。**

### §1.5 Lightfield：捕获优先的替换型
定位 **替换型 CRM**（"Lightfield is the CRM — it replaces"）。授权走 `Continue with Google/Microsoft`（OAuth，无密码）。会议录制器自动加入 Zoom/Meet/Teams 产转写+摘要。数据模型 **Schema-less**，加字段即**自动回填历史**。*"you review AI-suggested CRM updates before they're applied. Nothing changes in your CRM without your approval."*

### §1.6 ROX Tether（MCP/Agent-UI，对未来 MCP 的直接借鉴）
| 机制 | 原文要点 | 对我方启示 |
|---|---|---|
| Server-side identity rendezvous | MCP server 与 web app 共享后端+用户身份，配对是 lookup | MCP 会话与网页会话可服务端配对 |
| Authority follows the channel | agent token 调 confirm → **`403 CHANNEL_REQUIRED`**；*"The agent's credentials cannot express confirmation."* | 与「写操作走 HITL」同构——敏感动作按**通道**而非**提示词**强制 |
| Optimistic preconditions | 写带 `expect: qty==1`；冲突→降级为建议（Accept/Dismiss） | 我方 `cas_expect` 同族，可扩展到「冲突降级为建议」 |
| Handles, not copies | 服务端铸造句柄（view_42）是引用单位 | 与我方 `decision_id`/`particle_id` 一致 |
| context_sync 单工具 + cursor delta | 轮次开始用一个工具拉「实时状态+自上次增量」 | 优于「多工具拼上下文」，可作 MCP 工具面收敛参考 |

### §1.7 三家横向对比（我方定位）
| 维度 | ROX | ATTIO | Lightfield | 我方现状 |
|---|---|---|---|---|
| 与既有 CRM 关系 | 深度共存+双向回写 | 弱（中间件） | 不做（替换） | 读取骨架在，回写 v1 仅 internal（Q1-B） |
| 邮箱/日历授权 | WIF+DWD / Entra | per-user OAuth | OAuth | ⚠ 原 vault 收密码→应改 B 本机桥 |
| 是否收用户密码 | ⛔ 从不 | ⛔ 从不 | ⛔ 从不 | ⚠ 曾设计是→红线禁止，C 仅兜底 |
| 长期密钥 | **不存**（WIF 短时） | scoped token | scoped token | ⚠ vault 加密存（C 兜底） |
| 支持非 Gmail/Outlook | ⛔ | 邮件转发兜底 | ⛔ | ✅ IMAP 探针（可复用为 B 本机桥验证器） |
| 隐私排除清单 | Restricted Domains | blocklist | Do-not-track | ✅ **已落地**（G7/P1） |
| 未匹配不落库 | 建 SOR 归并 | **不落库** | 自动建记录 | ⛔ 待落（G8/Q2 已决） |
| 字段级同步方向 | ✅ 逐字段 | N/A | N/A | ⚠ 有映射无方向（P4） |
| 冲突处理 | 快照比对+pending 队列 | N/A | N/A | ⛔ 仅 CAS 拒绝（P5 待做） |
| 变更来源判定 | ✅ ID mapping | N/A | N/A | ⛔ 表有值恒 'in'（P7） |
| 同步频率 | 5–1440 min 逐对象 | 实时 webhook | 实时 | ⚠ 有游标无频率（P9） |
| 接入评审闸 | ⛔ 无 | ⛔ 无 | ⛔ 无 | ✅ **四类动作 HITL fail-closed** |
| 对外接口 | MCP（无公开 REST） | REST v2 | Webhook | MCP 81 工具 + REST 面 |

---

## §2 本平台现状基线（file:line 实测）

### §2.1 已就绪（可直接复用，不要重造）
| 能力 | 锚点 | 备注 |
|---|---|---|
| 同步内核单序 | `engine.js:7-68` | 读→映射→幂等 upsert→计数 |
| 两个生产触发点 | `timers.js:588-656`（⑩ integration-poll）、`connectorRouter.js:59`（webhook） | 零新增定时器 |
| 有效信任档取严 | `mount.js:21-26 effectiveTrustLevel` | 无提权路径 |
| 字段级 CAS | `connectorActions.js:194` + `writeback.js:39-41` | 与 ROX 快照比对同族 |
| 静态来源标记 | `connectorActions.js:192` `Source:'crm-ai-native'` | ↔ ROX `Source="Rox"` |
| 白名单回写 | `writeback.js:28-37` + `connectorActions.js:175` | 双保险，白名单空即拒 |
| 决策凭证 | `writeback.js:43` + `autonomyEngine.decisionIdOf` | 同事务留痕 |
| 出口健康闸 | `exportGate.js:44-78`（三判据 fail-closed） | 竞品未见 |
| executor 第 3 闸 | `executor.js:155-159` | 回写默认被拦 |
| 双向 ID 表 | `external_ref` 含 last_direction/last_hash/external_updated_at | **已存在**，见 §5.4 |
| 通道 kind 单一事实源 | `channels/kinds.js` | 禁 startsWith |
| 四真实探针 | `channels/probes.js`（IMAP/CalDAV/Meeting/企微） | 已实测到达真服务端 |
| 隐私排除清单 | `channels/privacyFilter.js` + `privacyConfigRouter.js` + `config_store['sync-privacy']` | ✅ **已落地**（G7/P1） |
| 接入三形态 | `channels/sourceKinds.js` + 向导 A/B/C + 分路验证 | ✅ **已落地**（P2） |
| 用户侧确认回写 | `POST /api/channels/:id/confirm-user-side` + 卡片按钮 | ✅ **已落地**（P2.5） |
| 评审闸接线 | `mount.js` gatedCallWriteback + `reviewGate.js` 按 business_type 查 + `connectorRouter/timers` 注入 createSyncGate | ✅ **已落地**（P3） |

### §2.2 真实缺口（本轮实测，含已修标记）
| # | 缺口 | 锚点 | 与竞品对照 | 状态 |
|---|---|---|---|---|
| G0 | 同步线评审闸纸面化 | `sync/gate.js` | P3 已修，enable-writeback 已真接线 | ✅ 已修 |
| **G1** | 不回写客户侧 CRM | `writeback.js:15` | ROX 立身之本 | 🟡 Q1-B 已决单向 outbound，v1 仅 internal |
| **G2** | 写失败即丢意图 | `engine.js:62-63` conflicted++ | ROX pending 队列+对账 | ⛔ P5 |
| **G3′** | 变更来源判定未实现 | `resolver.js:33,50` 硬编码 'in' | ROX change-origin | ⛔ P7 |
| **G4** | 无 per-cell 检查点 | `cursor.js:12-23` | ROX per-cell last synced | ⛔ P8 |
| **G5** | 无逐对象频率 | `timers.js:591` 单值 | ROX 5–1440 min | ⛔ P9 |
| **G6** | 出向映射被丢弃 | `mount.js:47` `if direction!=='in' continue` | ROX Mappings 方向 | ⛔ P4 |
| **G7** | 无隐私排除清单 | 无 | 三家都有 | ✅ 已落地（P1） |
| **G8** | 无「未匹配不落库」 | `channelGraphIngest.js:24` 全量 | ATTIO 默认不落库 | 🟡 Q2 已决同意收窄，代码未落 |
| **G9** | 凭据姿态（vault 收密码） | `onboarding-guide.html` 表单 | 三家均不做 | 🟡 B 本机桥设计已就，真实接线未做 |
| **G10** | 探针方向（IMAP 密码） | `channels/probes.js` | 可复用为 B 本机桥验证器 | 🟡 见 G9 |
| **G11** | MCP 敏感动作无通道级强制 | 全局 | ROX Tether 403 | ⛔ P10 |

---

## §3 目标架构总览
```
┌───────────── 接入三形态（§4，单一事实源 sourceKinds.js）─────────────┐
│  connector（默认）      local-bridge（无官方套件默认）    direct（兜底）  │
│  凭据：对方平台+本机     凭据：用户本机                  凭据：我方 vault │
└───────┬───────────────────────┬───────────────────────────┬──────────┘
        ▼                       ▼                           ▼
 ┌────────────────────┐      ┌──────────────────────────┐
 │ 【通道线】需求②     │      │ 【同步线】需求④           │
 │ normalizeChannelRow│      │ mapping.apply（in 字段）  │
 │ → 事件行契约        │      │ → resolver.upsert        │
 │ → enrichment 四落点 │      │ → external_ref（in/out）  │
 │ → 图谱汇入          │      │ → writeback（target）     │
 └─────────┬──────────┘      └────────┬─────────────────┘
          │                          │
┌─────────┴──────────────────────────┴──────────────────┐
│ 【合规面】§7  privacyFilter（双线共用单一事实源）        │
│   exclude_domains/addresses/keywords + matched_only    │
└───────────────────────────────────────────────────────┘
闸门（自内向外，任一未过即不放行）：
  第 0 闸 决策铸造 → 第 3 闸 executor.approvalPassed
  → 评审闸（gate.js 四类动作，P3 已接线）→ 出口健康闸（exportGate）
```
**三个设计约束**：① 零新增内核；② 零新增定时器（挂既有 ⑩ poll）；③ 单一事实源纪律（`sourceKinds.js` / `channels/kinds.js` / `providerDescriptor.js`）。

---

## §4【通道线】接入三形态（P2 ✅ 已落地）

| 形态 | 凭据持有者 | 通路 | sourceKind |
|---|---|---|---|
| `connector`（默认） | 对方平台+用户本机 | WorkBuddy Agent 调 connector 工具 → 经 crm-native MCP 写入 | `connector` |
| `local-bridge`（无官方套件默认） | **用户本机** | 本机 CLI/MCP → Agent 读取 → 经 MCP 写入 | `local-bridge` |
| `direct`（兜底） | 我方 vault（pgcrypto） | `channels/probes.js` + `verifyScope.js` 直连 | `direct` |

**分路验证（各自 fail-closed，互不冒充）**：connector 验证经「Agent 调一次只读工具」回 `{sourceKind, verified_at, tool, ok}` 绝不回传凭据/正文；local-bridge 经本机 CLI 探针（复用 `probes.js` IMAP，跑用户机器）；direct 经 `verifyScope` 真探测。**connector/local-bridge 平台侧无探针**，接入后描述符记 `verifications[source_kind]={ok:false,pending:true,method:'user_side_*'}`，界面显「**待确认**」而非「已验证」；P2.5 `confirm-user-side` 端点把 pending→ok（未确认前不得说已验证）。

**⚠ 默认值双义（已由单测锁定）**：`PREFERRED_SOURCE_KIND='connector'`（向导界面默认卡）；`DEFAULT_SOURCE_KIND='direct'`（接口缺省，未声明时按 direct，避免「形态升级跳过平台校验」）。

**入口集成落地清单**（用户要求：引导用户在自家应用内输入凭据，而非本站网页收密码）：
- **A 连接器**：企业微信/飞书/钉钉官方套件 → 用户在自家 App 登录授权，我方仅收 `{tool, ok}`。
- **B 本机桥**（无官方套件如 163 个人邮箱）：`himalaya`(IMAP/SMTP)/`khal`(CalDAV) 跑**本机**，凭据不进平台。
- **C 兜底**：自建探针+vault，**保留但降级**，界面显式标注「凭据将上传我方平台」。

---

## §5【同步线】回写设计（本设计核心）

### §5.1 G1 范围裁决（Q1-B 已决 ✅）
红线③已改写为三前置条件（`writeback.js:10-16`）：回写客户侧 CRM 仅当 ① `descriptor.outbound` 显式声明 ② 通过 enable-writeback 评审闸 ③ exportGate 出口健康；且目标默认 `internal`，`target='crm'` 须经三前置+运营显式开启。**v1 只落 internal，不假绿。**

### §5.2 写通道：不新增 Action，既有 Action 加 `target` 参数（Q3 已决 ✅）
`connectorActions.js:169 sync-writeback-fields` handler 内按 `target` 分流：`internal`（默认，现状零变化）/ `crm`（须 external_ref + descriptor.outbound）。守住「单一写通道」红线，Action 面不增长。

### §5.3 G2 待写队列 + 快照对账（⛔ P5 待做）
现状 `engine.js:62-63` 写回失败仅 `conflicted++`，意图消失。**新表** `crm.sync_pending_write`（id/tenant/provider/object/id/particle_id/target/fields JSONB/baseline_hash/status/attempts/...），写入时机=失败分支追加（conflicted++ 保留），drain 挂既有 ⑩ poll。drain 语义：实时拉客户侧当前对象↔baseline_hash 比对，不同→`skipped_stale`，相同→落盘 `applied`，失败退避→`failed`。⚠ **反假绿**：pending 不得作乐观缓冲掩盖失败；判据 `applied+skipped_stale+failed+pending=写入总数`。⚠ **禁用 wall clock 判胜负**，一律用 baseline_hash/内容比对。

### §5.4 G3′ 变更来源判定（⛔ P7 待做）
`external_ref` 已有 `last_direction`/`last_hash`/`external_updated_at`；`resolver.js:33,50` 硬编码 `'in'`。设计：我方回写成功→`last_direction='out'`+`last_hash=hash(写入字段)`；读入前置 `classifyOrigin()`：回声（out 且读回==hash）→不计 created/updated、不触发下游信号、只更新 last_synced_at；客户侧真实变更→正常 upsert 置 `in`；in/NULL→正常。不做则「我方写出被读回」当成客户侧变更，触发重复入库与下游信号自我触发（ROX §1.3③ 同条）。

### §5.5 G6 逐字段方向（⛔ P4 待做）
`mount.js:47` 出向映射在读入表被丢弃。`sync-mappings.fields[]` 增 `direction:'in'|'out'|'both'`（缺省 `'in'`）。`mapping.js` 新增 `outboundFields(object)`（只读）供写回侧取集合。**双闸**：可写字段 = `outboundFields()` ∩ `sync-trust.writeback_fields_whitelist`，皆非空才可写。

---

## §6 调度与检查点（G4/G5）
- **G5 逐对象频率（⛔ P9）**：descriptor 增 `interval_minutes`；`sync_cursor` 增 `next_due_at`；档位对齐 ROX `5/10/15/30/60/180/360/720/1440` min；⚠ 防假绿：配置值<实际 poll 间隔时显示**实际频率**而非配置值。
- **G4 per-cell 检查点（⛔ P8）**：新表 `crm.sync_cell_checkpoint(...field,last_synced_at,last_hash)`；每次成功回写同事务写入；重放判据 last_hash 一致→跳过。

---

## §7 隐私与合规
- **G7 隐私排除清单（✅ 已落地 P1）**：`config_store['sync-privacy']` = `{exclude_domains, exclude_addresses, exclude_keywords, matched_only, window_days}`；纯函数 `src/channels/privacyFilter.js` 通道线+同步线共用；fail-closed 四态（未配置=合法空规则 / 读取失败=异常留痕 / 形状坏=invalid_items / 字段缺失=不丢）；域名信号含邮箱自身域名（`domainFromEmail` 共用）。
- **G8「未匹配不落库」（🟡 Q2 已决同意，⛔ 代码未落）**：仅当行能匹配我方客户粒子（域名/邮箱）才汇入 enrichment；未匹配行不落 + 保留丢弃计数 `ingest_skipped_unmatched`。是对已批设计的收窄，合规更严。
- **G9 凭据姿态（🟡 B 本机桥设计已就，⛔ 真实接线未做）**：见 §13 P0-1。C vault 仅兜底且界面显式声明。
- **G11 敏感动作通道级不可表达（⛔ P10）**：现状 `executor.js:157` 第 3 闸已是服务端强制；可补强 MCP 侧对 `target='crm'` 回写拒绝 agent 通道携带的 approvalPassed，只接受浏览器/审批流签名凭证（403 CHANNEL_REQUIRED 语义）。

---

## §8 差异声明（不学什么）
| 不学 | 理由 |
|---|---|
| 不收用户密码 | 三家一致规避；direct 仅兜底并显式标注 |
| 不以「替换客户 CRM」为目标 | Lightfield 切换成本高；坚持共存 |
| 不照抄「只有 MCP、无公开 REST」 | ROX 敢这样因不打算被集成；我方是平台方需保留 REST 面 |
| **不把 admin 直配生效当默认** | ROX 接入无评审闸——我方不该对齐；前提是闸真的接线了（P3 已就） |

**必须保留并强化**：executor 第 3 闸、exportGate 出口健康闸、信任三档无提权、读失败必留痕（`engine.js:26-36` 区分「同步在跑」与「一条没读到」）、拒因透传。

---

## §9 验证方案（每条判据自带反证）
| 判据 | 反证方式 |
|---|---|
| P3 三类评审动作真接线 | 未批准→拒；批准→放；扫生产消费点非零 |
| P5 待写队列不丢意图 | 真库制造写失败→断言 pending 行→drain 后 applied/skipped_stale |
| P5 drain 可对账 | `applied+skipped_stale+failed+pending=写入总数` |
| P6 客户侧回写真到达 | 本地真 HTTP 桩断言收到字段+Source 头；**只断言 counts.writeback>0 不合格** |
| P7 echo 不回环 | 写 out→读回同值→created=0 && 无下游信号 |
| P8 检查点可重放 | 同字段重放两次→第二次跳过 |
| P9 频率显示真实值 | 显示值==实测 last_run_at 差值 |
| P1 隐私过滤真生效 | 排除域名/关键词行→断言不入库且计数可见 |
| P2 三形态不互相冒充 | connector 验证通过后断言 local-bridge/direct 仍未验证 |

**纪律**：静态 grep 不构成证据；否定断言必先剥注释；守卫永不触发同属假绿；渲染类断言看产物（行数/字段值）不看请求发出。

---

## §10 分阶段交付（每 Task 一 commit、显式 add）
| 阶段 | 内容 | 状态 |
|---|---|---|
| **P1** | 隐私排除清单（sync-privacy + privacyFilter.js 双线共用 + 界面 + 丢弃计数） | ✅ 已落地 |
| **P2** | 接入三形态（sourceKinds.js + source_kind + 向导 A/B/C + 分路验证 + 防双写） | ✅ 已落地 |
| **P2.5** | 用户侧确认回写（confirm-user-side 端点 + 卡片按钮 + 守卫） | ✅ 已落地 |
| **P3** | 评审闸接线（enable-writeback 接入生产 + reviewGate 按 business_type + 单一事实源 allowWritebackForLevel） | ✅ 已落地 |
| **P4** | 出向集合确定性：字段级 direction + outboundFields() + 双闸；target 参数 | ⛔ 待做 |
| **P5** | 待写队列 + 快照对账（先 target='internal' 验证不丢意图） | ⛔ 待做 |
| **P6** | 客户侧回写放开（红线③落地）+ 本地真 CRM 桩 + 三闸齐备 | ⛔ 待做（依赖 Q1-B） |
| **P7** | 变更来源判定：classifyOrigin() + last_direction='out' + outbound_at | ⛔ 待做 |
| **P8** | per-cell 检查点 + 安全重放 | ⛔ 待做 |
| **P9** | 逐对象频率 + next_due_at + 显示真实频率守卫 | ⛔ 待做 |
| **P10** | （可选）MCP 通道级不可表达 | ⛔ 待做 |

**DB 变更纪律**：只增不删（`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`），同步写 `db/schema.sql` 与 `db/migration-*.sql`。

---

## §11 风险与不做清单
| 风险 | 处置 |
|---|---|
| 放开回写后误写客户 CRM | target 默认 internal；crm 需三前置+人工闸；Source='crm-ai-native' 便于过滤回滚 |
| pending 队列成新黑洞 | §5.3 对账判据强制；failed 态人工可见；不无限重试 |
| 隐私收窄致「数据变少」误判故障 | 丢弃计数可见 + 文档说明 |
| 频率配置与实际不符 | §6 显示真实频率守卫 |
| 三形态并行致双写 | (channel_id, source_kind) 联合键；同通道仅一个已验证形态生效 |
| **不做** | 不收用户密码（direct 仅兜底）；不新增粒子类型；不改业务域模型；不做 CRM 替换；不新增定时器；不删既有模块 |

---

## §12 待批准问题（已裁决）
| # | 问题 | 裁决 |
|---|---|---|
| Q1 ✅ | G1 红线③范围 | **B 单向白名单回写**，分期到 C；已改写三前置条件 |
| Q2 ✅ | G8 是否收窄为「匹配到客户才汇入」 | **同意收窄**（ATTIO 事实标准），落 config_store['sync-ingest'] |
| Q3 ✅ | P4 target 走加参数还是新增 Action | **加参数**（守单一写通道） |

---

## §13 【新增】P0 立即借鉴方案（待确认）

> 以下是从 ATTIO/ROX 真正该「**马上借鉴**」而**代码未做**的核心，按优先级排列。已落地的 G7/P1、P2、P2.5、P3 与 Q1-B/Q2/Q3 不重复列入。
> 用户「我来确认」后，按功能线分组 commit 实施。

### P0-1（ATTIO 红线·不保存密码）— 🔴 最高优先，红线性
- **借鉴**：ATTIO *"does not get your password — gets a scoped OAuth token"*；三家均不收密码。
- **现状缺口**：B 本机桥设计已就（§4），但**真实接线未做**——用户今天要给 `wangchuan08@inspur.com` 密码，若走 `channel-config.html` 的 C(direct/vault) 表单即违背红线。
- **动作**：把 inspur 邮箱接入改走 **B 本机桥**（本机 `himalaya` CLI 拉取，密码只留本机）；平台侧 `verifications[local-bridge]={ok:false,pending:true}` → 用户确认翻 ok（P2.5 已就绪）。C vault 表单保留但**默认不选中 + 强制显式「凭据将上传平台」二次确认**。
- **验收**：走 B 后查 vault **不得**出现该通道凭据（P2 判据②）；界面显示「凭据保存在本机」。

### P0-2（ROX 立身之本·待写队列+快照对账）— G2/P5
- **借鉴**：ROX *"exactly-once(ish) semantics ... without clock synchronization"*（写失败不丢意图 + 快照比对防覆盖）。
- **现状缺口**：`engine.js:62-63` 写失败仅 `conflicted++`，意图消失，无对账无重放。
- **动作**：建 `crm.sync_pending_write` 表 + drain（挂既有 ⑩ poll，零新增定时器）；`baseline_hash` 比对（禁用 wall clock）；status 四态 applied/skipped_stale/failed/pending。
- **验收**：真库制造写失败→断言存在 pending 行→drain 后落 applied/skipped_stale；`applied+skipped_stale+failed+pending=写入总数`（防新黑洞假绿）。

### P0-3（ROX 防回环·变更来源判定）— G3′/P7
- **借鉴**：ROX §1.3③ Change-origin disambiguation（ID mapping 存两侧，回声不重复计入）。
- **现状缺口**：`external_ref` 表已有，但 `resolver.js:33,50` 硬编码 `last_direction='in'`，双向回环无判定。
- **动作**：回写成功写 `last_direction='out'` + `last_hash`；`resolver.upsert` 前置 `classifyOrigin()`：回声（out 且读回==hash）→ 不计 created/updated、不触发下游信号。
- **验收**：写 out→读回同值→`created=0 && updated=0` 且无下游信号（去回声）。

### P0-4（ATTIO 隐私·未匹配不落库）— G8/Q2
- **借鉴**：ATTIO *"emails ... that do not match any Person are NOT logged"*。
- **现状缺口**：Q2 已决同意收窄，但 `channelGraphIngest.js:24` 仍全量汇入。
- **动作**：`matched_only` 落 `channelGraphIngest` 前置判定（匹配我方客户粒子才汇入 enrichment）+ 丢弃计数 `ingest_skipped_unmatched`。
- **验收**：未匹配行不落 enrichment + 计数可见；`account-360.html` 合并时间线数据变少（预期非缺陷）。

### P0 取舍说明（为何只这 4 条）
- **G4 per-cell 检查点 / G5 逐对象频率 / G6 出向方向 / G11 MCP 通道级**：重要但属 P4/P8/P9/P10，依赖 P0-2/P0-3 先立底座，不列入「马上」首批。
- **P6 客户侧回写放开**：依赖 Q1-B 三前置已全部就位（P3 闸 + outbound 声明 + exportGate），但属高风高收益，建议紧接 P0-2 之后单独立项，不混在 P0 首批。

---

### 来源清单（竞品一手文档）
- ROX CRM 集成：https://www.roxdemo.com/docs/engineering/docs/rox-enterprise-integrations/crm-integration
- ROX Writeback：https://launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback
- ROX Google 邮箱/日历：https://launch.rox.com/docs/engineering/rox-enterprise-integrations/google-org-wide-email-calendar-integration
- ROX Microsoft 权限：https://launch.rox.com/docs/engineering/docs/rox-enterprise-integrations/granting-microsoft-integration-permissions-for-rox
- ROX Tether：https://www.rox.com/articles/tether
- ATTIO 邮箱日历：https://www.attio.com/help/reference/email-calendar/email-and-calendar-syncing
- ATTIO 隐私：https://www.attio.com/help/reference/how-to-guides/manage-email-and-calendar-privacy-across-your-workspace
- ATTIO 集成短板：https://www.automationjinn.com/blog/attio-integrations
- Lightfield 设置：https://support.lightfield.app/articles/7600587835-lightfield-setup-guide
- Lightfield 捕获：https://lightfield.app/product/crm-data-capture
