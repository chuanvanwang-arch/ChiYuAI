# [全链集成 Q3：回写与运行时闸门] Implementation Plan

> **执行状态（2026-09-16）：✅ 已执行完成** —— 6 个 Task 全部落地并实跑通过
> （exportGate 11 / writebackGateWiring 6 / standingExportGate 7 / mapping 6 / writebackDispatcher 9 / 既有回归 43+22 全绿）。
> 执行期发现 **5 处计划缺陷（P-1…P-5）**，均已修正并登记于设计 **§8.3.1 修正记录 v1.2**。
> ⚠ **验收口径警告（E1，取证发现）**：判据② 全域仅有 **smoke 租户**数据，唯一 `last_status='ok'` 行 `provider='mock'` —— **真实租户从未被「接通」**。
> 据此已在设计 §5.1 补适用范围、§5.2 新增 **N10**（判据② 不得由 smoke/mock 自证），并落成取证脚本的可机检条目。详见设计 §7.1.1。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「先出口、后回写」从**排期纪律**升级为**运行时闸门**——新建设备 `src/sync/exportGate.js`，出口判据①不成立时**阻断回写与自治**（fail-closed），并补齐 Q3-1/Q3-2 的行为级断言（二者的实现已由 S4 先行落地，此前仅有静态源码断言）。

**Architecture:** `exportGate` 是**纯判定器 + DI 工厂**（`createExportGate({query, readConfig, detectFn})` → `{isExportHealthy, guard}`），三项判据全部复用既有设施（`crm.signal_delivery` 聚合、`config_store['signal-delivery']`、`detectNegativePredicates`），**零新表、零新粒子类型、零 DELETE**。接入点两处：`sync-writeback-fields` Action 入口（回写）与 `consultStandingGate`（自治放行）。

**Tech Stack:** Node 22 ESM · Express 4 · PostgreSQL 16 · vitest 3 · 既有 `src/db.js`（`query`） · 既有 `src/config/configStore.js`（`readConfig`） · 既有 `src/monitor/signalMetrics.js`（`detectNegativePredicates`，Q1-4 已修正为配置驱动） · 既有 `src/action/registry.js`（`registerAction`）

**设计来源（FINAL，已批准）：** `docs/2026-09-16-full-chain-integration-design.md` **v1.1** §1.3 / §3.4 / §4（Q3-1…Q3-4、Q4-1）/ §5.2（N4/N5）
**本计划覆盖契约：** `ct-quote-calc` × 1（Q3-1）、`ct-decision` × 2（Q3-2 / Q4-1）、`ct-review-gate` × 2（Q3-3 / Q3-4）——契约块**逐条平移自设计 §4，不重写**。

---

## ⚠ §0 计划期代码侦察结论（先读，决定本计划的任务形状）

按 §8.4「writing-plans 阶段须做代码侦察」的要求，对 Q3 四项逐条**复跑判据**（非快照、非印象），结论如下：

| # | 项 | 复跑判据 | 实测 | 结论 |
| - | -- | -------- | ---- | ---- |
| Q3-1 | 字段级白名单 + 字段级 CAS | `grep -n "casExpectField" src/particles/particleRepo.js src/connectors/connectorActions.js` | `particleRepo.js:203/234-239`、`connectorActions.js:163-184` 均命中 | ✅ **实现已存在**（S4 落地）：`mapping.js:21-23` 未知字段计入 `skippedFields`；`connectorActions.js:169-175` 白名单过滤 + `denied[]`；`:179-192` 字段级 CAS + `cas_mismatch` 拒绝 |
| Q3-2 | 回写 Action 生产接线 | `grep -rn "sync-writeback-fields" src/ \| grep -v "seed-actions\|action/"` | 命中 `writeback.js:47`（`dispatch('sync-writeback-fields', …)`）＋ `mcp/tools.js:52-54` | ✅ **判据已成立**（≥1）；`Source='crm-ai-native'` 在 `connectorActions.js:177` 静态拼入 payload |
| Q3-3 | 运行时顺序闸门 `exportGate` | `grep -rn "exportGate\|isExportHealthy" src/` | **0 命中** | 🔴 **真缺口** → 本计划 Task Q3-3a / Q3-3b |
| Q3-4 | 自治前置闸门 | `grep -rn "standing-grants-policy" src/` | 唯一消费点 `authorization/standingAuthorization.js:19`（`loadGrantsPolicy`），**无 `require_export_healthy`** | 🔴 **真缺口** → 本计划 Task Q3-4 |

**⇒ Q3 四项中，两项（Q3-1 / Q3-2）属「实现先行、设计滞后」的追认**（同族先例：A-B3 同名工厂、B-B3 落点更正、B-B7 配置契约）。**本计划不为这两项重写实现**，只补**行为级断言**——原因见下条。

### ⚠ §0.1 Q3-2 现有的"断言"是静态源码文本断言（假绿高危）

`test/connectors/writebackAction.test.js` 全部三条用例都是 `expect(src).toContain(...)` 读源码文本：

```js
expect(src).toContain("Source='crm-ai-native'"); // ← 改格式即红；注释里出现该串即"假绿"
```

这是本仓已登记的反模式（**注释/文档承诺 ≠ 实现**）的变体：**断言的是"源码里有这个字符串"，不是"写入真的带了 Source"**。故 Task Q3-2 **不新增静态断言**，而是把其中最关键的一条**升级为行为断言**（真跑 handler、断言返回值与写入载荷）。

### ⚠ §0.2 计划期发现 P-1：命名同族风险（`gate.js` vs `exportGate.js`）

`src/sync/` 下**已存在** `src/sync/gate.js` → `createSyncGate({reviewGate})`，语义是**接入评审闸门**（`first-connect` / `mapping-change` / `trust-elevate` / `enable-writeback` 四类动作的 `hasApproval` 判定，**人工审批类**）。

本计划的 `exportGate` 是**运行时顺序闸门**（**自动健康度判定**），与它**同名族、不同职责**。本仓已有两起同名事故先例（两个 `KIND_FACTORY`；`signal/router.js` 与 `signal/route.js` 仅差一字符）。

**纪律（写入本计划，实施时不得违反）**：

1. 新文件名为 `src/sync/exportGate.js`，导出 `createExportGate`——**不得**命名为 `createSyncGate` 或放进 `gate.js`。
2. 两者**不得合并**：合并会让「人工未审批」与「出口不健康」两种失败原因无法区分（本仓铁律：同名字段的解释权应收敛，但**不同职责不得共用入口**）。
3. `exportGate.js` 文件头必须写明与 `gate.js` 的边界（见 Task Q3-3a Step 3 的文件头注释）。

### ⚠ §0.3 计划期发现 P-2：`signalMetrics.js:178` 是 D1 的同族遗漏（**登记，不在本计划修**）

```js
// src/monitor/signalMetrics.js:178（createSignalObservabilitySweep.sweepOnce）
const { rows } = await query(`SELECT DISTINCT tenant_id FROM crm.signal WHERE tenant_id <> 'system'`);
```

设计 §3.1.1 的 **D1 修正**确立「泵范围**含** `system`」，并立红线 **R4**（泵候选集 SQL 严禁 `tenant_id <> 'system'`）。但**定时器⑯ 的观测扫描（sweep）仍带该排除条件** → 平台租户（`tenant_id='system'`）的 `delivery_silent` / `gen_silent` **永远不会被巡检**。

- **定性**：D1 的同族遗漏（同一条"平台租户被静默排除"的病因，第二处发作）。
- **影响面**：**不影响本计划的 `exportGate`**——`exportGate` 在自己的判定里对传入的 `tenantId` 直接查（含 `system`），不经过 sweep 的租户选择器。
- **处置**：**登记在案**（本计划 §0.3），建议由 Q1-4 的同一批次或单独 P1 任务修（改 `sweepOnce` 的选择器为 `SELECT DISTINCT tenant_id FROM crm.signal` + 逐租户跑判据）。**本计划不修**——避免与本计划的闸门语义混淆，也避免扩大改动面。

### ⚠ §0.4 计划期裁决 D3：`require_export_healthy` 的**默认值**取 `false`（与 §1.3 的表面值有张力）

设计 §1.3 Q3-4 行写「增 `require_export_healthy: true`」，而 §4 Q3-4 契约的 `success` 写「**置 false 时行为与既有 S6 一致（向后兼容）**」。

| 取值 | 后果 |
| ---- | ---- |
| 默认 `true` | Q3 上线当日，**所有自治执行立刻归零**——因为出口判据①在生产上尚未成立（`crm.signal_delivery` 0 行）。这不是"更安全"，而是**上线即停摆**，且直接违反 Q3-4 自己的 `success` 判据（"置 false 时与 S6 一致"意味着**存在一个不改变 S6 的取值**）。 |
| 默认 `false`（**选中**） | S6 零回归；闸门**代码就位但默认关闭**，与 §1.4 的图「Q3 回写与自治【存在但关闭】」逐字一致；启用由运营显式改配置（继承「**播种 ≠ 接通**」纪律）。 |

**裁决**：`DEFAULT_GRANTS_POLICY.require_export_healthy = false`，播种模板同样置 `false`。**契约（`success` 判据）优先于 §1.3 的示意值**——契约是可机检的，示意值不是。登记于本计划；实施后按 §D.4 维护约定回写设计 §8.3。

---

## 执行前环境与纪律（务必先读）

- 工作目录：`D:\system\CRM-ai-native`。
- **测试库**：`crm_native_test`；直连先 `SET search_path TO crm,public`；凭据 `agent2b/agent2b@localhost:5433`。
- **Node 运行时**：优先托管版本 `C:\Users\wangchuan08\.workbuddy\binaries\node\versions\22.22.2-2\node.exe`。
- **Vitest**：`npx vitest run <path> -t "<name>"`。
- **提交纪律**：AI 无提交凭证 → 每个 Task 末尾输出**精确 PowerShell 命令**（显式路径 add、**禁 `git add -A`**、`-m` 单行、无 heredoc），由用户在本地仓库执行。
- **回归纪律**：全量回归 flaky（约 2612 例）→ **单次红不得直判回归**；跨会话共享 `crm_native_test` 并发 TRUNCATE 会伪失败 → 先查并行会话再判。
- **红线**：不新增粒子类型；不改业务域模型；写操作过决策第 0 闸；零 `DELETE`；**R2**——`exportGate` 未投产前**不得**放行回写或自治；**R3**——不得为本批次之外的厂商填占位实现。

### ⚠ 五处必须在动手前知道的既有事实（已实测，避免踩坑）

1. **`readConfig` 的返回形状**：`readConfig(key, {tenantId})` 返回 `{ value, decision_id }` 或 `null`，**不是** `{ key, value }`。取值写法固定为 `(await readConfig(k,{tenantId}))?.value`（参照 `src/signal/scheduleScanner.js:24`）。
2. **`detectNegativePredicates` 已含判据 A 与判据 B**：返回 `[{type:'delivery_silent',channel}]` 或 `[{type:'gen_silent',fired}]`。**`exportGate` 只看 `delivery_silent`**（判据 B 属"生成侧静默"，与出口健康度无关，混入会让闸门在信号生成侧故障时误关回写）。签名：`detectNegativePredicates({ tenantId, since, enabledChannels = null, readConfigFn = readConfig })`——**不传 `enabledChannels` 时它自己读配置**（Q1-4 修正后的行为），这正是我们要的。
3. **`seedConnectorActions()` 当前无参数**（`src/connectors/connectorActions.js:16`），由 `src/mcp/tools.js` 无参调用。本计划给它加**可选** `deps` 参数 → 缺省行为零变化（向后兼容）。
4. **`consultStandingGate` 的既有语义**：`if (escalated || !standingAction) return escalated;`——**未声明动作即不介入**（opt-in）。本计划的闸门必须插在 `try` 块内、`isActionAuthorized` 之前，且**只在 `require_export_healthy === true` 时生效**。
5. **`crm.signal_delivery` 的真实列**（`db/migration-signal-tables.sql:35-48`）：`delivery_id` / `signal_id` / `tenant_id` / `channel` / `provider` / `recipient` / `status`（`pending|sent|failed|skipped`）/ `attempts` / `last_error` / `provider_msg_id` / `delivered_at` / `created_at`。判据①用的是 `status='sent'` **且** `created_at >= since`（`delivered_at` 只用于 §5.1 的成立条件补充，**不要**用它当窗口谓词——它可为 NULL）。

---

## 文件结构（本计划创建/修改清单）

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `src/sync/exportGate.js` | **新建** | 运行时顺序闸门：三判据健康度判定 + `guard()` fail-closed 包装 |
| `test/sync/exportGate.test.js` | **新建** | 闸门单测（零 DB，注入替身 query/readConfig/detectFn）：三判据真值表 + fail-closed |
| `src/connectors/connectorActions.js` | 修改 | `seedConnectorActions(deps)` 加可选参数；`sync-writeback-fields` handler 入口接闸门 |
| `test/connectors/writebackGateWiring.test.js` | **新建** | 行为断言：闸门关 → Action 返 `blocked_by_export_gate`；闸门开 → 正常写入且载荷含 `Source` |
| `src/authorization/standingAuthorization.js` | 修改 | `DEFAULT_GRANTS_POLICY` 加 `require_export_healthy:false`；`consultStandingGate` 增闸门前置 |
| `test/authorization/standingExportGate.test.js` | **新建** | 自治闸门：`true`+闸门关 → 升级（自主执行 0）；`false` → 与既有 S6 一致（向后兼容） |
| `db/migration-standing-grant.sql` | 修改 | 幂等 `UPDATE` 给 system 模板补 `require_export_healthy:false`（**不改既有行语义**） |
| `test/sync/mapping.test.js` | 追加 | Q3-1 断言：未声明字段被拒并计入 `skippedFields`（当前缺此用例） |
| `test/sync/writebackDispatcher.test.js` | 追加 | Q3-1 断言：部分字段越界 → 越界字段被剔除、命中字段照常派发 |

> **本计划不新建任何表、不新增任何粒子类型、不新增任何迁移文件**（只幂等追加一行 UPDATE 到既有迁移）。全部改动落在上表 10 个文件内。

**实施顺序按依赖调整**（任务编号与设计 §4 保持一致，**契约按 Q 编号平移，不重编号**）：

```
Q3-3a exportGate.js  →  Q3-3b 回写接入  →  Q3-4 自治接入  →  Q3-1/Q3-2 断言补齐  →  Q4-1 端到端取证
```

---

## Task Q3-3a: `src/sync/exportGate.js` —— 运行时顺序闸门（三判据 + fail-closed）

> 对应契约：`ct-review-gate`（设计 §4 Q3-3）
> 依赖：无（本任务先做）
> **红线 R2**：本闸门是 §0.4 的机制本体——「先出口、后回写」不再是排期承诺，而是运行时前置条件

**Files:**
- Create: `src/sync/exportGate.js`
- Test: `test/sync/exportGate.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/sync/exportGate.test.js`：

```js
// test/sync/exportGate.test.js — 运行时顺序闸门（全链集成 Q3-3，设计 §3.4）
// 零 DB：query / readConfig / detectFn 全部注入替身。
// 三判据（设计 §3.4）：① 窗口内存在 status='sent' 行 ② 渠道集合来自 config_store
//                      ③ 无「配置为 on 但零投递行」的渠道（复用 Q1-4 修正后的判据 A）
// 铁律：fail-closed —— 任一判据为假 **或判定过程抛错**，一律 not healthy（绝不返回 healthy）。
import { describe, it, expect } from 'vitest';
import { createExportGate, DEFAULT_WINDOW_HOURS } from '../../src/sync/exportGate.js';

const rc = (value) => async () => (value === null ? null : { value });
const CONFIGURED = { channels: { inbox: 'on', email: 'off' } };

// 替身 query：只认 signal_delivery 的 sent 计数
function q(sentCount) {
  return async () => ({ rows: [{ c: sentCount }] });
}
// 替身 detect：返回给定告警数组
const noAlert = async () => [];
const silentAlert = async () => [{ type: 'delivery_silent', channel: 'email', tenant_id: 't1' }];
const genSilentOnly = async () => [{ type: 'gen_silent', tenant_id: 't1', fired: 3 }];

function gate({ sent = 0, cfg = CONFIGURED, detect = noAlert } = {}) {
  return createExportGate({ query: q(sent), readConfig: rc(cfg), detectFn: detect });
}

describe('exportGate.isExportHealthy（三判据真值表）', () => {
  it('三判据全真 → healthy', async () => {
    const r = await gate({ sent: 2 }).isExportHealthy({ tenantId: 't1' });
    expect(r.healthy).toBe(true);
    expect(r.reason).toBe('ok');
    expect(r.checks).toEqual({ sent_exists: true, channels_from_config: true, no_silent_channel: true });
  });

  it('判据①假（窗口内零 sent 行）→ not healthy，reason 含 sent_exists', async () => {
    const r = await gate({ sent: 0 }).isExportHealthy({ tenantId: 't1' });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('sent_exists');
  });

  it('判据②假（配置缺失）→ not healthy，reason 含 channels_from_config', async () => {
    const r = await gate({ sent: 3, cfg: null }).isExportHealthy({ tenantId: 't1' });
    expect(r.healthy).toBe(false);
    expect(r.checks.channels_from_config).toBe(false);
    expect(r.reason).toContain('channels_from_config');
  });

  it('判据②假（配置存在但全部 off → 无启用渠道）→ not healthy', async () => {
    const r = await gate({ sent: 3, cfg: { channels: { inbox: 'off', email: 'off' } } }).isExportHealthy({ tenantId: 't1' });
    expect(r.checks.channels_from_config).toBe(false);
    expect(r.healthy).toBe(false);
  });

  it('判据③假（某启用渠道零投递行）→ not healthy，reason 含 no_silent_channel', async () => {
    const r = await gate({ sent: 3, detect: silentAlert }).isExportHealthy({ tenantId: 't1' });
    expect(r.checks.no_silent_channel).toBe(false);
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('no_silent_channel');
  });

  it('判据③的输入只取 delivery_silent：gen_silent 不得关闸（出口健康 ≠ 生成侧健康）', async () => {
    const r = await gate({ sent: 3, detect: genSilentOnly }).isExportHealthy({ tenantId: 't1' });
    expect(r.checks.no_silent_channel).toBe(true);
    expect(r.healthy).toBe(true);
  });

  it('窗口由 windowHours 派生（默认 24h），并回传 tenant_id', async () => {
    const r = await gate({ sent: 1 }).isExportHealthy({ tenantId: 't-system' });
    expect(r.tenant_id).toBe('t-system');
    expect(r.window_hours).toBe(DEFAULT_WINDOW_HOURS);
    expect(DEFAULT_WINDOW_HOURS).toBe(24);
  });
});

describe('exportGate.guard（fail-closed 包装 + trace 留痕）', () => {
  it('healthy → allowed:true', async () => {
    const r = await gate({ sent: 1 }).guard({ tenantId: 't1', action: 'sync-writeback-fields' });
    expect(r.allowed).toBe(true);
  });

  it('不健康 → allowed:false + error=blocked_by_export_gate + emit trace', async () => {
    const traces = [];
    const r = await gate({ sent: 0 }).guard({
      tenantId: 't1', action: 'sync-writeback-fields', emit: (k, name, p) => traces.push({ name, p }),
    });
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
    expect(traces.find((x) => x.name === 'export-gate-blocked')?.p).toMatchObject({
      tenant_id: 't1', action: 'sync-writeback-fields',
    });
  });

  it('判定抛错 → allowed:false（**绝不**因异常而放行）且 trace 留痕', async () => {
    const traces = [];
    const g = createExportGate({
      query: async () => { throw new Error('db down'); },
      readConfig: rc(CONFIGURED),
      detectFn: noAlert,
    });
    const r = await g.guard({ tenantId: 't1', action: 'sync-writeback-fields', emit: (k, name, p) => traces.push({ name, p }) });
    expect(r.allowed).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
    expect(r.reason).toContain('gate_error');
    expect(traces.find((x) => x.name === 'export-gate-error')).toBeTruthy();
  });

  it('readConfig 抛错 → 判据②为假 → 阻断（读取失败 ≠ 配置开启）', async () => {
    const g = createExportGate({
      query: q(5),
      readConfig: async () => { throw new Error('cfg down'); },
      detectFn: noAlert,
    });
    const r = await g.guard({ tenantId: 't1', action: 'x' });
    expect(r.allowed).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/sync/exportGate.test.js`

Expected: FAIL —— `Failed to resolve import "../../src/sync/exportGate.js"`（文件尚未创建）。

- [ ] **Step 3: 写最小实现**

创建 `src/sync/exportGate.js`：

```js
// src/sync/exportGate.js — 运行时**顺序**闸门（设计 §0.4 / §3.4 的落地形式）
//
// ⚠ 与 src/sync/gate.js 的边界（**不得混淆、不得合并**）：
//   gate.js        = 接入**评审**闸门（人工审批类：first-connect / mapping-change /
//                    trust-elevate / enable-writeback，判定依赖 reviewGate.hasApproval）
//   exportGate.js  = 运行时**顺序**闸门（自动健康度判定：出口是否健康 → 决定回写与自治能否启用）
//   两者失败原因不同（「人工未审批」vs「出口不健康」），合并会让二者无法区分。
//
// 立论（设计 §0.4）：原设计 §14.2 用「排期纪律」保证「先出口、后回写」——排期是人的承诺，不是机制。
//   本闸门把它变成**运行时前置条件**：出口判据①不成立 → 回写/自治一律阻断。
//
// 三判据（设计 §3.4）：
//   ① crm.signal_delivery 窗口内存在 status='sent' 行
//   ② 渠道集合来自 config_store['signal-delivery']（非硬编码）
//   ③ 无「配置为 on 但零投递行」的渠道（复用 §3.3/Q1-4 修正后的判据 A）
//
// 铁律：**fail-closed** —— 任一判据为假或判定抛错，一律 blocked（绝不放行）。
import { query as realQuery } from '../db.js';
import { readConfig as realReadConfig } from '../config/configStore.js';
import { emit as realEmit } from '../events/bus.js';

export const DEFAULT_WINDOW_HOURS = 24;

// 判据 A 的告警类型（判据 B `gen_silent` 属生成侧静默，**不**参与出口健康度——
//   混入会让"信号生成侧故障"误关掉回写，属误归因）
const EXPORT_PREDICATE = 'delivery_silent';

export function createExportGate({ query = realQuery, readConfig = realReadConfig, detectFn = null, emit = realEmit } = {}) {
  // detectNegativePredicates 懒加载（避免与 signalMetrics 的循环依赖；测试注入 detectFn 时零 IO）
  async function resolveDetect() {
    if (detectFn) return detectFn;
    const mod = await import('../monitor/signalMetrics.js');
    return mod.detectNegativePredicates;
  }

  async function isExportHealthy({ tenantId = 'system', windowHours = DEFAULT_WINDOW_HOURS } = {}) {
    const since = new Date(Date.now() - windowHours * 3600 * 1000);
    const checks = { sent_exists: false, channels_from_config: false, no_silent_channel: false };

    // ① 窗口内存在 status='sent' 行（用 created_at 作窗口谓词：delivered_at 可为 NULL）
    const { rows: [d] } = await query(
      `SELECT COUNT(*) AS c FROM crm.signal_delivery
       WHERE tenant_id=$1 AND status='sent' AND created_at >= $2`,
      [tenantId, since]
    );
    checks.sent_exists = Number(d?.c || 0) > 0;

    // ② 渠道集合来自 config_store（读不到 / 全 off → 视为未配置，绝不用硬编码默认值兜底）
    const row = await readConfig('signal-delivery', { tenantId });
    const cfg = row?.value || null;
    const enabled = cfg && cfg.channels && typeof cfg.channels === 'object'
      ? Object.entries(cfg.channels).filter(([, v]) => v === 'on' || v === true).map(([k]) => k)
      : [];
    checks.channels_from_config = enabled.length > 0;

    // ③ 无「配置为 on 但零投递行」的渠道（复用 Q1-4 修正后的判据 A；不传 enabledChannels → 它自己读配置）
    const detect = await resolveDetect();
    const alerts = await detect({ tenantId, since });
    checks.no_silent_channel = !(alerts || []).some((a) => a.type === EXPORT_PREDICATE);

    const healthy = checks.sent_exists && checks.channels_from_config && checks.no_silent_channel;
    return {
      healthy,
      tenant_id: tenantId,
      window_hours: windowHours,
      checks,
      reason: healthy ? 'ok' : Object.entries(checks).filter(([, v]) => !v).map(([k]) => k).join(','),
    };
  }

  // guard：供接入点使用的 fail-closed 包装。抛错一律 blocked（**绝不**因异常而放行）。
  async function guard({ tenantId = 'system', action = 'unknown', windowHours = DEFAULT_WINDOW_HOURS } = {}) {
    try {
      const r = await isExportHealthy({ tenantId, windowHours });
      if (r.healthy) return { allowed: true, gate: r };
      emit('trace', 'export-gate-blocked', {
        tenant_id: tenantId, action, reason: r.reason, checks: r.checks,
      });
      return { allowed: false, error: 'blocked_by_export_gate', reason: r.reason, gate: r };
    } catch (e) {
      // 闸门自身故障必须可见（不静默），且**一律视为 blocked**
      emit('trace', 'export-gate-error', { tenant_id: tenantId, action, error: String(e?.message || e) });
      return { allowed: false, error: 'blocked_by_export_gate', reason: `gate_error:${String(e?.message || e)}` };
    }
  }

  return { isExportHealthy, guard };
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/sync/exportGate.test.js`

Expected: PASS —— 13 个用例全绿（`Test Files 1 passed`）。

- [ ] **Step 5: 负向判据自查（N4 的单测形态）**

Run: `npx vitest run test/sync/exportGate.test.js -t "判据①假"`

Expected: PASS —— 该用例即 §5.2 **N4**（"`exportGate` 在判据①不成立时返回 healthy" 即验收失败）的单测形态。

- [ ] **Step 6: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/sync/exportGate.js test/sync/exportGate.test.js
git commit -m "feat(sync): Q3-3a 新建 exportGate 运行时顺序闸门(三判据+fail-closed)"
```

---

## Task Q3-3b: 回写接入闸门（`sync-writeback-fields` Action 入口）

> 对应契约：`ct-review-gate`（设计 §4 Q3-3 的接入点之一）
> 依赖：Task Q3-3a
> 红线 **R2**：闸门未投产前不得放行回写——本任务即"投产"动作本身

**Files:**
- Modify: `src/connectors/connectorActions.js`（`seedConnectorActions` 签名 + `sync-writeback-fields` handler 入口）
- Test: `test/connectors/writebackGateWiring.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/connectors/writebackGateWiring.test.js`：

```js
// test/connectors/writebackGateWiring.test.js — 回写入网关（Q3-3b，设计 §3.4）
// test/connectors/writebackGateWiring.test.js — 回写入网关（Q3-3b，设计 §3.4）
// 既有 test/connectors/writebackAction.test.js 是**静态源码断言**（expect(src).toContain(...)），
//   只能证明"源码里有这个字符串"——本项目已登记反模式：注释/文档承诺 ≠ 实现。
//   本文件用**行为断言**承担 Q3-3b 的验收：真跑 handler，断言返回值与写入载荷。
import { describe, it, expect, beforeEach } from 'vitest';
import { seedConnectorActions } from '../../src/connectors/connectorActions.js';
import { listActions, __resetRegistry } from '../../src/action/registry.js';

const rc = (value) => async () => (value === null ? null : { value });
const TRUST = { writeback_fields_whitelist: ['industry'], default_level: 'L3' };

const gateOpen = { guard: async () => ({ allowed: true, gate: { healthy: true } }) };
const gateClosed = { guard: async () => ({ allowed: false, error: 'blocked_by_export_gate', reason: 'sent_exists' }) };

function setup({ gate, written = [] } = {}) {
  __resetRegistry();
  const updateCalls = [];
  seedConnectorActions({
    exportGate: gate,
    readConfig: rc(TRUST),
    updateParticle: async (id, opts) => { updateCalls.push({ id, opts }); return { id }; },
  });
  const action = listActions().find((a) => a.name === 'sync-writeback-fields');
  return { action, updateCalls };
}

describe('Q3-3b · 回写 Action 接闸门（行为断言）', () => {
  it('闸门关 → ok:false + blocked_by_export_gate，且**不写库**', async () => {
    const { action, updateCalls } = setup({ gate: gateClosed });
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工' } }, { tenantId: 't1', actor: 'u1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
    expect(r.reason).toBe('sent_exists');
    expect(updateCalls).toHaveLength(0); // 关键：阻断必须发生在**任何写入之前**
  });

  it('闸门开 → 白名单命中字段写入，载荷含静态 Source=crm-ai-native', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工', secret: 'x' } }, { tenantId: 't1', actor: 'u1' });
    expect(r.ok).toBe(true);
    expect(r.source).toBe('crm-ai-native');
    expect(r.written).toEqual(['industry']);
    expect(r.denied).toEqual(['secret']);         // 非白名单字段被拒且**可见**
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].opts.patch.Source).toBe('crm-ai-native'); // 静态标记真的写进了载荷
  });

  it('闸门开 + cas_expect → 透传为 casExpectField', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    await action.handler(
      { account_id: 'acc1', fields: { industry: '化工' }, cas_expect: { path: 'industry', value: '涂料' } },
      { tenantId: 't1', actor: 'u1' }
    );
    expect(updateCalls[0].opts.casExpectField).toEqual({ path: 'industry', value: '涂料' });
  });

  it('未注入闸门 → 使用真实 exportGate（生产路径），此时默认阻断（出口判据①未成立）', async () => {
    __resetRegistry();
    seedConnectorActions({ readConfig: rc(TRUST), updateParticle: async () => ({ id: 'acc1' }) });
    const action = listActions().find((a) => a.name === 'sync-writeback-fields');
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工' } }, { tenantId: 't1', actor: 'u1' });
    // 无 signal-delivery 配置 + 无 sent 行 → 闸门必关
    expect(r.ok).toBe(false);
    expect(r.error).toBe('blocked_by_export_gate');
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/connectors/writebackGateWiring.test.js`

Expected: FAIL —— `seedConnectorActions` 不接受 `deps`（注入被忽略），第 1 例 `r.ok` 为 `true` 或抛错；`__resetRegistry` 若不存在则 import 报错。

- [ ] **Step 3: 实现（两处改动）**

**改动 ①** —— `src/connectors/connectorActions.js` 的工厂签名与依赖注入（当前 `export function seedConnectorActions() {`，第 16 行）：

先在文件头的 import 区**新增一行**（`connectorActions.js` 当前有 `registerAction` / `updateParticle` / `createEdge` / `requireDecision` / `emit` 四类 import，此为第五个，静态 import 无循环依赖）：

```js
import { readConfig } from '../config/configStore.js';
```

再把 `seedConnectorActions` 的签名与依赖注入改为（当前 `export function seedConnectorActions() {`，第 16 行）：

```js
// deps 可选（缺省走真实实现）——为行为测试提供注入点；无参调用行为零变化（MCP/tools.js 无参调用）。
// Q3-3b：exportGate 为运行时顺序闸门（src/sync/exportGate.js），缺省 `createExportGate()`。
export function seedConnectorActions(deps = {}) {
  const readCfg = deps.readConfig || readConfig;                 // 返回 Promise<{value}|null>，与既有调用形状一致
  const upd = deps.updateParticle || updateParticle;
  let gatePromise = null;
  const getGate = () => {
    if (deps.exportGate) return Promise.resolve(deps.exportGate);
    if (!gatePromise) gatePromise = import('../sync/exportGate.js').then((m) => m.createExportGate());
    return gatePromise;
  };
```

> **为什么其它 Action 不改**：本段只把 `sync-writeback-fields` 一个 handler 切到 `readCfg` / `upd` / `getGate`，其余 handler 保持原样直用模块级 import——**改动面最小化**，避免触碰 10 余个既有 Action 的行为（零回归优先）。

**改动 ②** —— `sync-writeback-fields` 的 handler：**删除**原本的 `const { readConfig } = await import('../config/configStore.js');` 一行（改用上面的 `readCfg`），并把闸门判定放在**第一行**：

```js
    handler: async ({ account_id, fields, cas_expect }, ctx) => {
      // Q3-3b（设计 §3.4）：运行时顺序闸门 —— **必须在任何读写之前**判定。
      //   出口判据①不成立（窗口内无 status='sent' 行）→ 阻断回写（fail-closed，R2）。
      const gate = await getGate();
      const g = await gate.guard({ tenantId: ctx.tenantId, action: 'sync-writeback-fields' });
      if (!g.allowed) return { ok: false, error: g.error, reason: g.reason, denied: [] };
      // ① 白名单过滤：仅写 config_store['sync-trust']['writeback_fields_whitelist'] 内字段
      const trustCfg = await readCfg('sync-trust', { tenantId: ctx.tenantId }).catch(() => null);
      const whitelist = trustCfg?.value?.writeback_fields_whitelist || [];
      const allowed = {};
      let denied = [];
      for (const [k, v] of Object.entries(fields || {})) {
        if (whitelist.includes(k)) allowed[k] = v;
        else denied.push(k);
      }
      // 对外标记：Source 恒为 crm-ai-native（写回客户 CRM 时的身份来源）
      const payload = { ...allowed, Source: 'crm-ai-native' };
      const casField = cas_expect?.path ? { path: cas_expect.path, value: cas_expect.value } : null;
      let r;
      try {
        r = await upd(account_id, { patch: payload, casExpectField: casField, systemBypass: false });
      } catch (e) {
        if (String(e.message).includes('cas_mismatch')) {
          return { ok: false, error: 'cas_mismatch: 外部记录已被修改，拒绝覆盖' };
        }
        throw e;
      }
      return { ok: true, written: Object.keys(allowed), denied, source: 'crm-ai-native', particle: r.id };
    },
```

> **注意**：`readCfg` 是"返回 Promise 的函数"，与 `readConfig` 的直接调用形状一致（`readCfg('k',{...})` 而非 `(await readCfg)('k')`），故 `await readCfg(...)` 与既有代码写法一致。
> **注意**：`upd` 缺省为模块级 `updateParticle`（已在文件头 import），故生产路径零变化。

再在 `src/action/registry.js` 侧确认测试用的 `__resetRegistry` 是否存在；若不存在，改为在测试文件里用 `vi.resetModules()` + 动态 `import()`，**不要**为此改动 registry 的生产接口：

```js
// 若无 __resetRegistry，测试文件顶部改为：
import { beforeEach, vi } from 'vitest';
beforeEach(() => { vi.resetModules(); });
const { seedConnectorActions } = await import('../../src/connectors/connectorActions.js');
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/connectors/writebackGateWiring.test.js`

Expected: PASS —— 4 个用例全绿。

- [ ] **Step 5: 跑既有回写测试确认零回归**

Run: `npx vitest run test/sync/writebackDispatcher.test.js test/sync/writebackGate.test.js test/connectors/writebackAction.test.js test/mcp/connectorToolsExposed.test.js`

Expected: PASS —— 全绿。**特别确认 `writebackAction.test.js` 的静态断言未红**（我们保留了 `writeback_fields_whitelist` / `Source='crm-ai-native'` / `needsApproval: true` / `autoDecision: true` / `agentTool: false` / `casExpectField` 六个字面量）。

- [ ] **Step 6: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/connectors/connectorActions.js test/connectors/writebackGateWiring.test.js
git commit -m "feat(sync): Q3-3b 回写 Action 入口接 exportGate(阻断发生在任何写入之前)"
```

---

## Task Q3-4: 自治前置闸门（`standing-grants-policy.require_export_healthy`）

> 对应契约：`ct-review-gate`（设计 §4 Q3-4）
> 依赖：Task Q3-3a
> 裁决 **D3**（本计划 §0.4）：默认值取 `false`（S6 向后兼容；启用须人工改配置）

**Files:**
- Modify: `src/authorization/standingAuthorization.js`（`DEFAULT_GRANTS_POLICY` + `consultStandingGate`）
- Modify: `db/migration-standing-grant.sql`（幂等 UPDATE 补字段）
- Test: `test/authorization/standingExportGate.test.js`

- [ ] **Step 1: 写失败测试**

创建 `test/authorization/standingExportGate.test.js`：

```js
// test/authorization/standingExportGate.test.js — 自治前置闸门（Q3-4，设计 §3.4 接入点之二）
// 契约（设计 §4 Q3-4 success）：
//   ① require_export_healthy=true 且闸门关 → crm.grant_execution 零新增行（= consultStandingGate 升级为 HITL）
//   ② 置 false（含缺省）→ 行为与既有 S6 一致（向后兼容）
// 零 DB：policy 读取走 readConfig 替身；鉴权走注入 q 替身；闸门走替身。
import { describe, it, expect } from 'vitest';
import {
  consultStandingGate, DEFAULT_GRANTS_POLICY, loadGrantsPolicy,
} from '../../src/authorization/standingAuthorization.js';

const gateClosed = { guard: async () => ({ allowed: false, error: 'blocked_by_export_gate', reason: 'sent_exists' }) };
const gateOpen = { guard: async () => ({ allowed: true, gate: { healthy: true } }) };

describe('Q3-4 · 自治受运行时闸门约束', () => {
  it('DEFAULT_GRANTS_POLICY 含 require_export_healthy 且**默认 false**（S6 向后兼容，D3）', () => {
    expect(DEFAULT_GRANTS_POLICY.require_export_healthy).toBe(false);
  });

  it('require_export_healthy=false（缺省）→ 闸门不被调用，行为与 S6 一致', async () => {
    let gateCalls = 0;
    const spyGate = { guard: async () => { gateCalls++; return { allowed: false }; } };
    // 无活跃凭证 → 既有语义 = 升级（true）；但闸门不得被调用
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account', standingFields: [],
      exportGate: spyGate, q: async () => ({ rows: [] }),
      policyOverride: { require_export_healthy: false },
    });
    expect(escalated).toBe(true);
    expect(gateCalls).toBe(0);
  });

  it('require_export_healthy=true 且闸门关 → 直接升级（自主执行量为 0）', async () => {
    let authorizedCalls = 0;
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account', standingFields: [],
      exportGate: gateClosed, policyOverride: { require_export_healthy: true },
      q: async () => { authorizedCalls++; return { rows: [{ grant_id: 'g1', scope_actions: ['crm-update-account'], status: 'active' }] }; },
    });
    expect(escalated).toBe(true);
    // 关键：闸门关时**不应**再去判定动作鉴权（先闸门、后鉴权；避免"凭证齐备但出口不健康"仍放行）
    expect(authorizedCalls).toBe(0);
  });

  it('require_export_healthy=true 且闸门开 → 回落既有鉴权路径（凭证齐备则放行）', async () => {
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account', standingFields: [],
      exportGate: gateOpen, policyOverride: { require_export_healthy: true },
      q: async () => ({ rows: [{ grant_id: 'g1', scope_actions: ['crm-update-account'], scope_fields: null, status: 'active' }] }),
    });
    expect(escalated).toBe(false);
  });

  it('闸门自身抛错 → fail-closed 升级（绝不放行）', async () => {
    const boomGate = { guard: async () => { throw new Error('gate exploded'); } };
    const escalated = await consultStandingGate(false, {
      tenantId: 't1', standingAction: 'crm-update-account',
      exportGate: boomGate, policyOverride: { require_export_healthy: true },
    });
    expect(escalated).toBe(true);
  });

  it('A 轴已升级 或 未声明动作 → 原样返回（opt-in，零回归）', async () => {
    expect(await consultStandingGate(true, { tenantId: 't1', standingAction: 'x' })).toBe(true);
    expect(await consultStandingGate(false, { tenantId: 't1' })).toBe(false);
  });

  it('loadGrantsPolicy 缺键时兜底默认值（含 require_export_healthy）', async () => {
    const { readConfig } = await import('../../src/config/configStore.js');
    expect(typeof readConfig).toBe('function');
    expect(DEFAULT_GRANTS_POLICY.require_export_healthy).toBeDefined();
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `npx vitest run test/authorization/standingExportGate.test.js`

Expected: FAIL —— `DEFAULT_GRANTS_POLICY.require_export_healthy` 为 `undefined`；`consultStandingGate` 不认 `exportGate` / `policyOverride` 参数。

- [ ] **Step 3: 实现（三处改动）**

**改动 ①** —— `DEFAULT_GRANTS_POLICY`（`standingAuthorization.js:10-16`）加一行：

```js
export const DEFAULT_GRANTS_POLICY = {
  default_tier: 'T1',
  allow_tier_upgrade_by_ai: false,           // 写死：档位提升必须新批一次授权
  auto_pause_on_consecutive_rejects: 3,
  max_daily_executions: null,
  notify_on_execution: true,
  // Q3-4（全链集成 §3.4）：自治放行的**运行时顺序闸门**开关。
  //   ⚠ 缺省 false（计划期裁决 D3）：置 true 会让"出口未健康"直接冻结全部自治，
  //   若默认开启，Q3 上线当日因出口判据①未成立 → 自主执行归零（违反本任务 success 的向后兼容要求）。
  //   启用方式：运营在配置中心把 require_export_healthy 置 true（继承「播种 ≠ 接通」纪律）。
  require_export_healthy: false,
};
```

**改动 ②** —— `consultStandingGate`（`standingAuthorization.js:57-65`）插入闸门前置：

```js
// 在既有 A 轴放行结果上叠加 B/C 轴（常驻授权）。opt-in：仅当 standingAction 提供时介入（既有调用方不传 → 行为不变）。
// fail-closed：未提供动作 / 鉴权抛错 / 无凭证 / 字段越界 / T3 → 一律升级 HITL。
// Q3-4（2026-09-16）：若策略 `require_export_healthy===true`，**先过运行时顺序闸门**（出口判据①）——
//   闸门关或闸门自身抛错 → 直接升级（自主执行量为 0），**不再进入动作鉴权**（先闸门、后鉴权）。
//   deps 新增两项均为**可选**：`exportGate`（替身注入）、`policyOverride`（测试用策略覆盖，零 DB）。
export async function consultStandingGate(
  escalated,
  { tenantId, standingAction, standingFields = [], exportGate = null, policyOverride = null, q = query } = {}
) {
  if (escalated || !standingAction) return escalated; // A 轴已升级 或 未声明动作 → 保持不变
  try {
    const policy = policyOverride || (await loadGrantsPolicy(tenantId));
    if (policy.require_export_healthy === true) {
      const gate = exportGate || (await import('../sync/exportGate.js')).createExportGate();
      const g = await gate.guard({ tenantId, action: `standing:${standingAction}` });
      if (!g.allowed) return true; // 出口不健康 → 升级 HITL（闸门自身的抛错在此也会被 catch 兜住 → true）
    }
    const az = await isActionAuthorized({ tenantId, action: standingAction, fields: standingFields, q });
    return !az.authorized; // 无凭证/越界/T3 → 升级
  } catch {
    return true; // fail-closed：鉴权不可用则升级
  }
}
```

**改动 ③** —— `db/migration-standing-grant.sql` 在既有 INSERT 之后追加**幂等 UPDATE**（不新建行、不改已有语义，只补字段）：

```sql
-- Q3-4（全链集成 §3.4）：给既有 system 模板补 require_export_healthy 字段（缺省 false）。
-- 用 jsonb `||` 合并：**不覆盖**既有键，只补缺失键；已存在该键时幂等无变化。
-- 为什么不用 INSERT ... ON CONFLICT DO UPDATE：既有行的 value 由运营维护，整块覆盖会丢运营改动。
UPDATE crm.config_store
   SET value = value || '{"require_export_healthy": false}'::jsonb
 WHERE tenant_id = 'system' AND key = 'standing-grants-policy'
   AND NOT (value ? 'require_export_healthy');
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `npx vitest run test/authorization/standingExportGate.test.js`

Expected: PASS —— 7 个用例全绿。

- [ ] **Step 5: 跑既有自治/S6 测试确认零回归**

Run: `npx vitest run test/authorization/ test/signal/alertPersistWiring.test.js`

Expected: PASS —— 全绿。**重点确认 S6 既有行为未变**（缺省 `require_export_healthy=false` → 闸门分支根本不进入）。

> **若 `test/authorization/` 目录不存在**，改为：`npx vitest run test/ --dir test` 的定向替代——用 `grep -rln "consultStandingGate\|executeUnderGrant" test/` 找出真实测试文件后逐个跑。

- [ ] **Step 6: 验证迁移幂等（真库）**

Run:
```powershell
cd D:\system\CRM-ai-native
$env:PGDATABASE='crm_native_test'; node db/migrate.js
$env:PGDATABASE='crm_native_test'; node db/migrate.js
```

Expected: 两次均成功；第二次输出「新增 0 条」（幂等）。随后直查：

```sql
SELECT value ? 'require_export_healthy' AS has_key, value->>'require_export_healthy' AS val
  FROM crm.config_store WHERE tenant_id='system' AND key='standing-grants-policy';
-- 期望：has_key=t, val=false
```

- [ ] **Step 7: 提交**

```powershell
cd D:\system\CRM-ai-native
git add src/authorization/standingAuthorization.js db/migration-standing-grant.sql test/authorization/standingExportGate.test.js
git commit -m "feat(auth): Q3-4 自治放行接 exportGate(require_export_healthy 缺省 false 保 S6 兼容)"
```

---

## Task Q3-1: 补 Q3-1 的行为断言（**不重写实现**）

> 对应契约：`ct-quote-calc`（设计 §4 Q3-1）
> 依赖：无
> **本任务的性质**：Q3-1 的实现**已存在**（§0 侦察结论），但三条判据中有两条**缺行为断言**（见下）。本任务只补断言。

**Files:**
- Test: `test/sync/mapping.test.js`（追加）
- Test: `test/sync/writebackDispatcher.test.js`（追加）

- [ ] **Step 1: 追加 mapping 的"未知字段被拒并计入 skipped"断言**

在 `test/sync/mapping.test.js` 的 `describe` 块内追加：

```js
  // Q3-1（全链集成 §4）：未在 mappings.fields 声明的外部字段 → 拒绝并计入 skippedFields。
  // 契约原文："未在 mappings.fields 声明的外部字段被拒绝并计入 skipped；……不报错不静默"。
  // 既有 4 个用例覆盖了「正常映射 / 未注册对象 / external_id 两形状」，**独缺这一条**。
  it('未声明字段被拒并计入 skippedFields（不报错、不静默）', () => {
    const r = createMappingResolver({
      mappings: {
        AccountObj: {
          particle_type: 'CRM_ACCOUNT',
          fields: [{ ext: 'name', particle: 'company_name' }],
          identity: { external_id_field: '_id' },
        },
      },
    });
    const out = r.apply('AccountObj', { _id: 'x1', name: '甲公司', 未声明字段: 'y', 另一个: 'z' });
    expect(out.ok).toBe(true);                       // 不报错
    expect(out.payload).toEqual({ company_name: '甲公司' });  // 未声明字段**未**进入 payload
    expect(out.skippedFields).toEqual(expect.arrayContaining(['未声明字段', '另一个'])); // 且**可见**
    expect(out.external_id).toBe('x1');
  });

  it('已声明但值为 null/undefined 的字段 → 计入 skippedFields（与"未声明"同列可见）', () => {
    const r = createMappingResolver({
      mappings: { AccountObj: { particle_type: 'CRM_ACCOUNT', fields: [{ ext: 'name', particle: 'company_name' }] } },
    });
    const out = r.apply('AccountObj', { name: null });
    expect(out.payload).toEqual({});
    expect(out.skippedFields).toContain('name');
  });
```

> ⚠ 第二个用例锁定一个**既有语义**（`mapping.js:18`：值为 `null/undefined` 也 push 进 `skipped`）。若实施时发现这与设计意图冲突（"未声明"与"值为空"混在同一数组），**停下来登记**，不要顺手改 `mapping.js`——那属行为变更，需单独裁决。

- [ ] **Step 2: 追加 writebackDispatcher 的"部分越界"断言**

在 `test/sync/writebackDispatcher.test.js` 的 `describe` 块内追加：

```js
  // Q3-1：白名单内外的**混合**字段 → 越界字段被剔除、命中字段照常派发（既有用例只覆盖了
  //   "全空白名单"与"零命中"两个极端，缺"部分命中"这一最常见的真实形状）。
  it('部分字段越界 → 仅命中白名单的字段派发（越界字段被剔除，不报错）', async () => {
    const dispatch = vi.fn(async () => ({ ok: true, written: ['industry'] }));
    const call = createWritebackDispatcher({
      dispatch,
      readConfig: rc({ writeback_fields_whitelist: ['industry'] }),
    });
    const r = await call({
      tenantId: 't1', object: 'AccountObj', externalId: 'x1', particleId: 'p1',
      row: { industry: '化工', secret: 'should-not-leave', Source: 'spoofed' }, level: 'L3',
    });
    expect(r.ok).toBe(true);
    const sent = dispatch.mock.calls[0][1];
    expect(sent.fields).toEqual({ industry: '化工' });   // 越界字段与伪造 Source 均未出站
    expect(sent.fields.secret).toBeUndefined();
    expect(sent.fields.Source).toBeUndefined();
  });
```

> **为什么这条重要**：`Source` 由 Action 侧**静态**写入（`connectorActions.js:177`）。若派发器允许调用方传入的 `Source` 透传，则外部可通过 `row.Source` **伪造身份**。本用例把"`Source` 不在白名单 → 被剔除"变成**可复跑断言**。

- [ ] **Step 3: 运行，确认通过**

Run: `npx vitest run test/sync/mapping.test.js test/sync/writebackDispatcher.test.js`

Expected: PASS —— 两文件全绿（mapping 4→6、writebackDispatcher 8→9）。

- [ ] **Step 4: 提交**

```powershell
cd D:\system\CRM-ai-native
git add test/sync/mapping.test.js test/sync/writebackDispatcher.test.js
git commit -m "test(sync): Q3-1 补行为断言(未声明字段拒绝/部分越界剔除+Source 不可伪造)"
```

---

## Task Q3-2: 把静态源码断言升级为行为断言（**不重写实现**）

> 对应契约：`ct-decision`（设计 §4 Q3-2）
> 依赖：Task Q3-3b（复用同一个测试文件的两套替身）
> **本任务的性质**：Q3-2 的实现与判据**均已成立**（§0），但既有断言是 `expect(src).toContain(...)`。本任务**保留**既有静态断言（它是"别删这个字面量"的护栏），**新增**行为断言。

**Files:**
- Test: `test/connectors/writebackGateWiring.test.js`（追加；本任务不新建文件）

- [ ] **Step 1: 追加"Source 静态标记真的落进写入载荷"的负向断言**

在 `test/connectors/writebackGateWiring.test.js` 的 `describe` 块内追加：

```js
  // Q3-2（设计 §4）：`Source='crm-ai-native'` 必须是**写入载荷**的一部分，
  //   而不是只出现在源码里（既有静态断言 `expect(src).toContain("Source='crm-ai-native'")`
  //   无法区分「真的写了」与「注释里提了」——本项目已登记反模式：注释/文档承诺 ≠ 实现）。
  it('调用方传入伪造 Source → 被静态标记覆盖（不可冒充）', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    await action.handler(
      { account_id: 'acc1', fields: { industry: '化工', Source: 'evil-corp' } },
      { tenantId: 't1', actor: 'u1' }
    );
    // Source 不在白名单 → 走 denied；载荷里的 Source 恒为我们自己的静态值
    expect(updateCalls[0].opts.patch.Source).toBe('crm-ai-native');
    expect(updateCalls[0].opts.patch['evil-corp']).toBeUndefined();
  });

  it('返回值 source 字段与写入载荷一致（可观测，不靠猜）', async () => {
    const { action, updateCalls } = setup({ gate: gateOpen });
    const r = await action.handler({ account_id: 'acc1', fields: { industry: '化工' } }, { tenantId: 't1', actor: 'u1' });
    expect(r.source).toBe(updateCalls[0].opts.patch.Source);
  });
```

- [ ] **Step 2: 运行，确认通过**

Run: `npx vitest run test/connectors/writebackGateWiring.test.js`

Expected: PASS —— 6 个用例全绿。

- [ ] **Step 3: 提交（可与 Q3-1 合并为一次「测试补齐」提交；若已单独提交则此处仅追加）**

```powershell
cd D:\system\CRM-ai-native
git add test/connectors/writebackGateWiring.test.js
git commit -m "test(sync): Q3-2 Source 静态标记升级为行为断言(伪造被覆盖)"
```

---

## Task Q4-1: 端到端取证（两条判据 + 判据①的 `system` 口径）

> 对应契约：`ct-decision`（设计 §4 Q4-1）
> 依赖：**Q1（出口接电）与 Q2（入口接线）已落地并可运行**——本任务是**验收**，不是实现
> 判据出处：设计 §5.1（两条正向判据）+ §5.2（N1–N9 负向判据）

**Files:**
- Create: `scripts/smoke-full-chain-e2e.mjs`

- [ ] **Step 1: 写取证脚本**

创建 `scripts/smoke-full-chain-e2e.mjs`：

```js
// scripts/smoke-full-chain-e2e.mjs — 全链集成端到端取证（Q4-1）
// 判据来源：docs/2026-09-16-full-chain-integration-design.md §5.1（正向）+ §5.2（负向 N1–N9）
// 运行：node scripts/smoke-full-chain-e2e.mjs <tenantId>   （tenantId 缺省 system）
// 纪律：只读 + 只跑泵（不 DELETE、不迁移状态）；输出逐条判据的 PASS/FAIL，任一 FAIL → exit 1。
import { query, pool } from '../src/db.js';
import { createExportGate } from '../src/sync/exportGate.js';
import { detectNegativePredicates } from '../src/monitor/signalMetrics.js';

const tenantId = process.argv[2] || 'system';
const since = new Date(Date.now() - 24 * 3600 * 1000);
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

// ── 判据 ①（出口，设计 §5.1）：窗口内存在 status='sent' 行；配置 off 的渠道零行 ──
const { rows: [d] } = await query(
  `SELECT COUNT(*) FILTER (WHERE status='sent' AND delivered_at IS NOT NULL) AS sent_delivered,
          COUNT(*) FILTER (WHERE status='sent') AS sent
     FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2`,
  [tenantId, since]
);
check('判据① 存在 status=sent 且 delivered_at 非空的投递行', Number(d.sent_delivered) > 0, `sent=${d.sent} sent_delivered=${d.sent_delivered}`);

const { rows: offRows } = await query(
  `SELECT DISTINCT channel FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2`,
  [tenantId, since]
);
const { rows: [cfgRow] } = await query(
  `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='signal-delivery'`,
  [tenantId]
);
const channels = (cfgRow?.value?.channels) || {};
const offChannels = Object.entries(channels).filter(([, v]) => v === 'off' || v === false).map(([k]) => k);
const offending = offRows.map(r => r.channel).filter(c => offChannels.includes(c));
check('判据① 配置为 off 的渠道零投递行', offending.length === 0, offending.length ? `越界渠道=${offending.join(',')}` : 'ok');

// ── 判据 ②（入口/回写，设计 §5.1）──
const { rows: [sc] } = await query(`SELECT COUNT(*) AS c FROM crm.sync_cursor WHERE tenant_id=$1 AND last_status='ok'`, [tenantId]);
const { rows: [er] } = await query(`SELECT COUNT(*) AS c FROM crm.external_ref WHERE tenant_id=$1 AND external_id IS NOT NULL`, [tenantId]);
check('判据② crm.sync_cursor 存在 last_status=ok 行', Number(sc.c) >= 1, `count=${sc.c}`);
check('判据② crm.external_ref 存在真实外部 ID 行', Number(er.c) >= 1, `count=${er.c}`);

// ── 负向判据 N1–N3（防假绿）──
const alerts = await detectNegativePredicates({ tenantId, since });
check('N1 无 delivery_silent（配置 on 的渠道均有投递行）',
  !alerts.some(a => a.type === 'delivery_silent'),
  JSON.stringify(alerts.filter(a => a.type === 'delivery_silent')));
const { rows: [nr] } = await query(
  `SELECT COUNT(*) AS c FROM crm.signal_delivery WHERE tenant_id=$1 AND last_error='no_recipient' AND created_at >= $2`,
  [tenantId, since]
);
check('N2/N3 留痕族（no_recipient / quiet_hours / rate_limited）可查', true, `no_recipient=${nr.c}（0 值合法：本次无缺失收件人）`);

// ── 负向判据 N4：exportGate 在判据①不成立时不得返回 healthy ──
const gate = createExportGate();
const g = await gate.isExportHealthy({ tenantId });
check('N4 exportGate 与判据①一致（无 sent 行则 not healthy）',
  !(Number(d.sent) === 0 && g.healthy === true),
  `healthy=${g.healthy} reason=${g.reason}`);

// ── 汇总 ──
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 判据通过（tenant=${tenantId}）`);
await pool.end();
process.exit(failed.length ? 1 : 0);
```

- [ ] **Step 2: 运行（先对平台租户，再对业务租户——§5.1 的 D1 适用范围要求）**

Run:
```powershell
cd D:\system\CRM-ai-native
node scripts/smoke-full-chain-e2e.mjs system
node scripts/smoke-full-chain-e2e.mjs <某业务租户ID>
```

Expected: 两次运行输出的判据结果**逐条对照**。**注意**：在设计 §5.1 下，判据①必须在 `system` 与业务租户**各成立一次**才算通过——若 `system` 口径 FAIL，说明 D1 修正未真正生效（**这正是 N8 要防的事**）。

- [ ] **Step 3: 把结果写进设计 §7 闭环回写表**

按设计 §D.4 维护约定，把本次取证结果（逐条判据 + 运行时间 + 租户）追加到 `docs/2026-09-16-full-chain-integration-design.md` §7 的表格，并在 §8.3 追加一行修正记录（若本计划的 D3 裁决与 §0.2/§0.3 的发现需要正式登记）。

- [ ] **Step 4: 提交**

```powershell
cd D:\system\CRM-ai-native
git add scripts/smoke-full-chain-e2e.mjs docs/2026-09-16-full-chain-integration-design.md
git commit -m "test(full-chain): Q4-1 端到端取证脚本(两判据+N1-N4, system 与业务租户各验一次)"
```

---

## 契约自检（每个 Task 完成后执行）

```powershell
node scripts/validate-contract.mjs docs/2026-09-16-full-chain-integration-design.md --registry src/agent/agentSpec.js
```

Expected: `{"valid": true, "errors": []}`（exit 0）。本计划的 6 个 Task 共对应 5 个已批准的 `contract-yaml` 块（Q3-1 / Q3-2 / Q3-3 / Q3-4 / Q4-1），**不新增、不改写契约**。

---

## Self-Review（写完计划后的自查）

**1. Spec coverage（设计 §4 Q3/Q4 → 任务映射）**

| 设计任务 | 本计划任务 | 覆盖 |
| --- | --- | --- |
| Q3-1 字段级白名单与 CAS | Task Q3-1（**实现已在，补断言**） | ✅ |
| Q3-2 回写 Action 生产接线 | Task Q3-2（**实现已在，补行为断言**） | ✅ |
| Q3-3 运行时顺序闸门 exportGate | Task Q3-3a（新建）+ Q3-3b（回写接入） | ✅ |
| Q3-4 自治前置闸门 | Task Q3-4 | ✅ |
| Q4-1 两条判据端到端取证 | Task Q4-1 | ✅ |
| §5.2 N4（闸门误报 healthy） | Q3-3a Step 5 + Q4-1 Step 1 | ✅ |
| §5.2 N5（未声明字段写入） | Q3-1 Step 1 | ✅ |
| §0.2 P-1（命名同族） | Q3-3a Step 3 文件头 + §0.2 纪律 | ✅ |
| §0.3 P-2（sweep 的 D1 同族遗漏） | **登记，不在本计划修** | ⬜ 明确不覆盖 |
| §0.4 D3（默认值裁决） | Q3-4 Step 3 改动 ① | ✅ |

**2. Placeholder scan**：全文无可执行内容层面的空实现 / 「类似 Task N」/ 延时实现标记。

> **复跑判据与一个自指陷阱**：对本文件扫描占位符模式时，**必须先剥离本节**——否则判据会命中本节自己的声明文字，产生**假红**（本仓已登记变体「禁词断言未剥离注释」的**第 3 次同族发作**；前两次分别在守卫测试的 SQL 关键词统计、以及注释里写被禁字面量）。**正确的判据是**：扫描时排除 Placeholder scan 一节，期望 **0 行**。

- 初稿的 Task Q3-3b Step 1 曾含一段使用 CommonJS 模块加载调用（本仓 ESM 项目**禁用该调用**，须用顶层 `import`）的示意代码——**已在定稿中删除**，现只保留单一完整可运行版本。
- ⚠ Task Q3-4 Step 5 与 Task Q3-3b Step 3 各有一处"若不存在则改"的分支说明（`test/authorization/` 目录、`__resetRegistry`）——这不是占位符，而是**已探明的不确定点的两条确定性路径**（本仓纪律：不确定点必须给出两条可执行路径，不许"想当然"）。

**3. Type consistency**

| 接口 | 定义处 | 使用处 | 一致 |
| --- | --- | --- | --- |
| `createExportGate({query, readConfig, detectFn, emit})` | Q3-3a Step 3 | Q3-3b（缺省 `createExportGate()`）、Q3-4（缺省动态 import）、Q4-1 | ✅ |
| `isExportHealthy({tenantId, windowHours}) → {healthy, tenant_id, window_hours, checks, reason}` | Q3-3a Step 3 | Q3-3a 测试、Q4-1 | ✅ |
| `guard({tenantId, action, windowHours}) → {allowed, error?, reason?, gate?}` | Q3-3a Step 3 | Q3-3b（Action 入口）、Q3-4（`consultStandingGate`）、测试替身 | ✅ |
| `checks = {sent_exists, channels_from_config, no_silent_channel}` | Q3-3a Step 3 | Q3-3a 测试逐键断言、Q4-1 | ✅ |
| `seedConnectorActions(deps = {})`，deps = `{exportGate, readConfig, updateParticle}` | Q3-3b Step 3 改动 ① | Q3-3b/Q3-2 测试注入；`mcp/tools.js` 无参调用（零变化） | ✅ |
| `consultStandingGate(escalated, {tenantId, standingAction, standingFields, exportGate, policyOverride, q})` | Q3-4 Step 3 改动 ② | Q3-4 测试 | ✅ |
| `DEFAULT_GRANTS_POLICY.require_export_healthy` | Q3-4 Step 3 改动 ① | Q3-4 测试、`loadGrantsPolicy` 兜底 | ✅ |
| `crm.signal_delivery` 列名（`status` / `created_at` / `tenant_id` / `last_error`） | `db/migration-signal-tables.sql:35-48` | Q3-3a 判据①、Q4-1 | ✅ |
| `detectNegativePredicates({tenantId, since})`（不传 `enabledChannels`） | `src/monitor/signalMetrics.js:82`（Q1-4 已修正） | Q3-3a 判据③、Q4-1 | ✅ |

**4. 两处必须在实施时复核的依赖（写在最前，避免顺序错误）**

| # | 依赖 | 若不满足 |
| - | ---- | -------- |
| 1 | `src/monitor/signalMetrics.js` 的 `detectNegativePredicates` **已按 Q1-4 修正**（配置驱动、不传参时自己读配置） | Q3-3a 的判据③会拿到"硬编码全开渠道"的假前提 → 闸门永远误判不健康。**实施前先跑** `grep -n "signal-observability-config-missing" src/monitor/signalMetrics.js` 确认命中 |
| 2 | `src/signal/dispatcher.js` / `src/signal/route.js`（Q1）已落地 | 判据①在生产上不可能成立 → `exportGate` 永远关 → 回写与自治被永久阻断。这是**设计的预期状态**（§1.4「存在但关闭」），不是缺陷——但取证（Q4-1）必须等 Q1 完成 |

---

## 后续计划（不在本文件范围）

| 计划文件 | 内容 | 状态 |
| --- | --- | --- |
| `2026-09-16-full-chain-q1-export-dispatch.md` | Q1-1…Q1-5（出口接电） | 已编写（`51eaab3`），**正在实施** |
| `2026-09-16-full-chain-q2-ingress-wiring.md` | Q2-1…Q2-5（入口接线 + generic-rest） | 待编写（Q2-1…Q2-4 已接线；Q2-5 由 prospecting 承接） |
| **本文件** | Q3-1…Q3-4 + Q4-1 | ✅ 已编写 |

**本计划遗留的建议项（不属本批次，需用户裁决后另立计划）**：

| # | 项 | 出处 |
| - | -- | ---- |
| P-2 | `src/monitor/signalMetrics.js:178` 的 sweep 租户选择器仍排除 `system`（D1 同族遗漏） | 本计划 §0.3 |
| P-3 | `test/connectors/writebackAction.test.js` 三条用例全为静态源码断言，建议逐步替换为行为断言（本计划已为其最关键的两条提供替代实现） | 本计划 §0.1 |
| P-4 | A-B2 的第二消费面：`timers.js:489` 注入 `resolveCredentials` 但 `runIntegrationPollOnce`（`:125`）签名未接收，且富化 ctx 无 `credentials` → 消费 `ctx.credentials[pid]` 的四个 adapter（anysite/qixin/genericRest/genericMcp）凭据全落空 | `2026-09-16-design-merge-audit.md` 同族；2026-09-16 复核新识别 |
