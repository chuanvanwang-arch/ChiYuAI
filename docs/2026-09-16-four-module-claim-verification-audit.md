# CRM-ai-native 四模块新增功能 · 代码级落地核验审计报告

- **审计日期**：2026-09-16
- **审计对象**：用户主张的 4 组新增功能（拓客模块 / 开通期邮箱·日历·会议·微信集成 / 日期驱动自动化推送 / 原 CRM 系统集成）
- **审计方法**：三查法（grep 定位 → Read 确认 → 交叉引用调用点）+ 运行态直查（`crm_native` 库表行数/分布）双证据
- **判定口径**：✅ 已落地（机制 + 调用点 + 数据）；⚠️ 部分落地（模块在但闭环断点）；⛔ 未落地；🔴 假绿（表面绿、实则未生效）
- **基线**：`docs/superpowers/plans/2026-09-16-line-a-mount-points.md`、`docs/2026-09-15-final-design-coexistence-and-proactive.md`
- **运行库**：`crm_native`（本机 PG16 @5433）

---

## 0. 结论速览

| # | 主张 | 判定 | 一句话结论 |
|---|---|---|---|
| 1 | 拓客模块（邮箱/公司名补齐 · 新客户筛选 · 公海认领回退） | ⚠️ 部分 | 引擎/动作齐备，**前台零自助入口**；「高层变动/新战略」仅有权重配置、无数据面；回退动作代码真实但台面不可达 |
| 2 | 开通期打通邮箱/日历/会议/微信并提取客户信息成图谱 | ⛔ 未落地 | 4 类通道 **0/4** 实现；图谱存在但数据源是 CRM 粒子，非外部沟通数据 |
| 3 | 日期驱动自动运行 + 推送邮箱/微信 + 建日历 | ⚠️ 部分 | 拜访/线索/逾期 3 维有扫描器；**邮件渠道未接线**、微信为占位假绿、日历 0 实现；汇报/投标日期无驱动 |
| 4 | 原 CRM 集成（一次性抽取 · 定时获取 · MCP 回写） | ⚠️ 部分 | 同步内核+挂载点+信任分级已建；**provider 是桩**、无全量抽取、**回写未接线**、真实 provider 运行态 0 行 |

**总判**：四组主张中 **0 组完整实现**，1 组未落地，3 组部分实现。核心落差集中在「模块已建 → 生产接线/真实数据面」这一跳。

---

## 1. 模块一 · 拓客

### 1.1 输入邮箱/公司名称 → 客户信息补齐 — ⚠️ 引擎✅ / 前台入口⛔

| 环节 | 证据 | 判定 |
|---|---|---|
| 拓客会话状态机 | `src/action/prospectingSession.js:21` `transition()` / `:35` `createProspectingSession()` | ✅ |
| 四段动作 | `src/action/prospectingActions.js:41` `prospecting-lookup`（读）/ `:66` `prospecting-search` / `:117` `prospecting-select` / `:135` `prospecting-confirm`（写，`needsApproval:true`） | ✅ |
| 富化瀑布 | `src/connectors/discovery/waterfall.js` `runWaterfall` → `src/action/discoveryActions.js:65` 调用 | ✅ |
| 适配器实现 | `qixin.js:41` 真实 `fetch(${QIXIN_API}/company?name=...)`；另有 `xinbang / gaode / tender / emailVerify / webResearch / anysite / genericRest / genericMcp / genericCli` 共 10 个 | ✅ |
| **前台入口** | `src/web/discovery.html` 仅 **78 行**，只读 `GET /api/discovery/candidates`（`routes.js:207`）——**无「输入邮箱/公司名称」表单** | ⛔ |
| 出厂可用源 | `src/config/discoveryRules.js:27-29`：`qixin / anysite / xinbang` 均为 `scope:'paid', enabled:false` → 出厂仅 4 源（email-verify / web-research / tender / gaode） | ⚠️ |

**关键缺口**：`prospecting-*` 四个动作全部 `agentTool:true`，即**只能经 Agent/MCP 调用**；销售在 CRM 前台无自助补全入口。且付费源缺 key 时 `enrich()` 返回 `{}`（`qixin.js:37-40` fail-open）→ **静默空结果，界面无区分"没查"与"查无"**。

### 1.2 筛选新客户（新战略 / 高层变动 / 人员招聘）— ⚠️ 配置齐 / 数据面缺 2/3

> **口径修正（2026-09-16，用户批准）**：原表述「可以筛选新客户，比如新战略、高层变动、人员招聘」
> 与平台数据面不符——「人员招聘」「新战略」在本平台**无数据源**（无 HR、无战略情报面）。
> 现口径为：**可识别「内部可观测」的客户异动**——客户侧联系人台账变动（`CRM_CONTACT` 近 14 天内更新，
> 属"关键人变动"的弱代理）、客户关系冷却（`CRM_ACCOUNT` 停滞超 30 天）、商机停滞（既有 `deal_stuck`）。
> **不覆盖**外部招聘 / 战略情报（待 S2 外部数据接入）。
> 实现：`src/signal/activityDerivation.js`（`source='derived'` + `confidence_basis='internal_inference'`，
> 权重低于实测情报）+ 定时器⑱；口径标注见 `src/config/discoveryRules.js` 与拓客规则配置页。
>
> **⚠ 实测补充（2026-09-17）**：`contact_ledger_change` 真库产出 2 条（可证伪通过）；
> `relation_cooling` **零命中**——根因＝`crm.particles.updated_at` 在**列**不在 `payload`，
> 派生器读 `payload.updated_at` ⇒ 该规则在当前数据面永不可能命中（详见
> `docs/2026-09-16-internal-signal-derivation-design.md` §8）。修复前不得宣称「关系冷却」已可产出。

| 信号 | 配置位点 | 数据面实现 | 判定 |
|---|---|---|---|
| 人员招聘 `hiring_icp_role` | `discoveryRules.js:33` 权重 0.7；岗位层级加权 `prospectingRules.js:65-95` | `qixin.js:27` coverageFields 含该字段；`prospectScanner.js` 未见产出 | ✅ 配置+采集 |
| 高层变动 `leadership_change` | `discoveryRules.js:35` 权重 0.5 | **全仓 grep `leadership_change` 仅此 1 处命中** — 无任何适配器产出该字段 | ⛔ |
| 新战略 | — | **无对应信号键、无实现** | ⛔ |
| 融资 `funding_round` | `discoveryRules.js:32` 权重 0.9 | `qixin.js:31` | ✅ |
| 招投标 `tender_match` | `discoveryRules.js:34` 权重 0.8 | `tender.js:77` | ✅ |
| 时间衰减 | `discoveryRules.js:43-54` `signal_time_fields` + `signal_age_tiers` | — | ✅ |

**运行态反证**：`crm.signal` 全文 265 行，`source` 仅 `rule-scan / agent-research / event-trigger`，`kind` 分布为 `visit_shortfall 160 / info_collect_lag 80 / suggestion_card 16 / s0_stale 3 / deal_stuck 2 / lead_overdue 1 / payment_gap 1 / named_visit_overdue 1 / object_changed 1` — **零条拓客发现类信号**（无 hiring/funding/tender）。配置存在，但发现链在运行态未产出过信号。

### 1.3 公海池认领与回退 — ⚠️ 认领✅ / 回退代码✅但台面不可达

| 能力 | 证据 | 判定 |
|---|---|---|
| 认领规则纯判定 | `src/sales/pool.js:57` `checkPickRule`（日限额/领取间隔/限前归属/限新数据） | ✅ |
| 回收规则 | `src/sales/pool.js:83` `checkRecycleRule` | ✅ |
| 三池配置化 | `pool.js:103` `DEFAULT_POOL_TEMPLATE`（new/nurture/lost）；真源 `config_store['lead-pool-config']`（`pool.js:100`） | ✅ |
| 认领端点 | `src/http/routes.js:1030` `POST /api/lead-pool/:id/pick`；`GET /api/lead-pool`（`:941`） | ✅ |
| 认领 Action | `seed-actions.js:859` `crm-lead-pick`（CAS：`casExpectStage`/`casExpectOwnerEmpty` + `pooled_at`） | ✅ |
| 认领 UI | `src/web/lead-pool.html:148` 认领按钮 → `:162` `fetch(.../pick)` | ✅ |
| **回退 Action** | `seed-actions.js:994-1047` `crm-lead-return`：校验仅 S0P/S1 可退、无归属拒退、5 类 `reason_code`、写 `stage='S0'/owner_id=null/prev_owner_id/returned_at/pooled_at/pool_type`、过第 0 闸 `requireDecision('LEAD_FOLLOW_UP')` | ✅ 实现真实 |
| **回退 UI** | `grep 回退\|退回\|释放\|归还 src/web/lead-pool.html` → **0 命中** | ⛔ |
| 其它池动作 | `seed-actions.js:935` `crm-lead-recycle`（自动回收）/ `:1055` `crm-deal-archive-to-pool`（战败归档）/ `:1108` `crm-lead-reclaim-bulk` | ✅ |
| 运行态 | `crm.signal` 有 `s0_stale 3` 条 → 拓客扫描器真跑过 | ✅ |

**关键缺口**：回退能力**代码完整、但销售台面不可达**。当前仅可经 MCP/Agent（`page/schema.js:57` 写动作白名单）触发；`lead-pool.html` 只有「认领」，无「退回公海」。主张「能够对公海线索进行认领和回退」在**用户可操作层面只满足一半**。

---

## 2. 模块二 · 开通期打通邮箱/日历/会议/微信 → 提取客户信息成图谱

### 2.1 外部通道接入 — ⛔ 0/4

| 通道 | 探测命令 | 结果 | 判定 |
|---|---|---|---|
| 邮箱 | `grep -i "imap\|pop3\|mailparser\|fetchMail" src/**/*.js` | **0 命中**（仅 `routes.js:1346` "审批收件箱"业务语义）。email 仅两处用途：① 激活码 SMTP `activation.js:32`；② 未接线的投递渠道 | ⛔ |
| 日历 | `grep -i "BEGIN:VCALENDAR\|VEVENT\|\.ics\|caldav\|googleapis.com/calendar\|microsoft.graph\|outlook" src/**/*.js` | **0 命中** | ⛔ |
| 会议 | `grep -i "transcript\|转录\|录音" src/**/*.js` | 0 命中（仅 `interactionIndex.js:6` 的枚举字面量 `'meeting'`） | ⛔ |
| 微信 | `grep -i "oapi.dingtalk\|qyapi.weixin\|open.feishu\|wecom\|feishu" src/**/*.js` | 仅 `delivery/im.js` 注释 3 处，**零实现**（`billing/wechatV3.js` 是支付通道，非客户沟通） | ⛔ |

**孤儿模块证据**：`src/particles/interactionIndex.js:6` 声明 `INTERACTION_CHANNELS = ['email','calendar','call','meeting','general']`，但 `grep -rn "interactionIndex\|INTERACTION_CHANNELS" src/` **除自身外 0 命中** → 该互动索引**无任何写入方**，是一个声明了渠道枚举却从未被填充的孤儿模块。

### 2.2 图谱 — ✅ 存在，但数据源与主张不符

| 项 | 证据 |
|---|---|
| 图镜像写时同步 | `src/ontology/ageSync.js:1-16`：把 `crm.*` 表写后状态 `MERGE` 进 AGE 图 `crm_decision_network`；受控谓词 `EDGE_MAP` 9 种（owned_by / part_of / has_quotation / has_contract / key_contact …） |
| 页面 | `src/web/ontology.html`、`decision-graph.html`、`decision-graph-board.html` |
| **数据源** | `crm.*` 粒子 + 受控边 —— **不是**从邮箱/日历/会议/微信提取的客户信息 |

**判定**：图谱能力真实存在；但主张的"将当前客户的详细信息进行提取，形成图谱"其**提取源（邮箱/日历/会议/微信）全部不存在**，故该主张实际为未落地。

---

## 3. 模块三 · 日期驱动自动化 + 推送 + 建日历

### 3.1 日期维度覆盖 — ⚠️ 3/5

| 维度 | 驱动位点 | 运行态 | 判定 |
|---|---|---|---|
| 拜访 | `src/alerts/ruleEvaluator.js:108` `visit_shortfall`（日/周拜访量未达标）；`timers.js:374` `named_visit_overdue` | 160 条 / 1 条 | ✅ |
| 线索 | `src/alerts/alertRegistry.js:16` `lead_overdue`；`signal/prospectScanner.js:29` S0P 回收前 T-3 预警 | 1 条 | ✅ |
| 逾期 | `alertRegistry.js:9` `deal_stuck`；`migration-signal-schedule-config.sql:11-16` `stage_silence`(7d) / `quote_approval_timeout`(3d) | 2 条（deal_stuck） | ✅ 规则在，T15 真实库 0 命中（`CRM_DEAL` 的 `quote_status/last_activity_at` 为 null → 规则休眠） |
| 汇报 | `src/report/nightlyReport.js` 是**系统级**夜批日报（落盘 + `workbenchRouter.js:274` 展示） | — | ⛔ 无「销售个人汇报到期」驱动；`grep 日报\|周报\|汇报` 无个人级触发器 |
| 投标 | `grep "deadline\|bid_deadline\|开标" src/**/*.js` → 仅命中 `decision/retro.js`（夜批时长预算）与 `stop_loss.deadline`（决策止损），**与投标无关**。`tender.js:77` 只产 `tender_match` 布尔值，不建日期提醒 | — | ⛔ |

定时器总量：16 个（`test/timers.test.js:26` `EXPECTED_TIMERS = 16`），其中 `signal-schedule-scan`(30min) / `prospect-scan`(30min) / `agent-research`(1h) / `integration-poll` 均在册。

### 3.2 推送渠道 — ⛔ 未接线 + 🔴 假绿

| 渠道 | 证据 | 判定 |
|---|---|---|
| 邮件（SMTP） | `src/signal/delivery/email.js:32-48` 真实 `nodemailer`（默认 Brevo `smtp-relay.brevo.com:587`），缺凭据 `verifyConfig` fail-closed | ✅ 实现 |
| 微信/钉钉/企微/飞书 | `src/signal/delivery/im.js:5-35`：**「当前占位」**，无任何 HTTP 调用（`grep fetch\|http` 于 im.js = **0**），却 `deliveryStore.record({status:'sent'})` | 🔴 **假绿** |
| 投递分发器接线 | `grep -rn "createDeliveryRegistry\|deliver(" src/` 排除 `signal/delivery/` 自身 → **0 命中**；仅 `test/signal/delivery.test.js` 引用 | ⛔ 未接线 |
| 唯一生产 sink | `src/alerts/alertSignalHook.js:21` persister 仅写 `crm.signal`（收件箱/DB），**从不调用分发器** | ⛔ |
| **运行态铁证** | `SELECT channel,status,count(*) FROM crm.signal_delivery GROUP BY 1,2` → **`[]`（0 行）**，而 `crm.signal` 有 265 行 | 🔴 |

**关键假绿**：`im.js:25-33` 注释直言「真实推送在此接入…当前占位：落 sent 流水标记意图」，却写入 `status:'sent'`。这条流水正是设计用来**防假绿**的 `crm.signal_delivery` —— 用一个占位代码污染了防假绿账本。

### 3.3 建立日历 — ⛔

见 §2.1：`VEVENT/.ics/caldav/calendar API` 全仓 **0 命中**。

---

## 4. 模块四 · 与原 CRM 系统集成

### 4.1 已落地部分

| 环节 | 证据 |
|---|---|
| 同步内核 | `src/sync/engine.js:7` `runOnce`：read → map → upsert → 计数（`created/updated/skipped/conflicted/writeback`） |
| 幂等对齐 | `src/sync/resolver.js` + `crm.external_ref`（`external_object/external_id/particle_id/last_hash`） |
| 游标 | `src/sync/cursor.js` + `crm.sync_cursor` |
| 声明式映射 | `src/sync/mapping.js:10` `apply()`，未知对象/字段拒绝（fail-closed） |
| 信任分级 | `src/sync/trust.js` L1/L2/L3；`mount.js:21` `effectiveTrustLevel` 取 `min(descriptor, global)` — **无自动提权** |
| 第 0 闸 | `mount.js:136-142` L2/L3 每 run 铸 1 枚决策，铸不出即拒写（fail-closed） |
| 挂载点 | ① `timers.js:485-505` ⑩ `integration-poll` 增量分支（A-B6）② `src/http/connectorRouter.js:58` `POST /api/integration/webhook/:provider` 对象变化路由（A-B5） |
| 权限闸 | `connectorRouter.js:21` 仅 `admin/sysadmin` |
| 描述符工厂 | `src/sync/factory.js:56` `SYNC_PROVIDER_FACTORY = { fxiaoke, neocrm, 'generic-rest' }` |

### 4.2 关键缺口

| 缺口 | 证据 | 优先级 |
|---|---|---|
| **provider 是桩** | `src/sync/fxiaoke.js:52-58`：`readIncremental` **恒返回 `{ ok:true, rows:[], cursor, note:'...生产查询由接入配置驱动' }`** → `counts.read=0` + `last_status='ok'` → **假健康** | P0 |
| **无一次性全量抽取** | `grep "fullSync\|initialSync\|fullPull\|全量" src/sync src/scheduler/timers.js` → 0 命中；`engine.js` 只有 `readIncremental` | P0 |
| **对象映射未声明** | 运行库 `config_store` 中 **无 `sync-mappings` / `sync-trust` / `integration-providers` 任何行**（仅有 `discovery-rules / prospecting-rules / lead-pool-config / signal-schedule / integration-secrets`）→ `loadSyncMappings` 返回 `{}` → `mapping.apply` 恒 `object_not_mapped` → 全部 skipped。**「客户/线索/商机/合同/产品/报价」6 类均未声明** | P0 |
| **回写未接线** | `engine.js:38` `if (allowWriteback && typeof callWriteback === 'function')`；生产两处装配（`timers.js:494-500` deps、`connectorRouter.js:65-77` deps）**均未传 `callWriteback`**；且 `handleObjectChanged` 形参（`mount.js:173-176`）**根本不含 callWriteback** → `counts.writeback` 恒 0 | P0 |
| **回写 Action 不在 MCP 面** | `sync-writeback-fields`（`connectors/connectorActions.js:158`）由 `seedConnectorActions()` 注册，该函数只在 `routes.js:616`（app 进程）调用；而 `src/mcp/server.js:26 buildMcpTools()` 只执行 `seedActions()+seedDiscoveryActions()`（`tools.js:57`）→ **独立 MCP 进程（3001 / 生产 /mcp）工具面无此工具** → 「办公智能体经 MCP 交互后写回」链路断 | P0 |
| **真实 provider 零数据** | 运行态：`crm.sync_cursor` 11 行、`crm.external_ref` 26 行，`provider` **全部 = `'mock'`**，`tenant_id` **全部 = `smoke-sync` / `smoke-line-a-*`** | P0 |

**真实数据面仅 1 条**：`src/sync/factory.js:31-51` `createGenericRestSyncProvider` 真 `fetch(endpoint?object=..&updated_at=..)` —— 自研/套装 CRM 可走此路，但需 descriptor + 凭据（均未配置）。

---

## 5. 假绿清单（本次审计最高价值产出）

| # | 假绿形态 | 位点 | 后果 |
|---|---|---|---|
| F1 | **占位代码写入 `status:'sent'`** | `signal/delivery/im.js:25-33` | 污染「防假绿」的 `crm.signal_delivery` 账本；一旦接线，微信未发也记已发 |
| F2 | **桩 provider 返回 `ok:true, rows:[]`** | `sync/fxiaoke.js:52-58` | `last_status='ok'` 假健康；「同步在跑」与「一条都没读到」不可区分 |
| F3 | **模块全绿但生产零接线** | `signal/delivery/index.js` 的 `createDeliveryRegistry` 仅被 `test/signal/delivery.test.js` 引用 | 测试通过 ≠ 投递可用；运行态 `signal_delivery` 0 行 |
| F4 | **清单驱动遗漏（第三次同类陷阱）** | `mcp/tools.js:57` `buildMcpTools` 只 seed 两族，漏 `seedConnectorActions/seedProspectingActions`(后者已并入 seedActions) | MCP 工具面静默缺 `sync-writeback-fields` 等；`tools.js:47-56` 注释已记录同族事故，属复发 |
| F5 | **配置无种子 → 能力静默降级为 no-op** | `loadTenantSyncTargets`（`mount.js:102`）catch → `[]`；`loadSyncMappings`（`:66`）catch → `{}` | 环境未播种即「无目标、无映射」，零报错零日志 |
| F6 | **孤儿模块（声明枚举无写入方）** | `particles/interactionIndex.js:6` | 渠道枚举看似齐备，实际无任何数据源填充 |

---

## 6. 建议（未获批准不进入实施）

### P0（闭环断点）

> **✅ 2026-09-16 全部闭环**（用户批准；实施计划 `docs/superpowers/plans/2026-09-16-p0-closure-fixes.md`）

| # | 状态 | 落地证据（file:line） | 验证 |
|---|---|---|---|
| 1 | ✅ | `sync/writeback.js`(新) + `mount.js:176/205-215`(L3 分支) + `timers.js:489-505` + `connectorRouter.js:54-79` | `test/sync/writebackDispatcher.test.js` 8/8、`mountWriteback.test.js` 5/5 |
| 2 | ✅ | `fxiaoke.js:58-103`（真 `POST /cgi/crm/v2/data/query`；缺凭据 fail-closed）+ `engine.js:16-36`（尊重 `ok:false` → `last_status='failed'`） | `fxiaokeRead.test.js` 7/7、`engineReadFailure.test.js` 5/5 |
| 3 | ✅ | `db/migration-sync-config.sql`(新) + `migrate.js`（幂等播种块）+ `seed-test-config.mjs` `ensureSyncConfig()` | 真库直查：三键在 `crm_native` 就位（object/object/array）；幂等复跑 0 新增、总行数仍 3；`syncConfigTemplate.test.js` 5/5 |
| 4 | ✅ | `mcp/tools.js:8/56`（补 `seedConnectorActions()`） | `connectorToolsExposed.test.js` 3/3 |
| 5 | ✅ | `signal/delivery/im.js:25-40`（`sent` → `skipped` + `last_error='im_not_implemented'`） | `imDeliveryNoFalseGreen.test.js` 2/2 |

**未随 P0 闭环的红线（仍生效）**：
- 回写**不落客户侧 CRM**（provider 反向写需外部平台配合，属 S4）。本次交付「通道可达 + 可观测 + fail-closed」。
- 自动同步路径**不传 `approvalPassed`** → 回写被 executor 第 3 闸拦（`approval_required`），计入 `writeback_error`。仅配置 `sync-trust.writeback_auto_approved=true`（人工开启）才放行。
- 播种 ≠ 接通：`integration-providers` 样例 `enabled:false`；`writeback_fields_whitelist=[]`（拒绝一切回写）。

---

1. **补回写接线**：`timers.js` 与 `connectorRouter.js` 两处装配注入 `callWriteback`，并在 `handleObjectChanged` 形参补该依赖；否则 L3 永远不可达。（~20 行）
2. **provider 去桩或标注**：`fxiaoke.readIncremental` 改真实现，或在 descriptor 增加 `stub:true` 使 `last_status='stub'` 而非 `'ok'`（禁止桩返回 `ok:true` 假健康）。
3. **播种同步配置**：`sync-mappings`（客户/线索/商机/合同/产品/报价 6 类映射）+ `sync-trust` + `integration-providers` 模板，走无条件幂等播种点（对齐 `migration-lead-pool-config.sql` 范式）。
4. **补 MCP 装配**：`mcp/tools.js` 补 `seedConnectorActions()`，修复 F4 复发。
5. **im.js 去假绿**：占位分支禁止写 `status:'sent'`（改 `skipped` + `last_error:'not_implemented'`）。

### P1
6. **投递分发器接线**：在信号产生点（`alertSignalHook.js:21` persister / 四个 scanner）串联 `createDeliveryRegistry().deliver()`，使 `crm.signal_delivery` 有真实流水。
7. **拓客前台入口**：`discovery.html` 增加「输入邮箱/公司名称」表单 + 挂 `prospecting-lookup`；`lead-pool.html` 增加「退回公海」按钮挂 `crm-lead-return`。
8. **补齐缺失筛选**：`leadership_change` / 新战略 增加数据源适配器或明确剔除该主张。

### P2
9. **日历能力**：若确需「建立日历」，需新设计（ICS 生成或 CalDAV/OAuth 对接）——当前零实现。
10. **汇报/投标日期驱动**：新增 `signal-schedule` 规则（`report_due` / `tender_deadline`）。

---

## 7. 审计声明

- 本报告所有判定均有 `file:line` 锚点或运行库直查结果，未采信文档/注释/测试声称。
- 运行态证据取自 `crm_native`（本机开发库）；生产口径需经 `ssh -L 5432` 或 compose exec psql 复核。
- 审计为只读操作，未修改任何业务代码；唯一写入为本文档。临时探查脚本已删除。
- HARD-GATE：本报告 + 建议方案为审计合法终点，**未获确认不进入修复实施**。

---

## 8. P0 实施后回归：既存红归因（2026-09-16 补记）

P0 实施后跑「`test/sync` + `test/signal` + `test/mcp` + `test/connectors` + `test/scheduler` + `external-integration`」共 **91 文件 / 613 用例**，结果 **4 文件 3 用例红**。**逐条归因后确认均与本次 P0 改动无关**（证据如下），但属真实缺陷，需另立任务。

> ⚠ **本节表格的归因已被 §8.1 的后续实测部分推翻，保留原文以存证。**
> 差异要点：`graph-query` 实为**并发伪失败**（单跑 3/3 绿）；`confirm-params-merge` 实为**测试期望过期**
> （生产早在 `7f3bea4` 已修，测试停在 `17c8faf`）；`anysiteRest` 实为**测试未隔离环境变量**
> （适配器守卫本身正确）；`route.test.js` 已被并行会话补齐。
> 以 §8.1 为准。

| 红 | 症状 | 归因证据 | 结论 |
|---|---|---|---|
| `test/signal/route.test.js` | 文件级 FAIL：`Cannot find module '../../src/signal/route.js'` | 该测试为 **untracked(`??`)**，引用不存在的 `route.js`（实际文件是 `router.js`）；`verify-release-source.mjs` 亦报同一缺失 | **他人未完成的新测试**，非本会话产物 |
| `test/mcp/graph-query.test.js` | `missing_context: 维度缺失 identity`（`decisionRepo.js:204`） | **AB 实验**：临时回退 `seedConnectorActions()` 后**依然红** → 与 P0-4 无关。根因在 `LEAD_FOLLOW_UP` 场景的 `required_dims` 校验 | 既存红（决策场景配置） |
| `test/mcp/confirm-params-merge.test.js` | 协议位键未剔除（`params` 多了键） | 纯函数测试，仅依赖 `gateway.js`/`seed-actions.js`/`issueToken.js`——**均未改动**；AB 实验同样红 | 既存红（⚠ 疑与 `tools.js protocolShape` 扩展后 gateway 协议位键白名单未同步同族——**清单驱动遗漏第 4 次复发嫌疑**，建议 P1 排查） |
| `test/connectors/discovery/anysiteRest.test.js` | 无凭据时返回 1 条数据而非空 | 仅依赖 `connectors/discovery/adapters/anysiteRest.js`（未改动） | 既存红（适配器内建样例数据未随凭据收口） |

**归因方法**：① 单文件隔离复跑排除并发伪失败（共享 `crm_native_test` 并发 TRUNCATE）；② 检查失败测试 import 图与本次改动文件集是否有交集；③ 对唯一有交集的 `graph-query`（import `tools.js`）执行 **AB 实验**（回退改动→复跑→仍红）。

**另发现（非本次范围，建议 P1/P2）**：
- `verify-release-source.mjs` 报 **2 处 `file:///D:/...` 绝对路径**（`scripts/tmp-debug-engine.mjs`、`test/monitor/syncMetrics.test.js`）——指向本仓工作树，干净树/CI 上会「测本机树」造成假绿（与本仓既有 18 处同族，此脚本已能报出）。
- `test/signal/followupRouter.js` 处于 `M`（未提交改动），与 `route.test.js` 同族，**属并行会话在途工作**——本次提交已刻意规避，不得混入。

### 8.1 L1（出口播种 / R-A）关闭证据与既存红重分类（2026-09-16 23:2x 实测）

#### 8.1.1 R-A 已关闭（由并行会话交付）

R-A「全库零租户配置过 `signal-delivery` → 泵上线即零投递空转」**已关闭**。交付面：
`db/migration-signal-config.sql`（登记于 `db/migrate.js` 的 `INCREMENTAL_SQL:52`）+ `readConfig` autoSeed 克隆到全部租户。

| 判据 | 实测读数（本地 `crm_native`） |
|---|---|
| `config_store['signal-delivery']` | **15 行**（`system` + 14 个业务租户，随新租户出现持续增长） |
| `config_store['signal-dispatch']` | 1 行（`system`，`max_age_days:7`） |
| `crm.signal_delivery` | **1051 行，全部 `inbox/sent`**（此前恒 0 行） |
| `createExportGate().isExportHealthy({tenantId:'system'})` | `healthy:true`，三项 checks 全 `true` |

复现命令见实施计划 `docs/superpowers/plans/2026-09-16-signal-calendar-ics-and-date-rules.md` Task 1 Step 1。
⇒ 本报告 §8 中「投递分发器生产接线（`signal_delivery` 仍 0 行）」一项**状态由「未闭合」改为「已闭合」**。

**唯一遗留裁决（非缺陷）**：`email` 渠道出厂默认值。交付面按 `email:'off'` 播种；审计过程中用户另作
「`email:'on'` 且写收件人」裁决（较交付面更宽）。**落地前实测其外发量级**：

| 实测项 | 读数 |
|---|---|
| 有邮箱的用户 | 仅 **1** 个：`tenant=system` / `username=admin` / `role=admin` |
| open 信号 `target_role` 分布 | `sales` 1011、`ops` 39、`finance` 1 |
| 面向 `admin` 的信号数 | **0** |

⇒ 按 role 聚合真邮箱所得 `role_recipients` 只含键 `admin`，与全部信号角色不匹配 →
**实际外发量 = 0**（全部落 `skipped/no_recipient`，属真实读数）。
另注：判据 A 谓词为 `COUNT(*) GROUP BY channel`（**零行**才告警），故 `email` 全落 skipped 仍不触发；
该渠道开关**不会**锁死 `exportGate`（判据① 只要求窗口内存在 `sent`，由 `inbox` 提供）。

#### 8.1.2 既存红重分类（取代 §8 表格的归因）

| 项 | §8 原归因 | **§8.1 实测归因** | 处置 |
|---|---|---|---|
| `test/signal/route.test.js` | 他人未完成的测试 | 已被并行会话补齐（`route.js` 已存在并绿） | **非我方项，不碰** |
| `test/mcp/graph-query.test.js` | 决策场景 `required_dims` 缺失 | **单独跑 3/3 绿**；两次批量失败的**文件集合不同** | **并发伪失败**（共享测试库竞态）→ 按 `shared-db-test-hygiene` 取批内稳定证据 |
| `test/mcp/confirm-params-merge.test.js` | 清单驱动遗漏嫌疑 | 生产已在 `7f3bea4` 把 `force` 移出协议位（`gateway.js:22-24` 有决策注释），测试期望停在 `17c8faf` | **测试期望过期**，改测试、零生产改动 |
| `test/connectors/discovery/anysiteRest.test.js` | 适配器内建样例数据未收口 | `anysite.js:101` 的 `if (!key) return []` **正确**；根因是 `src/db.js:8 dotenv.config()` 把 `.env` 真 `ANY_SITE_KEY` 注入测试进程（探针实测 `envKey:true`） | **测试未隔离环境变量** → `vi.stubEnv` + 零 fetch 断言 + 变异验证 |
| `test/mcp-tenant.test.js` M1 | 未提及 | **新发现**：单跑即红、**15,016ms** 打满超时（`1e8bb9a` 已放宽至 15s 仍无效） | **真实缺陷** → 归因阻塞点（禁以放宽阈值了结） |

**新增判据（已入长期记忆）**：`src/db.js:8` 的 `dotenv.config()` 会把 `.env` 真键注入测试进程，
使「无凭据 / fail-closed 返回空」类测试**假红或假绿不可信**；**同一根因也会骗过诊断**——
用 `node -e` 探 `process.env.SMTP_*` 得 false，而实际 `.env` 持有真实 SMTP 凭据（本报告上一轮据此得出的
「SMTP 未配置」结论即为该误判，已更正）。

