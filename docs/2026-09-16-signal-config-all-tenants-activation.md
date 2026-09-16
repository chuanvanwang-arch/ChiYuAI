# 信号出口「全租户接通」· 裁决落地与实测验收（2026-09-16）

> **裁决来源**：2026-09-16 用户「**对当前所有租户都采用0闸**」
> **关联设计**：`docs/2026-09-16-full-chain-integration-design.md` v1.1（Q1 出口接电，已批准）
> **本文性质**：**执行 + 实测验收记录**。设计如需变更，另走批准流程。

---

## §0 结论（先行）

🟢 **出口链路已真的接通** —— 这一次不是"红框消失因为没开渠道"，而是**链路自身产出了数据**。

| 指标 | 落地前（实测） | 落地后（实测） |
|---|---|---|
| `config_store` 信号配置键 | **0 行** | system 2 键 + **10 个租户各 1 行**（autoSeed） |
| `crm.signal_delivery` | **0 行** | **449 行 `sent`**（0 failed / 0 skipped / 0 idle） |
| 判据 A `delivery_silent` | 不触发 | 不触发 |
| 巡检租户数 | 8（排除 `system`） | **9（含 `system`）** |
| `delivery_success_rate` | `null`（无尝试，防假绿） | **1**（system 88 / acme-demo 89） |

⚠️ **两点必须同时讲清，否则又会读出假绿**：

1. **「判据 A 不触发」在前后含义完全不同**：
   - 落地前 = `channels.length === 0` ⇒ 判据**自己没资格判**（零渠道 → 判据静默）；**判据与链路同时静默**，是本项目最危险的组合。
   - 落地后 = 渠道已开**且窗口内确有投递行** ⇒ 判据**有资格判且判为健康**。
2. **本次接通的是「出口管道」，不是「对外送达」**：唯一启用的渠道是 `inbox`（平台内视角消费 `crm.signal`，无外部收件人/凭据/外发）。`email` / `im` / `webhook` **仍为 `off`**，需运营在配置中心显式启用并配置 `role_recipients`。

---

## §1 落地口径：为什么是「播 system 模板」而非「枚举租户」

**用户的"所有租户"用机制实现，而不是用清单实现。**

`src/config/configStore.js` 的 `rawRead` 内建 **autoSeed**：租户缺键 → 从 `(system, key)` 模板克隆落该租户（打 `_seeded:'system-template'`），此后租户自持一份；`system` 仅作模板源。

⇒ 播 **1 条 system 模板** = 覆盖**全部现存租户 + 未来新建租户**。枚举租户名必然漏掉未来租户（这是本仓 `lead-pool-config` / `sync-config` 既有的唯一标准范式）。

**新增文件**：`db/migration-signal-config.sql`（2 键，幂等 `WHERE NOT EXISTS`，仅 INSERT 不删不改）
- `(system,'signal-delivery')`：`channels = { inbox:'on', email:'off', im:'off', webhook:'off' }`，`route/role_recipients` 空、`quiet_hours/rate_limit` null、`retry:0`
- `(system,'signal-dispatch')`：`{ version:1, max_age_days:7 }`（D2 泵候选集时间窗）

**注册**：`db/migrate.js:52` 的 `INCREMENTAL_SQL` 清单。

**渠道默认值的设计判断**：`inbox` 与 `email/im/webhook` **必须区别对待**——前者可安全出厂开启（自闭环、零外发），后者出厂即开会造成**不可撤回的对外发送**（本机 `.env` 含真实 `SMTP_*`）。立场与 `migration-sync-config.sql` 的 `enabled:false + 占位 endpoint` 一致：**模板骨架 ≠ 已接通**。

---

## §2 实测证据链（本地业务库 `crm_native`）

| # | 动作 | 实测结果 |
|---|---|---|
| 1 | 落地前查配置键 | `signal` / `delivery` / `dispatch` 相关键 **0 行**；`crm.signal_delivery` **0 行** |
| 2 | 执行 `db/migration-signal-config.sql` | system 两键落库 ✅ |
| 3 | 逐租户 `readConfig` 触发 autoSeed | **10 个租户全部** `seeded=system-template`、`channels_on=[inbox]`（含 `system` 自身 = `own`） |
| 4 | 复刻定时器⑰ 装配手工驱动泵（首轮） | `signal_delivery` 0 → **449 行 `sent`**；`tenants=9`、`days=7`、0 failed/skipped/idle/failures；**2150ms** |
| 5 | 泵复跑（幂等） | `sent=0`，`signal_delivery` **449 → 449（新增 0）** ✅ 幂等成立 |
| 6 | 逐租户跑判据 A/B（since=7d） | **9 个租户全部 `[]` 无告警** |
| 7 | `sweepOnce()` | `{"fired":0,"tenants":9}` —— **含 `system`**（早前读到 8 = 旧版排除实现，见 §4） |
| 8 | `getSignalMetrics` | `system`: `success_rate=1`, `sent=88`；`acme-demo`: `success_rate=1`, `sent=89` |

**投递分布（449 条）**：`acme-demo 89` / `system 88` / `acme-chem 85` / `acme-consult2 83` / `acme-training 83` / `smoke-followup 6` / `smoke-sync 6` / `smoke 5` / `smoke-writeback 4`（均为 `channel='inbox'`, `status='sent'`）。

⚠️ 如实记录：`smoke-*` 残留测试租户亦被覆盖（21 条）——这是"所有租户"字面口径的必然结果，非缺陷。

**驱动它的进程（元缺陷「交付 ≠ 可触发」的最后一环）**：
`src/http/server.js:105` → `ensureTimers()` → `src/scheduler/timers.js:673` 注册定时器⑰ `signal-dispatch`（默认 300000ms，`VITEST` 护栏）。
本次端到端实测用的是**与定时器同一个装配函数**（`createDispatcher({query, deliveryRegistry, deliveryStore, router, readConfig})`），非另一条路径。

---

## §3 隔离处置：为什么**刻意不播测试库**

`signal-delivery` 与 `lead-pool-config` / `sync-mappings` **性质不同**：后者是**新键**（测试库无"该键缺失"前提的用例），前者**至少 3 个用例以「该键不存在」为断言前提**：

- `test/monitor/signalMetrics.test.js:119`「租户无 signal-delivery 配置 → 不产生 delivery_silent（且不回退为全开）」
- `test/signal/dispatch-e2e.test.js:166`「P-5：未配置 signal-delivery 的租户 → 泵空转且回带 idle 原因」
- `test/connectors/writebackGateWiring.test.js:62`「无 signal-delivery 配置 + 无 sent 行 → 闸门必关」

若测试库存在 `(system,'signal-delivery')` 模板，autoSeed 会在这些租户**首读时自动补行** ⇒「无配置」状态在测试库**再也无法构造**，三例前提被摧毁（轻则断言理由失真，重则直接转红）。这与「`.env` 被 vitest 载入破坏『未配置』前提」**同源**。

⇒ **该模板只走业务库/生产通道**（`db/migrate.js`），`scripts/seed-test-config.mjs` 内保留一段说明注释解释**为何不播种**；测试如需 system 模板，由用例自身写入并清理（`test/monitor/signalObservabilityScan.test.js` beforeAll 已是此模式）。

---

## §4 并发冲突记录（本仓已知风险再次发作）

本轮 `src/monitor/signalMetrics.js` 在 **21:16:39 与 21:17:53** 之间被并行会话反复写入：
- 21:16 前后：注释已写「D1 同族遗漏 P-2 修正……本处不应保留任何形式的豁免」，但实现**仍带 `system` 排除条件** ⇒ **注释与实现自相矛盾**（= 「注释承诺 ≠ 实现」，本项目假绿成因之一）。此刻 `sweepOnce()` 实测 `tenants=8`。
- 21:17:53：并行会话落盘为无排除版本，`sweepOnce()` 实测 `tenants=9` ✅

**处置**：该处修正归属并行会话（**不重复造物**）；我方保留注释与实现的一致性复核，未再改动该文件。
**教训复用**：本仓「并发写同一树」的复核纪律有效——**判断必须基于同一时刻的磁盘+运行结果，不能跨改动窗口拼接**（否则会把旧版结果当成新版的证据）。

---

## §5 生产发布路径

生产迁移通道已核（`scripts/tencent-lighthouse-deploy/deploy.sh:174`）：release 执行 `docker compose exec -T app node db/migrate.js`（不带 `--seed`）⇒ 会顺序跑 `INCREMENTAL_SQL`，**自动带上** `migration-signal-config.sql`（幂等，不覆盖运营已改配置）。

⇒ **无需单独手工播种生产**；下一次标准 release 即完成"对生产所有租户接通"。

⚠️ 发布前仍须遵守既有红线：跑 `node scripts/verify-release-source.mjs`、核对 nginx 模板 443 段（`deploy.sh:192` 无条件覆盖）。

---

## §6 未闭合项

| # | 事项 | 性质 |
|---|---|---|
| 1 | **生产发布**（让生产也接通） | 🔴 需用户显式确认（生产/破坏操作红线） |
| 2 | `require_export_healthy` 是否置 `true`（回写/自治前置闸门） | 🔴 属**另一个闸门**（出口闸门 exportGate），非本轮的决策第 0 闸；设计 §8.3.1 D3 现取 `false`，启用须运营显式配置。**顺序纪律**：判据①本轮已成立 ⇒ 现已具备开启条件 |
| 3 | 外发渠道（email/im/webhook）启用 | 🔴 需凭据 + 真实收件人 + `role_recipients`，业务决策 |
| 4 | `smoke-*` / `test_e2e_*` 残留租户治理 | 🟡 环境卫生（禁 DELETE 铁律下需另定收敛方式） |
| 5 | 测试套件回归（signal/monitor/connectors 相关） | 🟡 本轮检测到**并行 vitest 正在运行**（PID 47480），为免互 TRUNCATE 产生伪失败，本次未并行执行；由该会话产出结论 |

---

## §7 「第 0 闸」的现状（本轮同步核实）

- 决策第 0 闸位于 `src/action/executor.js:47-61`（写通道：无 `decision_id` 不写），**实现中无任何租户分支** ⇒ **对全部租户本就统一生效**，本轮无需改动。
- 本轮配置播种属**出厂默认（bootstrap / 系统引导类）**，与 `lead-pool-config` / `sync-config` 同范式，不带 `decision_id`（与 `executor.js` 的 `ctx.bootstrap` 豁免同源）。
- **运营改渠道开关**属业务写，必须走配置中心 HTTP 通道（`writeConfig` 携带 `decision_id`）以满足第 0 闸。
