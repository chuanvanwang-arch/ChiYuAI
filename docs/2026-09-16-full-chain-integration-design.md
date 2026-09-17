# 全链集成设计：信号出口接电 + 现有 CRM 接线 + 运行时顺序闸门

> **版本** v1.1（FINAL，唯一有效设计）｜ **日期** 2026-09-16 ｜ **状态**：✅ **已批准**（2026-09-16 用户批准；批准范围 = §1 三段式 15 任务 + §0.4 对最终设计 §14.2 的修正）
> **v1.1 变更**（2026-09-16，计划期发现 → 用户裁决）：新增 §3.1.1「泵范围与有界性」修正 D1（**泵须含 `system` 平台租户**，用户选定方案 A）与 D2（**候选集加时间窗**，模型保守裁决）；连带改 §3.2 / §1 / §4（Q1-1、Q1-2 的 `success`）/ §5.1 / §5.2（N8、N9）。**完整改动清单见 §8.3。契约的 `contract_task_id` / `agent` / `skills` / `memory` / `knowledge_scope` 一律未变。**
> **性质**：实施级设计。**批准后唯一入口为 `writing-plans`**（§8）。批准前不写实现代码的 HARD-GATE **现已解除**——可进入实施计划。
> **前序权威**：`docs/2026-09-15-final-design-coexistence-and-proactive.md`（FINAL v1.0，2026-09-16 已批准）。
> **本设计的性质**：**不含任何新能力**。全部工作是把「已交付但未被生产触发点驱动」的模块接上电。这不是加功能，是**接线**。
> **对最终设计的关系**：本设计**修正**最终设计 §14.2 的实施顺序表述（修正理由与替代机制见 §0.4），其余 §15 红线 11 条**全部继承，无一放宽**。

---

## §0 结论先行

### 0.1 一条最重要的判断

> **截图上那四条红色告警是真的，而它暴露的不是一个 bug，是同一个元缺陷在更深一层的重演。**

最终设计 §0.2 曾点破病灶：`alertEndpoints.js` 文件头自述「等挂载方统一 add」——**挂载方一直没来**。

S1 交付后，这个模式**下沉了一层**：

| 层级 | 模块 | 生产调用点 | 判定 |
| --- | --- | --- | --- |
| 第一层（最终设计 §0.2 已修） | `alertEndpoints` / `registerAlertHook` | 已在 S1 挂载 | ✅ 已闭合 |
| **第二层（本次发现）** | `createDeliveryRegistry`（投递 provider + 分发器） | **0** —— 仅出现在定义处与单元测试 | 🔴 **未闭合** |

即：**S1 造好了水管（四渠道 provider），但没有造水泵（编排层），也没有人开水泵。** S1 计划 `docs/superpowers/plans/2026-09-16-proactive-s1-delivery.md` 的 9 个 Task 中，**没有任何一个是「编排 / 驱动」**——它只交付了 `deliver()` 这个**方法**，未交付调用它的**进程**。

### 0.2 起点诊断：三层断链（全部源码级实证）

**第 1 层 · 出口编排层不存在**

| 判据 | 命令 | 结果 |
| --- | --- | --- |
| 生产调用点 | `grep -rn "createDeliveryRegistry" src/` | **0**（仅 `src/signal/delivery/index.js:10` 定义） |
| 测试调用点 | `grep -rn "createDeliveryRegistry" test/` | 7（`test/signal/delivery.test.js`） |
| S1 计划是否含编排任务 | `grep -n "^## Task" docs/superpowers/plans/2026-09-16-proactive-s1-delivery.md` | 9 个 Task，**无编排/驱动** |

**第 2 层 · 「防假绿判据」自身携带假前提**（比第 1 层危险，因为它让防护机制失效）

```js
// src/monitor/signalMetrics.js:11
const DEFAULT_CHANNELS = ['inbox', 'email', 'im', 'webhook'];
// src/monitor/signalMetrics.js:73
export async function detectNegativePredicates({ tenantId, since, enabledChannels = DEFAULT_CHANNELS })
```

而定时器⑯ 调用 `createSignalObservabilitySweep()` 时**未传 `enabledChannels`**（`src/scheduler/timers.js:604`）。

后果：**无论租户真实配置如何，四个渠道一律被判为「已开启」。** 面板上「渠道『email』已开启」这句话，不是读取 `config_store['signal-delivery'].channels` 的结果，而是**判据硬编码注入的断言**。也就是说：一个用来防假绿的判据，自己制造了一条假前提。

**第 3 层 · 与现有 CRM 的集成（线 A）全线未接线**

| # | 项 | 状态 | 复跑判据 |
| - | -- | ---- | -------- |
| E1-1 | 挂载层 `src/sync/mount.js` | 🟡 模块已建、**未接线** | `grep -rn "sync/mount\|runTenantSyncOnce" src/scheduler/timers.js src/http/connectorRouter.js` → 0 |
| E1-2 | `integration-poll` 增量拉取分支 | ❌ 未接（`runIntegrationPollOnce` 仍只跑 `runWaterfall` + `monitorAccount`） | `grep -n "runTenantSyncOnce" src/scheduler/timers.js` → 0 |
| E1-3 | 对象变化事件路由 | ❌ 未接（webhook 分支派发 `conn-signal-lead-gen`，非 sync 内核） | `grep -n "handleObjectChanged" src/http/connectorRouter.js` → 0 |
| E1-4 | 端到端证据 | ❌ 无 | `crm.sync_cursor` 无 `last_status='ok'` 行 |
| A-B1 | `integration-providers` 扩 `objects[]`/`token_mode`/`trust_level` | ❌ 未实现 | `grep -n "objects\|token_mode\|trust_level" src/connectors/discovery/tenantInstances.js` → 0 |
| A-B2 | `credentialVault` 结构化凭据 | ❌ 未实现 | `grep -n "JSON.parse\|appId\|permanentCode" src/connectors/discovery/credentialVault.js` → 0 |

**第 3.5 层 · 配置面零消费**（三个新发现的零命中）

| 配置键 / 字段（最终设计 §9.4 已定义） | `src/` 命中数 | 含义 |
| --- | --- | --- |
| `signal-delivery` | **0** | 渠道开关 / 路由 / 收件人 / 频次 / 静默时段**全部未被消费** |
| `role_recipients` | **0** | 收件人解析**不存在** |
| `rate_limit` | **0** | 频次闸**不存在** |
| `signal-digest` | **0** | 每日简报未被驱动 |

### 0.3 与 ROX / Attio / Lightfield 的对照结论

仓库已有 `docs/2026-09-16-competitive-learning-plan.md`（用户已确认），其 §1–§3 的事实基线与红线**本设计全部继承、不重复**。本节只补充**对本问题唯一要命的推论**：

> **三家没有一家是靠「多接几个投递渠道」解决「提醒发不出去」的。**
>
> | 家 | 真正的机制 | 对本问题的启示 |
> | -- | ---------- | -------------- |
> | ROX | Inbox 是统一行动中心；**之所以不空**，是因为有一个「优先级排序器 + 收件人解析器」**直接消费 CRM 的对象状态** | 投递的前置是**消费端契约**，不是传输通道 |
> | Attio | 工程护城河 = MCP 37 工具 + OAuth 继承用户权限 + **分工作区限速** | **限速是一等公民**，不是可选优化 |
> | Lightfield | 护城河 = agentic CSV import / replacement agent（**迁移成本 = 切换成本**） | 入口能力决定天花板；同步是产品而非脚本 |
>
> **共同点**：**投递必须先有「消费端契约」，再有「传输通道」。我方当前恰好只有通道、没有消费端。**
> 因此本设计的重心不在「加渠道」，而在**补消费端（编排 + 路由 + 收件人 + 限速）**与**补入口（接线 + 通用通道）**。

### 0.4 ⚠ 对最终设计 §14.2 的正式修正（顺序纪律 → 运行时闸门）

最终设计 §14.2 规定：

> 「**客户价值排序 ≠ 实施顺序**……在链路断裂且无投递观测时放开自动写＝把假绿放大成真错。」

用户本次选择的**方案 C（一次全链贯通）**与该表述**表面上冲突**。本节按最终设计 §D.4 维护约定处理（该约定要求：突破设计表述须先改设计并走 `brainstorming`——本次即该路径），并给出**不牺牲安全初衷的替代机制**：

| 维度 | §14.2 原表述 | 本设计（v1.0 修正） |
| --- | --- | --- |
| 顺序纪律的载体 | **排期**（先做 S1，再做 S2/S4） | **运行时闸门**（`exportGate`，fail-closed） |
| 交付批次 | 分批 | **同批交付**（Q1/Q2/Q3 并行开发） |
| 危险动作的放行条件 | 隐含于「还没做到」 | **显式判据**：出口判据 ① 成立（见 §5）才允许回写与自治启用 |
| 未满足条件时的行为 | 功能尚未存在 | 功能存在但 **`blocked_by_export_gate`**，并 emit trace |

**判据的等价性论证**：§14.2 想防的是「没有投递观测就放开自动写」。排期只是达成它的一种手段；**运行时闸门是达成同一目标的更严格手段**——因为闸门在生产环境**持续生效**，而排期纪律在交付完成后即失效。故本修正**不是放宽，是收紧**。

> **⚠ 表述红线（继承 §0.5）**：闸门未投产前，**不得**对外表述「顺序纪律已由运行时保障」。

### 0.5 目标 / 非目标 / 硬约束

**目标**
1. **出口**：任一 `crm.signal` 都能在 `crm.signal_delivery` 找到对应 `sent` / `failed` / `skipped` 行；渠道集合来自 `config_store`。
2. **判据**：`detectNegativePredicates` 的启用渠道集合来自真实配置，消除假前提。
3. **入口**：`generic-rest` 通道端到端跑通，`crm.sync_cursor` 出现 `last_status='ok'` 行。
4. **回写**：`sync-writeback-fields` Action 在有生产调用者且受 `exportGate` 约束。

**非目标（明确不做）**
- ❌ 不新增粒子类型、不改业务域模型（继承最终设计 §15.1 #2）。
- ❌ 不做「完整双向同步」（继承 §15.2 #6）。
- ❌ 不做**产品专属适配器**（本批次只 `generic-rest` 一个实现，R3）。⚠ 2026-09-17 用户扩范围：Salesforce / 销售易 / 纷享逍客 三家**已接入**，但**以 `generic-rest` 的纯数据预设**形式（`src/sync/presets/*.js`），非产品专属代码；真实租户凭据/对象待接入方提供（Q2-5）。
- ❌ 不做 Voice Mode / Artifacts 等形态项（P2 观察清单，不立项）。

**硬约束（不可偏离）**
- 零 `DELETE`；所有状态变更走状态字段。
- 全部查询带 `tenant_id`；跨租户零可见。
- 写操作过决策第 0 闸 + 审计。
- 全部配置 per-tenant 走 `readConfig` / `writeConfig`（`src/config/configStore.js`），**零硬编码**。
- 不新增投递渠道种类（仍是 inbox / email / im / webhook 四渠道）。

---

## §1 三段式方案

### 1.1 Q1｜出口接电（P0，截图的直接修复）

| # | 交付物 | 职责 | 关键判据 |
| -- | ------ | ---- | -------- |
| Q1-1 | `src/signal/dispatcher.js`（新建） | **投递编排器（水泵）**：泵出 `crm.signal` 中 `status='open'` 且落于时间窗内的行，逐渠道调 `deliver()`；**泵范围含 `system` 平台租户（D1）**；幂等键 `signal_id + channel`；失败重试 `attempts ≤ config.retry` | 同一条 signal 二次泵不产生重复 `sent` 行；`tenant_id='system'` 的信号同样被泵（不得静默排除） |
| Q1-2 | `src/signal/route.js`（新建） | **消费端契约**：读 `config_store['signal-delivery']` → 真实 `channels{}` / `route{severity→渠道}` / `role_recipients`（**含 `platform` 回退，D1**） / `quiet_hours` / `rate_limit` | 配置为 `off` 的渠道零投递行；`role_recipients` 解析出真实收件人；`system` 租户回退 `role_recipients.platform`，缺失则 `no_recipient` |
| Q1-3 | `src/scheduler/timers.js`（修改） | 注册定时器⑰ `signal-dispatch`（默认 5 分钟，`SIGNAL_DISPATCH_MS` 可覆盖），`EXPECTED_TIMERS` 16 → **17** | `timers.test.js` EXPECTED_TIMERS=17 通过 |
| Q1-4 | `src/monitor/signalMetrics.js`（修改） | **修正假前提**：`enabledChannels` 改为从 `config_store['signal-delivery'].channels` 读取；**读不到配置时视为「全部关闭」并 emit trace**（而非默认全开） | 租户未配置 → 判据不触发且 trace 有记录；配置只开 `inbox` → 只对 `inbox` 判据 |
| Q1-5 | 真库端到端验收 | `crm.signal_delivery` 出现真实 `sent` 行（非测试） | 判据 ① 成立（见 §5） |

### 1.2 Q2｜入口接线（P1，与现有 CRM 打通）

| # | 交付物 | 职责 | 关键判据 |
| -- | ------ | ---- | -------- |
| Q2-1 | `src/scheduler/timers.js`（修改） | `integration-poll` 增对象增量拉取分支，调用 `mount.runTenantSyncOnce()`（E1-2 接线） | `grep -n "runTenantSyncOnce" src/scheduler/timers.js` ≥ 1 |
| Q2-2 | `src/http/connectorRouter.js`（修改） | webhook 分支增对象变化事件路由，调用 `mount.handleObjectChanged()`（E1-3 接线） | `grep -n "handleObjectChanged" src/http/connectorRouter.js` ≥ 1 |
| Q2-3 | `src/connectors/discovery/tenantInstances.js`（修改） | A-B1：`integration-providers` 描述符扩 `objects[]` / `token_mode` / `trust_level` | 三个字段 grep 命中 |
| Q2-4 | `src/connectors/discovery/credentialVault.js`（修改） | A-B2：支持结构化凭据（`appId` / `appSecret` / `permanentCode` / `token` 等），仍 fail-closed | 结构化凭据可读写且不明文落日志 |
| Q2-5 | `src/sync/factory.js` + provider（修改/新建） | `generic-rest` 端到端：`verifyAuth` / `discoverObjects` / `readIncremental` 三方法可用 | 判据 ② 成立（见 §5） |

> **实施状态（2026-09-16 17:10 复核，逐条复跑判据，非快照）**
>
> | # | 复跑判据 | 结果 |
> | -- | -------- | ---- |
> | Q2-1 | `grep -n "runTenantSyncOnce" src/scheduler/timers.js` | ✅ 命中 1（`:494`，缺省装配注入 `mount.runTenantSyncOnce`）；`test/external-integration.test.js` A-B6 段 6 例 |
> | Q2-2 | `grep -n "handleObjectChanged" src/http/connectorRouter.js` | ✅ 命中 1（`:58`）；`conn-signal-lead-gen` 分支零回归（A-B5 段含"不带 `event.object` → 保持既有线索派发"用例） |
> | Q2-3 | `grep -rln "providerDescriptor.js" src/` | ✅ 命中 3（归一化模块 + `tenantInstances.js` + `sync/mount.js`，**两侧共用同一判据**）；旧描述符（`field_map`/`signal_map`、无 `token_mode`）仍可加载 → 向后兼容判据成立；`providerDescriptor.test.js` 13 例 |
> | Q2-4 | `grep -c "parseCredentialPayload\|persistToken" src/connectors/discovery/credentialVault.js` | ✅ 命中 5；三条判据各有断言：① 写入并读回（`persistSecret(object)` / `readToken` 往返）② **零日志出口**（静态守卫：模块内无 `console.*` / `emit(` / `logger`；负向对照防恒真）③ **缺字段 verifyAuth 返回 `ok:false` 而非抛**（fxiaoke 缺 appSecret、网络抛错、generic-rest 缺 endpoint/凭据 共 4 例） |
> | Q2-5 | `prospecting` 承接，本批次未动 | ⬜ 未实施 |
>
> **Q2-3 落点说明（与 §1.2 表的一致性）**：设计指定落点为 `tenantInstances.js`；实现把**归一化逻辑**放在新模块 `src/connectors/discovery/providerDescriptor.js`，由 `tenantInstances.js` 消费——满足"三字段可解析"且**避免 enrich / sync 两侧各写一套判据**（同族前例：A-B3 的两个同名 `KIND_FACTORY`）。`tenantInstances.js` 仍是该能力的**入口**，判据不变。
> **Q1 / Q3 未动**：Q1 出口接电与 Q3 回写+运行时闸门本批次均未实施（E.1 已登记"投递编排层缺失"由 Q1 承接）。


### 1.3 Q3｜回写与运行时闸门（P2）

| # | 交付物 | 职责 | 关键判据 |
| -- | ------ | ---- | -------- |
| Q3-1 | `src/sync/mapping.js`（修改） | 字段级白名单 + 字段级 CAS：`sync-mappings.fields[]` 未知字段一律拒绝；回写字段 ⊆ `sync-trust.writeback_fields_whitelist` | 未知字段被拒并计入 `skipped`，不报错不静默 |
| Q3-2 | `src/action/seed-actions.js` + 执行侧（修改） | `sync-writeback-fields` Action 接入生产调用者（E-③ 判据）；带 `static_on_write: {Source: 'crm-ai-native'}` | `grep -rn "sync-writeback-fields" src/ \| grep -v "seed-actions\|action/"` ≥ 1 |
| Q3-3 | `src/sync/exportGate.js`（新建） | **运行时顺序闸门**：回写与自治的启用前置 = 出口判据 ① 成立；不成立则返回 `blocked_by_export_gate` 并 emit trace（**fail-closed**） | 出口未健康 → 回写 Action 被拒且 trace 留痕 |
| Q3-4 | `config_store['standing-grants-policy']`（扩展） | 增 `require_export_healthy: true`，自治执行同样受闸门约束 | 闸门关时自主执行量为 0 |

### 1.4 交付与闸门的关系（本设计与 §14.2 的衔接）

```
同批开发 ────────────────────────────────────────────
  Q1 出口接电          Q2 入口接线          Q3 回写+闸门
      │                    │                    │
      └──────── 同批交付（一个发布批次）──────────┘
                           │
              ┌────────────▼─────────────┐
              │  exportGate（运行时闸门） │
              │  出口判据① 未成立 → 阻断   │
              └────────────┬─────────────┘
                           │
              Q3 回写与自治【存在但关闭】
```

> **要点**：危险动作（回写 / 自治）**代码同批就位**，但**默认不可用**，由 `exportGate` 在生产环境持续把关。这样既满足「一次贯通」，又比排期纪律**更严格**地守住 §14.2 的安全初衷。

---

## §2 数据与配置（零新表）

### 2.1 复用既有表（不新建）

| 表 | 用途 | 状态 |
| -- | ---- | ---- |
| `crm.signal` | 信号统一收口 | 已存在，174 行真实数据 |
| `crm.signal_delivery` | 投递流水（**防假绿核心**） | 已存在，0 行（本设计将其填满） |
| `crm.external_ref` | 外部引用映射 | 已存在（线 A） |
| `crm.sync_cursor` | 同步运行留痕 | 已存在（线 A） |
| `crm.standing_grant` / `crm.grant_execution` | 常驻授权与执行流水 | 已存在（S6） |

> **结论**：**本设计零新表、零新粒子类型**。这从根本上规避了「新增粒子类型」红线。

### 2.2 配置键（复用 2 个 + 扩展 1 个）

| 键 | 动作 | 本设计新增字段 |
| -- | ---- | -------------- |
| `signal-delivery` | **首次消费**（此前零命中） | 无新增字段，按最终设计 §9.4 既有结构落地 |
| `standing-grants-policy` | 扩展 | `require_export_healthy: true` |
| `integration-providers` | 扩展 | `objects[]` / `token_mode` / `trust_level`（A-B1） |

---

## §3 关键机制设计

### 3.1 投递编排器（幂等 + 重试 + 熔断）

```
定时器⑰（每 5 分钟）
  → 候选租户集 = SELECT DISTINCT tenant_id FROM crm.signal
                   WHERE status='open' AND created_at >= now() - $window
        （**含 `system` 平台租户** —— 见 §3.1.1，不得静默排除）
  → 对每个 tenant：
      SELECT crm.signal WHERE status='open' AND tenant_id=$1 AND created_at >= now() - $window
  → 对每条 signal：
      route.js 计算 {channels, recipients}（读 config_store）
      → 频次闸（rate_limit.per_hour / per_day）
      → 静默时段闸（quiet_hours）
      → 对每个 channel：dispatcher.deliver()
           ├ 幂等检查：signal_delivery 是否已有该 (signal_id, channel) 的终态行
           │            已有 sent → 跳过；已有 failed 且 attempts < retry → 重试
           └ 调 deliveryRegistry.deliver() → 落 sent / failed / skipped
  → 失败累计超阈值 → emit trace + monitor_event（不静默）
```

**幂等键**：`signal_id + channel`（重试不改键，只增 `attempts`）。
**不静默纪律**：`skipped` 必带 `last_error`（如 `quiet_hours` / `rate_limited`）——继承最终设计 §10.2 判据。

#### 3.1.1 泵范围与有界性（设计修正 D1 / D2，2026-09-16 计划期发现）

计划期对 Q1-1 的候选集逐字核验，发现两处会导致「泵上线但红框不消失」的缺陷，现予以修正：

| 编号 | 缺陷 | 修正 | 依据 |
| --- | --- | --- | --- |
| **D1** | 初稿 `pumpAllTenants` 的租户选择器为 `... AND tenant_id <> 'system'`，而定时器只调 `pumpAllTenants` → **平台租户的信号永不被泵**，平台级告警继续静默 | **泵范围含 `system`**；收件人按 §3.2 回退到 `role_recipients.platform` | 判据① 须在 `system` 口径下同样成立，否则「全链集成」在平台口径下为假绿 |
| **D2** | `crm.signal.status` 投递后**不迁移**（仍是 `open`），泵候选集随时间为单调增长；幂等由 `signal_delivery` 去重保证（正确但**不有界**） | 加**时间窗** `created_at >= now() - $window`，默认 7 天，`config_store['signal-dispatch'].max_age_days` 可覆盖 | 见下方取舍 |

**D2 的取舍（为何加窗口而不加终端标记）**：

- **备选 1（选中）· 时间窗**：零 DDL、不改 `crm.signal` 状态机语义、与既有 `S_STAGES` / `isOpenStage` 判据零冲突；代价是「超过窗口仍未投递的信号」不再重试——但**这是显式可见的**（窗口外 signal 仍留在 `status='open'`，可被巡检看到），而非静默丢弃。
- **备选 2（否决）· 在 `crm.signal` 加 `delivered_at` / 状态迁移**：需改表 + 迁移 + 全部 `status='open'` 读取点复评（本仓铁律：**配置/状态表加语义前须先 grep 全部读取点并逐个决定过滤与否**）——一次改动 15 个读取点，收益仅是候选集更小。**风险显著高于收益**，且与 §1「本段不新增粒子类型、不改业务域模型」的约束精神相悖。

> **红线**：**不得因为「窗口外」而删除或迁移 `crm.signal` 行**（本仓绝对禁 DELETE）。窗口只影响**泵的候选集**，不影响留痕。

### 3.2 收件人解析（`role_recipients`）

```
signal.target_role + signal.owner_id
  → config_store['signal-delivery'].role_recipients{ role → [用户] }
  → owner_id 优先（若 signal 有归属人）
  → 解析出 { user_id, email, im_webhook }
  → 解析不到 → status='skipped' + last_error='no_recipient'（不静默、不假绿）
```

**平台租户（`tenant_id='system'`）的收件人回退（设计修正 D1 的配套）**：

```
signal.tenant_id === 'system'
  → 优先按 target_role 解析（与业务租户同路径）
  → 解析不到 → 回退 role_recipients.platform
  → platform 键缺失 → 仍走 skipped + last_error='no_recipient'
```

> **两点纪律**：
> ① **`system` 不享有投递豁免**——不得因为「平台信号没有明确收件人」而跳过投递判定；缺失收件人必须留 `skipped` 行。
> ② **不得硬编码平台收件人**（如把运维邮箱写进代码）——一切收件人来自 `config_store`，继承本仓「阈值/差异化 100% 后台配置化」铁律。

> **判据**：**解析不到收件人必须留 `skipped` 行**，否则「投递失败」会伪装成「没信号」，形成假绿。

### 3.3 假绿判据修正（本设计最容易被忽略、但最重要的一项）

```js
// 修正前（假前提）
export async function detectNegativePredicates({ tenantId, since, enabledChannels = DEFAULT_CHANNELS })

// 修正后（真前提）
const cfg = await readConfig('signal-delivery', { tenantId });
if (!cfg || !cfg.channels) {
  emit('trace', 'signal-observability-config-missing', { tenant_id: tenantId });
  return [];                       // 读不到配置 → 不判（并留痕），而非默认全开
}
const enabledChannels = Object.entries(cfg.channels)
  .filter(([, v]) => v === 'on' || v === true)
  .map(([k]) => k);
```

**为什么这是「最重要」**：本设计修的是**仪表**，不是**管道**。若只接水泵、不修仪表，运维会看到「全绿」而实际链路仍断——**这正是本项目一贯最忌讳的假绿**。

### 3.4 运行时顺序闸门 `exportGate`（§0.4 的落地形式）

```
exportGate.isExportHealthy({ tenantId }) 判定式：
  ① crm.signal_delivery 存在 status='sent' 行（窗口内）
  ② 渠道集合来自 config_store（非硬编码）
  ③ crm.signal_delivery 无「配置为 on 但零投递行」的渠道（复用 §3.3 修正后的判据）
三者全真 → healthy；否则 blocked
```

**接入点**：
- `sync-writeback-fields` Action 入口（回写）
- `standing-grants-policy` 的自治放行判定

**fail-closed**：`isExportHealthy` 抛错 → 视为 **blocked**（不是 healthy）。

---

## §4 生命契约（15 任务，覆盖全部 7 个名册 agent）

> **字段语义**：见 `brainstorming` SKILL §A。`contract_task_id` **必填**，值须等于 `src/agent/contractIds.js` 的 `CONTRACT_IDS[agent]`。
> **校验命令（P7 强制，已执行）**：
>
> ```bash
> node scripts/validate-contract.mjs docs/2026-09-16-full-chain-integration-design.md --registry src/agent/agentSpec.js
> ```
>
> **覆盖断言（双向）**：本设计覆盖 **7 个**登记 agent，故必须**全覆盖**——下文 15 个契约块对应 7 个 agent，无一遗漏。

### Q1｜出口接电

#### Q1-1 投递编排器（水泵）

```contract-yaml
- task: "Q1-1 新建 src/signal/dispatcher.js 投递编排器（泵 open signal → 逐渠道 deliver，幂等 + 重试）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read, method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "对同一批 open signal 连跑两次 pumpOnce，crm.signal_delivery 的 (signal_id,channel) 终态行数不增；failed 行 attempts 随重试递增且上限不超过 config.retry；泵候选租户集含 tenant_id='system'（平台信号不得被静默排除，D1）"
```

**契约说明：** 本任务由 `followup-agent` 承接（提醒投递 = 跟进同源职责），调用 `data-particle-read` 与 `method-followup-engine`、读 `followup-agent` 记忆（L1，≤2 跳）；成功标准为编排器**幂等**且重试不越界。

#### Q1-2 路由与收件人解析

```contract-yaml
- task: "Q1-2 新建 src/signal/route.js 消费 signal-delivery 配置（channels/route/role_recipients/quiet_hours/rate_limit）"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "配置 channels.im=off 时 route 返回的渠道集合不含 im；role_recipients 解析不到收件人时返回 skipped 原因 no_recipient 而非空集合；system 租户业务角色解析不到时回退 role_recipients.platform，该键缺失仍返回 no_recipient（D1 配套）"
```

**契约说明：** 本任务由 `followup-agent` 承接，调用 `data-particle-read`、读 `followup-agent` 记忆（L1）；成功标准为**渠道集合来自真实配置**、收件人解析失败**显式留因**（不静默）。

#### Q1-3 定时器⑰ signal-dispatch

```contract-yaml
- task: "Q1-3 注册定时器⑰ signal-dispatch（SIGNAL_DISPATCH_MS，默认 5 分钟），EXPECTED_TIMERS 16→17"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "timers.test.js 的 EXPECTED_TIMERS 为 17 且定时器清单含 signal-dispatch；VITEST 护栏下该定时器不执行 dispatch"
```

**契约说明：** 本任务由 `followup-agent` 承接，调用 `method-followup-engine`、读 `followup-agent` 记忆（L1）；成功标准为定时器登记数从 16 增至 17，且测试环境护栏生效。

#### Q1-4 假绿判据修正（enabledChannels 读真实配置）

```contract-yaml
- task: "Q1-4 修正 detectNegativePredicates 的 enabledChannels——从 config_store['signal-delivery'] 读取，读不到则视为全关并 emit trace"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "租户无 signal-delivery 配置时 detectNegativePredicates 返回空数组且存在 signal-observability-config-missing trace；配置仅开 inbox 时只产生 inbox 的 delivery_silent"
```

**契约说明：** 本任务由 `decision-retro` 承接（判据自身失真是「校准」问题，非功能问题），调用 `decision-retrospective`、读 `decision-retro` 记忆（L1）；成功标准为**判据不再携带假前提**——这是防假绿机制自身的修复。

#### Q1-5 出口真库端到端验收

```contract-yaml
- task: "Q1-5 出口端到端验收：真库跑通 signal → 投递 → crm.signal_delivery 出现真实 sent 行"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [data-particle-read, method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "本地真库 crm.signal_delivery 存在 status='sent' 且 delivered_at 非空的行；同窗口 detectNegativePredicates 对已投递渠道不再触发"
```

**契约说明：** 本任务由 `followup-agent` 承接，调用 `data-particle-read` 与 `method-followup-engine`、读 `followup-agent` 记忆（L1）；成功标准为**判据 ① 真实成立**（这是 §0.4 闸门的放行前提）。

### Q2｜入口接线

#### Q2-1 integration-poll 增量拉取接线

```contract-yaml
- task: "Q2-1 integration-poll 增对象增量拉取分支，调用 mount.runTenantSyncOnce（E1-2 接线）"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing, data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "src/scheduler/timers.js 中 runTenantSyncOnce 命中数大于等于 1；开启该分支后 crm.sync_cursor 产生一行新记录"
```

**契约说明：** 本任务由 `intake-router` 承接（数据进入 = 接诊同源职责），调用 `method-intake-routing` 与 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为**挂载方终于来了**——模块从「已建」变为「可触发」。

#### Q2-2 对象变化事件路由接线

```contract-yaml
- task: "Q2-2 connectorRouter webhook 分支增对象变化事件路由，调用 mount.handleObjectChanged（E1-3 接线）"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing, data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "src/http/connectorRouter.js 中 handleObjectChanged 命中数大于等于 1；既有 conn-signal-lead-gen 分支行为不变（向后兼容）"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing` 与 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为事件路由接通**且既有分支零回归**。

#### Q2-3 A-B1 描述符扩展

```contract-yaml
- task: "Q2-3 integration-providers 描述符扩 objects[] / token_mode / trust_level（A-B1）"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "tenantInstances.js 中 objects、token_mode、trust_level 三字段均可解析；缺 token_mode 的旧描述符仍可加载（向后兼容）"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1）；成功标准为三字段落地且**旧配置不被破坏**。

#### Q2-4 A-B2 结构化凭据

```contract-yaml
- task: "Q2-4 credentialVault 支持结构化凭据（appId/appSecret/permanentCode），仍 fail-closed"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing, data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "结构化凭据可写入并按 key 读回；凭据内容不出现在任何日志或 trace 载荷中；缺字段时 verifyAuth 返回失败而非抛出"
```

**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing` 与 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为**结构化凭据可用且零明文外泄**。

#### Q2-5 generic-rest 通道端到端

```contract-yaml
- task: "Q2-5 generic-rest provider 端到端（verifyAuth / discoverObjects / readIncremental）"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-search, prospecting-lookup, data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "对 mock 通用 REST 端点：verifyAuth 返回 ok；discoverObjects 返回对象清单；readIncremental 按 since 游标拉取且二次调用不重复入库"
```

**契约说明：** 本任务由 `prospecting` 承接（**外部对象发现** = 拓客发现同源职责），调用 `prospecting-search` / `prospecting-lookup` / `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为**判据 ② 成立**（增量拉取幂等）。

### Q3｜回写与运行时闸门

#### Q3-1 字段级白名单与 CAS

```contract-yaml
- task: "Q3-1 sync-mappings 字段级白名单 + 字段级 CAS；未知字段一律拒绝"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [data-particle-read, method-quote-engine]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "未在 mappings.fields 声明的外部字段被拒绝并计入 skipped；回写字段不属于 sync-trust.writeback_fields_whitelist 时被拒；CAS 不匹配时写入不生效且原值不变"
```

**契约说明：** 本任务由 `quote-engine` 承接（**字段级精度** = 报价字段精度同源职责），调用 `data-particle-read` 与 `method-quote-engine`、读 `quote-engine` 记忆（L1）；成功标准为**字段级越权被拒**且 CAS 语义正确。

#### Q3-2 回写 Action 生产接线

```contract-yaml
- task: "Q3-2 sync-writeback-fields Action 接入生产调用者（带 static_on_write 标记）"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "grep 判定 sync-writeback-fields 在 src/ 非 seed-actions 与 action/ 目录下命中数大于等于 1；回写请求带 Source=crm-ai-native 静态标记"
```

**契约说明：** 本任务由 `decision-agent` 承接（回写 = 决策执行同源职责），调用 `method-decision-execute` 与 `data-particle-read`、读 `decision-agent` 记忆（L1）；成功标准为回写 Action **有真实生产调用者**。

#### Q3-3 运行时顺序闸门 exportGate

```contract-yaml
- task: "Q3-3 新建 src/sync/exportGate.js 运行时顺序闸门（出口判据①不成立则 fail-closed 阻断回写）"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "crm.signal_delivery 窗口内无 sent 行时 isExportHealthy 返回 false 且回写 Action 返回 blocked_by_export_gate 并 emit trace；判据查询抛错时按 false 处理"
```

**契约说明：** 本任务由 `review-gate` 承接（闸门 = 评审同源职责），调用 `method-review-gate` 与 `data-particle-read`、读 `review-gate` 记忆（L1）；成功标准为**闸门 fail-closed**——这是 §0.4 替代 §14.2 排期纪律的机制本体。

#### Q3-4 自治前置闸门

```contract-yaml
- task: "Q3-4 standing-grants-policy 增 require_export_healthy，自治放行同受 exportGate 约束"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "require_export_healthy=true 且闸门关时 crm.grant_execution 零新增行；置 false 时行为与既有 S6 一致（向后兼容）"
```

**契约说明：** 本任务由 `review-gate` 承接，调用 `method-review-gate`、读 `review-gate` 记忆（L1）；成功标准为**自治也被闸门约束**，且默认关闭不破坏 S6 既有行为。

### Q4｜端到端验收

#### Q4-1 两条判据的端到端取证

```contract-yaml
- task: "Q4-1 两条集成判据的端到端取证 + sync HTTP 端点"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute, data-particle-read]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "判据①：crm.signal_delivery 真库存在 sent 行且 detectNegativePredicates 对已投递渠道不触发；判据②：crm.sync_cursor 存在 last_status='ok' 真实行且 crm.external_ref 存在真实外部 ID"
```

**契约说明：** 本任务由 `decision-agent` 承接，调用 `method-decision-execute` 与 `data-particle-read`、读 `decision-agent` 与 `review-gate` 记忆（L1，≤3 跳）；成功标准为**两条可复跑判据同时成立**——本设计以此判定「真正实现集成」。

---

## §5 验收标准（含负向判据）

### 5.1 两条正向判据（「真正实现集成」的定义）

**判据 ①（出口）**
```sql
SELECT channel, status, count(*) FROM crm.signal_delivery
 WHERE tenant_id = $1 AND created_at >= now() - interval '24 hours'
 GROUP BY 1,2;
```
**成立条件**：至少一行 `status='sent'` 且 `delivered_at IS NOT NULL`。
**且**：`config_store['signal-delivery'].channels` 中标记为 `off` 的渠道**零行**。

> **适用范围（D1 修正）**：`$1` **必须分别取平台租户 `system` 与业务租户各验一次**，两次均成立方算判据 ① 通过。
> 理由：平台级告警（`tenant_id='system'`）此前不在泵范围内，若只验业务租户口径，「全链集成」在平台口径下仍是假绿。

**判据 ②（入口/回写）**
```sql
SELECT count(*) FROM crm.sync_cursor WHERE tenant_id = $1 AND last_status = 'ok';
SELECT count(*) FROM crm.external_ref WHERE tenant_id = $1 AND external_id IS NOT NULL;
```
**成立条件**：两数均 ≥ 1。

> **适用范围（E1 修正，2026-09-16 取证新增）**：成立条件须再补一条 —— 该行**不得**来自 smoke/测试租户，且 `provider` **不得**为 `mock`。
> 理由：Q4-1 取证实测，全域 `crm.sync_cursor` 的 11 行与 `crm.external_ref` 的 26 行**全部**归属 `smoke-*` 租户，唯一 `last_status='ok'` 行的 `provider='mock'`。若不加此限定，**smoke 脚本会自己把判据 ② 刷绿**——「判据由被测方提供证据」的变体。详见 §7.1.1 与 §5.2 **N10**。
>
> **可验证性补充（F-4，2026-09-16）**：判据② 的**代码路径**可经 `scripts/seed-integration-sim.mjs` 在**模拟口径**下端到端复现（租户 `sim-erp`，取证 8/8）。该复现**只**证明「代码路径通」（真 HTTP / 真适配器 / 真凭据解密 / 真第 0 闸 / 真落库），**不**满足本节「真实租户口径」的成立条件；引用时必须同时声明模拟口径，禁止作为 KPI 或交付验收证据（详见 §8.3.3）。

### 5.2 负向判据（防假绿，**任一不成立即验收失败**）

| # | 负向判据 | 判定方式 |
| - | -------- | -------- |
| N1 | 渠道配置为 `on` 但窗口内零投递行 | 修正后的 `detectNegativePredicates` 返回该渠道（不依赖硬编码默认值） |
| N2 | 收件人解析失败却无 `skipped` 行 | 查 `signal_delivery` 是否存在 `last_error='no_recipient'` 行；缺失即失败 |
| N3 | 静默时段/限速丢弃却无留痕 | 查 `last_error IN ('quiet_hours','rate_limited')` 行存在性 |
| N4 | `exportGate` 在判据 ① 不成立时返回 healthy | 构造无 `sent` 行的租户，断言 `isExportHealthy=false` |
| N5 | 回写写入未声明字段 | 构造未声明字段，断言被拒且计入 `skipped` |
| N6 | 凭据明文外泄 | 全量日志/trace 载荷 grep 凭据值，命中即失败 |
| N7 | 跨租户可见 | 两租户并行，断言 A 租户查不到 B 租户的 signal / delivery / sync_cursor 行 |
| N8 | **平台租户被静默排除**（D1） | 造一条 `tenant_id='system'` 的 open signal，跑 `pumpAllTenants`，断言其出现在泵候选集内且最终落 `sent`/`skipped` 行；**候选集不含 `system` 即失败** |
| N9 | **无界候选集**（D2） | 造一条 `created_at` 早于窗口的 open signal，断言其**不在泵候选集**且**行仍存在**（窗口只收窄候选集，绝不删除留痕） |
| N10 | **判据② 自证**（E1，2026-09-16 取证新增） | 判据 ② 的「成立行」若来自 `smoke*/测试` 租户或 `provider='mock'`，**即视为验收失败**——防 smoke 脚本把自己的测试数据当作生产证据（「判据由被测方提供证据」的变体） |

### 5.3 回归与纪律

- `timers.test.js` `EXPECTED_TIMERS` 16 → 17，随 Q1-3 同步更新。
- 既有 `conn-signal-lead-gen` 分支、S6 自治行为**不得回归**（Q2-2 / Q3-4 显式断言）。
- 共享测试库 `crm_native_test` 并发 TRUNCATE 伪失败须先排除并行会话再判回归（继承计划纪律）。

---

## §6 红线（继承最终设计 §15 全部 11 条，本设计新增 3 条）

**继承（不放宽）**：不新增粒子类型 / 不做完整双向同步 / 不取消人工录入 / HITL 铁律 / 零 DELETE / 投递不骚扰（rate_limit + quiet_hours）/ 不宣称「发送即送达」/ 未交付不得对外宣称。

**本设计新增**：

| # | 不做项 | 理由 |
| - | ------ | ---- |
| R1 | ⛔ **不得**用「默认全开渠道」作为判据输入 | 这正是本次发现的假前提，修复后不得以任何形式回归 |
| R2 | ⛔ **不得**在 `exportGate` 未投产前放行回写或自治 | §0.4 的机制本体；放宽即退回排期纪律 |
| R3 | ⛔ **不得**为任何厂商写产品专属代码（deep-customization） | 唯一实现只有 `generic-rest`；任何厂商（Salesforce / 销售易 / 纷享逍客 / 自建 …）差异**一律经 `src/sync/presets/*.js` 纯数据预设表达**（endpoint / objects[] / 凭据 / 鉴权流 / 请求响应形状）。预设＝数据，**不得含任何产品逻辑**（无 if/switch/函数）。历史上曾误建 `src/sync/fxiaoke.js`，已按本条删除。 |
| R3.1 | ⛔ **不得**为「未真接通的厂商」填占位实现 | 占位实现＝假绿。**2026-09-17 用户扩范围**：Salesforce / 销售易 / 纷享逍客 三家已按 R3 以预设形式**真实实现**（token-flow 鉴权流 + 读取），经 mock 端到端证明；预设中 `objects[]` 为标准模板，接入真实租户时按租户填真实对象/凭据（属 Q2-5，未接通前不得对外宣称已连通）。 |

---

## §7 闭环回写

> 数据来源：`docs/2026-09-16-full-chain-integration-design.md.feedback.json`（P0 预检时**不存在**，故无历史缺口需吸收）。

| 缺口类型 | 观测 | 期望 | 处置 |
| -------- | ---- | ---- | ---- |
| —（首轮，无历史） | — | — | 待 workbench 首次监控后回填 |

**监控口径（workbench 侧）**：逐个 `contract-yaml` 块跟踪三件事——① 是否调用了声明的 `skills`；② 是否读取了声明的 `memory` / 知识层；③ `success` 是否通过。任一缺失按 `{task, agent, gap_type, observed, expected, ts, severity}` 追加到 `*.feedback.json`（按 `task+gap_type` 幂等 upsert），并镜像到本表。

**吸收与建议（下一轮 P0）**：同一 `(task, gap_type)` 复现 ≥ 2 次 → 产出 SKILL 改进建议（如补 `agentSpec.skillCalls`、强化某 SKILL 调用指令、新增记忆读取约定），**仅作提案，须用户显式批准后方可改动 SKILL 文件**。

### 7.1 Q4-1 端到端取证结果（2026-09-16 20:46 · `scripts/smoke-full-chain-e2e.mjs`）

运行：`node scripts/smoke-full-chain-e2e.mjs system` 与 `... acme-demo`（库 = `crm_native`；脚本**只读 + 只跑闸门判定**，不写配置、不迁移状态）。

| 判据 | system | acme-demo | 观测 |
| ---- | ------ | --------- | ---- |
| ① 存在 `status='sent'` 且 `delivered_at` 非空的投递行 | 🔴 FAIL | 🔴 FAIL | `sent=0`；全域 `crm.signal_delivery` = **0 行** |
| ① 配置为 `off` 的渠道零投递行 | 🟢 PASS | 🟢 PASS | 配置为空 → 无越界渠道。⚠ 这是**「空」通过**，不是「正确」通过 |
| ② `crm.sync_cursor` 存在 `last_status='ok'` 行 | 🔴 FAIL | 🔴 FAIL | 两租户均 0 行 |
| ② `crm.external_ref` 存在真实外部 ID 行 | 🔴 FAIL | 🔴 FAIL | 两租户均 0 行 |
| N1 无 `delivery_silent` | 🟢 PASS | 🟢 PASS | `[]` |
| N2/N3 `failed`/`skipped` 必带 `last_error`，`sent` 不带 error | 🟢 PASS | 🟢 PASS | `no_reason=0 sent_with_error=0` |
| N4 `exportGate` 与判据①一致 | 🟢 PASS | 🟢 PASS | `healthy=false reason=sent_exists,channels_from_config` |
| N10 判据② 不得由 smoke/mock 自证 | 🟢 PASS | 🟢 PASS | `mock_ok=0`（反例：以 `smoke-sync` 运行 → **N10 FAIL**，其判据② 却"通过"，正是该条要防的自证） |

**汇总：5/8（两租户同形），exit 1** —— 与 §1.4「Q3 回写与自治【存在但关闭】」的预期状态一致，**不是缺陷**。

#### 7.1.1 取证暴露的一条新事实（超出设计预期，必须记录）

判据② 的全域取证（`crm_native`）显示：`crm.sync_cursor` 共 **11 行**、`crm.external_ref` 共 **26 行**，但**全部归属 smoke 测试租户**：

| 租户 | sync_cursor | external_ref |
| ---- | ----------- | ------------ |
| `smoke-line-a-13fsmu3t1exh` | 2 | 4 |
| `smoke-line-a-103omu3ulpzo` | 2 | 5 |
| `smoke-line-a` | 2 | 4 |
| `smoke-line-a-1148mu3tkr4t` | 2 | 5 |
| `smoke-line-a-j34mu3t4gko` | 2 | 5 |
| `smoke-sync` | 1 | 2 |
| `smoke-followup` | 0 | 1 |

- `last_status` 分布：`idle:10`、`ok:1`；**唯一 `ok` 行** = `smoke-sync` / `provider='mock'`。
- `config_store['integration-providers']` 仅 **1 行且 tenant=`system`**（播种模板本身）→ **无任何租户级集成实例**。

**结论**：线 A（Q2-1 / Q2-2）的接线是**真的**（代码路径存在、smoke 可跑通），但**从未有真实租户产生过同步数据** —— 判据② 目前在「smoke 口径」下成立、在「**真实租户口径**」下**不成立**。这是 §0.2 元缺陷「交付 ≠ 可触发」的**第三次发作**，且形态再进一步：*挂载点有了、泵也有了，但没有任何租户被「接通」* —— 缺的不是代码，是**启用**（与 §2.2「播种 ≠ 接通」同源）。

> **对验收口径的正式修正**：§5.1 判据② 的成立条件须补一句「且该行**不得**来自 smoke/测试租户、**不得** `provider='mock'`」。否则 smoke 脚本会自己把判据②「刷绿」——这属 N 族（自证/恒真）的变体，登记为 **N10**。

---

## §8 批准记录与移交

### 8.1 批准记录（2026-09-16）

| # | 事项 | 结果 |
| - | ---- | ---- |
| 1 | **本设计整体**（Q1 / Q2 / Q3 / Q4 共 15 任务） | ✅ **已批准** |
| 2 | **§0.4 对最终设计 §14.2 的修正**（顺序纪律：排期 → 运行时闸门） | ✅ **已确认**——已回写最终设计 §14.2 与附录 B，见 §8.2 |
| 3 | **本批次范围**——只做 `generic-rest`（R3：不得写产品专属代码） | ✅ **已确认** |
| 4 | **范围扩展（2026-09-17）**——Salesforce / 销售易 / 纷享逍客 三家集成，**经 `generic-rest` 预设实现**（`src/sync/presets/*.js` 纯数据，零产品代码） | ✅ **已批准并实现**（用户指令「3 家集成 + 不能按某产品深度定制」；见 §8.3.4） |

### 8.2 对最终设计的回写（已完成，按 §D.4 维护约定）

| 回写对象 | 内容 |
| -------- | ---- |
| `docs/2026-09-15-final-design-coexistence-and-proactive.md` §14.2 | 增「顺序纪律的载体可由排期升级为运行时闸门」的修正段，指向本设计 §3.4 |
| 同上 附录 B | 增修正记录 1 行（来源：本设计 §0.4） |
| 同上 附录 E | 增指向本设计的闭合路径说明（E.1 四项由本设计 Q2 承接） |

### 8.3 修正记录 v1.1（2026-09-16，计划期发现 → 用户裁决）

`writing-plans` 阶段的代码侦察对 Q1-1 的候选集逐字核验，发现两处「泵上线但截图红框不消失」的缺陷。按 §D.4 维护约定登记如下：

| 编号 | 缺陷 | 裁决 | 状态 |
| --- | --- | --- | --- |
| **D1** | `pumpAllTenants` 租户选择器为 `... AND tenant_id <> 'system'`，而定时器⑰ 只调 `pumpAllTenants` → **平台租户信号永不被泵**，平台级告警继续静默 | **用户选定方案 A**：泵范围含 `system`；收件人解析对 `system` 回退到 `role_recipients.platform`（缺失仍 `no_recipient`） | ✅ 已入 §3.1.1 / §3.2 / §1 / §5.1 / §5.2（N8） |
| **D2** | `crm.signal.status` 投递后不迁移 → 泵候选集单调增长（幂等正确但**不有界**） | **模型裁决（保守侧）**：加时间窗（默认 7 天，`config_store['signal-dispatch'].max_age_days` 可覆盖）；**否决**在 `crm.signal` 加 `delivered_at` / 状态迁移——后者需改表并复评全部 `status='open'` 读取点，风险显著高于收益 | ✅ 已入 §3.1.1 / §5.2（N9） |

**改动清单（本次回写仅动 5 处，契约 `contract_task_id` / `agent` / `skills` / `memory` / `knowledge_scope` 一律不变）**：

1. §3.1 编排器伪代码（泵范围含 `system` + 时间窗）+ 新增 §3.1.1（D1/D2 及取舍依据）。
2. §3.2 收件人解析（新增 `platform` 回退与两条纪律）。
3. §1 任务表 Q1-1 / Q1-2 两行（并顺带消除「幂等键 `signal_id + channel + bucket`」与 §3.1「`signal_id + channel`」的**既有自相矛盾**——以 §3.1 为准）。
4. §4 契约块 Q1-1 / Q1-2 的 `success` 字段追加 D1 判据（否则修正不可机检）。
5. §5.1 判据 ① 增「适用范围：`system` 与业务租户各验一次」；§5.2 增 N8（平台租户被静默排除）/ N9（无界候选集）。

**红线不变**：窗口只收窄泵的候选集，**绝不允许删除或迁移 `crm.signal` 行**；`system` 不享有投递豁免。

### 8.3.1 修正记录 v1.2（2026-09-16，Q3 执行期）

| 编号 | 事项 | 裁决 / 实测 | 落点 |
| --- | --- | --- | --- |
| **D3** | §1.3 Q3-4 行写 `require_export_healthy: true`（示意值），而 §4 Q3-4 契约的 `success` 写「置 false 时与既有 S6 一致」——**二者张力**：若默认 true，Q3 上线当日因出口判据①不成立 → 全部自治归零（"上线即停摆"，且直接违反自身 success） | **取 `false`**：契约（可机检）优先于示意值。闸门**代码就位但默认关闭**，与 §1.4 图逐字一致；启用须运营显式改配置（继承 §2.2「播种 ≠ 接通」） | `standingAuthorization.js:16` + `db/migration-standing-grant.sql`（幂等 `jsonb \|\|` 补键，不覆盖既有键）；实测 `has_key=t val=false default_tier=T1` |
| **E1** | **新增事实（取证发现）**：判据② 在全域仅有 smoke 租户数据，唯一 `ok` 行 `provider='mock'` → 真实租户从未被「接通」 | 属「交付 ≠ 可触发」第三次发作；**处置 = 补口径 + 上报**，不在本批写业务配置（第 0 闸） | §7.1.1；新增负向判据 **N10**（判据② 不得由 smoke/mock 自证） |
| **P-1** | Q3-3a 测试把 `emit` 注入在 **guard 调用处**，而实现从**工厂**读取 → 3 条 trace 断言将永远拿不到 trace（`toMatchObject` on `undefined`） | 实现侧接受 **guard 级 `emit` 覆盖**（缺省回落工厂注入），两种调用形状同时成立；工厂级 `emit` 契约不变 | `src/sync/exportGate.js` `guard({..., emit: emitOverride})` |
| **P-2** | 计划 Q3-3a Step 4 写「Expected 13 个用例」，实际文件为 **11 例**（7 + 4） | 期望值即为错，改记实测 11 | 本表 |
| **P-3** | 计划 Q3-3b 测试引 `__resetRegistry`，而 `src/action/registry.js` 实际导出 **`resetRegistry`**（计划已预告此不确定点并给了两条路径） | 走"用既有导出"路径，**不为测试改生产接口** | `test/connectors/writebackGateWiring.test.js` |
| **P-4** | Q4-1 脚本原 N2/N3 条目为 `check(..., true, ...)`（**恒真锚点**，永远 PASS） | 改为**真实不变量**：`failed/skipped` 行 `last_error` 非空数 = 0 且 `sent` 行带 error 数 = 0 | `scripts/smoke-full-chain-e2e.mjs` |
| **P-5** | 计划 Q3-4 Step 6 期望 migrate 第二次输出「新增 0 条」；`db/migrate.js` **无此输出**（无迁移账本，增量 SQL 每次重跑，靠语句自身幂等） | 改以**直查结果**为判据：`has_key=t val=false` 且既有键 `default_tier` 未被覆盖 | 本表 |

### 8.3.2 修正记录 v1.3（2026-09-16，全租户接通后续执行）

**背景**：用户裁决「对当前所有租户都采用 0 闸」已由 system 模板 + `readConfig` autoSeed 覆盖全租户（详见 `docs/2026-09-16-signal-config-all-tenants-activation.md`）。本轮续执行闭合下列两项。

> ⚠ **编号消歧**：本小节的 **P-4** 指 *Q3 计划书 §0「本计划遗留的建议项」* 中的凭据第二消费面（*计划遗留编号*），与 §8.3.1 表中同名的 **P-4**（*Q4-1 脚本恒真锚点*，*执行期编号*）**不是同一项**。两个编号空间独立，勿混。

| 编号 | 事项 | 裁决 / 实测 | 落点 |
| --- | --- | --- | --- |
| **F-1**（机制实证） | **§0.4 的机制本体验证**：运行时闸门真能"自己开"，而非靠排期纪律 | `exportGate` 随判据① 成立**自动**由 `healthy=false reason=sent_exists,channels_from_config` 翻为 `healthy=true reason=ok checks={sent_exists:t,channels_from_config:t,no_silent_channel:t}` —— **零人为开关**。Q4-1 取证 5/8 → **6/8、exit 0**（`system` / `acme-demo` 同形）；未通过项仅剩判据② | §7.1 复跑 |
| **P-4**（计划遗留·凭据第二消费面） | `runIntegrationPollOnce` 签名**不接收** `resolveCredentials` —— 调用方（定时器⑩ `timers.js:501` 起）已注入却被**静默丢弃**；且 `runWaterfall` 的 ctx 仅 `{ tenantId }` ⇒ 消费 `ctx.credentials[pid]` 的五个 adapter（anysite / qixin / xinbang / genericRest / genericMcp）凭据**恒空**，退化为「无 `Authorization` 的请求」→ 表现为"没有数据"而非"凭据没送到"（典型假绿；与 §0.2「交付 ≠ 可触发」同族，**同一库内第四次发作**） | **修**：签名接收 `resolveCredentials`；按本租户 `adapters.map(a => a.id)` 解析 → 经 `ctx.credentials` 透传进 `runWaterfall`；范式对齐 `discoveryOrchestrator.js:58-63` / `prospectingActions.js:79-83`（**注入优先 + 缺省动态 import 回落**，使"未来调用方忘记注入"不再重演同一断点）。解析失败**不静默**（`integration-poll-credentials-failed` trace + `recordFailure`）但**不阻断**富化 —— 缺凭据在 adapter 侧本等价于"不带 Authorization"，硬阻断会把"缺凭据"升级成"整轮富化归零"，超出本修复意图 | `src/scheduler/timers.js`（签名 + 凭据块 + ctx）；`test/external-integration.test.js`（+3 例） |
| **观测（未修·登记）** | `test/connectors/discovery/anysiteRest.test.js:39`「无凭据 → fail-open 返回空」为**既有红**：`.env` 载入 `ANY_SITE_KEY` ⇒「无凭据」前提被摧毁。**已证与本轮无关**（该测试除 `vitest` 外**零 import**，结构上不可能受 `timers.js` 影响；`ANY_SITE_KEY=` 清空后 5/5 转绿） | 与 `shared-db-test-hygiene` 既有「外部环境输入破坏『未配置』前提」同族；**不在本轮修**（属测试环境隔离议题） | 本表 |

**P-4 证据链（三层，全部真跑，非快照）**：

1. **行为断言**（真 `runWaterfall` + 真 adapter 消费形状）：注入解析器 → `providerIds` == 本租户 adapter ids → adapter **实收**凭据。**负向对照双证**（防假绿）：① 仅退「ctx 透传」→ 断点②守卫红（`seen=[undefined]`）；② 模拟「注入被静默丢弃」→ 断点①守卫红 + 留痕断言红。两例均**仅在缺陷存在时红**，证明断言有鉴别力。
2. **真库回落路径**（不注入任一解析器，库 = `crm_native`）：`ctx.credentials={"qixin":null}`、零失败留痕 ⇒ 回落路径未抛。
3. **真 pgcrypto 端到端往返**（**零 DB 写入**，规避禁删铁律下的不可清理污染）：真加密（明文零泄露）→ 真 `resolveCredentials` 解密 + 形状还原（单串 `string` / 结构化 `object`）→ 真 `runIntegrationPollOnce` + 真 `runWaterfall` → adapter 实收 `"sk-real-qx-secret"`。

**回归**：`external-integration` **49/49**（新增 3 例）；`timers` / `discoveryOrchestrator` / `prospectingSearchAdapters` / `connectors/discovery` 合计 172 例中 **171 绿**，唯一红即上表登记之**既有红**。

**判据② 剩余唯一阻断项**：真实租户的集成实例启停（**第 0 闸，须用户裁决**）。F-1 与 P-4 已消除其**前置**障碍。

### 8.3.3 修正记录 v1.5（2026-09-17 09:10 · 用户「修」裁决：F-5 / F-6 落地）

> v1.4（2026-09-16 23:45 · 「模拟种子」实跑暴露）见下；v1.5 将 F-2 / F-5 / F-6 的「未修 / 待裁决」落点全部改为「已修」，并追加双库对照、真泵取证与变异验证闭环。

**触发**：用户裁决「可以模拟一些种子」。交付 `scripts/seed-integration-sim.mjs`（幂等、禁删、默认 dry-run，`--apply` 落库），起本地模拟外部 CRM 并沿**生产同源装配**实跑。
**口径声明（必读）**：本轮取得的一切外部数据均为**模拟**。判据② 在**模拟口径**下成立，**不得**作为 KPI / 交付验收证据引用。

| 编号 | 事项 | 裁决 / 实测 | 落点 |
| --- | --- | --- | --- |
| **F-2** | **判据② 的前置缺口**：L2/L3 同步写路径须 `mintDecision('integration-sync')`，而 `decision_scenario` 全量 24 场景中**从无 `integration-sync`** → `requireDecision` 抛「未知决策场景」→ 被 `.catch(() => null)` 吞掉 → `decisionId=null` → 内核 `throw decision_required` → **写路径结构性 fail-closed**。这是「播种 ≠ 接通」的又一实例：**启用 L2 的前置条件是先播该场景** | **已修（2026-09-17）**：载体为 `db/seed-decision-scenarios.sql`（**每次 migrate 幂等 ensure**，不在 `--seed` 分支内，容器启动即执行）——**载体改判依据**：`db/migrate.js:213-226` 已具「决策场景字典每次 migrate 幂等 ensure」机制；反例 `db/migration-particle-update-scenario.sql` / `migration-requirement-collect-scenario.sql`（同族单场景文件）**不在 `INCREMENTAL_SQL` 清单，是永不执行的孤儿** → 照抄它们＝新造永不生效 migration。行形状 `('integration-sync','meta',…,'{"timer":["integration-poll"]}','NORMAL',TRUE)`，与 `PARTICLE_CREATE` 逐字对齐。**取证（防「migrate 报 0 条=通过」假绿）**：本库 `node db/migrate.js` → 「新增 0 条」（已存在，幂等 no-op，exit 0）；**测试库真实插入对照**（该库原本无此行）→ **新增 1 行**，逐列核对 `trigger/default_tier/autonomous_allowed`/4 维度权重全对 ⇒ 字面量确实物质化。脚本侧 `seedScene()` 抽 `SCENE_DESC` 常量与文件**同一文本**，防库间漂移 | `db/seed-decision-scenarios.sql` + `scripts/seed-integration-sim.mjs` |
| **F-3** | **决策凭证读取层级系统性错误（11 处）**：`requireDecision` 返回 `{ mode, decision, … }`，凭证在 **`result.decision.decision_id`**；但 11 处调用方按**顶层** `result.decision_id` 读取 → 恒 `undefined`。后果：① 配置写 `decision_id` 恒 NULL（第 0 闸「有决策、无留痕」，实测 `config_store` 204 行仅 7 行有值）② L2/L3 同步被判「无决策」而 fail-closed。唯一正确读法此前只在 `executor.js:70` | **收敛为单一读取点** `autonomyEngine.decisionIdOf(result)`（对齐「同名字段解释权收敛单一模块」铁律），11 处调用方全部改用它；**刻意不**在引擎补顶层别名（避免同义双键）。新增 `test/decision/decisionIdOf.test.js` 6 例：形状 + **真引擎**（真库锁定真实形状）+ 收敛守卫（含**正向对照**防恒真；负向对照已验证能精确定位回退的文件） | `src/decision/autonomyEngine.js`（新增导出）+ 11 个调用方 |
| **F-4** | **模拟种子交付与取证**：`sim-erp`（非 `smoke*`）+ `kind='generic-rest'`（≠ `mock`）→ 出口与入口两侧在同一模拟租户同时成立 | **v1.5 更新（2026-09-17）**：`scripts/smoke-full-chain-e2e.mjs sim-erp` → **9/9、exit 0**（F-6(a) 修复后新增 **N1b 判据**：`delivery_undelivered` 检出 email `sent=0 attempted=1603 top_error=no_recipient`——修正前完全漏报；`N4 exportGate healthy=true reason=ok` 三判据全 true）。早期 v1.4 取证（8/8，N1–N4/N10）：`sync_cursor` 2 行 `ok`、`external_ref` 5 行、`signal_delivery` 2 行 `sent`、幂等两轮 `created=0`/`sent=0`、模拟源实测 `auth_ok=true`（守 N6 不记录值）；`system`/`acme-demo` 复跑 6/8 无回归 | `scripts/seed-integration-sim.mjs` + `scripts/smoke-full-chain-e2e.mjs` |
| **F-5** | **第 0 闸在平台内存在第二套语义（`propagationRoutes.js` 本地同名 `decisionIdOf`）**：`src/http/propagationRoutes.js:19-27` 的 `requireConfigChangeDecision` **不调用**引擎 `requireDecision`（该文件 `:6` 的导入为**死导入**，全文件无调用点），而是 `recordDecisionEvent('config_change', …)` → 取 **`event_id` 当 `decision_id` 凭证**，并**双写两形**返回 `{ decision_id: id, decision: { decision_id: id } }`；配套的**本地** `decisionIdOf`（`:36-38`）含 `dec?.decision_id || dec?.id` 兜底 —— 与 F-3 收敛出的 `autonomyEngine.decisionIdOf`（严格单一路径、**刻意不**留同义键）**同名不同义**，直接违反「同名字段解释权收敛单一模块」铁律。**后果**：改前 11 处（F-3）读错 → 恒 `undefined` → fail-closed；本处自造凭证 → **恒有值、不 fail-closed** ⇒ 同一平台**两套第 0 闸语义**；`.id` 兜底在异常输入下可把**非决策 id** 写进 `config_store.decision_id` 与审计链。测试替身形状已在佐证：`test/propagation/routes.test.js:77` 的桩返回**顶层** `{ decision_id: 'D1' }`（真引擎形状见 `test/decision/decisionIdOf.test.js` 的「真引擎形状（真库）」） | **已修（2026-09-17，收敛层 A3，零行为变更）**：① 删 `:6` 死导入；② 本地 `decisionIdOf`（含 `.id` 兜底）**并入** `autonomyEngine.decisionIdOf`（用引擎版语义：**剥离兜底**，异常输入返回 `null`，杜绝非决策 id 入审计链）；③ `routes.test.js:77` 桩从顶层 `{ decision_id: 'D1' }` 改为**真引擎形状** `{ decision: { decision_id: 'D1' } }`。取证：`test/propagation/` 全绿；全受影响套件 44 文件 256 例全绿。**口径说明**：仍维持「记事件、不铸真决策、不阻断写」的降级语义（= 用户裁决 A1 未实施前的收敛层）；`config-change` 是否铸**真决策**另属 ① 裁决（见 ⚠ 段） | `src/http/propagationRoutes.js` + `test/propagation/routes.test.js` |
| **F-6** | **出口观测两处真实缺陷（收尾复核实测暴露；**非**本轮改动引入，属已发布代码）**：<br>**(a) 判据粒度不足以识别「渠道开了但一封也发不出去」**：`src/monitor/signalMetrics.js` 判据 A 的查询是 `SELECT channel, COUNT(*) FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at>=$2 GROUP BY channel` —— **只看「有无行」，不看 `status`**；`src/sync/exportGate.js:59` 又直接以「无该告警」当**判据③ 通过**的条件。⇒ 配置为 on 的渠道若**全部 skipped**（如无收件人），仍被判**健康**。<br>**(b) skipped 投递行无幂等键 → 每次泵运行线性累积**：实测租户 `sim-erp` 的 `email skipped` 行 `935 → 1125`（**+190 = 2 次泵调用 × 95 条 open 信号**，确定性可复现，两次独立测量一致），而同一批 signal 的 `inbox sent` 稳定在 95 ⇒ **幂等在 `sent` 维度有效、在 `skipped` 维度失效**。<br>**合并后果**：① `crm.signal_delivery` 无界增长（全租户 × 每泵周期 × 每条 open 信号 × 每个未成立渠道）；② 判据 A 赖以判「静默」的「有行」分母被**判据自身产生的噪音**永久污染 ⇒ **任何真实静默都不会再被检出**（`exportGate` 判据③ 与 `delivery_silent` 告警**同时失效**）—— 属「自指仪器」族（仪器自己制造的噪音使仪器永久静默）。 | **已修（2026-09-17，用户「修」裁决）**：<br>**(a)** 判据 A 收紧为按 status 分列 `sent / attempted`，**`sent===0` 即判静默**；并**拆两级**——「零行」仍报 `delivery_silent`，「有尝试但零 sent」新报 **`delivery_undelivered`**（带 `sent/attempted/top_error/top_error_count`，让「一次都没试」与「试了 N 次没成」可区分）；`exportGate` 判据③ 改为「无 sent 行即不健康」（**刻意 fail-closed**：配 `on` 即声明已就绪，未就绪应改 `off`）。<br>**(b)** `signal_delivery` 加**确定性幂等键** `delivery_id = signal_id + ':' + channel` + `ON CONFLICT (delivery_id) DO UPDATE`（`attempts` 递增、`created_at` 不动、`updated_at` 更新、**保留首末两条 `last_error`**）；`dispatcher.attemptCount` 从 `COUNT(*)` 改为 `COALESCE(MAX(attempts),0)`（否则 `attempts` 列恒 1，retry 逻辑失效——必须成对改）。<br>**取证**：① **测试库实测**幂等键 upsert 语法与语义全绿；② **真泵三轮**行数零增长、`attempts` 累加到 3（旧实现每轮 +98）；③ 变异验证——注入「回退 COUNT(*)」与「零行即静默」两处变异 → 守卫用例**精确红**（`signalMetrics` 1 红 + `dispatcher` 2 红），还原后 44 文件 256 例全绿；④ `sim-erp` 冒烟 **9/9**：`N1b` 检出 `delivery_undelivered`（email `sent=0 attempted=1603 top_error=no_recipient`——修正前完全漏报）、`N4 exportGate healthy=true reason=ok` | `src/monitor/signalMetrics.js` + `src/signal/dispatcher.js` + `src/signal/delivery/signalDeliveryStore.js` + `src/sync/exportGate.js` + `scripts/smoke-full-chain-e2e.mjs`（N1/N1b 判据）+ 4 个测试文件 || **观测（未修·登记）** | `test/llm/ai-attributes.test.js:71` 超时（fake timers 下的重试等待）为**既有失败**：文件与 `src/llm/` 均未被本轮改动（`git status` 为空）⇒ 该失败存在于 HEAD；单独跑仍红（确定性） | 不在本轮修 | 本表 |
| **修正（本轮内自纠）** | `scripts/seed-integration-sim.mjs` ⑪ 自检原为 `const onChannels = ['inbox']`（**硬编码**「模板默认仅 inbox=on」）—— 违反本仓铁律「阈值/差异化 100% 后台配置化，禁域字面量」。并行会话把平台 `signal-delivery` 模板的 `email` 由 off 改 on（经 `autoSeed` 派生到全部租户）后，该硬编码前提立即失效 → 输出 ❌「越界行=1」，**而同一时刻读实时配置的 `smoke-full-chain-e2e.mjs` 仍 8/8 通过** ⇒ 纯硬编码前提造成的假红 | 已改为读本租户实时配置（与 smoke 判据同源）；复跑 `越界行 = 0 ✅`。并显式声明本检查的已知局限（配置历史上曾置 on 留下的行会计入）⇒ **权威判据以 smoke 脚本为准** | `scripts/seed-integration-sim.mjs` ⑪ |

**F-3 的现场还原（为何此缺陷此前不可见）**：`timers.js` / `connectorRouter.js` 的 `mintDecision` 把异常与空值都压成 `decisionId: null`，trace 只留 `decision_required` —— 读起来像"没配置"；而 `crm.decision` 表**确实新增了行**（模拟种子首轮实跑：决策 5 条、`sync_cursor` 仍 0 行、`external_ref` 仍 0 行）。**「表里有决策」与「链路取到决策」不可区分** —— 本项目已登记反模式「断言/读数与真实行为脱钩」的又一变体。

**⚠ 一处**必须由用户裁决**的相邻缺口（超出本轮授权范围，故未动）**：
`requireDecision('config-change', …)` 是 configRouter / llmConfigRouter / namedAccountAssignRouter / 6 个 portal 模块的**统一第 0 闸场景**，但 `decision_scenario` 里**没有 `config-change`**（只有 `ATTR_SCHEMA_CHANGE` / `CALIBRATION_CHANGE`）⇒ 这些写路径全部落到 `catch → recordDecisionEvent → { decisionId: null, ok: true }` 的**降级分支**：**记了事件、未铸决策、不阻断写**。即「写操作过决策第 0 闸」这条口径，对**配置写通道**目前是**纸面口径**。修与不修都要先定口径（涉及平台级治理），故只登记、不改动。

> **v1.5 状态更新（2026-09-17）**：用户裁决 **A3 收敛层（=F-5）** 已完成（见上表 F-5 行）——「**本地自造凭证**」这一种形态已消除，11 处降级分支与 `propagationRoutes.js` 现在**同一条语义**（记 `config_change` 事件、以 `event_id` 作凭证、不铸真决策、不阻断写）。剩余未决的**只有**「要不要铸**真决策**（`crm.decision` 行）、要不要能**阻断**写」这一个问题（= A1/A2 分叉），与「`integration-sync` 场景已接入生产播种」相互独立。**该口径一旦裁决**，上述 11 处与 `propagationRoutes.js` 应**一次性**迁移到位。

### 8.3.4 范围扩展：Salesforce / 销售易 / 纷享逍客 三家集成（2026-09-17）

**用户指令**：「实现 3 家集成（Salesforce / 销售易 / 纷享逍客）」+「做成通用接口，不能按某产品深度定制」。

**解析**：两条指令不冲突——**一个通用实现 + 3 份纯数据预设**。绝不写 `salesforce.js` / `neocrm.js` / `fxiaoke.js`；厂商差异全部落在 `src/sync/presets/*.js`（纯数据，无逻辑）。

**技术缺口与修复**：原 `generic-rest` 仅支持**静态 Bearer token**，无法覆盖三家的**动态令牌流**。故在唯一实现 `createGenericRestSyncProvider` 内新增三项**通用能力**（无产品名）：

| 通用能力 | 说明 | 覆盖 |
| --- | --- | --- |
| `auth.type='token-flow'`（链式请求） | `steps[]` 每步一个 HTTP 请求；body 模板引用 `{cred.x}` 与 `{steps[i].var}`；`tokenPath` 提 token、`outputVars` 捕获中间字段；`inject` 决定注入方式（header/query/none）；`expiresInPath` 做令牌缓存 TTL | Salesforce OAuth2、销售易 getToken、纷享逍客**两步串联** |
| 请求模板化 | `request.urlTemplate` / `bodyTemplate`，两遍消解（先解 `{base}/{soql}`，再解内嵌 `{cursor}/{token}`） | Salesforce SOQL GET、销售易/FXiaoke POST JSON |
| 响应模板化 | `response.rowsPath` / `cursorPath` | `records` / `data.records` / `data.dataList` |
| 凭据缺失 fail-closed **零请求** | 发请求前扫描模板中 `{cred.x}` 引用，缺任一即返回 `credentials_missing`（守项目纪律，不给测试留缝） | 三家 |

**预设文件**（纯数据，`src/sync/presets/`）：`salesforce.js`（OAuth2 client_credentials → `instance_url` 作基址 → SOQL）、`neocrm.js`（getToken → `X-Access-Token` → queryV2）、`fxiaoke.js`（get_app_token → get_corp_token 两步 → body 注入 `corpAccessToken` → v2/data/query）；`index.js` 提供 `listPresets / getPresetConfig / createProviderFromPreset`（合并租户凭据/对象后喂给唯一实现）。

**生产接线（守「零接线即假绿」）**：`src/scheduler/timers.js` ⑩ integration-poll 的 sync 工厂由 `SYNC_PROVIDER_FACTORY` 扩为 `{ ...base, ...PRESET_FACTORIES }`——使 `descriptor.kind = 预设名`（如 `salesforce`）的租户描述符能**真正构造 provider**（否则被 `mount.loadTenantSyncTargets` 静默跳过）。工厂字典仍只在此装配点合并，核心 `factory.js` 零产品名。

**验证**：`test/sync/presets.test.js` **12 例**（三家 `verifyAuth=ok` + `readIncremental` 抽行 + 三家凭据缺失 fail-closed + 注册表 + **生产装配**：`loadTenantSyncTargets` 用 `kind='salesforce'` 构造出 `provider.kind='generic-rest'` 的 target，且**反向对照**——不并预设则静默跳过为空，证明并入确有作用）；`test/sync/` 全目录 **111 例全绿** + `test/scheduler/` **34 例全绿**（含既有 `factory.test.js` 10 例向后兼容不破）。**变异验证**：破坏 `response.rowsPath` 提取 → 三家读取用例**精确红**（3 红/5 绿），还原后全绿 ⇒ 断言有鉴别力。

**口径**：本轮证明的是**鉴权流与读取逻辑真通（mock 端到端）**；预设 `objects[]` 为标准模板，**真实租户连通仍属 Q2-5**（需接入方提供真实 endpoint/凭据/对象清单），未接通前**不得**对外宣称已连通。

### 8.4 移交

- **唯一入口**：`writing-plans`。将 §1 三段式 15 任务转为可执行任务清单，**每任务继承 §4 同名生命契约（`contract-yaml` 块逐条平移，不重写）**。
- **执行纪律**：每 Task 一 commit；AI 无提交凭证，输出按功能线分组的 PowerShell 命令（显式路径 add、禁 `git add -A`）。
- **回归纪律**：全量回归 flaky，单次红不得直判；共享 `crm_native_test` 并发 TRUNCATE 会伪失败，先查并行会话再判回归。

---

**— 文档结束 —**
