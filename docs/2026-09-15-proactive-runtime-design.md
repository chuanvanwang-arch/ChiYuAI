> ⛔ **已废弃（SUPERSEDED）— 2026-09-15**
> 本文结论**已被完整吸收并取代**（任务编号映射：原 `T1–T10` → 最终设计 **`T11–T20`**）。唯一有效设计 → `docs/2026-09-15-final-design-coexistence-and-proactive.md`（最终设计 v1.0）。
> **本文件仅保留过程证据、DDL 草案与一手资料锚点，用于追溯；不得作为实施、评审或对外表述的依据。**
> 若本文与最终设计冲突，一律以最终设计为准。

---

# 设计：主动运行时设计（Proactive Runtime）——从「等销售问话」到「它主动值守」

> 日期：2026-09-15 ｜ 状态：**待用户评审批准（brainstorming P8）** ｜ 下一步：writing-plans
> 设计输入：`docs/2026-09-15-rox-benchmark-differentiation-analysis.md`、`docs/2026-09-15-attio-lightfield-rox-three-way-comparison.md`、`docs/2026-09-15-crm-coexistence-sync-design.md`
> 关联既有设计：`docs/2026-09-03-agent-event-trigger-design.md`（C1 首批事件触发）、`docs/2026-08-25-alert-feedback-loop-design.md`（告警规则 + 处置状态机）
> 硬约束：**不新增粒子类型、不改业务域模型**（2026-09-08 已批设计 §10）；绝对禁 DELETE；未批准前不写实现代码（HARD-GATE）

---

## §0 结论先行

**问题不是「我方缺主动能力」，而是「主动产出全掉进黑洞」。**

我方每 30 分钟就在主动巡检（11 个定时器 + 13 类告警规则），产出链路却在投递层断掉：告警落**进程内存 Map**、`/api/alerts` 八个端点**从未挂载**、`registerAlertHook` **未注册**、待办六视角**无告警视图**、`src/web/` 下 `api/alerts` **零命中**、外发推送**全 0 命中**。结果：`trace 'sales-daily-scan' {hits:N}` 每天在刷，**指标是绿的，但没有任何人能看到任何一条告警**——与项目里 L1–L4 同源的假绿：**指标绿 ≠ 链路通**。

而 Rox 的「主动」经过其发布说明全量（2024-08 → 2026-09，每周一版）核对后，**90% 体现在投递层，而非「自动执行写操作」**：Daily Digest 邮件、Pre-Meeting Briefing、Slack delivery、Home（每天自动呈现 book of business 实时信号）、To-Dos Dashboard、Notifications controls。

**因此本次设计的核心判断是：先修出口，再扩感知，再升判断，最后才放开写权限。** 顺序不可颠倒——在链路是断的、且没有投递观测的前提下放开自动写，等于**把假绿放大成真错**。

### §0.1 四个关键取舍（用户已定）

| 取舍 | 决定 | 含义 |
|---|---|---|
| 落地档位 | **全四层** | 投递面 + 感知面 + 判断面 + 授权面，不缩范围 |
| 实施顺序 | **渐进式（方案 B）** | 逐层可独立交付、独立回滚 |
| 首批投递渠道 | **全渠道可配置** | 一次性抽象 provider 契约，邮箱 / IM / webhook / 平台内全上，按严重度与角色路由 |
| 常驻授权首批档位 | **T1 内部字段** | 只自动写客户不可见字段；**不可自动提升**，升级须重新批准 |

### §0.2 一句话定位

> 我方从「**问答式**」（销售想起来才问 MCP）」升级为「**值守式**」（系统按节律与事件主动发现、主动研究、主动投递，人只需点头或否决）——而写权限仅在 T1 档、凭可撤回的常驻授权、留全程审计。

---

## §1 Rox 一手证据：它的「主动」到底主动在哪

来源：`docs.rox.com/development/about-rox/release-notes`（全量版本条目，2024-08 起，每周一版）。按类别归并：

### §1.1 投递型（**最大类，也是其主动性的真正载体**）

| 功能（原文） | 时点 | 机制 |
|---|---|---|
| **Daily Digest** | 2025-02-04 | 合并 Daily Digest 与 Pre-Meeting Briefing 为一封邮件（原文："将 Daily Digest 与 Pre-Meeting Briefing 合并为一封邮件"） |
| **Pre-Meeting Briefing** | 2024-11-26 | 覆盖**未来 7 天**会议，会前自动推送 |
| **Slack delivery** | 2024-12-17 / 2025-04-01 / 2025-05-07 | Slack 收 digest 与 briefing；Slack Wrap-Up 会后总结；`@Rox` 直接提问 |
| **Home** | 2026-06-03 | "每天自动呈现整个 book of business 的实时信号（real-time signals）" |
| **To-Dos Dashboard** | 2025-07-01 | "汇集所有机会与账户的待办任务" |
| **Notifications controls** | 2024-12-03 | 按数据源调整交付设置与频率 |
| **Custom email digest insight count** | 2026-03-10 | 可配置 digest 中的 insight 条数 |
| **(Actionable) Insights** | 2025-09-09 | Digest 中每条 insight 直链 Command，可即时开启对话 |

> **判据**：Rox 的"主动"第一性不是"AI 自己动手"，而是"**AI 的产出出现在人一定会看到的地方**"。`Notifications controls` 的存在反证：**投递过量会变成骚扰**，所以频次与静默时段必须是配置项（见 §14 红线 1）。

### §1.2 持续监控型

| 功能（原文） | 时点 | 机制 |
|---|---|---|
| **Stage-Aware Opportunity Risks** | 2025-09-30 | 机会监控 Agent 按管道各阶段查找特定风险 |
| **Agentic Deal Risk** | 2025-07-22 | 自动扫描最新 transcript、邮件与笔记，为每个机会生成最新风险 |
| **Champion Tracking** | 2025-04-15 | 追踪关键人角色变动（晋升/调岗/跳槽），纳入 Daily Digest 与 UI |
| **Role changes insights** | 2024-10-02 | 监控账户关键人角色变动 |
| **Tracked Changes & Weekly Refresh** | 2026-03-03 | 分别控制哪些账户被持续追踪、哪些 research prompt 每周刷新 |
| **Configurable column refresh** | 2026-07-29 | 研究列可按周至季度周期自动刷新 |

### §1.3 周期/事件触发型

| 功能（原文） | 时点 | 机制 |
|---|---|---|
| **PR/Blogposts 自动追踪** | 2024-10-24 | 自动追踪所有账户的新闻稿页与博客，推送新内容 |
| **Research Insights** | 2026-02-03 | Insight 回溯到生成它的 signal |
| **Next steps** | 2024-08-27 | 定义客户下一步，**到期时在每日 digest 中提醒** |

### §1.4 自动执行型（少数派，但 Rox 声量最大）

| 功能（原文） | 时点 | 说明 |
|---|---|---|
| **Auto-prospecting** | 2026-09-02 | Agent 自建候选名单，符合条件者自动加入序列 |
| **Agentflows** | 2026-08-25 | 自然语言描述任务与工具范围，Agent 自主规划、执行并迭代纠错 |
| **Automated Follow-Up Emails** | 2025-08-05 | 自动排期、间隔发送跟进邮件 |
| **Automatic AI steps** | 2025-12-23 | 可安排 Agent 生成的邮件自动发送 |
| **Auto-reload for Agent Actions** | 2026-07-22 | 用量低于阈值自动充值保活，并设**月度花费上限** |

> **判据**：连 Rox 的实际自动执行也集中在**低风险、可逆、对外部无直接损害**的动作上；且用 `Auto-reload … 月度上限` 做熔断。这与我方 T1 首批的保守选择一致。

### §1.5 反馈闭环型

| 功能（原文） | 时点 | 说明 |
|---|---|---|
| **👍/👎 Insight Feedback** | 2025-02-11 | 对收到的 insight 提供反馈，越参与越智能 |
| **Contact dismissal feedback** | 2025-02-25 | 对不感兴趣的联系人给出反馈，让 Agent 学习 |

> **判据**：Rox 的反馈采集点在**投递物上**（insight 卡片），不是在一个独立"反馈页"里。我方对应物是决策建议卡的三态反馈 + `crm_decision_outcome_write`（已存在，见 §6 N7）。

---

## §2 源码级现状（四层，逐条带锚点）

### §2.1 感知面 = 已在跑

| 事实 | 锚点 |
|---|---|
| **11 个定时器**：nightly-distill / crm-risk-scan / lead-pool-recycle / decision-retro(+boot) / sales-daily-scan / named-visit-scan / auditability-sla-snapshot / ready-queue-pump / provenance-patrol / integration-poll / calibration-sla-scan | `src/scheduler/timers.js:163-466` |
| `crm-risk-scan` 每 30 分钟全量重算 AI 属性（LLM 预算 200/轮，超预算走确定性兜底） | `timers.js:176-182`、`scheduler/riskScanner.js` |
| `sales-daily-scan` 每 30 分钟**逐租户**扫描覆盖缺口/流失/漏斗/承诺红 | `timers.js:242-292` |
| `named-visit-scan` 每 30 分钟扫应访逾期（达标自动解除） | `timers.js:297-357` |
| `lead-pool-recycle` 每 30 分钟扫 S0P 超期未跟进 → emit 预警事件（只发事件不写） | `timers.js:187-214` |
| `ready-queue-pump` 每 60 秒泵起 ready 任务（编排层心跳） | `timers.js:383-393` |
| 事件触发层：3 条矩阵规则、仅订阅 `ontology` 域、冷却 300s + DB 去重 + 租户化、**全只读** | `src/agent/eventTrigger.js`，注册于 `src/http/server.js:97` |

**判定：感知面覆盖率够，但只有一个域（ontology）与三种时间节律（30min/1h/24h）。**

### §2.2 判断面 = 半通（全部为阈值判定型）

| 事实 | 锚点 |
|---|---|
| **13 类告警规则**：approval_bottleneck / commit_red / coverage_gap / deal_stuck / forecast_breach / funnel_jitter / funnel_unhealthy / lead_overdue / lost_contact / named_visit_overdue / payment_due / payment_due_plan / payment_gap | `src/alerts/alertRegistry.js`（DEFAULT_RULES） |
| 规则判定内核（纯函数） | `src/alerts/ruleEvaluator.js` |
| 销售巡检 7 类命中：coverage_gap / lost_contact / visit_shortfall / info_collect_lag / funnel_unhealthy / funnel_jitter / commit_red | `src/scheduler/salesDailyScan.js:52-109` |
| 告警规则表落配置面迁移 | `db/migrate-config.sql:95`，租户化 PK `(kind, tenant_id)` 见 `db/migration-alert-tenant.sql` |

**判定：判断力=阈值。没有"智能体主动研究"这一档——即无法产出"我想好了，你只需点头"的成稿建议。**

### §2.3 投递面 = **断链（本设计的核心靶点）**

| 观测点 | 源码事实 | 判定 |
|---|---|---|
| 告警落库 | `createAlert` 写**进程内 `new Map()`**，注释自述"DB crm.alert 镜像" | 🔴 不持久化 |
| 告警实例表 | `crm.alert` 在 `db/schema.sql`（56 张表）**零命中**，全 `db/` 下**无建表语句** | 🔴 表不存在 |
| 查询/处置端点 | `src/alerts/alertEndpoints.js` 的 8 个端点（`GET /api/alerts`、ack/close、rules 启停、evaluate、feedback metrics）**只在常量清单里**；`buildAlertHandlers` 全仓**零调用**。文件头自述"并发隔离：并发整合会话正在重写 routes.js…由挂载方统一 add"——**挂载方一直没来** | 🔴 从未挂载 |
| 写时触发 | `registerAlertHook` **未注册**；`src/http/server.js:74` 只注册了 `registerFinanceAlertHook` | 🔴 断线 |
| 待办融合 | `workbenchRouter.buildViewRows` 六视角 = approval / processing / initiated / cc / tuning / follow，**无告警或信号视角** | 🔴 未纳入 |
| 页面消费 | `src/web/` 下 `api/alerts` **零命中**（84 个页面中无一处调用） | 🔴 无出口 |
| 外发推送 | `钉钉 / 企业微信 / wecom / dingtalk / lark / sms` 在 `src/` 下**全 0 命中**；`smtp`/`nodemailer` 命中仅在计费域 | 🔴 无通道 |
| 唯一交付方式 | SSE（12 个事件域，`alert` 域 12 处 emit），**要求用户已打开页面** | 🟡 被动 |

> **假绿实证**：`timers.js:242-292` 每 30 分钟产出 hits 并 emit `trace 'sales-daily-scan' {tenants, scanned, hits}`；`createAlert` 返回 `{ok:true}`。**从任何观测面看都是绿的**，但产出停留在进程内存、无端点可查、无页面展示、无外发通道。**这正是「指标绿 ≠ 链路通」。**

### §2.4 授权面 = 结构性压制

| 事实 | 锚点 |
|---|---|
| 第 0 闸：`if (!params?.decision_id && !def?.deferDecisionMint)` → 拒绝写入 | `src/mcp/gateway.js:201`，提示语见 `:224` |
| 事件触发明文说明：触发任务无 `decision_id`，写操作**必被第 0 闸拒** | `src/agent/eventTrigger.js`（`READ_ONLY_SKILLS` 注释） |
| 现有旁路范式：`deferDecisionMint`（handler 内自 mint），已用于 5 个 Action：`crm-deal-advance` / `crm-deal-reopen` / `crm-lead-return` / `crm-deal-archive-to-pool` / `crm-lead-reclaim-bulk` | `src/action/seed-actions.js:741/801/994/1055/1108`；`registry.js:14` 契约说明 |
| 决策结果回写通道**已存在但无输入**：`crm_decision_outcome_write` / `_set` / `_query`、`decision-disposition` | `src/action/seed-actions.js:1791/1815/1870` |

**判定：现有安全模型的隐含假设是「每个写动作都由人发起并 mint 决策」。这与「主动」天然冲突。** 常驻授权即是为这个假设**增加一类合法凭证**，而非取消闸门（见 §11）。

---

## §3 目标 / 非目标 / 硬约束

### §3.1 目标

1. 让已有主动产出**有人能看到**（S1，当天可见）。
2. 把感知面从 1 域扩到 **3 类触发器**（时间型 / 变更型 / 外部型）。
3. 把判断力从「阈值告警」升级为**三级递进**，最高级产出带推理链与证据的**成稿建议卡**。
4. 引入**常驻授权**：在可撤回、可审计、有熔断的前提下，让 AI 自动完成 T1 内部字段写入。
5. 全链路**防假绿**：投递有流水、执行有快照、否决有回写。

### §3.2 非目标（本次明确不做）

- ❌ 不新增粒子类型、不改业务域模型（§10 硬约束）。
- ❌ 不做 IM **数据接入**（只做 IM **外发投递**）——数据接入属 `docs/2026-09-15-crm-coexistence-sync-design.md` 的 N/B 项，不在本设计。
- ❌ 不放开 T2/T3 档写权限；**常驻授权不可自动提升**。
- ❌ 不做「取消人工录入 / 替代 CRM」类动作。
- ❌ 不改 `src/mcp/gateway.js:201` 的现有语义（只增加凭证类型，不删判据）。

### §3.3 硬约束继承

| 约束 | 本设计的遵守方式 |
|---|---|
| 绝对禁 DELETE | 信号关闭、授权撤销、执行否决**全部为状态变更**；表内不提供 delete 路径 |
| 阈值/行业差异化 100% 后台配置化 | 6 个新配置键全部 per-tenant 落 `config_store`（§9） |
| 建表单一事实源 `db/schema.sql` | 4 张新表 DDL 一律追加 `db/schema.sql`（§8） |
| 写操作过决策第 0 闸 | T1 自动写**仍 mint 决策**（handler 内、`deferDecisionMint` 范式），只是 actor 为 `standing-auth` |
| 不得绕过装配闭包 | 新 Action 若走 `agentTool:true` 须三处同改；本设计新 Action 走 `agentTool:false`（同 `connectorActions.js:132` 范式），**免 agentSpec 同改** |
| 假绿 L1–L4 | 每条链路带负向判据（§15） |
| config-routing id36 禁改 | 本设计不触碰 `context-routing` |

---

## §4 方案选型

| | 方案 A · 投递补链式 | **方案 B · 四层渐进式（选定）** | 方案 C · 授权优先式 |
|---|---|---|---|
| 做法 | 只挂载端点 + 建表 + 加视图 + 首页卡 | S1 投递面 → S2 感知面 → S3 判断面 → S4 授权面 | 先做常驻授权与自主执行，投递当附属 |
| 交付周期 | 最短 | 分 5 段，每段独立可回滚 | 中 |
| 风险 | 最低，但达不到"全四层" | 低（逐层验证） | **最高** |
| 关键缺陷 | 感知面仍窄、判断力仍为阈值 | — | 在链路断裂且无观测时放开写权限 → **把假绿放大成真错** |
| 判定 | 不满足已定范围 | ✅ | ❌ |

**选 B 的判据**：用户已定"全四层"，且**顺序不可颠倒**——先让人看得见，才允许它自己动手。C 的风险不是理论风险：当前 `createAlert` 的产出**连持久化都没有**，此时增加自动写权限，出错后既无页面可查、也无流水可回溯。

---

## §5 补齐清单（已有实现但未接线，零新能力）

| # | 补齐项 | 现状 | 落点 |
|---|---|---|---|
| **B1** | 挂载 `alertEndpoints` 的 8 个端点 | 清单存在、处理器存在、**零调用** | `src/http/routes.js` |
| **B2** | 注册 `registerAlertHook` | 未注册（server.js:74 只有 finance 版） | `src/http/server.js` |
| **B3** | `crm.signal` 表落 `db/schema.sql` + store 由内存迁 DB | 表不存在、内存 Map | `db/schema.sql`、`src/alerts/alertStore.js` |
| **B4** | 工作台增加信号视角（第 7 视角） | 六视角无信号 | `src/http/workbenchRouter.js`（对齐 :101-175 既有 case 结构） |
| **B5** | 首页信号卡（对齐 Rox Home） | 无 | `src/web/home.html` |
| **B6** | 事件触发从单域扩为三源 | 仅 `ontology` | `src/agent/eventTrigger.js`（键名 `agent-event-trigger` 不变，**向后兼容扩矩阵**） |
| **B7** | 复用 SMTP（抽公共 mailer） | SMTP 仅计费域在用 | 抽 `src/mail/` 公共模块，计费域与信号域共用 |
| **B8** | 复用 13 类规则 + `salesDailyScan` 作为 L1 判断 | 已实现 | 直接消费，**不重复造** |
| **B9** | 复用 `ready-queue-pump` 作为调度心跳 | 已实现（60s） | 直接复用，**不新增定时器** |

---

## §6 新增清单

| # | 新增项 | 说明 | 为何必须新建 |
|---|---|---|---|
| **N1** | `crm.signal` 表 | 信号统一收口（告警 / 巡检 / 事件触发 / 智能体研究四源） | 内存 Map 无法支撑投递、去重、审计 |
| **N2** | `crm.signal_delivery` 表 | 投递流水（渠道 / 收件人 / 状态 / 错误 / 重试） | **防假绿**：`send 被调用` ≠ `已送达` |
| **N3** | `src/signal/` 模块 | store / router / digest 三件套 | 统一收口，避免重蹈"清单在但挂载方没来" |
| **N4** | `src/signal/delivery/` provider 契约 + 四实现 | inbox / email / im / webhook | 用户已定"全渠道可配置" |
| **N5** | `config_store['signal-delivery']` | 渠道路由（severity→channel、role→recipient）、频次上限、静默时段 | 阈值配置化铁律 + 防骚扰 |
| **N6** | `config_store['signal-schedule']` | 时间型节律表（T+n 未跟进、报价 T+n 未审批、阶段静默等） | 让时间型触发**配置化而非硬编码** |
| **N7** | L3 主动研究调度 | 按节律选对象 → 跑**只读 SKILL** → 产出建议卡 | 判断面从阈值升到"想好了" |
| **N8** | `crm.standing_grant` + `crm.grant_execution` + `config_store['standing-grants-policy']` | 常驻授权凭证 + 执行流水 + 全局策略 | 授权面（见 §11） |
| **N9** | `src/web/signal-center.html` | 信号中心页（列表 / 筛选 / 采纳 / 否决 / 静默） | 人一定会看到的地方 |

---

## §7 客户价值排序

> 用户明确要求按客户价值排序。以下为**客户感知强度**排序。

| 排名 | 客户获得的价值 | 支撑项 | 感知 |
|---|---|---|---|
| **1** | **每天打开就知道今天该干什么**——不用自己找 | S1 待办信号视角 + 首页信号卡 + 每日作战简报 | ★★★★★ |
| **2** | **不用去查，它主动告诉我**——时间/变更/外部三类触发 | S2 三源触发器 + 节律表 | ★★★★★ |
| **3** | **提醒里已经带好理由和证据**，不是一句"该跟进了" | S2 上下文增强 + S3 建议卡（推理链 + 证据） | ★★★★ |
| **4** | **一键采纳，改动自动落库**，并回写客户 CRM | S3 采纳回路 + 回写通道（接共存设计） | ★★★★ |
| **5** | **低风险的事 AI 自己做完**，我不用点 | S4 常驻授权 T1 | ★★★ |
| **6** | **我知道 AI 干了什么、能撤、能让它停** | S4 执行流水 + 熔断 + 撤销 + 观测上墙 | ★★★ |

### §7.1 ⚠ 客户价值排序 ≠ 实施顺序（必须点破）

| 排名 4–6 的价值（一键采纳 / 自动执行 / 可撤回）**全部依赖**： |
|---|
| **先有信号 → 先有投递 → 先有建议卡 → 才有采纳对象 → 才有授权执行 → 才有执行流水可看。** |
| 因此实施顺序必须是 **S1 → S2 → S3 → S4**，**倒序实施会造出「无对象的采纳按钮」与「无观测的自动写」**。 |

---

## §8 数据模型（DDL，全部追加 `db/schema.sql`）

> 4 张表均为**运行态表（非粒子域）**，与 `crm.tasks` 同类，**不触碰 §10「不新增粒子类型、不改业务域模型」**。全部 `CREATE TABLE IF NOT EXISTS` + `ALTER ADD COLUMN IF NOT EXISTS` 补偿列（对齐既有迁移范式）。

### §8.1 `crm.signal` —— 信号统一收口（替换内存 Map）

```sql
CREATE TABLE IF NOT EXISTS crm.signal (
  signal_id     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  source        TEXT NOT NULL,                      -- rule-scan | event-trigger | agent-research | external
  kind          TEXT NOT NULL,                      -- 13 类告警 kind + 新增 kind
  severity      TEXT NOT NULL,                      -- low | medium | high
  target_role   TEXT NOT NULL,                      -- sales | finance | exec | ops
  owner_id      TEXT NULL,                          -- 责任人（投递路由第一依据）
  l2c_stage     TEXT NULL,
  particle_id   TEXT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb, -- 证据链（来源、快照、阈值、规则版本）
  suggestion    JSONB NOT NULL DEFAULT '{}'::jsonb, -- 建议卡（L3）：{headline, reasoning, evidence_refs, action_name, action_params}
  status        TEXT NOT NULL DEFAULT 'open',       -- open | acked | closed | acted
  dedup_key     TEXT NULL,                          -- 幂等去重键：kind:particle_id:bucket
  decision_id   TEXT NULL,
  action_ref    TEXT NULL,                          -- 采纳后触发的 Action 名
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at      TIMESTAMPTZ NULL,
  closed_at     TIMESTAMPTZ NULL,
  closed_reason TEXT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_signal_dedup
  ON crm.signal(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signal_inbox
  ON crm.signal(tenant_id, owner_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_open_kind
  ON crm.signal(tenant_id, kind, status);
```

**幂等写入语义**：`ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET payload/severity/created_at`（**更新而非新建**），避免同一事实每 30 分钟刷一条。`bucket` 由 `config_store['signal-schedule'].bucket` 决定（默认按日）。

### §8.2 `crm.signal_delivery` —— 投递流水（**防假绿核心表**）

```sql
CREATE TABLE IF NOT EXISTS crm.signal_delivery (
  delivery_id  TEXT PRIMARY KEY,
  signal_id    TEXT NOT NULL,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  channel      TEXT NOT NULL,                       -- inbox | email | im | webhook
  provider     TEXT NULL,                           -- smtp | dingtalk | wecom | feishu | custom
  recipient    TEXT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',     -- pending | sent | failed | skipped
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT NULL,
  provider_msg_id TEXT NULL,
  delivered_at TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_signal ON crm.signal_delivery(signal_id);
CREATE INDEX IF NOT EXISTS idx_delivery_fail
  ON crm.signal_delivery(tenant_id, status, created_at DESC);
```

> **判据（负向）**：任何一次 `send` 调用都必须留下 `sent` 或 `failed` 行。**若渠道配置为启用状态而表中无对应投递行，视为假绿，验收不通过。**

### §8.3 `crm.standing_grant` —— 常驻授权凭证

```sql
CREATE TABLE IF NOT EXISTS crm.standing_grant (
  grant_id        TEXT PRIMARY KEY,
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  title           TEXT NOT NULL,
  scope_actions   TEXT[] NOT NULL,                  -- 可自动执行的 Action 白名单
  scope_objects   TEXT[] NULL,                      -- 限定对象类型
  field_whitelist TEXT[] NULL,                      -- 允许自动写入的字段（T1 内部字段）
  risk_tier       TEXT NOT NULL DEFAULT 'T1',       -- T1 | T2 | T3
  max_uses        INT NULL,
  used_count      INT NOT NULL DEFAULT 0,
  period          TEXT NULL,                        -- day | week
  limit_payload   JSONB NOT NULL DEFAULT '{}'::jsonb, -- 业务约束（金额上限等）
  status          TEXT NOT NULL DEFAULT 'active',   -- active | paused | revoked | expired
  approved_by     TEXT NOT NULL,
  approved_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision_id     TEXT NULL,                        -- 授权动作自身的决策凭证（溯源铁律）
  expires_at      TIMESTAMPTZ NULL,
  revoked_at      TIMESTAMPTZ NULL,
  revoked_reason  TEXT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_grant_active
  ON crm.standing_grant(tenant_id, status, risk_tier);
```

### §8.4 `crm.grant_execution` —— 自主执行流水（可审计 / 可否决 / 可对照）

```sql
CREATE TABLE IF NOT EXISTS crm.grant_execution (
  execution_id TEXT PRIMARY KEY,
  tenant_id    TEXT NOT NULL DEFAULT 'system',
  grant_id     TEXT NOT NULL,
  signal_id    TEXT NULL,                           -- 由哪条信号触发
  action_name  TEXT NOT NULL,
  target_id    TEXT NULL,
  before_state JSONB NOT NULL DEFAULT '{}'::jsonb,  -- 执行前快照（对照/回滚参照）
  after_state  JSONB NOT NULL DEFAULT '{}'::jsonb,
  decision_id  TEXT NULL,                           -- 执行决策（actor='standing-auth'）
  actor        TEXT NOT NULL DEFAULT 'standing-auth',
  hitl_verdict TEXT NULL,                           -- adopted | rejected | pending
  rejected_at  TIMESTAMPTZ NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exec_grant ON crm.grant_execution(grant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_exec_verdict
  ON crm.grant_execution(tenant_id, hitl_verdict, created_at DESC);
```

---

## §9 配置层（`config_store`，全部 per-tenant）

| 键 | 语义 | 关键字段 |
|---|---|---|
| `signal-schedule`（N6） | 时间型节律表 | `rules[]: {id, kind, entity_type, condition, threshold, period, severity, target_role, enabled}`、`bucket`（去重窗口，默认 `day`）、`enabled` |
| `signal-delivery`（N5） | 渠道与路由 | `channels: {inbox:on, email:on, im:off, webhook:off}`、`route: {high:[im,email], medium:[email], low:[inbox]}`、`role_recipients: {sales:{...}, exec:{...}}`、`quiet_hours`（静默时段）、`rate_limit: {per_day, per_hour}` |
| `signal-digest` | 作战简报 | `enabled`、`period`（`daily`）、`at`（如 `08:30`）、`max_items`、`order`（severity→owner→created_at）、`include_low` |
| `agent-event-trigger`（B6 扩矩阵） | 变更型触发矩阵 | 沿用现键，行内新增 `source: 'event'`，域从 `ontology` 扩到 `particle`/`approval`/`decision`；**旧行语义不变（向后兼容）** |
| `agent-research-schedule`（N7） | L3 主动研究节律 | `enabled`、`period`、`max_objects_per_run`、`daily_llm_budget`、`concurrency`（≤ 现有 agent `governance.concurrency`）、`select_rule`（对象选取规则） |
| `standing-grants-policy`（N8） | 常驻授权全局策略 | `default_tier:'T1'`、`allow_tier_upgrade_by_ai:false`、`auto_pause_on_consecutive_rejects:3`、`max_daily_executions`、`notify_on_execution:true` |

**分发与读取**：全部经既有 `readConfig(key,{tenantId})` / `writeConfig(key, value, {tenantId, decisionId, updatedBy})`（`src/config/configStore.js`，自带 `decisionId` 字段，写配置本身即带决策依据）。

---

## §10 投递抽象（provider 契约）

### §10.1 契约

```
provider = {
  id,                       // 'inbox' | 'email' | 'im' | 'webhook'
  verifyConfig(config),     // 配置自检（缺凭据/域名非法 → 拒绝启用，fail-closed）
  send({ signal, recipient, channelConfig }) → { ok, provider_msg_id, error }
}
```

新增实现（N4）：`inbox`（平台内，默认启用）、`email`（复用 §5 B7 抽出的公共 mailer）、`im`（dingtalk / wecom / feishu，**仅外发**）、`webhook`（通用）。

### §10.2 投递流程

```
signal 落库(crm.signal)
  → router 读 config_store['signal-delivery']
  → 按 severity / target_role / owner_id 计算收件人与渠道集合
  → 频次与静默时段闸（超限 → status='skipped' 并留痕，不静默丢弃）
  → 逐渠道 send
  → 每次 send 落 crm.signal_delivery（sent / failed + last_error）
  → 失败重试（attempts ≤ config），最终失败进 monitor_event（不静默）
```

> **判据**：`skipped` 必须留痕（防"静默丢弃"）；`failed` 必须带 `last_error`。

---

## §11 授权面：常驻授权设计

### §11.1 核心立场

**不取消第 0 闸，而是给它增加一类合法凭证。** `src/mcp/gateway.js:201` 的判据语义不变；常驻授权走的是 `deferDecisionMint`（handler 内自 mint）这条**已有旁路**，只是把 actor 从 `mcp` 换成 `standing-auth`，并强制带 `grant_ref`。

### §11.2 闭环三要素

| 要素 | 机制 |
|---|---|
| **授权凭证自己带决策依据** | 凭证通过既有审批流（`CRM_APPROVAL_FLOW`）批准 → `standing_grant.decision_id` 非空。**溯源铁律不破**：任何自动执行的源头都可追到一次人工批准 |
| **执行仍 mint 决策** | 执行时 handler 内 mint，`decision` 记录 `actor='standing-auth'` + `grant_ref` + `autonomy_level` → 可回答"这个动作为什么被允许" |
| **执行留前后快照** | `grant_execution.before_state/after_state` → 可对照、可判断是否需要回填 |

### §11.3 分级与首批边界（用户已定 T1）

| 档 | 内容 | 首批 |
|---|---|---|
| **T0** | 只读 / 研究 / 建议产出 | ✅ 无需授权（现状） |
| **T1** | **内部字段写**：AI 属性、评分、标签、研究结论回填 | ✅ **首批开放** |
| T2 | 客户可见内部动作：跟进记录、任务、提醒 | ❌ 本轮不开 |
| T3 | 对外动作：发信、阶段推进至 S7/S8 | ❌ **永久不可常驻授权**（必须前置审批） |

> **判据**：T1 的判定标准是「**客户不可见、不对外、可对照回填**」。凡写入内容会被客户看到的，一律不低于 T2。

### §11.4 熔断 / 降级 / 撤回（全部为状态变更，零 DELETE）

| 机制 | 规则 |
|---|---|
| 用量熔断 | `used_count` 达 `max_uses`（或 `period` 内上限）→ `status='paused'` + 通知 |
| **信任降级** | `grant_execution.hitl_verdict='rejected'` **连续 N 次**（默认 3，`config_store['standing-grants-policy']`）→ 自动 `paused` + 通知 + `trace` 留痕 |
| **不可自动提升** | `allow_tier_upgrade_by_ai:false` 写死；档位提升必须新批一次授权（新 `grant_id`） |
| 到期 | `expires_at` 到期 → 调度扫为 `expired`（状态变更） |
| 撤回 | `revoked_at` + `revoked_reason`；已执行动作进审计链，**不删除**（符合禁 DELETE 铁律） |

### §11.5 与人机反馈闭环的衔接（接上 J2 缺口）

`grant_execution.hitl_verdict` 的三态（adopted / rejected / pending）→ 经既有 `crm_decision_outcome_write`（`seed-actions.js:1791`）回写决策结果。

**这一步同时补上了此前判定的 P0 缺口**：`decision.outcome` 长期无输入、闭环三条腿缺一条。**常驻授权的执行流水天然就是 J2 的数据源**——无需另造入口。

---

## §12 铁律映射

| 铁律 | 本设计的遵守点 |
|---|---|
| 不新增粒子类型 / 不改业务域模型（§10） | 4 张新表全为运行态表（非粒子域）；信号承载既有 13 类 kind；`payload` 不改粒子结构 |
| 绝对禁 DELETE | 关闭信号、撤销授权、否决执行**全部为状态字段变更**；DDL 与代码路径均无 DELETE |
| 写操作过决策第 0 闸 | T1 自动写仍 mint 决策（`deferDecisionMint`），actor=`standing-auth`，带 `grant_ref` |
| 阈值/差异化 100% 后台配置化 | 6 个新配置键 per-tenant；**不新增任何域/粒子字面量** |
| 建表单一事实源 | 4 张表 DDL 追加 `db/schema.sql` |
| 不静默失败 | 投递失败写 `last_error` + `monitor_event`；巡检失败 `recordFailure`；降级/暂停发通知 |
| 装配闭包三处同改 | 新 Action 走 `agentTool:false`（同 `connectorActions.js:132`），**免 agentSpec 三处同改** |
| 多租户隔离 | 4 张表均带 `tenant_id`；投递路由按 `tenant_id + owner_id`；配置 per-tenant |
| 并发写入风险 | 新增文件为主、对既有文件的改动集中在确定行（routes.js 挂载点、server.js 注册点、workbenchRouter 视角分支） |

---

## §13 生命契约（10 任务，覆盖全部 7 个名册 agent）

> 契约字段对齐 `src/agent/agentSpec.js` 与 `src/agent/contractIds.js`；`contract_task_id` 必填且须等于 `CONTRACT_IDS[agent]`。校验：`node scripts/validate-contract.mjs docs/2026-09-15-proactive-runtime-design.md --registry src/agent/agentSpec.js`

### T1 信号统一收口：`crm.signal` 建表 + store 由内存迁 DB（S1）

```contract-yaml
- task: "T1 新建 crm.signal 表与 signalStore，alertStore 由内存 Map 迁移为 DB 幂等 upsert"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "createAlert 落 crm.signal 且进程重启后仍可查；同 (tenant_id,dedup_key) 二次写入走 ON CONFLICT 更新而非新建（行数不增）；DDL 存在于 db/schema.sql 单一事实源；表内无任何 DELETE 路径"
```
**契约说明：** 本任务由 `intake-router`（数据进入与承载的同源职责）承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1，≤2 跳）；成功标准为持久化 + 幂等 + 单一事实源 + 零 DELETE 四项同时成立。

### T2 感知三源：`eventTrigger` 扩为 `triggerRegistry`（S2）

```contract-yaml
- task: "T2 感知层扩为三源触发器（timer/event/external），eventTrigger 向后兼容扩矩阵"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [method-intake-routing, method-dialog-router]
  memory: [intake-router, followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "三类 source 各有一条规则可被触发；旧矩阵 3 行语义不变且不报错；变更型新增域（particle/approval/decision）触发后落 crm.signal 且 dedup 生效；非只读 SKILL 派发仍被拒并留 trace"
```
**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing` 与 `method-dialog-router`、读 `intake-router`/`followup-agent` 记忆（L1–L2，≤3 跳）；成功标准为三源可用、旧行为不回归、只读闸不放松。

### T3 投递抽象层与四渠道 provider（S1）

```contract-yaml
- task: "T3 新建 src/signal/delivery provider 契约与 inbox/email/im/webhook 四实现，落 signal_delivery 流水"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "四 provider 各实现 verifyConfig/send；send 失败落 signal_delivery 行 status=failed 且 last_error 非空；未配置凭据的渠道 verifyConfig 拒绝启用（fail-closed）；超频次或静默时段落 status=skipped 且留痕"
```
**契约说明：** 本任务由 `followup-agent`（触达与节奏的同源职责）承接，调用 `method-followup-engine`、读 `followup-agent` 记忆（L1–L2）；成功标准为四渠道可插拔 + 失败不静默 + 配置自检 fail-closed。

### T4 信号进入工作台与首页信号卡（S1）

```contract-yaml
- task: "T4 工作台增加信号视角 + 首页信号卡 + 每日作战简报（消费 signal-digest 配置）"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine, method-funnel-classification]
  memory: [followup-agent, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 2 }
  success: "buildViewRows('signals') 返回本租户本角色可见信号；首页信号卡数量与同视角条数一致（不出现两套口径）；简报条目数受 max_items 与 rate_limit 约束；空态返回空数组而非抛错"
```
**契约说明：** 本任务由 `followup-agent` 承接，调用 `method-followup-engine` 与 `method-funnel-classification`、读 `followup-agent`/`quote-engine` 记忆；成功标准为视角可用、口径唯一、限额生效、空态安全。

### T5 报价与阶段推进的时间型信号（S2）

```contract-yaml
- task: "T5 报价待审批超时/阶段静默/价格基线漂移三类时间型信号接入节律表"
  agent: quote-engine
  contract_task_id: ct-quote-calc
  skills: [method-quote-engine, method-stage-progression]
  memory: [quote-engine, followup-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "三类信号的阈值全部读 config_store（无字面量）；阈值调整后同批数据命中集合随之改变（可证配置生效）；命中落 crm.signal 且 severity/target_role 按配置分档"
```
**契约说明：** 本任务由 `quote-engine`（报价与阶段闸门的同源职责）承接，调用 `method-quote-engine` 与 `method-stage-progression`、读 `quote-engine`/`followup-agent` 记忆；成功标准为阈值零硬编码且配置变更可观测生效。

### T6 主动拓客信号（S2）

```contract-yaml
- task: "T6 公海 S0 停滞/候选池触达窗口/线索回收前预警三类拓客信号"
  agent: prospecting
  contract_task_id: ct-prospecting
  skills: [prospecting-search, method-outreach-hook]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "S0 超期未认领、S0P 回收前 T-3 天、候选池触达窗口三类各产出一条信号；与既有 lead-pool-recycle 扫描不重复产同 dedup_key；拓客信号只提醒不改动归属（写入为零）"
```
**契约说明：** 本任务由 `prospecting`（获客与触达钩子的同源职责）承接，调用 `prospecting-search` 与 `method-outreach-hook`、读 `intake-router` 记忆（L1）；成功标准为三类信号可产、与既有扫描去重、且本任务零写入。

### T7 L3 智能体主动研究：产出建议卡（S3）

```contract-yaml
- task: "T7 主动研究调度：按节律选对象→跑只读 SKILL→产出带推理链与证据的建议卡"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-enrich, discovery-research]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "每轮研究对象数不超过 max_objects_per_run；LLM 调用不超过 daily_llm_budget（超预算降级不抛错）；建议卡的 reasoning 与 evidence_refs 均非空（缺证据时输出降级说明而非编造）；本任务不产生任何粒子写入"
```
**契约说明：** 本任务由 `decision-agent`（决策织入与自治的同源职责）承接，调用 `method-decision-enrich` 与 `discovery-research`、读 `decision-agent` 记忆（L1–L2，≤5 跳）；成功标准为预算受控、建议卡证据非空、零写入。

### T8 建议卡采纳回路与 J2 回写（S3）

```contract-yaml
- task: "T8 建议卡一键采纳（人 mint 决策调既有 Action）与否决回写决策结果"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute, data-particle-create, data-particle-read]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "采纳路径必携带 decision_id（无则被第 0 闸拒）；采纳后 signal.status='acted' 且 action_ref 落库；否决后 hits crm_decision_outcome_write 且 decision.outcome 行数增加（可观测）"
```
**契约说明：** 本任务由 `decision-agent` 承接，调用 `method-decision-execute` 等、读 `decision-agent`/`review-gate` 记忆；成功标准为采纳必须过闸、状态可追、否决可回写（补齐 J2 缺口）。

### T9 常驻授权凭证与 T1 自动执行（S4）

```contract-yaml
- task: "T9 crm.standing_grant/crm.grant_execution 落地：审批流批准→T1 字段白名单内自动执行→前后快照留痕"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate, quote-engine]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "凭证必须经审批流批准（decision_id 非空）方可 active；白名单外字段写入被拒且留痕；超出 max_uses/period 自动 paused；tier 无任何自动提升路径（T2/T3 动作在无凭证时被拒）"
```
**契约说明：** 本任务由 `review-gate`（高危动作闸门与评审的同源职责）承接，调用 `method-review-gate` 与 `data-particle-read`、读 `review-gate`/`quote-engine` 记忆（L1–L2，≤4 跳）；成功标准为凭证有据、白名单生效、限额熔断、无法自动提升。

### T10 主动链路观测与信任校准（S5）

```contract-yaml
- task: "T10 信号链路观测上墙（投递成功率/延迟/冲突/执行量）与连续否决自动降级"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "指标按 tenant_id 隔离返回；存在负向判据（无投递行但渠道为 on → 报警；hits>0 而新增 signal=0 → 报警）；连续 rejected 达阈值自动 paused 并 emit 告警；降级事件可在追溯链中查到"
```
**契约说明：** 本任务由 `decision-retro`（校准与复盘的同源职责）承接，调用 `decision-retrospective` 与 `data-particle-read`、读 `decision-retro`/`review-gate` 记忆；成功标准为指标租户隔离、含负向判据、降级可追溯。

---

## §14 红线（明确不学 Rox 的六条）

1. **不学「投递即骚扰」**：Rox 自己做了 `Notifications controls`（按数据源调频率），说明过量投递是真问题。我方必须有 `rate_limit` + `quiet_hours` + `include_low` 开关，默认**低频高信噪**。
2. **不学「always-on 全自动」**：常驻授权首批只开 **T1 内部字段**，`allow_tier_upgrade_by_ai:false` 写死；T3 对外动作**永久不可常驻授权**。
3. **不学「发送即送达」**：必须有 `signal_delivery` 流水与 `last_error`；`skipped` 也要留痕。**没有投递证据的投递，等于没投递。**
4. **不学「外部公开信号当主料」**：我方 K 层真实弱点是**内部数据不足**（`events` 供给、`supplied_dims` 覆盖），先把内部信号做透；外部信号接入属共存设计范畴，排在其后。
5. **不学「为主动而新增域模型」**：守 §10——4 张新表全为运行态表，信号 kind 复用既有 13 类，**不新增粒子类型**。
6. **不学「把主动能力当营销词」**：**对外只能讲已通电的链路**。S1 未交付前，不得对外宣称"AI 主动值守"——这正是本项目最忌讳的假绿。

---

## §15 验收标准（含负向判据，10 条）

| # | 判据 | 类型 |
|---|---|---|
| A1 | 巡检命中后，`crm.signal` 有对应行，**且进程重启后仍可查** | 正向 |
| A2 | 同 (tenant, dedup_key) 重复命中**不产生新行**（幂等） | 正向 |
| A3 | `GET /api/alerts`（挂载后）返回本租户信号，**跨租户不可见** | 正向 |
| A4 | 渠道配置为 `on` 时，每次投递在 `signal_delivery` 有 `sent` 或 `failed` 行 | **负向** |
| A5 | 渠道 `on` 但 `signal_delivery` 无对应行 → 判定假绿，**验收不通过** | **负向** |
| A6 | `trace 'sales-daily-scan' hits>0` 而当日新增 `signal` = 0 → 报警 | **负向** |
| A7 | 阈值改配置后，同批数据命中集合随之改变（证明非硬编码） | 正向 |
| A8 | 建议卡 `reasoning` 与 `evidence_refs` 均非空；缺证据时输出降级说明 | 正向 |
| A9 | 白名单外字段的自动写入被拒并留痕；超限额自动 `paused` | **负向** |
| A10 | 全链路 grep `DELETE FROM` 新增数 = **0** | **负向** |

---

## §16 闭环回写

| 任务 | 承接 agent | 观测点 | 缺口类型 |
|---|---|---|---|
| T1 | intake-router | `crm.signal` 行数 / 幂等命中率 | success |
| T2 | intake-router | 三源触发计数 / 只读闸拒绝留痕 | skill |
| T3 | followup-agent | 投递成功率 / failed 明细 | success |
| T4 | followup-agent | 视角条数 vs 首页卡数一致性 | success |
| T5 | quote-engine | 阈值变更后的命中集合差异 | memory |
| T6 | prospecting | 拓客信号产出数 / 与 lead-pool-recycle 去重率 | success |
| T7 | decision-agent | 研究轮次 / LLM 预算消耗 / 证据非空率 | success |
| T8 | decision-agent | 采纳率 / `decision.outcome` 增量 | success |
| T9 | review-gate | 白名单拦截数 / 熔断触发数 | skill |
| T10 | decision-retro | 负向判据报警数 / 降级次数 | success |

回写文件：`docs/2026-09-15-proactive-runtime-design.feedback.json`（机器，按 `task+gap_type` 幂等 upsert）+ 本表（人读）。同一 `(task, gap_type)` 复发 ≥2 次 → 出 SKILL 改进提案（**须显式批准**）。

---

## §17 移交

**本设计经用户批准（P8）后，唯一入口为 `writing-plans`。** S1–S5 转可执行任务清单，每任务**继承 §13 同名契约**（不新增、不弱化 `agent`/`skills`/`memory`/`knowledge_scope`/`success`/`contract_task_id`）。

### §17.1 实施分段

| 段 | 内容 | 交付后可验证的客户价值 |
|---|---|---|
| **S1** | T1 信号收口 + T3 投递全渠道 + T4 待办视角/首页卡/简报（含 B1/B2 挂载修复） | §7 排名 1、2 立即成立（**当天可见**） |
| **S2** | T2 三源触发器 + T5 报价节律 + T6 拓客信号 | 排名 2 扩展（从"库里变了"到"世界变了"） |
| **S3** | T7 主动研究 + T8 采纳回路 | 排名 3、4 |
| **S4** | T9 常驻授权（T1 档） | 排名 5 |
| **S5** | T10 观测与信任校准 | 排名 6（其中投递流水的最小集已在 S1） |

### §17.2 批准前的前置动作（成本极低，建议先做）

1. **核实生产 `EMBEDDING_PROVIDER` 是否 = `model`**（`src/ontology/hooks.js:22`）：若否，向量列为空，"语义检索"的对外表述需修正。**此条比对接 Rox 任何功能都更要紧。**
2. **复核 `supplied_dims` 现状覆盖率**：文档引用的"峰值 4/7"是 9 月初口径，非本次实测。
3. **确认 `crm.alert` 表在生产库是否真的不存在**：本设计判断依据是 `db/schema.sql`（56 表）零命中 + `db/` 无建表；若生产库手工建过表而 schema.sql 未同步，则 §2.3 的"表不存在"需改为"表未纳入单一事实源"（**机制差异不影响结论，但表述必须准确**）。

---

## 附录：证据索引

**我方源码锚点**
- 定时器与巡检：`src/scheduler/timers.js:163-466`、`src/scheduler/riskScanner.js`、`src/scheduler/salesDailyScan.js:52-109`
- 事件触发：`src/agent/eventTrigger.js`、注册点 `src/http/server.js:97`
- 告警判定：`src/alerts/alertRegistry.js`、`src/alerts/ruleEvaluator.js`、`src/alerts/alertHook.js`
- **断链证据**：`src/alerts/alertStore.js:6`（内存 Map）、`src/alerts/alertEndpoints.js:12-24`（清单/处理器零挂载）、`src/http/server.js:74`（只注册 finance hook）、`src/http/workbenchRouter.js:101-175`（六视角无信号）、`db/schema.sql`（56 表，`alert` 零命中）
- 授权约束：`src/mcp/gateway.js:201/224`、`src/action/registry.js:14`、`src/action/seed-actions.js:741/801/994/1055/1108`（deferDecisionMint 五处）
- 决策回写通道：`src/action/seed-actions.js:1791/1815/1870`
- 装配与契约：`src/agent/agentSpec.js`（7 agent）、`src/agent/contractIds.js`（7 契约键）、`src/contract/contractParser.js`

**Rox 一手来源**
- 官网：`www.rox.com`（首页 / Platform / Pricing / Manifesto / Security）
- 文档：`docs.rox.com/development/about-rox/revenue-operating-system`、`docs.rox.com/development/about-rox/release-notes`（全量版本条目 2024-08 → 2026-09）
