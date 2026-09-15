# 线索公海池·三类池 + 租户隔离 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把线索公海池改造成「S0 公海 / S0P 私海待校验 / S1 正式线索」三档阶段 + 每租户独立三类池（new/nurture/lost），并补全四类退回通道中的 ②③④（手动退回 / 战败归档入池 / 离职批量回收），同时修复 3 处租户隔离缺陷（含 1 处 P0 写操作无租户限定）。

**Architecture:** 池不是粒子，是治理配置——真源从 `CRM_ORGANIZATION.pool_config` 迁到 `crm.config_store`(key=`lead-pool-config`)，靠 PK=(tenant_id,key) + autoSeed 懒克隆实现租户隔离；阶段模型用「两套集合」隔离（`S_STAGES` 保持 S1–S8 供漏斗口径，`S_ALL_STAGES` 增 S0/S0P 供状态机），避免公海线索污染漏斗转化率；所有退回/回收/归档/重开一律走 `updateParticle` 而非 `advanceStage`（后者有「只进不退」硬约束，前者是 `reopenDeal.js` 既有范式）。

**Tech Stack:** Node.js ESM、PostgreSQL (crm schema, JSONB payload)、Express、vitest。

**上游设计文档：** `docs/2026-09-11-lead-public-pool-tenant-design.md`

**测试命令基线：** `node node_modules/vitest/vitest.mjs run <path>`（`npm test` = 全量）

---

## 文件结构映射

| 文件 | 职责 | 变更类型 |
|---|---|---|
| `src/sales/stageTaxonomy.js` | S 码单一事实源（新增 S0/S0P 常量、推进边、闸门定义、`normalizeDealStage`、`isPoolStage`） | 改 |
| `src/particles/particleModel.js` | `CRM_DEAL.states.flow` 改用 `S_ALL_STAGES`（否则 `advanceStage` 拒识 S0/S0P） | 改 |
| `src/particles/particleRepo.js` | `DEAL_STAGES` 改用 `S_ALL_STAGES`（否则写 `stage:'S0'` 被 `normalizeStage` 判非法） | 改 |
| `src/sales/pool.js` | 三类池模板 + `readPoolConfig`/`writePoolConfig`/`resolvePoolId`/`poolOf`/`normalizePoolConfig`/`legacyToPools` | 改 |
| `src/action/executor.js` | `STAGE_GATES` 增 `S0P→S1` hard BANTCC 闸 | 改 |
| `src/action/seed-actions.js` | 改造 pick/recycle/reopen；新增 return / archive / reclaim-bulk 三个 Action | 改 |
| `src/http/controlledConfigPages.js` | `def.fetch(req)` 透传请求；pool-config 页按租户读 | 改 |
| `src/http/routes.js` | `/api/pool-config` 走新读写；4 处 `'lead'` 兜底改 `normalizeDealStage`；待办排除公海 | 改 |
| `src/scheduler/timers.js` | 超期扫描对象 `'lead'`→`'S0P'`，事件带 `tenant_id` | 改 |
| `src/sales/reopenDeal.js` | 源阶段扩至 `S0+lost`，目标 `S2`→`S0P`，补 `tenantId` | 改 |
| `src/portal/poolConfigRender.js` | `POOL_KEYS` 对齐引擎真实字段 | 改 |
| `src/web/pool-config.html` | 三池 TAB + 平台模板徽标 | 改 |
| `db/migration-lead-pool-s0.sql` | 存量 `lead` 三分支迁移 + 守恒校验 | 新建 |
| `db/migration-lead-pool-config.sql` | 播种 `system` 三池模板行 + 兼容读回写 | 新建 |
| `test/sales/stagePoolStage.test.js` | 阶段模型单测 | 新建 |
| `test/sales/poolTypes.test.js` | 三池解析 + 租户隔离 | 新建 |
| `test/action/leadPoolActions.test.js` | return / archive / reclaim-bulk 正反例 | 新建 |

**关键约束（务必遵守）**

1. **禁 DELETE**：归档/回收一律字段变更 + 审计边（`updateParticle`），无物理删除。
2. **只进不退**：`advanceStage`（`src/particles/lifecycle.js:17`）用 `flow.indexOf` 判定，`S0P→S0` 会被拒。因此 **退回/回收/归档/重开一律用 `updateParticle`**，不得走 `advanceStage`。
3. **漏斗口径零漂移**：`src/sales/funnelKpi.js:36` 用 `S_STAGES.indexOf()` 前缀展开。`S_STAGES` 必须保持 `['S1'..'S8']`，改动即导致全量转化率失真。
4. **配置禁字面量**：天数/目标池/权限一律读 `config_store`，不写死。

**与设计文档的两处刻意偏离（执行前须知）**

- **偏离 A（闸门实现）**：设计 §5 写「移除 `executor.js:380` 的 S1 豁免」。实测该豁免属于 `salesDealPrereq`，只作用于 `data-particle-create` 新建 CRM_DEAL；移除后「新建商机默认 stage=S1」会被三要素闸硬拦 → 商机创建全线失败。故**保留该豁免不动**，改为在 `STAGE_GATES` 新增 `S0P→S1` hard 闸（第 3.5 闸只对 `crm-deal-advance` 生效，`executor.js:166`），语义等价且零回归。
- **偏离 B（决策场景）**：设计 §6-T0 写 `S1→OPP_QUALIFY`。`STAGE_DEFAULT_SCENARIO.S1` 现为 `LEAD_FOLLOW_UP`，改它会漂移所有既有 S1 决策场景。故**只新增 `S0:'LEAD_FOLLOW_UP'`、`S0P:'LEAD_FOLLOW_UP'`，S1 保持不动**（S1 作为正式线索仍属线索跟进范畴）。
- **偏离 C（执行期追加，2026-09-11）**：`test/web/readableConfig.test.js` 的「池」段原断言锁定**待修缺陷本身**（`POOL_KEYS=['pickRule','recycleAfterDays']` + `renderPoolForm`），与设计 §3 要求的引擎消费键（`daily_limit/pick_interval_hours/prev_owner_only/new_data_only/recycle_days`）直接冲突。计划 Files 清单未列该文件（遗漏）。若保留，则 T5 必须为错误契约提供向后兼容 shim（等于把缺陷固化为双表面）。故**按设计迁移该测试契约**（改为新键集 + `renderPoolTabs`），断言强度不降（新增 `daily_limit:0` 越界与 `data-pool` 锚点）。属「实现已批准设计」，非新设计偏离。

---

## Task 1: S0/S0P 阶段常量与状态机接入（+ 术语同源 + 要素闸豁免）

> **派发前源码级契约复查（执行时消解，全部实测非转述）**：原计划本节有 **2 项 🔴 遗漏变更面**（D1 / D2）+ 2 项 🟡（D4 / D7），已就地修补；
> **D3（闸门三件套）已从本节移至 Task 2**（理由见 Step 3 的 (3d) 注）。行号均已实测。

**Files:**
- Modify: `src/sales/stageTaxonomy.js`（常量 + 函数）
- Modify: `src/particles/particleModel.js:13`（`flow` 接线）
- Modify: `src/particles/particleRepo.js:18`（`DEAL_STAGES` 接线）
- Modify: `src/action/executor.js:379`（`salesDealPrereq` 豁免 S0/S0P —— **D2 新增**）
- Modify: `src/action/executor.js:252`（注释术语 —— **D7**）
- Modify: `src/action/seed-actions.js:445`（脏值判据 `S_STAGES`→`S_ALL_STAGES` —— **D4 新增**）
- Modify: `src/portal/scoring.js:40`（前端第二套标签表同步 —— **D1 新增**）
- Modify: `src/decision/thinkingTemplates.js:34`、`scripts/seed-tenant-demo-data.mjs:88`（注释术语 —— D7）
- Test: `test/sales/stagePoolStage.test.js`（新建，**纯常量零 DB import**）
- Modify: `test/sales/stageTaxonomy.test.js:10`
- Modify: `test/action/executor-gate-hard.test.js`（+2 例 S0/S0P 豁免 —— D2 回归）
- Modify: `test/portal-scoring.test.js:60`（标签断言同步 —— D1）
- Modify: `test/particles-write.test.js:107`（`DEAL_STAGES` 严格白名单断言 —— **D8 新增，首跑即红**）

**变更面证据（实测 grep，防漏）**

| 面 | 锚点 | 实测内容 | 本 Task 动作 |
|---|---|---|---|
| 术语第一真相源 | `src/sales/stageTaxonomy.js:8` | `S1: '线索发掘'` | 改 `'正式线索'` |
| 术语第二真相源（🔴D1） | `src/portal/scoring.js:40` | `{key:'S1', title:'线索发掘'}`（浏览器 ESM，**无法 import 后端**，注释自述「内联等价」） | 同步改 `'正式线索'` |
| 术语断言（🔴D1） | `test/portal-scoring.test.js:60` | `toEqual(['线索发掘', ...])` | 同步改 |
| 术语断言 | `test/sales/stageTaxonomy.test.js:10` | `S_LABEL.S1 === '线索发掘'` | 同步改 |
| 步骤状态机 | `src/particles/particleModel.js:13` | `flow: S_STAGES` | `S_ALL_STAGES` |
| 写白名单 | `src/particles/particleRepo.js:18` | `DEAL_STAGES = S_STAGES` | `= S_ALL_STAGES` |
| 要素闸（🔴D2） | `src/action/executor.js:379` | `if (stage === 'S1' \|\| raw === '线索') return {ok:true}` | 扩为 `S_PRE_DEAL_STAGES` ∪ `S1` ∪ `'线索'` |
| 脏值判据（🟡D4） | `src/action/seed-actions.js:445` | `if (!S_STAGES.includes(stage) && ...)` | `S_ALL_STAGES.includes` |
| 闸门证据表 | `src/action/seed-actions.js:456-468` | `GATE_EVIDENCE[gateDef.key]` 未命中即报「闸门条件未满足」 | **本 Task 不动**（无 `S_GATE_DEFS` 新条目 → 不触发）；Task 2 补齐 |
| 回退 flow（🟡D5） | `src/sales/stageConfig.js:35` | 第四套硬编码 `['S1'..'S8']`（`checkRollback` 用） | **故意不改**：退回/回收/归档一律走 `updateParticle`（见「关键约束 2」），不经 `checkRollback`；已核查无其它调用路径依赖 S0 |
| 索引敏感断言（🟡D6） | `test/integration/discoveryToS1.test.js:128` | `S_GATE_DEFS[0].from === 'S1'` | 只做**末尾追加**，索引 0 不受影响；禁止未来在 `S_GATE_DEFS` **开头**插入条目 |
| DB 层 | `db/schema.sql:120` | `stage TEXT NOT NULL`（**无 CHECK 约束**） | 无需改（S0 不会被 DB 拒） |
| 白名单严格断言（🔴D8） | `test/particles-write.test.js:107` | `expect(DEAL_STAGES).toEqual(['S1'..'S8'])`（**原计划 Files 段漏列**） | 改十段 + 补 S0/S0P 可写用例 |

- [x] **Step 1: 写失败测试（纯常量，零 DB）**

创建 `test/sales/stagePoolStage.test.js`：

```js
// test/sales/stagePoolStage.test.js — S0 公海 / S0P 私海待校验 阶段模型
// ⚠ 纯常量测试：只 import stageTaxonomy.js（零 DB / 零 executor），避免 PG 耦合
import { test } from 'vitest';
import assert from 'node:assert';
import {
  S_STAGES, S_ALL_STAGES, S_PRE_DEAL_STAGES, S_POOL_STAGE, S_PICKED_STAGE,
  S_LABEL, S_TRANSITIONS, S_TERMINAL_STAGES, toStageCode, isPoolStage, isOpenStage,
  normalizeDealStage, STAGE_DEFAULT_SCENARIO,
} from '../../src/sales/stageTaxonomy.js';

test('S_STAGES 保持 S1-S8（漏斗口径零漂移）', () => {
  assert.deepStrictEqual(S_STAGES, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
});

test('S_ALL_STAGES 前插 S0/S0P，S_PRE_DEAL_STAGES=[S0,S0P]', () => {
  assert.deepStrictEqual(S_ALL_STAGES, ['S0', 'S0P', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  assert.deepStrictEqual(S_PRE_DEAL_STAGES, ['S0', 'S0P']);
  assert.strictEqual(S_POOL_STAGE, 'S0');
  assert.strictEqual(S_PICKED_STAGE, 'S0P');
});

test('toStageCode 识别 S0/S0P，旧值 lead 仍映射 S1', () => {
  assert.strictEqual(toStageCode('S0'), 'S0');
  assert.strictEqual(toStageCode('S0P'), 'S0P');
  assert.strictEqual(toStageCode('lead'), 'S1');
});

test('isPoolStage 仅 S0 为真（S0P 属私海，须计入待办）', () => {
  assert.strictEqual(isPoolStage('S0'), true);
  assert.strictEqual(isPoolStage('S0P'), false);
  assert.strictEqual(isPoolStage('S1'), false);
  assert.strictEqual(isPoolStage('lead'), false);
});

test('normalizeDealStage：无主 S1 纠偏为 S0（迁移遗漏兜底）', () => {
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S1' } }), 'S0');
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S1', owner_id: 'u1' } }), 'S1');
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S0P', owner_id: 'u1' } }), 'S0P');
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S0' } }), 'S0');
});

test('推进边：S0P->S1 存在；S0->S1 / S0->S2 / S0->S0P 均不存在', () => {
  assert.ok(S_TRANSITIONS.some((t) => t.from === 'S0P' && t.to === 'S1'));
  assert.ok(!S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S1'));
  assert.ok(!S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S2'));
  assert.ok(!S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S0P'));  // 认领不经 advance，避免绕过 PickRule
  assert.ok(S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S8'));    // 公海可直接判无效
});

test('S_LABEL 含公海/私海线索/正式线索', () => {
  assert.strictEqual(S_LABEL.S0, '公海');
  assert.strictEqual(S_LABEL.S0P, '私海线索');
  assert.strictEqual(S_LABEL.S1, '正式线索');
});

test('isOpenStage("S0") 仍为 true —— fail-open 已知面，由调用方用 isPoolStage 排除', () => {
  // 锁行为而非锁意图：isPoolStage 是「排除公海」的正确判据（Task 9 接线）。
  // 此断言存在的价值：若未来有人把 S0 塞进 S_TERMINAL_STAGES 来「顺手修」，此处立刻变红。
  assert.strictEqual(isOpenStage('S0'), true);
  assert.strictEqual(S_TERMINAL_STAGES.includes('S0'), false);
});

test('S0/S0P 决策场景 = LEAD_FOLLOW_UP，S1 保持不动（偏离 B）', () => {
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S0, 'LEAD_FOLLOW_UP');
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S0P, 'LEAD_FOLLOW_UP');
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S1, 'LEAD_FOLLOW_UP');
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S4, 'QUOTE_PRICING'); // 既有键零漂移
});
```

- [x] **Step 2: 运行测试确认失败**

```
node node_modules/vitest/vitest.mjs run test/sales/stagePoolStage.test.js
```

预期：FAIL（`S_ALL_STAGES` / `isPoolStage` / `normalizeDealStage` / `S_POOL_STAGE` 均 undefined）。

- [x] **Step 3: 实现 `stageTaxonomy.js`**

(3a) 在 `export const S_STAGES` 之后插入新常量：

```js
// ── 公海阶段（2026-09-11）：公海 = S0；认领后 = S0P（私海待校验）；BANT 校验通过 = S1（正式线索）──
// ⚠ 两套集合并存是有意为之：funnelKpi.js:36 用 S_STAGES.indexOf() 做前缀展开，
//    把 S0 插进 S_STAGES 会让漏斗上游吞进公海线索 → 全部转化率失真。故 S_STAGES 冻结为 S1-S8。
export const S_POOL_STAGE = 'S0';    // 公海
export const S_PICKED_STAGE = 'S0P'; // 私海线索（待校验）
export const S_ALL_STAGES = [S_POOL_STAGE, S_PICKED_STAGE, ...S_STAGES];
export const S_PRE_DEAL_STAGES = [S_POOL_STAGE, S_PICKED_STAGE];
```

(3b) `S_LABEL` 增补并改写 S1 语义：

```js
export const S_LABEL = {
  S0: '公海', S0P: '私海线索',
  S1: '正式线索', S2: '需求确认', S3: '方案匹配', S4: '报价谈判',
  S5: '合同确认', S6: '赢单移交', S7: '输单', S8: '丢单',
};
```

> **标签口径消解（实测两处来源不一致）**：设计文档 §3.5 表写「私海线索（待校验）」，同文档 §3.5.4 写「私海线索」。
> 定稿：`S_LABEL` 是**短标签**（列表/角标用），取 `'私海线索'`；**「待校验」是释义**，不属于短标签。

(3c) `S_TRANSITIONS` 数组末尾追加：

```js
  // 公海三档（2026-09-11）：认领不经 advance（走 crm-lead-pick 的 updateParticle，受 PickRule 约束）
  { from: 'S0P', to: 'S1' },                                  // BANT 校验通过 → 正式线索
  { from: 'S0', to: 'S7' }, { from: 'S0', to: 'S8' },         // 公海直接判无效
  { from: 'S0P', to: 'S7' }, { from: 'S0P', to: 'S8' },       // 待校验直接判无效
```

(3d) ~~`S_GATE_DEFS` 数组追加 `S0P→S1` 条目~~ → **本节不做，移至 Task 2**。

> **为什么移走（D3）**：`S_GATE_DEFS` 的 `key` 会被 `src/action/seed-actions.js:468` 的 `GATE_EVIDENCE[gateDef.key]` 查表。
> 本节若先加条目、而 `GATE_EVIDENCE` 无 `bantcc_lead` 键，则 `method-stage-progression` 一类 next-stage 建议
> **对 S0P 商机恒输出「闸门条件未满足（缺可观察证据）」**——即「有闸无证据」的半成品。
> 闸门是**三件套**（`S_GATE_DEFS` 声明 + `executor.STAGE_GATES` 机器实现 + `seed-actions.GATE_EVIDENCE` 证据判据），
> 天然属于同一 Task。故整组下沉 Task 2 一次闭环，本节只保留「推进边」（推进边零消费者行为变更：
> 现网无 S0P 粒子，`gateDef` 查不到即 `if (gateDef)` 跳过，不产生 missing）。

(3e) `STAGE_DEFAULT_SCENARIO` 增补（S1 保持 `LEAD_FOLLOW_UP` 不动，见「偏离 B」）：

```js
export const STAGE_DEFAULT_SCENARIO = {
  S0: 'LEAD_FOLLOW_UP', S0P: 'LEAD_FOLLOW_UP',
  S1: 'LEAD_FOLLOW_UP', S2: 'OPP_QUALIFY', S3: 'SOLUTION_VALUE',
  S4: 'QUOTE_PRICING', S5: 'SIGN_RISK', S6: 'POST_CONTRACT',
  S7: 'LOSS_REVIEW', S8: 'LOSS_REVIEW',
};
```

(3f) `toStageCode` 的白名单改为 `S_ALL_STAGES`（**契约显式化，非必需修复**）：

> **实测更正（变异 M2 定性，2026-09-11）**：原计划称「不改则 `toStageCode('S0')` 返回 undefined」——**不成立**。
> 函数尾部有 `return S_ALIAS_FWD[v] || v;` 兜底，`S_ALIAS_FWD['S0']` 为 undefined 时 `|| v` 返回**原值 `'S0'`**。
> 故「仅回退白名单」实测为**等价变异**（行为完全一致）。保留本改动是为了**让白名单表达契约**（S 码白名单＝全部合法阶段），
> 并防未来 `S_ALIAS_FWD` 扩展或移除 `|| v` 兜底时误伤 —— 属正确性投资，不是本 Task 的功能修复。

```js
export function toStageCode(v) {
  if (!v) return v;
  if (v.startsWith('S') && S_ALL_STAGES.includes(v)) return v;
  return S_ALIAS_FWD[v] || v;
}
```

(3g) 在 `isOpenStage` 之后新增两个函数：

```js
// 是否公海阶段（S0）。S0P 属私海（有归属、需跟进），不在此列。
// 用途：待办/跟进视图据此排除公海——公海无人跟进，不该出现在任何人的待办里。
export function isPoolStage(v) {
  return toStageCode(v) === S_POOL_STAGE;
}

// 阶段归一（DB 视角）：公海判定以 owner_id 为准，而非仅看 stage。
// 迁移遗漏或脏数据时，「无主却标 S1」会制造「已认领」的假象 → 统一纠偏为 S0。
// 入参可为粒子（取 .payload）或裸 payload。
export function normalizeDealStage(deal = {}) {
  const p = deal.payload || deal;
  const code = toStageCode(p?.stage);
  if (!p?.owner_id && (code === S_POOL_STAGE || code === 'S1')) return S_POOL_STAGE;
  return code;
}
```

- [x] **Step 4: 接入状态机与写校验**

`src/particles/particleModel.js`：把 import 与 flow 改为全量阶段。

```js
import { S_ALL_STAGES } from '../sales/stageTaxonomy.js';
...
    states: { current: 'ACTIVE', flow: S_ALL_STAGES },
```

`src/particles/particleRepo.js`：

```js
import { S_ALL_STAGES, toStageCode } from '../sales/stageTaxonomy.js';
...
export const DEAL_STAGES = S_ALL_STAGES;
```

> `particleRepo.normalizeStage` 的**未分类兜底仍为 `'S1'`（故意不改）**：新建 DEAL 不传 stage 时默认「正式线索」。
> 「新建线索落 S0 公海」属**入口行为**，由 `discoveryOrchestrator` / `tenderConnector` / `crm-lead-pick` 显式写入 S0，
> 不在 `normalizeStage` 兜底里做（Task 9 逐处核对）。改兜底会把所有未传 stage 的历史写入路径一并改成公海，影响面失控。

- [x] **Step 5: 修正既有断言 + 术语同源（D1 / D7）**

`test/sales/stageTaxonomy.test.js:10`：`assert.strictEqual(S_LABEL.S1, '线索发掘')` → `'正式线索'`。

`src/portal/scoring.js:40`（**D1**，第二套标签表，浏览器端无法 import 后端，必须手工同源）：

```js
export const pipelineStages = [
  { key: 'S1', title: '正式线索' },
  { key: 'S2', title: '需求确认' },
  ...
];
```

`test/portal-scoring.test.js:60`（**D1**）：`toEqual(['线索发掘', ...])` → `toEqual(['正式线索', ...])`。

`test/particles-write.test.js:105-108`（**D8**）：`describe` 标题 + `expect(DEAL_STAGES).toEqual(['S1'..'S8'])` → 十段 `['S0','S0P','S1'..'S8']`，并补「写 S0/S0P 不被判非法」用例。

注释术语（D7，纯注释零行为）：`src/action/executor.js:252`、`src/decision/thinkingTemplates.js:34`、`scripts/seed-tenant-demo-data.mjs:88` 中的「线索发掘」→「正式线索」。

> ⚠ `src/portal/scoring.js` 的 `dealStageOf` 兜底 `|| 'S1'` 与 `S_ALIAS` 的 S0/S0P 处理**不在本节**（属 Task 9 的 12 处分流），本节只改 `title` 保术语同源。

- [x] **Step 6: 要素闸豁免 S0/S0P（D2）**

`src/action/executor.js` 顶部 import 增 `S_PRE_DEAL_STAGES`（与既有 `toStageCode` 同源）：

```js
import { toStageCode, S_PRE_DEAL_STAGES } from '../sales/stageTaxonomy.js';
```

`:379` 处（`salesDealPrereq` 内）：

```js
  // 公海/私海待校验阶段豁免商机三要素闸（S0/S0P 尚未成单，不该被 B/A/T 拦）
  // —— D2：S0/S0P 与 S1 同属「线索侧」，豁免理由一致；升级闸由 S0P→S1 阶段闸（Task 2）负责
  if (S_PRE_DEAL_STAGES.includes(stage) || stage === 'S1' || raw === '线索') return { ok: true, missing: [] };
```

`src/action/seed-actions.js:445`（D4）：

```js
      if (!S_ALL_STAGES.includes(stage) && typeof p.stage === 'string') {
```

（同文件 import 行同步把 `S_STAGES` 旁增 `S_ALL_STAGES`；`S_STAGES` 若变为未使用则一并删除，保持零死引用。）

- [x] **Step 7: 补 D2 回归用例（追加进既有文件，避免新起 PG 依赖）**

`test/action/executor-gate-hard.test.js` 的 `describe('executor C6 商机三要素闸')` 内追加：

```js
  it('S0 公海豁免三要素闸（未成单线索）', () => {
    assert.strictEqual(salesDealPrereq({ stage: 'S0' }).ok, true);
  });
  it('S0P 私海待校验豁免三要素闸（升级闸在 S0P→S1，不在此处）', () => {
    assert.strictEqual(salesDealPrereq({ stage: 'S0P', bantcc: {} }).ok, true);
  });
```

- [x] **Step 8: 运行测试确认通过**

```
node node_modules/vitest/vitest.mjs run test/sales/stagePoolStage.test.js test/sales/stageTaxonomy.test.js test/sales/funnelKpi.test.js test/portal-scoring.test.js test/action/executor-gate-hard.test.js test/particles-write.test.js test/particles
```

预期：全绿。**`funnelKpi.test.js` 必须仍绿**（证明漏斗口径零漂移）；`portal-scoring.test.js` 必须绿（证明术语两源同源）。

- [x] **Step 9: Commit**

```bash
git add src/sales/stageTaxonomy.js src/particles/particleModel.js src/particles/particleRepo.js src/action/executor.js src/action/seed-actions.js src/portal/scoring.js src/decision/thinkingTemplates.js scripts/seed-tenant-demo-data.mjs test/sales/stagePoolStage.test.js test/sales/stageTaxonomy.test.js test/action/executor-gate-hard.test.js test/portal-scoring.test.js test/particles-write.test.js
git commit -m "feat(stage): 引入 S0 公海 / S0P 私海待校验阶段 + 要素闸豁免 + 术语两源同源"
```

**执行记录（2026-09-11 实做，含变异测试）**

| 项 | 结果 |
|---|---|
| 验收 | `stagePoolStage`(9) + `stageTaxonomy`(5) + `funnelKpi`(9) + `portal-scoring`(9) + `executor-gate-hard`(17) + `particles-write` + `test/particles` = **11 文件 / 89 例全绿** |
| 鉴别力（有效变异） | M1 去 S0/S0P 前插 / M3 去无主纠偏 / M4 取消要素闸豁免 / M5 scoring 术语回退 / M6 `DEAL_STAGES` 回退 = **5/5 RED** ✅ |
| 等价变异已定性 | **M2**（仅回退 `toStageCode` 白名单）→ GREEN。核查为**变异点无效**（兜底 `|| v` 使白名单对 S0/S0P 冗余），非断言缺陷；替代变异 **M2b**（回退白名单 + 去兜底）**RED** ⇒ 断言本身有鉴别力 |
| 红线 | `routing.js` `aa7a5ad7b5ca7d12` / `assembler.js` `12ac9bc27edc76a8` **未变** |
| 故意未改 | `funnelKpi.js`（漏斗口径零漂移）、`stageConfig.js`（D5：退回不走 `checkRollback`）、`particleRepo.normalizeStage` 兜底 `'S1'` |
| 计划外发现 | **D8**：`test/particles-write.test.js:107` 严格断言八段 → 首跑即红（计划 Files 段漏列，已补进本 Task） |
| 变更面 | 13 文件（11 改 + 1 新建 + 1 计划文档），与本节 Files 清单**完全一致**（`git status` 实测） |

---

## Task 2: 闸门三件套 —— S0P→S1 的 BANT 硬闸（声明 + 机器实现 + 证据判据）

> **本节相对原计划的变更（执行时消解 + 派发前契约复查）**：
> ① 原计划只改 `executor.STAGE_GATES`，**漏了 `seed-actions.GATE_EVIDENCE`** → 会留下「有闸无证据」半成品（next-stage 建议恒报缺证据）；
> ② `S_GATE_DEFS` 的 `S0P→S1` 条目**从 Task 1 移入本节**，使闸门三件套同批闭环；
> ③ 判据抽为**共享纯函数** `src/sales/leadQualify.js`，executor 与 seed-actions **共用同一判据**，杜绝第三套副本。
> ④（🔴 **D1 派发前复查新增**）**同判据未收敛**：`src/action/executor.js:376` 的 `salesDealPrereq`（C6 建单三要素闸，服务 `data-particle-create`）与本节新增的 `leadQualifyGap` 是**同一套 B/A/T 逻辑**。若各自成文即「第二套副本」，直接违背 ③ 的初衷。故 `leadQualify.js` 再导出共享判定核 **`bantMissing(bantcc)`**（只算 B/A/T 缺失项，零阈值），`salesDealPrereq` 改为**委托** `bantMissing` —— 行为逐字等价（AI 兜底读数仍保持原 `.value`-only 语义，不做宽化），由既有 `test/action/executor-gate-hard.test.js` 13 例 + 本节新增 DRY 一致性用例守护。
> ⑤（🔴 **D2 派发前复查新增**）**`qualified_at`/`qualified_by` 落点全计划缺位**：设计 §3.5.2（`docs/2026-09-11-lead-public-pool-tenant-design.md:228/247` 及 §2.3 阶段表 `:132`）明确要求 `crm-deal-advance` 通过 `S0P→S1` 时**落 `qualified_at`/`qualified_by`**（「正式线索」状态载体）；原计划仅 Task 6（退回清空）与 Task 9（迁移补写）提及，**承载该边的 Task 2 反而漏写**。本节补 **Step 5b**。
> ⑥（🟡 **D3 派发前复查记录，不在本节实施**）**方法论层（SKILL）滞后**：`skills/method-stage-progression/{methodology.json:6, references/stages.md:7}` 的 S1 标签仍为「线索发掘」（真源 `S_LABEL.S1='正式线索'` 已在 Task 1 改），且 `rules/gates.md` 无 `S0P→S1` 行 —— 与 `executor.js:256` 自述「与 SKILL methodology.json / stageTaxonomy.S_GATE_DEFS **逐条对齐**」分叉。该 SKILL 为 **3 份 byte-equal 副本**（`skills/`、`connector/skills/`、`plugin/skills/`）且受 `scripts/verify-plugin-zips.py:143` 打包守护，属**打包工序**而非代码闸门 → 建议并入 **Task 10（设计文档回写）** 或独立 sync Task，本节不实施（避免把 SKILL 打包面混入闸门提交）。

**Files:**
- New: `src/sales/leadQualify.js`（纯函数 `leadQualifyGap` + 共享判定核 `bantMissing`，零依赖，可单测）
- Modify: `src/sales/stageTaxonomy.js`（`S_GATE_DEFS` 追加 S0P→S1 条目）
- Modify: `src/action/executor.js:257`（`STAGE_GATES` **最前面**插入 S0P→S1，调用共享判据）
- Modify: `src/action/executor.js:376`（**D1**：`salesDealPrereq` 改为委托 `bantMissing`，消第二套副本）
- Modify: `src/action/seed-actions.js:456`（`GATE_EVIDENCE` 增 `bantcc_lead` 键，调用共享判据）
- Modify: `src/action/seed-actions.js:761`（**D2**：`crm-deal-advance` 在 `S0P→S1` 落 `qualified_at`/`qualified_by`）
- Test: `test/action/leadQualifyGate.test.js`（新建：纯判据 + 闸门 + 三件套一致性 + DRY + qualified_at 五层）

- [x] **Step 1: 写失败测试**

创建 `test/action/leadQualifyGate.test.js`：

```js
// test/action/leadQualifyGate.test.js — S0P→S1（升级正式线索）BANT 硬闸
// 双层：① 纯判据 leadQualifyGap（零 DB）；② 经 salesStageGate 的闸门集成
import { test } from 'vitest';
import assert from 'node:assert';
import { leadQualifyGap } from '../../src/sales/leadQualify.js';
import { salesStageGate } from '../../src/action/executor.js';

const full = { bantcc: { budget: 100, authority: 'CTO', timetable_ok: true } };

test('纯判据：B/A/T 三要素齐 → null（放行）', () => {
  assert.strictEqual(leadQualifyGap(full), null);
});
test('纯判据：缺预算 → 返回缺失串（含"预算"）', () => {
  const g = leadQualifyGap({ bantcc: { authority: 'CTO', timetable_ok: true } });
  assert.ok(typeof g === 'string' && g.includes('预算'));
});
test('纯判据：ai.bantcc_completeness >= pass → null（AI 评估路径）', () => {
  assert.strictEqual(leadQualifyGap({ ai: { bantcc_completeness: { value: 0.75 } } }, { pass: 0.6 }), null);
});
test('纯判据：ai 低于 pass 且三要素缺 → 返回串（不得假绿）', () => {
  const g = leadQualifyGap({ ai: { bantcc_completeness: { value: 0.4 } } }, { pass: 0.6 });
  assert.ok(typeof g === 'string' && g.length > 0);
});

test('闸门：B/A/T 三要素齐 → S0P→S1 放行', () => {
  const v = salesStageGate({ curStage: 'S0P', toStage: 'S1', dealPayload: full });
  assert.strictEqual(v.ok, true);
  assert.deepStrictEqual(v.gaps, []);
});
test('闸门：缺预算 → S0P→S1 硬拦', () => {
  const v = salesStageGate({
    curStage: 'S0P', toStage: 'S1',
    dealPayload: { bantcc: { authority: 'CTO', timetable_ok: true } },
  });
  assert.strictEqual(v.ok, false);
  assert.ok(v.gaps.join(';').includes('预算'));
});
test('闸门：ai.bantcc_completeness>=0.6 → 放行（AI 评估路径）', () => {
  const v = salesStageGate({
    curStage: 'S0P', toStage: 'S1',
    dealPayload: { ai: { bantcc_completeness: { value: 0.75 } } },
  });
  assert.strictEqual(v.ok, true);
});
test('闸门：S0→S1 无闸定义（合法性由 S_TRANSITIONS 保证，不造放行假象）', () => {
  const v = salesStageGate({ curStage: 'S0', toStage: 'S1', dealPayload: full });
  assert.strictEqual(v.gaps.length, 0);
});
test('三件套一致性：S_GATE_DEFS 的 S0P→S1 key 可被 GATE_EVIDENCE 解析', async () => {
  const { S_GATE_DEFS } = await import('../../src/sales/stageTaxonomy.js');
  const def = S_GATE_DEFS.find((g) => g.from === 'S0P' && g.to === 'S1');
  assert.ok(def, 'S_GATE_DEFS 必须含 S0P→S1 条目');
  assert.strictEqual(def.key, 'bantcc_lead');
  // 锚定：该 key 必须同时存在于 seed-actions 的证据表（反向防漏，见 Task 2 声明②）
  const src = await import('node:fs').then((m) => m.readFileSync('src/action/seed-actions.js', 'utf8'));
  assert.ok(src.includes('bantcc_lead:'), 'GATE_EVIDENCE 必须含 bantcc_lead 键（否则建议恒报缺证据）');
});
```

- [x] **Step 2: 运行确认失败**

```
node node_modules/vitest/vitest.mjs run test/action/leadQualifyGate.test.js
```

预期：FAIL（`leadQualifyGap` 不存在；`S0P→S1` 闸放行）。

- [x] **Step 3: 实现共享判据 `src/sales/leadQualify.js`**

```js
// src/sales/leadQualify.js — S0P→S1「升级正式线索」的 BANT 判据（单一事实源）
// 消费者：executor.STAGE_GATES（写闸）+ seed-actions.GATE_EVIDENCE（建议闸）
// 纯函数零依赖：阈值由调用方解析后传入，避免此处 import config/DB。
// 语义（设计 §3.5.2）：B(预算)/A(责任人)/T(时间表) 三要素齐，或 AI 评估 bantcc_completeness >= pass。
// @returns {string|null} null=放行；string=未满足原因
export function leadQualifyGap(payload = {}, { pass = 0.6, unknown = 0 } = {}) {
  const b = payload.bantcc || {};
  const raw = (payload.ai || {}).bantcc_completeness;
  const aiComp = typeof raw === 'object' ? Number(raw?.value ?? unknown) : Number(raw ?? unknown);
  if (Number.isFinite(aiComp) && aiComp >= pass) return null;
  const bOk = b.budget_ok === true || (b.budget != null && String(b.budget) !== '');
  const aOk = b.authority_ok === true || (b.authority != null && String(b.authority) !== '');
  const tOk = b.timetable_ok === true || b.schedule != null || b.timeline != null;
  if (bOk && aOk && tOk) return null;
  const miss = [];
  if (!bOk) miss.push('预算');
  if (!aOk) miss.push('责任人');
  if (!tOk) miss.push('时间表');
  return `未满足正式线索条件，缺 ${miss.join('/')}（或 bantcc_completeness ≥ ${pass}）`;
}
```

- [x] **Step 4: `S_GATE_DEFS` 追加声明（Task 1 移入）**

`src/sales/stageTaxonomy.js`（**末尾追加**，索引 0 不受影响，见 D6）：

```js
  { from: 'S0P', to: 'S1', hard: true, key: 'bantcc_lead', attach: null },   // B/A/T 三要素（或 bantcc_completeness≥pass）→ 正式线索
```

- [x] **Step 5: `executor.STAGE_GATES` 机器实现**

`src/action/executor.js` 顶部 import 增 `leadQualifyGap`；在 `STAGE_GATES` 数组**最前面**插入：

```js
  {
    // S0P→S1：升级为「正式线索」的 BANT 硬闸（2026-09-11 设计 §3.5.2）
    // 判据与 seed-actions.GATE_EVIDENCE.bantcc_lead 共用 src/sales/leadQualify.js（杜绝第三套副本）
    from: 'S0P', to: 'S1', hard: true,
    check: (p, th) => leadQualifyGap(p, {
      pass: readThreshold(th, 'bantcc.pass'),
      unknown: readThreshold(th, 'bantcc.unknown'),
    }),
  },
```

- [x] **Step 5b: D2 —— `crm-deal-advance` 在 `S0P→S1` 落 `qualified_at`/`qualified_by`**

`src/action/seed-actions.js` 的 `crm-deal-advance` handler（`:761` `const updated = await advanceStage(...)` 之后、`updated.payload = { ...updated.payload, last_decision_id }` 之前）插入：

```js
      // S0P→S1 升级为「正式线索」：落状态载体 qualified_at / qualified_by（设计 §3.5.2 / §2.3）
      // 与返回/迁移口径一致（T6 退回置 null、T9 迁移补写），三处同字段名。
      if (toStageCode(deal.payload.stage) === 'S0P' && toStageCode(to_stage) === 'S1') {
        updated.payload = {
          ...updated.payload,
          qualified_at: new Date().toISOString(),
          qualified_by: ctx.actor,
        };
      }
```

> 依据：`advanceStage`（`src/particles/lifecycle.js:6`）只写 `stage`/`stage_changed_at`（注释 `seed-actions.js:31` 已列为铁律「advanceStage 只写 stage，其余 payload 须显式落库」），故 `qualified_at` 必须在 handler 内手工补写并随 `updateParticle` 落库。

- [x] **Step 5c: D1 —— `salesDealPrereq` 委托共享判定核 `bantMissing`（消第二套副本）**

`src/action/executor.js:376` 的 `salesDealPrereq` 函数体改为：

```js
export function salesDealPrereq(payload = {}) {
  const raw = payload.stage || payload.state || 'S1';
  const stage = toStageCode(raw) || raw;
  // 公海/私海待校验阶段豁免（S0/S0P 与 S1 同属线索侧）；升级闸由 S0P→S1 阶段闸负责
  if (S_PRE_DEAL_STAGES.includes(stage) || stage === 'S1' || raw === '线索') return { ok: true, missing: [] };
  const aiComp = Number(payload.ai?.bantcc_completeness?.value ?? 0); // 保持原 .value-only 语义，不宽化
  const pass = readThreshold(DEFAULT_THRESHOLDS, 'bantcc.pass', 0.6);
  if (Number.isFinite(aiComp) && aiComp >= pass) return { ok: true, missing: [] };
  const missing = bantMissing(payload.bantcc); // 与 leadQualifyGap 同源（单一事实源）
  return missing.length ? { ok: false, missing } : { ok: true, missing: [] };
}
```

> 等价性：原式 `if ((bOk && aOk && tOk) || aiComp >= pass)` 与「先判 aiComp、再判 `bantMissing` 是否为空」逐字等价；`missing` 的中文序（预算/责任人/时间表）与 `bantMissing` 完全一致。既有 `executor-gate-hard.test.js`（13 例，含 missing 精确断言）零改动即绿。

- [x] **Step 6: `seed-actions.GATE_EVIDENCE` 证据判据（计划遗漏项）**

`src/action/seed-actions.js` 的 `GATE_EVIDENCE` 对象内（`:456` 起）追加：

```js
        // S0P→S1 升级正式线索：与 executor 同判据（共享 leadQualifyGap）
        bantcc_lead: () => leadQualifyGap(p, {
          pass: bantccPass,
          unknown: readThreshold(thresholds, 'bantcc.unknown'),
        }) === null,
```

（同文件 import 增 `leadQualifyGap`。）

- [x] **Step 7: 运行确认通过**

```
node node_modules/vitest/vitest.mjs run test/action/leadQualifyGate.test.js test/action/sales-executor-gate.test.js test/action/executor-gate-hard.test.js test/integration/discoveryToS1.test.js test/sales/stagePoolStage.test.js
```

预期：全绿。`discoveryToS1.test.js` 必须绿（证明 `S_GATE_DEFS[0]` 仍是 S1→S2，末尾追加未破索引断言）。

- [x] **Step 8: Commit**

```bash
git add src/sales/leadQualify.js src/sales/stageTaxonomy.js src/action/executor.js src/action/seed-actions.js test/action/leadQualifyGate.test.js
git commit -m "feat(gate): S0P→S1 升级正式线索挂 BANT 硬闸（三件套闭环 + 共享判据）"
```

> **任务 2 执行记录（2026-09-11）**
> - 派发前契约复查：核实 `S_GATE_DEFS`(5 条，末尾追加安全) / `STAGE_GATES`(check 签名 `(p,th)`) / `GATE_EVIDENCE`(闭包 `()=>bool`，`p`·`thresholds`·`bantccPass` 均在作用域) / `salesStageGate` 返回 `{ok,gate,gaps,warnings}` / `readThreshold(cfg,path,fallback)` / `S_TRANSITIONS` 已含 `S0P→S1`(Task 1) / `discoveryToS1.test.js:128` 索引断言（末尾追加不破）。
> - 新增消解：**D1**（`salesDealPrereq` 委托 `bantMissing`，消第二套 B/A/T 副本）、**D2**（`S0P→S1` 落 `qualified_at`/`qualified_by`）。
> - 记录待办：**D3** 方法论层 SKILL 3 份 byte-equal 副本（`methodology.json`/`stages.md`/`gates.md`）术语与闸行同步 → 并入 Task 10。
> - 红线：`routing.js` / `assembler.js` sha256 未变。

---

## Task 3: 三类池模型 + 真源迁 `config_store`

**Files:**
- Modify: `src/sales/pool.js`
- Modify: `db/migrate.js`（D1 修订：运行时播种通道，2026-09-11 派发前复查新增）
- Modify: `scripts/seed-test-config.mjs`（D1 修订：pretest 播种通道）
- Create: `db/migration-lead-pool-config.sql`
- Test: `test/sales/poolTypes.test.js`（新建）

> ### ⚠ 派发前源码级契约复查（2026-09-11）—— 发现 4 项缺陷（3🔴）
>
> | # | 级别 | 缺陷 | 证据锚点 | 处置 |
> |---|---|---|---|---|
> | **D1** | 🔴 | **迁移 SQL 无执行渠道**：`db/migration-lead-pool-config.sql` 不在 `INCREMENTAL_SQL`（`db/migrate.js:12-42`）、不被 migrate.js/pretest/seed.sql 引用 → `(system,'lead-pool-config')` 模板行**永不播种**；原 Step 3 的 `psql -f` 为一次性手工步骤（本机无 psql），不可复现 | `db/migrate.js:12-42,202-243`（billing-plans 范式） | 双通道接入：`db/migrate.js`（migrate-tenant 之后）+ `scripts/seed-test-config.mjs` pretest |
> | **D2** | 🔴 | **假绿**：测试 ② 标题声称「缺键 autoSeed 打 `_seeded`」，正文**零断言 `_seeded`**；且该标记是 D1 的唯一鉴别器 | `test/sales/poolTypes.test.js:56` | 补 `expect(a._seeded).toBe('system-template')` |
> | **D4** | 🔴 | **legacy 探测恒真 → 静默退化单池**：`getPoolConfig` 查无行时返回 `{...DEFAULT_POOL_CONFIG}`（**非 null**，`pool.js:29-30`），故 `legacy && (legacy.pick_rule||legacy.recycle_rule)` 恒成立 → 缺模板行时 `readPoolConfig` 返回**单池**，`DEFAULT_POOL_TEMPLATE` 分支成死代码 | `pool.js:29-30,183-185` | 新增 `readLegacyPoolConfig()` 精确探测（无行/无 `pool_config` → null） |
> | **D5** | 🟡 | **渠道守卫缺位**：计划未锁「建了 SQL 必须有人执行」，同类脱钩可复发 | — | 新增 ③ 组文件契约守卫（零 DB）+ ④/⑤ 组探测/优先级守卫 |
>
> **补充定性（D3）**：`readPoolConfig` 兼容读槽位硬编码 `'org-hq'` —— 与 `resolvePoolId` 的「禁硬编码 org-hq」测试名表面张力，实为**旧配置读槽位**（历史单组织遗留），非业务硬编码；已加注释显式标注，新写路径一律走 config_store。

- [x] **Step 1: 写失败测试（纯函数部分）**

```js
// test/sales/poolTypes.test.js — 三类池解析 + 租户隔离
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_POOL_TEMPLATE, POOL_CONFIG_KEY, normalizePoolConfig, resolvePoolId,
  poolOf, legacyToPools, readPoolConfig, writePoolConfig,
} from '../../src/sales/pool.js';

describe('三类池解析（纯函数）', () => {
  it('默认模板含 new/nurture/lost 三池', () => {
    const t = normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
    expect(t.pools.map((p) => p.type)).toEqual(['new', 'nurture', 'lost']);
  });
  it('resolvePoolId：显式 pool_id 优先，其次按 pool_type，最后 default_pool', () => {
    const cfg = normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
    expect(resolvePoolId(cfg, { pool_id: 'pool-lost' })).toBe('pool-lost');
    expect(resolvePoolId(cfg, { pool_type: 'nurture' })).toBe('pool-nurture');
    expect(resolvePoolId(cfg, {})).toBe('pool-new');
    expect(resolvePoolId(cfg, { pool_id: 'org-hq' })).toBe('pool-new'); // 未知 id 回落默认
  });
  it('poolOf 返回池对象，未知 id 回落首池', () => {
    const cfg = normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
    expect(poolOf(cfg, 'pool-nurture').pick_rule.daily_limit).toBe(5);
    expect(poolOf(cfg, 'nope').id).toBe('pool-new');
  });
  it('旧组织粒子配置兼容读为单池 pool-new', () => {
    const p = legacyToPools({ pick_rule: { daily_limit: 3 }, recycle_rule: { recycle_days: 7 } });
    expect(p.pools).toHaveLength(1);
    expect(p.pools[0].type).toBe('new');
    expect(p.pools[0].pick_rule.daily_limit).toBe(3);
    expect(p.pools[0].recycle_rule.recycle_days).toBe(7);
  });
});

describe('config_store per-tenant 隔离（真库）', () => {
  it('租户写不污染 system；缺键触发 autoSeed 带 _seeded', async () => {
    const a = await readPoolConfig({ tenantId: 'e2e-pool-t-a' });
    expect(a.pools.map((p) => p.type)).toEqual(['new', 'nurture', 'lost']);
    const wrote = await writePoolConfig({
      tenantId: 'e2e-pool-t-a',
      patch: { pools: [{ ...a.pools[0], pick_rule: { ...a.pools[0].pick_rule, daily_limit: 99 } }, a.pools[1], a.pools[2]] },
      updatedBy: 'e2e',
    });
    expect(poolOf(wrote, 'pool-new').pick_rule.daily_limit).toBe(99);
    const sys = await readPoolConfig({ tenantId: 'system' });
    expect(poolOf(sys, 'pool-new').pick_rule.daily_limit).not.toBe(99);
    const b = await readPoolConfig({ tenantId: 'e2e-pool-t-b' });
    expect(poolOf(b, 'pool-new').pick_rule.daily_limit).not.toBe(99);
  });
});
```

- [x] **Step 2: 运行确认失败**

```
node node_modules/vitest/vitest.mjs run test/sales/poolTypes.test.js
```

预期：FAIL（`DEFAULT_POOL_TEMPLATE` 等未导出）。

- [x] **Step 3: 播种 system 模板行**

创建 `db/migration-lead-pool-config.sql`：

```sql
-- 线索池三类池模板（system 行 = 平台模板源；租户缺键时由 configStore autoSeed 克隆）
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
VALUES ('system', 'lead-pool-config', '{
  "version": 1,
  "default_pool": "pool-new",
  "pools": [
    {"id":"pool-new","type":"new","label":"新线索公海","enabled":true,
     "pick_rule":{"daily_limit":10,"prev_owner_only":false,"pick_interval_hours":24,"new_data_only":true},
     "recycle_rule":{"recycle_days":30,"recycle_target":"self"},
     "return_target":"pool-nurture"},
    {"id":"pool-nurture","type":"nurture","label":"培育公海","enabled":true,
     "pick_rule":{"daily_limit":5,"prev_owner_only":true,"pick_interval_hours":24,"new_data_only":false},
     "recycle_rule":{"recycle_days":90,"recycle_target":"self"},
     "promote_to":"pool-new"},
    {"id":"pool-lost","type":"lost","label":"战败回收公海","enabled":true,
     "pick_rule":{"daily_limit":5,"prev_owner_only":false,"pick_interval_hours":0,"new_data_only":false},
     "recycle_rule":{"recycle_days":180,"recycle_target":"self"},
     "reopenable":true}
  ]
}'::jsonb, 'system', now())
ON CONFLICT (tenant_id, key) DO NOTHING;
```

**执行渠道（D1 修订，取代原 `psql` 一次性步骤）**：本文件为 **JSON 单一事实源**，由双通道自动执行——
① 生产/新库：`db/migrate.js` 在 `migrateTenant()` 之后按「仅缺失时播种」范式 `readFileSync` 本文件（容器启动即跑，`docker-compose.yml:61`）；
② 测试库：`scripts/seed-test-config.mjs` 的 `ensureLeadPoolConfig()`（pretest）。
幂等形式由 `ON CONFLICT (tenant_id,key) DO NOTHING` 改为 **`WHERE NOT EXISTS`**（两代主键下均成立；复合 PK 下 `ON CONFLICT (key)` 会报 no unique constraint——`seed-test-config.mjs:326-336` 既有先例）。

- [x] **Step 4: 实现 `pool.js` 扩展**

在 `src/sales/pool.js` 末尾追加：

```js
// ══ 三类池（2026-09-11）：真源迁 crm.config_store key=lead-pool-config ══
// 迁移理由：组织粒子方案已实测漏传 tenantId（crm-lead-recycle 写无租户谓词）；
//   config_store PK=(tenant_id,key) 天然隔离 + autoSeed 懒克隆，零新增隔离代码。

export const POOL_CONFIG_KEY = 'lead-pool-config';

export const DEFAULT_POOL_TEMPLATE = {
  version: 1,
  default_pool: 'pool-new',
  pools: [
    {
      id: 'pool-new', type: 'new', label: '新线索公海', enabled: true,
      pick_rule: { daily_limit: 10, prev_owner_only: false, pick_interval_hours: 24, new_data_only: true },
      recycle_rule: { recycle_days: 30, recycle_target: 'self' },
      return_target: 'pool-nurture',
    },
    {
      id: 'pool-nurture', type: 'nurture', label: '培育公海', enabled: true,
      pick_rule: { daily_limit: 5, prev_owner_only: true, pick_interval_hours: 24, new_data_only: false },
      recycle_rule: { recycle_days: 90, recycle_target: 'self' },
      promote_to: 'pool-new',
    },
    {
      id: 'pool-lost', type: 'lost', label: '战败回收公海', enabled: true,
      pick_rule: { daily_limit: 5, prev_owner_only: false, pick_interval_hours: 0, new_data_only: false },
      recycle_rule: { recycle_days: 180, recycle_target: 'self' },
      reopenable: true,
    },
  ],
};

// 归一化：按 type 补齐缺省规则键（存量/手改配置缺键时引擎仍能读到完整规则）
export function normalizePoolConfig(cfg = {}) {
  const tpl = DEFAULT_POOL_TEMPLATE;
  const pools = Array.isArray(cfg.pools) && cfg.pools.length ? cfg.pools : tpl.pools;
  return {
    version: cfg.version || tpl.version,
    default_pool: cfg.default_pool || tpl.default_pool,
    _seeded: cfg._seeded || null,
    pools: pools.map((p) => {
      const base = tpl.pools.find((x) => x.type === p.type) || {};
      return {
        ...p,
        enabled: p.enabled !== false,
        pick_rule: { ...(base.pick_rule || {}), ...(p.pick_rule || {}) },
        recycle_rule: { ...(base.recycle_rule || {}), ...(p.recycle_rule || {}) },
      };
    }),
  };
}

// 旧组织粒子配置（{pick_rule, recycle_rule}）→ 单池 pool-new（存量兼容读，不回写）
export function legacyToPools(legacy = {}) {
  return {
    version: 1,
    default_pool: 'pool-new',
    pools: [{
      id: 'pool-new', type: 'new', label: '新线索公海', enabled: true,
      pick_rule: { ...DEFAULT_POOL_CONFIG.pick_rule, ...(legacy.pick_rule || {}) },
      recycle_rule: { ...DEFAULT_POOL_CONFIG.recycle_rule, ...(legacy.recycle_rule || {}) },
      return_target: 'pool-nurture',
    }],
  };
}

// 禁硬编码 'org-hq'：显式 pool_id → pool_type → default_pool 三级解析
export function resolvePoolId(cfg, { pool_id, pool_type } = {}) {
  const pools = (cfg && cfg.pools) || [];
  if (pool_id && pools.some((p) => p.id === pool_id)) return pool_id;
  if (pool_type) {
    const hit = pools.find((p) => p.type === pool_type && p.enabled !== false);
    if (hit) return hit.id;
  }
  return (cfg && cfg.default_pool) || DEFAULT_POOL_TEMPLATE.default_pool;
}

export function poolOf(cfg, poolId) {
  const pools = (cfg && cfg.pools) || [];
  return pools.find((p) => p.id === poolId) || pools[0] || null;
}

// 读优先级：config_store(租户) → 组织粒子旧配置（兼容） → 代码默认
export async function readPoolConfig({ tenantId = 'system' } = {}) {
  const { readConfig } = await import('../config/configStore.js');
  const row = await readConfig(POOL_CONFIG_KEY, { tenantId }).catch(() => null);
  if (row && row.value && Array.isArray(row.value.pools)) return normalizePoolConfig(row.value);
  const legacy = await getPoolConfig('org-hq', { tenantId }).catch(() => null);
  if (legacy && (legacy.pick_rule || legacy.recycle_rule)) return normalizePoolConfig(legacyToPools(legacy));
  return normalizePoolConfig(DEFAULT_POOL_TEMPLATE);
}

export async function writePoolConfig({ tenantId = 'system', patch = {}, decisionId = null, updatedBy = 'system' } = {}) {
  const { writeConfig } = await import('../config/configStore.js');
  const cur = await readPoolConfig({ tenantId });
  const next = { ...cur, ...patch, _seeded: null, updated_at: new Date().toISOString() };
  await writeConfig(POOL_CONFIG_KEY, next, { tenantId, decisionId, updatedBy });
  return normalizePoolConfig(next);
}
```

**⚠ 执行修订（D4/D5，2026-09-11）**：上方 `pool.js` 代码块为计划原稿。实际实现额外包含：
- 新增 `readLegacyPoolConfig(orgId='org-hq', { query, tenantId })`：精确探测旧组织粒子（无行 → `null`），替代原 `getPoolConfig` 恒真探测（D4）。
- `readPoolConfig({ tenantId, readConfig=null, query })`：`readConfig`/`query` **可注入**（与 `getPoolConfig` 同款），使三级优先级可在**零 DB** 下断言（D5；变异 M6 实测暴露「接线仅在 DB 组被覆盖 → DB 不可用时漏网」）。

- [x] **Step 5: 运行确认通过**

```
node node_modules/vitest/vitest.mjs run test/sales/poolTypes.test.js test/sales/poolTenant.test.js
```

预期：全绿；`poolTenant.test.js` 仍绿证明旧组织粒子路径未被破坏。

- [x] **Step 6: Commit**

```powershell
git add src/sales/pool.js db/migrate.js db/migration-lead-pool-config.sql scripts/seed-test-config.mjs test/sales/poolTypes.test.js
git commit -m "feat(pool): 池配置迁 config_store per-tenant，new/nurture/lost 三池 + 双通道播种 + 精确旧配置探测"
```


### 📌 执行记录（2026-09-11）

**结论**：Task 3 完成并通过全量鉴别力验证（**变异 7/7 RED**）。

**改动面（5 文件）**
- `src/sales/pool.js`：三池模型 + `readLegacyPoolConfig`（D4）+ `readPoolConfig` 依赖可注入（D5）
- `db/migrate.js`：`migrateTenant()` 之后运行时播种块（D1；镜像 billing-plans 存在性检查范式）
- `db/migration-lead-pool-config.sql`：JSON 单一事实源；`WHERE NOT EXISTS` 幂等（两代主键兼容）
- `scripts/seed-test-config.mjs`：`ensureLeadPoolConfig()` + steps 注册（D1 测试库通道）
- `test/sales/poolTypes.test.js`：17 例五层（①纯函数 / ②真库 autoSeed+`_seeded` / ③渠道守卫 / ④探测精确性 / ⑤优先级接线）

**验证**
- 零 DB 组 16 例全绿（② 因 PG 5433 未运行 skip，非降绿——显式 `ctx.skip`）。
- **变异 7/7 RED**：M1 删 migrate 播种块、M2 摘 pretest 步骤、M3 SQL 阈值漂移、M4 SQL 标签漂移、M5 探测恒返回默认、M6 优先级反转、M7 摘旧配置兼容读。
- **M6 首轮 GREEN → 定性为覆盖缺口**（非等价变异）：`readPoolConfig` 接线仅由 DB 组 ② 覆盖，DB 不可用时整组 skip ⇒ 接线缺陷静默通过。已补 ⑤ 组并经 M6/M7 复验 RED。
- 红线 sha256 未变：`routing.js`=`aa7a5ad7b5ca7d12`、`assembler.js`=`12ac9bc27edc76a8`。

**⚠ 环境说明**：PG 5433 未运行（本机无 PG 二进制/进程）→ ② 组与 `poolTenant.test.js`/`pool-config.test.js` 等真库套件不可跑。② 组的鉴别器（`_seeded`）已由 ③ 组源级守卫（migrate.js/pretest 双通道）在零 DB 下等价锁住。

**⚠ 工作树既有进展（非本轮）**：`src/action/seed-actions.js`、`src/http/controlledConfigPages.js` 已含未提交改动，`test/action/leadPickRecycle.test.js`（13/13 绿）已存在 —— 属 **Task 4 已实现 / Task 5 部分实现**，待各自独立走「派发前契约复查 + 变异 + 回写」流程，**不在 Task 3 范围**。

---

## Task 4: 修复租户漏传 + 改造 pick/recycle 到 S0/S0P 语义

> **⚠ 派发前源码级契约复查（2026-09-11，本会话）**：接管时本 Task 产物**已由前置会话落地但零验证**
> （计划零勾选、无执行记录）。复查发现 **6 项缺陷（2🔴）**，其中 D1 为跨层静默失效（纯函数层正确、
> SQL 层错误、且 mock 掩盖），D4 为**计划自身与 S25 schema 冲突**。逐项处置见文末执行记录。

**Files:**
- Modify: `src/action/seed-actions.js:839-935`
- Modify: `src/http/controlledConfigPages.js:192`（fetch 定义）、`:321`（fetch 调用）
- Modify: `src/scheduler/timers.js:141`
- Test: `test/action/leadPickRecycle.test.js`（新建）

- [x] **Step 1: 写失败测试**

```js
// test/action/leadPickRecycle.test.js — 认领/回收的 S0/S0P 语义与租户限定
import { test } from 'vitest';
import assert from 'node:assert';
import { toStageCode, isPoolStage } from '../../src/sales/stageTaxonomy.js';
import { readPoolConfig, resolvePoolId, poolOf } from '../../src/sales/pool.js';

test('仅 S0 可领取：S0P/S1 不满足领取前置', () => {
  for (const s of ['S0P', 'S1', 'S2']) assert.notStrictEqual(toStageCode(s), 'S0');
  assert.strictEqual(toStageCode('S0'), 'S0');
});

test('回收对象为 S0P（已认领），公海 S0 不参与超期扫描', () => {
  assert.strictEqual(toStageCode('S0P'), 'S0P');
  assert.ok(isPoolStage('S0'));
  assert.ok(!isPoolStage('S0P'));
});

test('池规则按目标池解析，且不再返回 org-hq 硬编码', async () => {
  const cfg = await readPoolConfig({ tenantId: 'e2e-pool-t-a' });
  assert.notStrictEqual(resolvePoolId(cfg, {}), 'org-hq');
  assert.ok(poolOf(cfg, resolvePoolId(cfg, {})).pick_rule);
});
```

- [x] **Step 2: 运行确认失败**（`readPoolConfig` 未就绪时全红；就绪后第 3 条绿，前两条在 S0 常量落地后绿）

```
node node_modules/vitest/vitest.mjs run test/action/leadPickRecycle.test.js
```

- [x] **Step 3: 改造 `crm-lead-pick`**（`seed-actions.js:841-890`）

替换 handler 内的判定与查询段：

```js
    handler: async ({ deal_id, owner_id, pool_id }, ctx) => {
      const { query } = await import('../db.js');
      const { readPoolConfig, poolOf, resolvePoolId, checkPickRule } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 仅公海(S0)可领；已认领(S0P/S1+)拒领（杜绝重复归属）
      if (toStageCode(deal.payload.stage) !== 'S0') {
        throw new Error(`非公海阶段: ${deal.payload.stage}（仅 S0 公海可领取）`);
      }
      if (deal.payload.owner_id) throw new Error('该线索已有归属，不可重复领取');
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const targetPool = resolvePoolId(cfg, { pool_id });
      const pool = poolOf(cfg, targetPool);
      const prev_owner = deal.payload.prev_owner_id || null;
      // 当日领取计数 + 上次领取时间（P1 修复：补 tenant 谓词，禁止跨租户计数串扰）
      const agg = await query(
        `SELECT count(*)::int n, max(updated_at) last_pick FROM crm.particles
         WHERE type='CRM_DEAL' AND tenant_id=$2 AND payload->>'stage'='S0P' AND payload->>'owner_id'=$1`,
        [owner_id, tenantId]
      ).catch((e) => { recordFailure('crm-lead-pick-agg-failed', e); return { rows: [{ n: 0, last_pick: null }] }; });
      const check = checkPickRule(pool.pick_rule, {
        owner: owner_id, prev_owner,
        today_picked_count: agg.rows[0].n,
        last_picked_at: agg.rows[0].last_pick,
        follow_up_at: deal.payload.last_follow_up_at,
        is_new: !!deal.payload.is_new,
      });
      if (!check.ok) throw new Error(`池领取规则拒绝: ${check.errors.join('; ')}`);
```

替换写入段：

```js
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0P',                       // 认领 = 进入私海待校验，不是正式线索
          owner_id, prev_owner_id: prev_owner,
          picked_at: new Date().toISOString(),
          pool_id: pool.id, pool_type: pool.type || 'new',
        },
        requireDecisionId: decision_id, tenantId,
      });
      emit('crm', 'lead-picked', { deal_id, owner_id, pool_id: pool.id, tenantId });
      return { ...updated, decision_id };
    },
  });
```

并把 `requireDecision` 的入参 `{ action: 'lead-pick', deal_id, owner_id, pool: pool_id || 'org-hq' }` 改为 `pool: pool.id`。

**⚠ 执行修订（D1/D5，2026-09-11）**：上方 Step 3 代码块中 `agg` 查询为计划原稿，实际实现已改：

```js
// D1：原 count(*) 无日期谓词 → today_picked_count 实为「在库 S0P 总量」，daily_limit 退化为总量上限。
//     且 max(updated_at) 被任意跟进刷新 → pick_interval_hours 判定失真。改「当日 FILTER + picked_at」条件聚合。
const agg = await query(
  `SELECT
     count(*) FILTER (WHERE NULLIF(payload->>'picked_at','')::timestamptz >= date_trunc('day', now()))::int AS n,
     max(NULLIF(payload->>'picked_at','')::timestamptz) AS last_pick
   FROM crm.particles
   WHERE type='CRM_DEAL' AND tenant_id=$2 AND payload->>'stage'='S0P' AND payload->>'owner_id'=$1`,
  [owner_id, tenantId]
)
```
D5：`emit('crm','lead-picked', …)` 的租户键由 `tenantId` 统一为 **`tenant_id`**（与 `timers.js` 的 `lead-overdue` 一致）。

- [x] **Step 4: 改造 `crm-lead-recycle`**（`seed-actions.js:896-935`）

```js
    handler: async ({ deal_id, reason }, ctx) => {
      const { readPoolConfig, poolOf, resolvePoolId, checkRecycleRule } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 回收对象 = 已认领的私海待校验线索（S0P）；公海 S0 无人跟进，不参与超期回收
      if (toStageCode(deal.payload.stage) !== 'S0P') {
        throw new Error(`非私海待校验阶段: ${deal.payload.stage}（仅 S0P 可回收）`);
      }
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const curPool = poolOf(cfg, resolvePoolId(cfg, { pool_id: deal.payload.pool_id, pool_type: deal.payload.pool_type }));
      const check = checkRecycleRule(curPool.recycle_rule, { last_follow_up_at: deal.payload.last_follow_up_at });
      if (!check.ok) throw new Error(`未达回收条件: ${check.reason}`);
```

写入段（**补 `tenantId` —— P0 修复**）：

```js
      const targetId = (!curPool.recycle_rule.recycle_target || curPool.recycle_rule.recycle_target === 'self')
        ? curPool.id : curPool.recycle_rule.recycle_target;
      const tgtPool = poolOf(cfg, targetId);
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0',                        // 回到公海
          owner_id: null, prev_owner_id: deal.payload.owner_id || null,
          pool_id: tgtPool.id, pool_type: tgtPool.type || curPool.type,
          recycled_at: new Date().toISOString(),
          recycle_reason: reason || check.reason,
        },
        requireDecisionId: decision_id,
        tenantId,                             // P0：此前缺失 → 回收写无租户谓词
      });
      emit('crm', 'lead-recycled', { deal_id, reason: reason || check.reason, decision_id, tenantId });
      return { ...updated, decision_id };
    },
  });
```

- [x] **Step 5: 修复 P0 —— 配置页租户串读**

`src/http/controlledConfigPages.js:321`：`raw = (await def.fetch()) || [];` → `raw = (await def.fetch(req)) || [];`

`src/http/controlledConfigPages.js:186-201` 的 pool-config 页：

```js
  'pool-config': {
    schema: S25_SCHEMA,
    inject: 'attr-field',
    // P0 修复（2026-09-11）：原实现 getPoolConfig('org-hq') 不带租户 → 租户管理员看到并改的是 system 配置
    fetch: async (req) => {
      try {
        const { resolveMe } = await import('./auth.js');
        const { scopeTenant } = await import('./tenantScope.js');
        const { readPoolConfig } = await import('../sales/pool.js');
        const me = resolveMe(req);
        const tenantId = scopeTenant(me && me.ok ? me : null);
        const c = await readPoolConfig({ tenantId });
        return [c];
      } catch {
        return [];
      }
    },
    map: (r) => ({
      pools: { value: r.pools || [] },
      default_pool: { value: r.default_pool || 'pool-new' },
      _seeded: { value: r._seeded || '' },
    }),
  },
```

**⚠ 执行修订（D4，2026-09-11）**：上方 Step 5 的 `map` 为计划原稿，**与 S25 schema 冲突** ——
`src/pages/S25.schema.js` 仅声明 `attr-field(pick_rule)` + `attr-field(recycle_rule)` + `select(targetPool)`，
无 `pools`/`default_pool`/`_seeded` 位；照计划返回 `{pools, default_pool, _seeded}` → 页面**全空**。
实装已改为**摘要桥接**（取 `default_pool` 的规则文本渲染成 `pick_rule`/`recycle_rule` 两个 attr-field，
保证页面非空；完整三池 TAB 属 T5 `src/portal/poolConfigRender.js`）。

- [x] **Step 6: 超期扫描改扫 S0P + 事件带 tenant**

`src/scheduler/timers.js:141`：

```js
    query(
      `SELECT id, tenant_id, payload FROM crm.particles
       WHERE type='CRM_DEAL' AND payload->>'stage'='S0P' AND payload->>'owner_id' IS NOT NULL`
    ).then(({ rows }) => {
```

并在两处 `emit` 的 payload 增 `tenant_id: deal.tenant_id`（供下游 Action 携带租户）。

- [x] **Step 7: 运行确认通过**

```
node node_modules/vitest/vitest.mjs run test/action/leadPickRecycle.test.js test/audit-hook.test.js test/action 2>/dev/null
```

- [x] **Step 8: Commit**

```bash
git add src/action/seed-actions.js src/http/controlledConfigPages.js src/scheduler/timers.js test/action/leadPickRecycle.test.js
git commit -m "fix(pool): 补租户漏传(P0)，认领/回收改 S0/S0P 语义，池查询带 tenant 谓词"
```

**执行记录（2026-09-11，本会话 inline execution）**

- **状态**：✅ 完成。接管前置会话未验证落地，按固定工作流补齐（契约复查 → 消解 → 补强测试 → 变异 → 回写）。
- **派发前契约复查 6 项缺陷（2🔴）**

| # | 级别 | 缺陷 | 证据锚点 | 处置 |
|---|---|---|---|---|
| D1 | 🔴 | **`daily_limit` 语义失效**：`today_picked_count` 的 SQL 为 `count(*)` **无日期谓词** → 实为「该 owner 在库 S0P 总量」；累计持有 N 条即锁死当日份额，线索回收后计数腾空 → 可无限刷单绕过日限。且 `max(updated_at)` 被任意跟进刷新 → `pick_interval_hours` 判定失真 | `seed-actions.js:879-883`（旧） | 改「当日 FILTER 条件聚合 + 锚定 `picked_at`」 |
| D4 | 🔴 | **计划 Step 5 的 `map` 与 S25 schema 冲突**：计划原稿返回 `{pools, default_pool, _seeded}`，S25 仅声明 `attr-field(pick_rule/recycle_rule)` + `select(targetPool)` → 照计划页面**全空**。实装已正确改为摘要桥接 | `S25.schema.js:8-11` vs 计划 Step 5 | 计划回写偏离说明（见 Step 5 注记） |
| D2 | 🟡 | `ctx.tenantId \|\| 'system'` 与铁律不一致（`executor.js:105`「缺 tenantId 即 fail-closed」）；但 pick/recycle 声明 `requiresEntitlement` → 第 1.7 闸先拒，**executor 链路下不可达** | `executor.js:105-114` | 记录，不改（避免与计划分歧） |
| D5 | 🟡 | 事件租户键命名分叉：`lead-picked`/`lead-recycled` 用 `tenantId`，`timers` 的 `lead-overdue` 用 `tenant_id` | `seed-actions.js:916,972` vs `timers.js:152` | 统一为 `tenant_id` |
| D6 | 🟡 | **测试鉴别力缺口**：原 13 例无一覆盖「显式 `pool_id`」；实现若忽略入参恒用 `default_pool` 仍全绿 | `leadPickRecycle.test.js` | 新增 ⑧ 例 + 变异 M5 证伪 |
| D3 | 🟢 | 配置页对 admin 得 `scopeTenant='*'` → `readConfig` 对 `'*'` 走「不 autoSeed、直读 system 模板」→ **行为正确**（通配读=平台默认） | `configStore.js:14-17` | 已验证，无需改 |

- **改动面**：`src/action/seed-actions.js`（D1 agg SQL + D5 双事件键）、`test/action/leadPickRecycle.test.js`（13→**17 例**）、`src/http/controlledConfigPages.js`（Step 5，前置落地）、`src/scheduler/timers.js`（Step 6，前置落地）
- **验证**：T4 验收集 **175 passed / 1 skipped**（DB 组显式跳过，非降绿）；**变异 11/11 RED** —— M1/M2 还原 D1、M3/M4 事件键、M5 忽略显式 pool_id、M6 阶段守卫、M7 tenantId 缺失、M8 不真回公海、M9 丢前归属、M10 忽略 recycle_target、M11 tenant 谓词失效
- **红线**：`routing.js`=`aa7a5ad7b5ca7d12`、`assembler.js`=`12ac9bc27edc76a8` 未变

---

## Task 5: 池配置页三池 TAB + 字段对齐

**Files:**
- Modify: `src/portal/poolConfigRender.js`
- Modify: `src/web/pool-config.html`
- Modify: `src/http/routes.js:772-791`
- Test: `test/pool-config.test.js`（如已存在则增补）、`test/portal/poolConfigRender.test.js`（新建）

- [x] **Step 1: 写失败测试**

```js
// test/portal/poolConfigRender.test.js — 池配置页字段与引擎契约对齐
import { test } from 'vitest';
import assert from 'node:assert';
import { POOL_KEYS, validatePoolPatch, renderPoolTabs } from '../../src/portal/poolConfigRender.js';

test('POOL_KEYS 覆盖引擎真实消费的四个领取键 + 回收天数', () => {
  for (const k of ['daily_limit', 'pick_interval_hours', 'prev_owner_only', 'new_data_only', 'recycle_days']) {
    assert.ok(POOL_KEYS.includes(k), `缺 ${k}`);
  }
});

test('validatePoolPatch 拒绝越界 daily_limit', () => {
  const r = validatePoolPatch({ daily_limit: 0 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join().includes('daily_limit'));
});

test('renderPoolTabs 输出 new/nurture/lost 三个 TAB', () => {
  const html = renderPoolTabs({ pools: [
    { id: 'pool-new', type: 'new', label: '新线索公海', pick_rule: {}, recycle_rule: {} },
    { id: 'pool-nurture', type: 'nurture', label: '培育公海', pick_rule: {}, recycle_rule: {} },
    { id: 'pool-lost', type: 'lost', label: '战败回收公海', pick_rule: {}, recycle_rule: {} },
  ] });
  assert.ok(html.includes('data-pool="pool-new"'));
  assert.ok(html.includes('data-pool="pool-nurture"'));
  assert.ok(html.includes('data-pool="pool-lost"'));
});

test('_seeded 时渲染平台模板徽标', () => {
  const html = renderPoolTabs({ pools: [], _seeded: 'system-template' });
  assert.ok(html.includes('继承自平台模板'));
});
```

- [x] **Step 2: 运行确认失败**

```
node node_modules/vitest/vitest.mjs run test/portal/poolConfigRender.test.js
```

- [x] **Step 3: 重写渲染器**

替换 `src/portal/poolConfigRender.js` 全文：

```js
// poolConfigRender.js — 池配置（第 20 项）渲染纯函数子模块
// 零服务端 import。三类池（new/nurture/lost）每租户一套，字段与引擎消费键严格对齐。
// 2026-09-11 修复：原 POOL_KEYS = ['pickRule','recycleAfterDays'] 与引擎实际消费的
//   daily_limit/pick_interval_hours/prev_owner_only/new_data_only 完全不对齐 → 页面改的键引擎不认。

// 引擎消费键（src/sales/pool.js checkPickRule / checkRecycleRule）——页面只能用这些键
export const POOL_KEYS = [
  'daily_limit', 'pick_interval_hours', 'prev_owner_only', 'new_data_only', 'recycle_days',
];

const POOL_LABEL = { new: '新线索公海', nurture: '培育公海', lost: '战败回收公海' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 校验并归一化单池规则补丁（纯函数）
export function validatePoolPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !POOL_KEYS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${POOL_KEYS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('daily_limit' in patch) {
    const v = Number(patch.daily_limit);
    if (!Number.isInteger(v) || v < 1 || v > 999) errors.push('daily_limit 须为 1–999 的整数');
    else n.daily_limit = v;
  }
  if ('pick_interval_hours' in patch) {
    const v = Number(patch.pick_interval_hours);
    if (!Number.isInteger(v) || v < 0 || v > 720) errors.push('pick_interval_hours 须为 0–720 的整数（小时）');
    else n.pick_interval_hours = v;
  }
  if ('prev_owner_only' in patch) {
    if (typeof patch.prev_owner_only !== 'boolean') errors.push('prev_owner_only 须为布尔');
    else n.prev_owner_only = patch.prev_owner_only;
  }
  if ('new_data_only' in patch) {
    if (typeof patch.new_data_only !== 'boolean') errors.push('new_data_only 须为布尔');
    else n.new_data_only = patch.new_data_only;
  }
  if ('recycle_days' in patch) {
    const v = Number(patch.recycle_days);
    if (!Number.isInteger(v) || v < 1 || v > 3650) errors.push('recycle_days 须为 1–3650 的整数（天）');
    else n.recycle_days = v;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// 三池 TAB（纯函数）：每个 TAB 一组规则输入，data-pool 供前端取池 id 回写
export function renderPoolTabs(v = {}) {
  const pools = Array.isArray(v.pools) ? v.pools : [];
  const badge = v._seeded
    ? '<span class="badge" title="该配置克隆自平台模板，保存后由本租户自持">继承自平台模板</span>'
    : '';
  if (!pools.length) return `<div class="empty">池配置未设置（readPoolConfig 兜底默认三池）</div>${badge}`;
  const tabs = pools.map((p, i) => {
    const pr = p.pick_rule || {};
    const rr = p.recycle_rule || {};
    return `<section class="pool-tab" data-pool="${esc(p.id)}" data-type="${esc(p.type)}" ${i === 0 ? '' : 'hidden'}>
      <h4>${esc(p.label || POOL_LABEL[p.type] || p.id)} <code>${esc(p.id)}</code></h4>
      <label>每日领取上限</label>
      <input name="daily_limit" type="number" min="1" max="999" value="${esc(pr.daily_limit ?? 10)}" />
      <label>领取间隔（小时）</label>
      <input name="pick_interval_hours" type="number" min="0" max="720" value="${esc(pr.pick_interval_hours ?? 0)}" />
      <label>限前归属人领取</label>
      <input name="prev_owner_only" type="checkbox" ${pr.prev_owner_only ? 'checked' : ''} />
      <label>限新数据</label>
      <input name="new_data_only" type="checkbox" ${pr.new_data_only ? 'checked' : ''} />
      <label>超期回收天数</label>
      <input name="recycle_days" type="number" min="1" max="3650" value="${esc(rr.recycle_days ?? 30)}" />
      <button class="btn" type="button" data-save="${esc(p.id)}">保存本池</button>
    </section>`;
  }).join('');
  const nav = pools.map((p, i) =>
    `<button class="tab-btn${i === 0 ? ' active' : ''}" data-target="${esc(p.id)}">${esc(p.label || POOL_LABEL[p.type] || p.id)}</button>`
  ).join('');
  return `<div class="pool-cfg">${badge}<nav class="tabs">${nav}</nav>${tabs}</div>`;
}
```

- [x] **Step 4: 扩展 `/api/pool-config` 端点**（`routes.js:772-791`）

GET 分支返回新配置并保留旧字段：

```js
  app.get('/api/pool-config', async (req, res) => {
    try {
      const me = resolveMe(req);
      const { orgId = 'org-hq' } = req.query;
      const tenantId = scopeTenant(me && me.ok ? me : null);
      const config = await readPoolConfig({ tenantId });
      const legacy = await getPoolConfig(orgId, { tenantId });
      res.json({ orgId, tenantId, config, legacy, seeded: Boolean(config._seeded) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.put('/api/pool-config', async (req, res) => {
    try {
      const me = resolveMe(req);
      const { orgId = 'org-hq', patch, pools } = req.body || {};
      const tenantId = scopeOf(me && me.ok ? me : null);
      if (Array.isArray(pools)) {
        const { validatePoolPatch } = await import('../portal/poolConfigRender.js');
        const cfg = await readPoolConfig({ tenantId });
        const nextPools = cfg.pools.map((p) => {
          const hit = pools.find((x) => x.id === p.id);
          if (!hit) return p;
          const pr = validatePoolPatch(hit.pick_rule || {});
          const rr = validatePoolPatch({ recycle_days: hit.recycle_rule?.recycle_days });
          if (!pr.ok || !rr.ok) throw new Error([...pr.errors, ...rr.errors].join('; '));
          return { ...p, pick_rule: { ...p.pick_rule, ...pr.normalized }, recycle_rule: { ...p.recycle_rule, ...rr.normalized } };
        });
        const config = await writePoolConfig({ tenantId, patch: { pools: nextPools }, updatedBy: me?.actor || 'system' });
        return res.json({ orgId, tenantId, config, updated: true });
      }
      if (!patch || typeof patch !== 'object') return res.status(400).json({ error: 'patch 或 pools 必填' });
      const config = await setPoolConfig(orgId, patch, { tenantId });
      res.json({ orgId, tenantId, config, updated: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
```

在 `routes.js` 顶部 import 增补 `readPoolConfig, writePoolConfig`。

- [x] **Step 5: 更新页面**（`src/web/pool-config.html`）：把表单容器换成 `#pool-tabs`，脚本改为拉取 `/api/pool-config` 的 `config.pools` 并调用 `renderPoolTabs`，TAB 切换绑定 `data-target`，保存按 `data-save` 的池 id PUT `{pools:[{id,pick_rule,recycle_rule}]}`。

- [x] **Step 6: 运行确认通过**

```
node node_modules/vitest/vitest.mjs run test/portal/poolConfigRender.test.js test/pool-config.test.js
```

- [x] **Step 7: Commit**

```bash
git add src/portal/poolConfigRender.js src/web/pool-config.html src/http/routes.js test/portal/poolConfigRender.test.js
git commit -m "feat(pool-config): 三类池 TAB，字段对齐引擎消费键，端点按租户读写"
```

---

## Task 6: `crm-lead-return` 手动退回（场景 ②）

**Files:**
- Modify: `src/action/seed-actions.js`（在 `crm-lead-recycle` 之后追加）
- Modify: `src/page/schema.js:57`（`ACTION_WHITELIST.write`）
- Test: `test/action/leadPoolActions.test.js`（新建，本任务只写 return 部分）

- [x] **Step 1: 写失败测试**

```js
// test/action/leadPoolActions.test.js — 退回 / 归档 / 离职回收 的正反例（纯判定部分）
import { test } from 'vitest';
import assert from 'node:assert';

const RETURN_REASONS = ['no_project', 'no_budget', 'no_decision_maker', 'no_timeline', 'other'];

test('reason_code 枚举封闭', () => {
  assert.ok(RETURN_REASONS.includes('no_budget'));
  assert.ok(!RETURN_REASONS.includes('随便填'));
});

test('可退回阶段仅 S0P/S1；S5 与 S0 不可退回', () => {
  const ok = (s) => ['S0P', 'S1'].includes(s);
  assert.strictEqual(ok('S0P'), true);
  assert.strictEqual(ok('S1'), true);
  assert.strictEqual(ok('S5'), false);
  assert.strictEqual(ok('S0'), false); // 已在公海
});
```

- [x] **Step 2: 运行确认失败**（文件当前不存在 → 先跑一次会红；随后随实现转绿）

```
node node_modules/vitest/vitest.mjs run test/action/leadPoolActions.test.js
```

- [x] **Step 3: 注册 Action**

在 `src/action/seed-actions.js` 的 `crm-lead-recycle` 注册块之后追加：

```js
  // crm-lead-return：销售手动退回公海（场景②：核实无立项/无预算，不能转正式商机）
  // 关键：不调用 checkRecycleRule —— 退回是「质量」判据（客户没立项），不是「时间」判据。
  //   原 crm-lead-recycle 硬校验超期（seed-actions.js:916）→ 未超期即 throw，销售退回被引擎拒（根因）。
  registerAction({
    name: 'crm-lead-return', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', reason_code: 'string', note: 'string' },
    parameters: {
      required: ['deal_id', 'reason_code'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, reason_code, note }, ctx) => {
      const RETURN_REASONS = new Set(['no_project', 'no_budget', 'no_decision_maker', 'no_timeline', 'other']);
      if (!RETURN_REASONS.has(reason_code)) {
        throw new Error(`非法 reason_code: ${reason_code}（须为 ${[...RETURN_REASONS].join('/')}）`);
      }
      const { readPoolConfig, poolOf, resolvePoolId } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const stage = toStageCode(deal.payload.stage);
      if (stage !== 'S0P' && stage !== 'S1') throw new Error(`非可退回阶段: ${deal.payload.stage}（仅 S0P/S1）`);
      if (!deal.payload.owner_id) throw new Error('无归属线索无需退回（已在公海）');
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const curPool = poolOf(cfg, resolvePoolId(cfg, { pool_id: deal.payload.pool_id, pool_type: deal.payload.pool_type }));
      const targetId = curPool?.return_target || 'pool-nurture';   // 默认进培育池，不回新线索池
      const tgtPool = poolOf(cfg, targetId);

      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LEAD_FOLLOW_UP',
          { action: 'lead-return', deal_id, reason_code, from_stage: stage },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'lead-return', { deal_id, decision_id, mode: res.mode });
      }
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0', owner_id: null,
          prev_owner_id: deal.payload.owner_id,
          pool_id: tgtPool?.id || targetId,
          pool_type: tgtPool?.type || 'nurture',
          returned_at: new Date().toISOString(),
          return_reason: reason_code,
          return_note: note || null,
          qualified_at: null, qualified_by: null,   // 退回即取消「正式线索」资格
          mant_ok_at_return: mantOk(deal.payload.funnel || {}).ok,  // 审计留痕，不作拒绝判据
        },
        requireDecisionId: decision_id, tenantId,
      });
      emit('crm', 'lead-returned', { deal_id, reason_code, decision_id, tenantId });
      return { ...updated, decision_id };
    },
  });
```

- [x] **Step 4: 加入页面白名单**

`src/page/schema.js:57` 的 `write` 数组内 `'crm-lead-recycle'` 之后追加 `'crm-lead-return'`。

- [x] **Step 5: 运行确认通过**

```
node node_modules/vitest/vitest.mjs run test/action/leadPoolActions.test.js test/page.test.js test/action-registry-wiring.test.js
```

- [x] **Step 6: Commit**

```bash
git add src/action/seed-actions.js src/page/schema.js test/action/leadPoolActions.test.js
git commit -m "feat(action): crm-lead-return 手动退回公海（跳过超期校验，按质量判据）"
```

---

## Task 7: `crm-deal-archive-to-pool` 战败归档 + 再激活（场景 ③）

**Files:**
- Modify: `src/sales/reopenDeal.js`
- Modify: `src/action/seed-actions.js`（新增 archive Action；改造 `crm-deal-reopen` 调用）
- Modify: `test/sales/reopenDeal.test.js`（目标阶段 S2→S0P）
- Test: `test/action/leadPoolActions.test.js`（增补归档用例）

- [x] **Step 1: 写失败测试**

在 `test/action/leadPoolActions.test.js` 追加：

```js
test('仅终态 S7/S8 可归档入战败公海；S3 拒绝', () => {
  const archivable = (s) => ['S7', 'S8'].includes(s);
  assert.strictEqual(archivable('S7'), true);
  assert.strictEqual(archivable('S8'), true);
  assert.strictEqual(archivable('S3'), false);
});

test('重开源阶段含 S0+lost（战败公海）', () => {
  const reopenable = (s, poolType) => ['S7', 'S8'].includes(s) || (s === 'S0' && poolType === 'lost');
  assert.strictEqual(reopenable('S0', 'lost'), true);
  assert.strictEqual(reopenable('S0', 'new'), false);
  assert.strictEqual(reopenable('S7', 'new'), true);
});
```

- [x] **Step 2: 运行确认失败**

```
node node_modules/vitest/vitest.mjs run test/action/leadPoolActions.test.js
```

- [x] **Step 3: 改造 `reopenDeal.js`**

```js
import { getParticle, updateParticle } from '../particles/particleRepo.js';
import { emit } from '../events/bus.js';
import { toStageCode } from './stageTaxonomy.js';

export const REOPENABLE_STAGES = new Set(['S7', 'S8']); // 输单 / 丢单
export const REOPEN_TARGET_STAGE = 'S0P';               // 重开后回私海待校验，重走 BANT

// decision_id 已由 action handler 经第 0 闸 mint（DEAL_REOPEN），此处只做粒子写
export async function reopenDeal(dealId, { reason, owner, decision_id, tenantId = null } = {}) {
  const deal = await getParticle(dealId);
  if (!deal) throw new Error(`DEAL 不存在: ${dealId}`);
  const cur = deal.payload.stage;
  const code = toStageCode(cur);
  // 战败公海（S0 + pool_type=lost）同样可激活；普通公海（S0 + new/nurture）不可
  const fromLostPool = code === 'S0' && deal.payload.pool_type === 'lost';
  if (!REOPENABLE_STAGES.has(code) && !fromLostPool) {
    throw new Error(`仅退出态(S7/S8)或战败公海(S0+lost)可重开，当前=${cur}`);
  }
  if (!decision_id) throw new Error('reopenDeal 需携带决策锚定 decision_id');
  const patch = {
    stage: REOPEN_TARGET_STAGE,
    reopen_count: (deal.payload.reopen_count || 0) + 1,
    reopened_at: new Date().toISOString(),
    last_reopen_reason: reason || null,
    last_reopen_decision_id: decision_id,
    transitionedBecause: reason || `reopen from ${cur}`,
    // 出池：恢复战败前的池归属（归档时留痕），无痕则回默认池
    pool_id: deal.payload.prev_pool_id || deal.payload.pool_id,
    pool_type: deal.payload.prev_pool_type || 'new',
    last_terminal_stage: code === 'S0' ? (deal.payload.last_terminal_stage || null) : code,
  };
  const updated = await updateParticle(dealId, { patch, tenantId });
  emit('decision', 'deal-reopen', { deal_id: dealId, from: cur, to: REOPEN_TARGET_STAGE, decision_id, owner });
  return { ...updated, decision_id };
}
```

- [x] **Step 4: 注册归档 Action**

```js
  // crm-deal-archive-to-pool：战败归档进战败公海（场景③）
  // 语义：归档后 stage=S0（统一公海语义）+ pool_type=lost，同时写 last_terminal_stage 保留输单/丢单事实，
  //       避免「归档即丢失战败信息」；再激活由 crm-deal-reopen 从 S0(lost) → S0P 重走 BANT。
  registerAction({
    name: 'crm-deal-archive-to-pool', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', reason: 'string' },
    parameters: {
      required: ['deal_id'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, reason }, ctx) => {
      const { readPoolConfig, poolOf, resolvePoolId } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const cur = toStageCode(deal.payload.stage);
      if (cur !== 'S7' && cur !== 'S8') throw new Error(`仅终态(S7/S8)可归档，当前=${deal.payload.stage}`);
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const lost = cfg.pools.find((p) => p.type === 'lost') || { id: 'pool-lost', type: 'lost' };

      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LOSS_REVIEW',
          { action: 'deal-archive-to-pool', deal_id, from_stage: cur },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'REJECT' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'deal-archive', { deal_id, decision_id, mode: res.mode });
      }
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0', pool_id: lost.id, pool_type: 'lost',
          owner_id: null, prev_owner_id: deal.payload.owner_id || null,
          prev_pool_id: deal.payload.pool_id || null,       // 供重开时恢复
          prev_pool_type: deal.payload.pool_type || null,
          last_terminal_stage: cur,                          // 保留 S7/S8 事实，不因归档丢失
          archived_at: new Date().toISOString(),
          archive_reason: reason || null,
        },
        requireDecisionId: decision_id, tenantId,
      });
      emit('crm', 'deal-archived-to-pool', { deal_id, last_terminal_stage: cur, decision_id, tenantId });
      return { ...updated, decision_id };
    },
  });
```

- [x] **Step 5: 改造 `crm-deal-reopen` 调用点**（`seed-actions.js:809`）

`reopenDeal(deal_id, { reason, owner: ctx.actor, decision_id })` →
`reopenDeal(deal_id, { reason, owner: ctx.actor, decision_id, tenantId: ctx.tenantId })`。

- [x] **Step 6: 更新既有断言**

`test/sales/reopenDeal.test.js` 中断言重开目标为 `'S2'` 的用例改为 `'S0P'`。

- [x] **Step 7: 运行确认通过**

```
node node_modules/vitest/vitest.mjs run test/sales/reopenDeal.test.js test/action/leadPoolActions.test.js
```

- [x] **Step 8: Commit**

```bash
git add src/sales/reopenDeal.js src/action/seed-actions.js test/sales/reopenDeal.test.js test/action/leadPoolActions.test.js
git commit -m "feat(action): crm-deal-archive-to-pool 战败归档入 lost 池，重开改落 S0P"
```

---

## Task 8: `crm-lead-reclaim-bulk` 离职批量回收（场景 ④）

**Files:**
- Modify: `src/action/seed-actions.js`（追加 Action）
- Test: `test/action/leadPoolActions.test.js`（增补用例）

- [x] **Step 1: 写失败测试**

```js
test('离职回收范围：非终态归原池，终态 S7/S8 归 lost 且不改阶段', () => {
  const plan = (stage, poolType) => (['S7', 'S8'].includes(stage)
    ? { poolType: 'lost', changeStage: false }
    : { poolType: poolType || 'new', changeStage: true });
  assert.deepStrictEqual(plan('S3', 'new'), { poolType: 'new', changeStage: true });
  assert.deepStrictEqual(plan('S0P', 'nurture'), { poolType: 'nurture', changeStage: true });
  assert.deepStrictEqual(plan('S8', 'new'), { poolType: 'lost', changeStage: false });
});

test('离职回收禁 system 通配租户', () => {
  const allowed = (t) => Boolean(t) && t !== 'system';
  assert.strictEqual(allowed('system'), false);
  assert.strictEqual(allowed('t-a'), true);
  assert.strictEqual(allowed(''), false);
});
```

- [x] **Step 2: 运行确认失败**

```
node node_modules/vitest/vitest.mjs run test/action/leadPoolActions.test.js
```

- [x] **Step 3: 注册 Action**

```js
  // crm-lead-reclaim-bulk：离职批量回收（场景④）
  // 语义：限定真实租户（禁 system 通配，避免一次误操作扫全库）；
  //   非终态(S0P/S1-S6) 归还原 pool_type 对应池并置 S0 公海；
  //   终态(S7/S8) 只解除归属并归 lost，不动阶段（避免把已关闭商机重新推回公海污染漏斗）。
  registerAction({
    name: 'crm-lead-reclaim-bulk', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { user_id: 'string', reason: 'string' },
    parameters: { required: ['user_id'], properties: {} },
    handler: async ({ user_id, reason }, ctx) => {
      const { query } = await import('../db.js');
      const tenantId = ctx.tenantId || 'system';
      if (!tenantId || tenantId === 'system') throw new Error('离职回收必须限定真实租户（禁 system 通配）');
      const { readPoolConfig, poolOf, resolvePoolId } = await import('../sales/pool.js');
      const cfg = await readPoolConfig({ tenantId });
      const lost = cfg.pools.find((p) => p.type === 'lost') || { id: 'pool-lost', type: 'lost' };
      const rows = await query(
        `SELECT id, payload FROM crm.particles
         WHERE type='CRM_DEAL' AND tenant_id=$1 AND payload->>'owner_id'=$2`,
        [tenantId, user_id]
      ).catch((e) => { recordFailure('crm-lead-reclaim-query-failed', e); return { rows: [] }; });

      const targets = (rows.rows || []).filter((r) => {
        const s = toStageCode(r.payload?.stage);
        return ['S0P', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].includes(s);
      });

      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LEAD_FOLLOW_UP',
          { action: 'lead-reclaim-bulk', user_id, tenantId, count: targets.length },
          [{ type: 'CRM_PERSON', id: user_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'lead-reclaim-bulk', { user_id, tenantId, decision_id, mode: res.mode });
      }

      let count = 0;
      const failed = [];
      for (const r of targets) {
        const cur = toStageCode(r.payload.stage);
        const terminal = cur === 'S7' || cur === 'S8';
        const poolType = terminal ? 'lost' : (r.payload.pool_type || 'new');
        const pid = terminal ? lost.id : resolvePoolId(cfg, { pool_type: poolType });
        try {
          await updateParticle(r.id, {
            patch: {
              ...r.payload,
              ...(terminal ? {} : { stage: 'S0' }),
              owner_id: null, prev_owner_id: user_id,
              pool_id: pid, pool_type: poolType,
              reclaimed_at: new Date().toISOString(),
              reclaim_reason: reason || 'offboard',
            },
            requireDecisionId: decision_id, tenantId,
          });
          count += 1;
        } catch (e) {
          failed.push({ id: r.id, error: String(e?.message || e) });
        }
      }
      emit('crm', 'lead-reclaimed-bulk', { user_id, tenantId, count, failed: failed.length, decision_id });
      return { ok: true, count, failed, decision_id };
    },
  });
```

- [x] **Step 4: 运行确认通过**

```
node node_modules/vitest/vitest.mjs run test/action/leadPoolActions.test.js test/action-registry-wiring.test.js
```

- [x] **Step 5: Commit**

```bash
git add src/action/seed-actions.js test/action/leadPoolActions.test.js
git commit -m "feat(action): crm-lead-reclaim-bulk 离职批量回收（租户强限定）"
```

---

## Task 9: 存量迁移 + `'lead'` 十二处分流 + 前端口径

**Files:**
- Create: `db/migration-lead-pool-s0.sql`
- Modify: `src/agent/discoveryOrchestrator.js:92`
- Modify: `src/connectors/tenderConnector.js:54`
- Modify: `src/http/routes.js:932/948/1081/1236/1655`
- Modify: `src/http/workbenchRouter.js:188`
- Modify: `src/account/insightService.js:159`
- Modify: `src/portal/businessBoard.js:87`
- Modify: `src/sales/namedAccountBoard.js:20`
- Modify: `src/portal/detailSections.js:46`
- Modify: `src/portal/scoring.js:34`

- [x] **Step 1: 存量迁移脚本**

创建 `db/migration-lead-pool-s0.sql`：

```sql
-- 存量 lead 三分支迁移（2026-09-11）：无主→S0 公海 / 有主且 BANT 达标→S1 正式线索 / 有主未达标→S0P 私海待校验
-- 三条互斥且覆盖全部存量；阈值读 config_store 不硬编码。禁 DELETE：仅 JSONB 字段变更。
WITH cfg AS (
  SELECT COALESCE(
    (SELECT (value #>> '{bantcc,pass}')::numeric
       FROM crm.config_store WHERE tenant_id='system' AND key='sales-thresholds'),
    0.6) AS bantcc_pass
)
UPDATE crm.particles p
   SET payload = p.payload || jsonb_build_object(
         'stage', 'S0',
         'pool_type', COALESCE(p.payload->>'pool_type', 'new'))
 WHERE type='CRM_DEAL'
   AND p.payload->>'stage' IN ('lead','S1','S0')
   AND COALESCE(p.payload->>'owner_id','') = '';

-- ② 有主 且 BANT 达标 → S1（正式线索），补 qualified_at
WITH cfg AS (
  SELECT COALESCE(
    (SELECT (value #>> '{bantcc,pass}')::numeric
       FROM crm.config_store WHERE tenant_id='system' AND key='sales-thresholds'),
    0.6) AS bantcc_pass
)
UPDATE crm.particles p
   SET payload = p.payload || jsonb_build_object(
         'stage', 'S1',
         'qualified_at', COALESCE(p.payload->>'qualified_at', to_char(now(),'YYYY-MM-DD')),
         'pool_type', COALESCE(p.payload->>'pool_type', 'new'))
 WHERE type='CRM_DEAL'
   AND p.payload->>'stage' IN ('lead','S1')
   AND COALESCE(p.payload->>'owner_id','') <> ''
   AND ( COALESCE((p.payload->'ai'->'bantcc_completeness'->>'value')::numeric, 0) >= (SELECT bantcc_pass FROM cfg)
      OR (p.payload->'bantcc'->>'budget' IS NOT NULL AND p.payload->'bantcc'->>'authority' IS NOT NULL) );

-- ③ 有主 且 BANT 未达标 → S0P（私海待校验）
WITH cfg AS (
  SELECT COALESCE(
    (SELECT (value #>> '{bantcc,pass}')::numeric
       FROM crm.config_store WHERE tenant_id='system' AND key='sales-thresholds'),
    0.6) AS bantcc_pass
)
UPDATE crm.particles p
   SET payload = p.payload || jsonb_build_object(
         'stage', 'S0P',
         'pool_type', COALESCE(p.payload->>'pool_type', 'new'))
 WHERE type='CRM_DEAL'
   AND p.payload->>'stage' IN ('lead','S1')
   AND COALESCE(p.payload->>'owner_id','') <> ''
   AND NOT ( COALESCE((p.payload->'ai'->'bantcc_completeness'->>'value')::numeric, 0) >= (SELECT bantcc_pass FROM cfg)
          OR (p.payload->'bantcc'->>'budget' IS NOT NULL AND p.payload->'bantcc'->>'authority' IS NOT NULL) );
```

附守恒校验（脚本末尾）：

```sql
-- 校验①：无残留 lead（期望 0）
SELECT count(*) AS residual_lead FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'stage'='lead';
-- 校验②：三分支守恒 count(S0)+count(S0P)+count(S1) 应等于迁移前线线索总数
SELECT payload->>'stage' AS stage, count(*) FROM crm.particles
 WHERE type='CRM_DEAL' AND payload->>'stage' IN ('S0','S0P','S1')
 GROUP BY 1 ORDER BY 1;
```

执行：`psql "$DATABASE_URL" -f db/migration-lead-pool-s0.sql`

- [x] **Step 2: 两处写入源改为直落公海**

`src/agent/discoveryOrchestrator.js:92`：

```js
  const deal = await create('CRM_DEAL', {
    name: seed.deal_name || `${seed.name} · 线索`,
    stage: 'S0', pool_type: 'new', source: 'discovery', account_id: account.id,
  });
```

`src/connectors/tenderConnector.js:54`：

```js
  const deal = await createParticle('CRM_DEAL', {
    name: tender.title, stage: 'S0', pool_type: 'new', source: '标讯',
    expected_amount: tender.amount || 0, region: tender.region,
    tender_id: tender.id, expected_close_date: null,
  }, { tenantId });
```

- [x] **Step 3: 路由阶段兜底走 `normalizeDealStage`**

| 位置 | 现状 | 改为 |
|---|---|---|
| `routes.js:932` | `(d.payload?.stage \|\| d.state) === 'lead'` | `normalizeDealStage(d) === 'S0'`（公海计数） |
| `routes.js:948` | `stage: d.payload?.stage \|\| d.state \|\| 'lead'` | `stage: normalizeDealStage(d) \|\| 'S0'` |
| `routes.js:1081` | `const stageOf = (p) => p.payload?.stage \|\| 'lead'` | `const stageOf = (p) => normalizeDealStage(p) \|\| 'S0'` |
| `routes.js:1236` | `stage: d.payload?.stage \|\| 'lead'` | `stage: normalizeDealStage(d) \|\| 'S0'` |

在 `routes.js` 顶部 import 增补 `normalizeDealStage`。

- [x] **Step 4: 待办排除公海**

`routes.js:1655` 与 `workbenchRouter.js:188`，在 `if (!isOpenStage(raw)) continue;` 之前各插入一行：

```js
        if (isPoolStage(raw)) continue; // 公海无人跟进，不进任何人的待办
```

两处 import 增补 `isPoolStage`。

- [x] **Step 5: 前端口径拆分**

`src/account/insightService.js:159`：

```js
    { key: 'lead', name: '线索', items: (related.deals || []).filter(d => ['S0', 'S0P', 'S1'].includes(toStageCode(d?.payload?.stage))) },
```

`src/portal/businessBoard.js:87`：

```js
  const publicPool = {
    count: deals.filter((p) => isPoolStage(p.payload?.stage)).length,
    note: '公海=CRM_DEAL 中 stage=S0',
  };
  const privateLeads = deals.filter((p) => ['S0P', 'S1'].includes(toStageCode(p.payload?.stage))).length;
```

（同步更新该对象下游消费方，使 `leadPool` 拆为 `publicPool` 与 `privateLeads` 两列。）

`src/sales/namedAccountBoard.js:20`：

```js
  const leads = dealList.filter(d => ['S0P', 'S1'].includes(toStageCode(d.payload?.stage))).length;
  const publicLeads = dealList.filter(d => isPoolStage(d.payload?.stage)).length;
```

`src/portal/detailSections.js:46` 的 `L2C` 数组首项 `['lead','线索']` 改为 `['S0','公海']`，并追加 `['S0P','私海线索']`、`['S1','正式线索']`。

`src/portal/scoring.js:34` 的内联 `S_ALIAS` 增补：

```js
  S0: 'S0', S0P: 'S0P',   // 公海 / 私海线索（2026-09-11）
```

- [x] **Step 6: 复验无残留**

```
grep -rn "'lead'" src --include=*.js | grep -v "lead-pick\|lead-recycl\|lead-return\|lead-reclaim\|lead-pool\|lead-overdue\|lead-move\|'leads'"
```

预期：仅剩 Action 名等无关命中；任何 `=== 'lead'` / `|| 'lead'` 的阶段比较都应已消失。

- [x] **Step 7: Commit**

```bash
git add db/migration-lead-pool-s0.sql src/agent/discoveryOrchestrator.js src/connectors/tenderConnector.js src/http/routes.js src/http/workbenchRouter.js src/account/insightService.js src/portal/businessBoard.js src/sales/namedAccountBoard.js src/portal/detailSections.js src/portal/scoring.js
git commit -m "refactor(stage): 存量 lead 迁移 S0/S0P/S1，十二处 lead 分流与前端公海口径"
```

---

## Task 10: 全量回归 + 契约校验 + 设计文档回写

**Files:**
- Modify: `docs/2026-09-11-lead-public-pool-tenant-design.md`（§0 红线1、§5 闸门行、§6-T3 契约说明、§8 边界、§9 未决项结论）
- Test: 全量

- [x] **Step 1: 全量回归**

```
node node_modules/vitest/vitest.mjs run
```

预期：新增失败 0。重点核对 `test/sales/funnelKpi.test.js`（漏斗口径零漂移）、`test/sales/poolTenant.test.js`（旧路径未破）、`test/sales/reopenDeal.test.js`、`test/page.test.js`、`test/action/*`。

- [x] **Step 2: 契约校验**

```
node scripts/validate-contract.mjs docs/2026-09-11-lead-public-pool-tenant-design.md --registry src/agent/agentSpec.js; echo "EXIT=$?"
```

预期：`{"valid":true,"errors":[]}` 且 EXIT=0。

- [x] **Step 3: 复核设计文档订正已生效**（以下 4 处已在计划编写时同步修正，此处只做复核，不需重复编辑）

1. §0 红线 1 已改为「线索 = `CRM_DEAL` 的 S0/S0P/S1 阶段」。
2. §5 `crm-deal-advance` 行已改为「闸门落在 `STAGE_GATES` 新增 `S0P→S1` 条目；`salesDealPrereq` 的 S1 豁免保留不动」（偏离 A）。
3. §6 T3 契约说明已由 `intake-router` 改为 `followup-agent`。
4. §8 范围边界已改为「§6 T0–T7」；§9 已由「未决项」改为「已拍板结论表」。

复核命令：`grep -n "S0/S0P/S1\|STAGE_GATES\|followup-agent 承接\|T0–T7\|已拍板" docs/2026-09-11-lead-public-pool-tenant-design.md`

- [x] **Step 4: Commit**

```bash
git add docs/2026-09-11-lead-public-pool-tenant-design.md
git commit -m "docs: 订正线索公海池设计文档（闸门实现方式、承接方、范围边界、未决项结论）"
```

---

## 自检清单（执行前复核）

| 项 | 结论 |
|---|---|
| 设计 §1 十项现状 | T1–T9 全覆盖；第 9 项 BANT 落点 → Task 2；第 10 项正式线索载体 → Task 1（S1 + `qualified_at`）+ Task 7 |
| 三类池 | Task 3 |
| 场景 ②③④ | Task 6 / 7 / 8 |
| 租户隔离 P0×2 + P1×3 | Task 3（P1 硬编码 org-hq）、Task 4（P0 回收无租户、P0 配置页串读、P1 聚合无租户谓词）、Task 5（P1 字段不对齐） |
| 漏斗口径 | `S_STAGES` 冻结，Task 1 Step 6 用 `funnelKpi.test.js` 锁定 |
| 禁 DELETE | 全部为 `updateParticle` 字段变更 |
| 契约校验 | Task 10 Step 2 |

---

## 执行记录（Task 5–10，2026-09-11 20:0x–20:4x）

> 环境：本机 **PostgreSQL 未运行**（`::1:5433` / `127.0.0.1:5433` 均 ECONNREFUSED，Windows 无 PostgreSQL 服务）→ 所有 DB 依赖用例**必然红**，不代表回归。非 DB 用例作为判据。

### Task 5（池配置页三池 TAB + 字段对齐）— 完成
- 红灯→绿：新建 `test/portal/poolConfigRender.test.js`（8 例）先红 6；重写 `src/portal/poolConfigRender.js` 后 8/8 绿。
- `src/http/routes.js` `/api/pool-config` GET 返回 `{config, legacy, seeded}`；PUT 支持 `pools[]`（`validatePoolPatch` 白名单 + 边界）；import 行补 `readPoolConfig, writePoolConfig`。
- `src/web/pool-config.html` 改 `#pool-tabs`（`renderPoolTabs` + `data-target` TAB 切换 + `data-save` 按池 PUT `{pools:[{id,pick_rule,recycle_rule}]}`）；徽标色改 tokens 语义变量（零硬编码色值铁律）。
- **偏离 C（计划遗漏）**：`test/web/readableConfig.test.js` 原「池」段断言锁定**待修缺陷本身**（`POOL_KEYS=['pickRule','recycleAfterDays']` + `renderPoolForm`），与设计 §3 要求的引擎消费键直接冲突。计划 Files 未列该文件。按设计迁移契约（新键集 + `renderPoolTabs`），断言强度不降（新增 `daily_limit:0` 越界 + `data-pool` 锚点）。
- 验收集：`poolConfigRender` 8/8、`pool-config` 7/7、`browserLoadable` 3/3、`readableConfig` 10/10、`tokens-css` 3/3、`controlled-config-pages` 中 `pool-config` 面 ✓（另 2 例 `users`/`decision-scenarios` 为 DB probe 失败）。
- **端点守卫补强（本会话 20:40–20:45 收口）**：并行落地后识别「端点层零守卫」缺口——`/api/pool-config` GET 四键契约 / PUT pools 合并写回 / 未知键 400 / 越界 400 / 旧 patch 形态均无断言。新建 `test/http/poolConfigRoute.test.js`（6 例，**零 DB**：`vi.mock` 整个 `src/sales/pool.js`），初跑 4/6 失败：
  - **D1（测试自身缺陷）**：`reqJson` helper `{ headers, ...opts }` 展开顺序错误 → PUT 用例传入的 `Content-Type` headers 覆盖了合成的 `Authorization` → 401。拆解合并修后 6/6 绿。
  - **D2（测试自身缺陷）**：`beforeEach` 未 `vi.clearAllMocks()` → `writePoolConfig` 调用记录跨用例累积 → `not.toHaveBeenCalled` 假失败。补清除。
  - **变异鉴别力**（`tmp/_t5_mutation.py`，3 变异全 RED）：M1 删 seeded 透出（`seeded:false`）→ 用例 2 红 `expected false to be true`；M2 合并丢未改池（`return null`）→ `Cannot read properties of null (reading 'id')` 红；M3 删校验 throw → `expected 200 to be 400` 红。还原一致 ✓。
  - 验收集：`poolConfigRoute` 6/6 + `poolConfigRender` 8/8 + `pool-config` 7/7 = **21/21 全绿**。

### Task 6（`crm-lead-return` 手动退回）— 完成
- 新建 `test/action/leadPoolActions.test.js`（T6 段 9 例）先红 7 → 实现后 9/9。
- `src/action/seed-actions.js` 注册 `crm-lead-return`（`write` + `autoDecision`；`RETURN_REASONS` 枚举封闭；仅 S0P/S1 可退；**不调 `checkRecycleRule`**——退回是质量判据非时间判据）；`src/page/schema.js` `ACTION_WHITELIST.write` 补 `crm-lead-return`。
- **计划补漏（计划 Files 未列）**：`test/page.test.js:48` 用 `toEqual` **全等数组**断言白名单 → 不同步修改必红（Step 5 要求该文件通过却未列改动）。已同步并补注

- **独立契约复查（2026-09-11 21:2x，全源码亲证）**：
  - **D1（文档未同步实现）**：计划 Step 3 骨架 `emit('crm','lead-returned',{deal_id,reason_code,decision_id,tenantId})` 用驼峰键，实现 `seed-actions.js:1041` 已用 **`tenant_id`**（与 T4 统一后的 `lead-picked`/`lead-recycled`/`lead-overdue` 族内键一致）。**实现优于计划**，须回写骨架。属「计划文档旧稿」，非实现缺陷。
  - **租户写路径**：`ctx.tenantId || 'system'`（`:1008`）与全项目 15 处统一范式一致（含 pick:876 / recycle:947 / archive:1063 / reclaim:1108）——非 T6 特有缺陷；T4 D2（漏传）类比不成立（本动作**有** tenantId 参数并传写）。
  - **return_target 池存在性**：`poolOf(cfg, resolvePoolId(...))` 取当前池 return_target；`poolOf(cfg, targetId)` 探测目标池（`:1011-1012`）。兜底 `'pool-nurture'` 是**模板真值**（pool.js:111/114 + migration-lead-pool-config.sql:18/19），非硬编码业务字面量——配置化优先+模板兜底，符合红线 3。
  - **不调 checkRecycleRule**：`:986` 注释 + handler 无该调用 + 核心用例「今天有跟进也可退回」实证（leadPoolActions.test.js:136-162）。
  - **写盘语义**：S0 + owner_id=null + prev_owner_id + pool_id/pool_type=return_target + returned_at/reason/note + **清 qualified_at/by** + mant_ok_at_return 审计留痕（`:1026-1040`）。
  - **测试**：T6 段 7 例正反例（枚举封闭 / reason_code 非法拒绝 / S5 拒绝 / 无归属拒绝 / S0P 核心写盘 11 断言 / S1 正例 / 不走 advanceStage）+ 全文件 28 例全绿。
  - **P2 风格建议（非缺陷）**：兜底字面量 `'pool-nurture'` 可改用 `DEFAULT_POOL_TEMPLATE` 常量引用，降低「模板 id 改名不同步」风险；当前与模板源一致，零生效差异。



### Task 7（战败归档 + 再激活）— 完成
- 增补 T7 用例（纯判据 2 + 归档 4 + reopenDeal 5）先红 6 → 实现后全绿。
- `src/sales/reopenDeal.js`：重开目标 **S2 → S0P**（重开须重走 BANT）；`REOPENABLE_STAGES` 之外新增「战败公海 `S0 + pool_type='lost'`」可激活；出池恢复 `prev_pool_id/prev_pool_type`；租户参数透传 `updateParticle`。
- `src/action/seed-actions.js` 注册 `crm-deal-archive-to-pool`（`confirm:'critical'`；S7/S8 → `S0` + `pool_type:'lost'` + `last_terminal_stage` 保留战败事实 + `prev_pool_*` 供重开恢复）；`crm-deal-reopen` 调用点补 `tenantId: ctx.tenantId`。
- **计划补漏**：`crm-deal-reopen` 决策事实 payload `{stage:'S2'}` 随目标阶段改为 `'S0P'`（计划 Step 5 仅提 tenantId 透传）。
- `test/sales/reopenDeal.test.js` 断言 `S2` → `S0P`（DB 依赖，本机红）。

### Task 7（战败归档 + 再激活）— 独立契约复查（T7 复查，2026-09-11）
- **四要素验证（源码级亲读，零采信转述）**：
  1. 归档 Action `crm-deal-archive-to-pool`（seed-actions.js:1048-1095）：`confirm:'critical'`（:1049）、仅 S7/S8 可归档（:1062）、决策场景 `LOSS_REVIEW`（:1071）、写 `S0+pool_type='lost'+owner_id=null+prev_pool_id/type+last_terminal_stage+archived_at`（:1079-1091）、事件 `deal-archived-to-pool` 带 `tenant_id`（:1092）——与设计 §6 T5 契约吻合。
  2. `reopenDeal.js` 全文 41 行：`REOPENABLE_STAGES={S7,S8}`（:10）、`REOPEN_TARGET_STAGE='S0P'`（:11）；**fromLostPool 判定** `code==='S0' && pool_type==='lost'`（:20）；出池恢复 `prev_pool_id/prev_pool_type`（:33-34）；`tenantId` 透传 updateParticle（:37）。
  3. 调用点 `crm-deal-reopen`（seed-actions.js:798-826）：决策场景 `DEAL_REOPEN`（:814）、重开目标 `{stage:'S0P'}`（:816）、:823 调 `reopenDeal(...,{tenantId:ctx.tenantId})` 签名匹配。
  4. **决策场景真实存在**（防假接线铁律）：`DEAL_REOPEN`/`LOSS_REVIEW` 实测注册于 decisionName.js:16/17、dialogAdvisor.js:15/16、scenarioAdvisors.js:135/136、thinkingTemplates.js:250/251——非仅代码引用。
- **测试覆盖核对**：leadPoolActions.test.js T7 段 9 例——归档 4（已注册 :209 / S3 拒绝 :217 / S7 核心写盘 11 断言 :223 / S8 可归档 :245）+ 重开 5（S7→S0P :257 / **S0+lost 激活 :272** / S0+new 拒绝 :283 / S2 拒绝 :289 / 缺 decision_id :295）。
- **轻微缺口（非缺失）**：独立 `reopenDeal.test.js` 仅 31 行、只覆盖 S7→S0P（DB 依赖本机红）；S0(lost) 分支断言等价落在 leadPoolActions.test.js:272-281——复用层单测未独立覆盖战败公海分支。
- **变异验证（3 变异全 RED + 还原全绿，tmp/_t7_mutation.py）**：
  - M1 删「仅 S7/S8 可归档」限制 → RED（归档 S3 拒绝用例命中）
  - M2 删 `fromLostPool` 判定 → RED（S0+lost 激活 / S0+new 拒绝用例命中）
  - M3 删 `last_terminal_stage` 保留 → RED（S7/S8 留痕断言命中）
  - 还原后全绿 → 测试有鉴别力，无恒绿假面。
- **实现优于计划**：事件键 `tenant_id`（:1092）vs 计划骨架 Step 4 写 `tenantId`（旧稿）——与 T4/T6 教训一致（同族事件键须逐字统一）；其余（confirm/entitlement/owner/决策场景名/事件名）与实现逐字一致。

### Task 8（`crm-lead-reclaim-bulk` 离职批量回收）— 完成
- 增补 T8 用例（纯判据 2 + handler 5）→ 实现后全绿。
- `src/action/seed-actions.js` 注册 `crm-lead-reclaim-bulk`（`confirm:'critical'`）：**显式禁 `tenantId==='system'`**；非终态置 `S0` 归原 `pool_type` 池；**终态 S7/S8 只解除归属归 `lost`、阶段不动**（防关闭商机回灌公海污染漏斗）；单条失败收集 `failed[]` 不中断整批。

### Task 8（`crm-lead-reclaim-bulk` 离职批量回收）— 独立契约复查（T8 复查，2026-09-11）
- **契约核对（源码亲读 + 设计 §6 T6 原文）**：设计契约成功判据「S0P/S1-S6 未成交 DEAL 全部 stage=S0 + owner_id=null + 按 pool_type 归池，S7/S8 归 lost；返回 count 与实际变更行数一致；跨租户资产不被回收」——实现 `seed-actions.js:1106-1164` 逐条吻合：
  - 查询 `WHERE type='CRM_DEAL' AND tenant_id=$1 AND payload->>'owner_id'=$2`（`:1113-1116`）——租户强限定 + 按属主过滤，跨租户零影响 ✅
  - 白名单 `['S0P','S1'…'S8']`（`:1121`）——含 S0P 与 S1–S8，**不含 S0**（公海无 owner 本就查不到）✅
  - `tenantId === 'system'` 硬闸（`:1109`）防通配扫全库 ✅
  - 终态 S7/S8 → lost 池 + `...(terminal ? {} : ...)` 不动阶段（`:1141-1143, :1148`）✅
  - 非终态 → `stage:'S0'` + 归原 `pool_type` 池（`:1148`）✅
  - 单条写失败收集 `failed[]` 不中断整批（`:1157-1159`）✅
  - 决策场景 `LEAD_FOLLOW_UP`（`:1128`）真实注册于 decisionName.js:10、dialogAdvisor.js:17、thinkingTemplates.js:38——**防假接线铁律通过** ✅
- **计划骨架对比**：Task 8 Step 3 骨架（:1611-1680）与实现**逐字一致**（含 system 硬闸/白名单/终态判定/写盘入参）——无分叉，实现未比计划更优或更差。
- **测试覆盖**：leadPoolActions.test.js T8 段 7 例——纯判据 2（范围/禁 system）+ handler 5（已注册形态 / ★ system 硬闸 :336 / ★ 核心 4 行写盘 :340 / 租户谓词 :371 / 失败收集 :380 / 空集 :394）。`resolvePoolId` 签名（pool.js:163 `{pool_id, pool_type}`）与调用匹配。
- **变异验证（3 变异全 RED + 还原全绿，tmp/_t8_mutation.py）**：
  - M1 删 `tenantId==='system'` 硬闸 → RED（★ system 通配拒绝用例命中）
  - M2 删终态归 lost/不动阶段判定 → RED（★ 核心用例 S7/S8 归 lost + pool_type 断言命中）
  - M3 删非终态置 S0 写盘 → RED（★ 核心用例 stage='S0' 断言命中）
  - 还原后全绿 → 测试有鉴别力，无恒绿假面。
- **P2 发现（非缺陷，未改实现）**：事件 `lead-reclaimed-bulk`（`:1161`）用 `tenantId`（camelCase）——与同族 `lead-returned`（`:1041`）/`deal-archived-to-pool`（`:1092`）的 `tenant_id` 不一致（T4 教训「同族事件键逐字统一」）。计划骨架 Step 4 同样写 `tenantId`（旧稿同分叉）。该事件当前无 src 消费者（仅 emit 一处），无行为影响；建议同族统一为 `tenant_id`（需批准后改）。

### Task 9（存量迁移 + `lead` 十二处分流 + 前端口径）— 完成
- 新建 `db/migration-lead-pool-s0.sql`（三分支互斥全覆盖 + 守恒校验；仅 UPDATE 幂等；不进 `INCREMENTAL_SQL`）。
- 写入源直落公海：`src/agent/discoveryOrchestrator.js`、`src/connectors/tenderConnector.js`。
- `src/http/routes.js` 四阶段兜底改 `normalizeDealStage`；**P0 修复**：`routes.js` 待办段 + `src/http/workbenchRouter.js` 跟进段各增 `if (isPoolStage(raw)) continue;`（`isOpenStage('S0')===true` → 否则公海线索全量灌入待办）。
- 前端口径：`src/account/insightService.js`、`src/portal/businessBoard.js`（`leadPool` → `publicPool` + `privateLeads`）、`src/portal/businessClosureRender.js`、`src/sales/namedAccountBoard.js`、`src/portal/detailSections.js`（L2C 8 档，内联 `S_ALIAS`）、`src/portal/scoring.js`。
- 同步测试：`test/web/businessClosure.test.js`（fixture/断言改 `publicPool`/`privateLeads`）、`test/sales-named-accounts/named-account-board.test.js`（未改，回归绿）。
- 验收集：`businessClosure` 41/41 与 `named-account-board` 同批、`detailSections`/`account-insight*`/`browserLoadable`/`tokens-css` 49/49 全绿。

### Task 9 — 独立契约复查（T9 复查，2026-09-11）
- **契约核对（源码级 + 设计 §3.5.4/§6 T7 原文）**：
  - 迁移 SQL `db/migration-lead-pool-s0.sql`：三分支互斥全覆盖（无主→S0 / 有主达标→S1+qualified_at / 有主未达标→S0P）+ 守恒校验 + 阈值读 `config_store['sales-thresholds'].bantcc.pass` 缺省 0.6 不硬编码 + 仅 UPDATE 幂等 + 注释声明不进 `INCREMENTAL_SQL`（grep migrate.js:12 清单实证不在）✅
  - 写入源直落公海：`discoveryOrchestrator.js:93`（S0+pool_type=new+source=discovery+account_id 挂接）、`tenderConnector.js:55`（S0+pool_type=new+source=标讯）✅
  - 四兜底：routes.js:952/968/1101/1256 `normalizeDealStage` ✅
  - **P0 修复双侧复核**（防并发回退）：routes.js:28 import + :1678 `if(isPoolStage(raw)) continue;`、workbenchRouter.js:24 import + :189 同款——import+usage 双侧在 ✅
  - 前端口径：businessBoard.js:90-102（publicPool=S0 / privateLeads=S0P+S1）、businessClosureRender.js:67-74（双读+降级）、namedAccountBoard.js:23-24（leads=S0P/S1 + publicLeads=isPoolStage）、detailSections.js:57（S0/S0P/S1 三档映射 + L2C 8 档）、scoring.js（浏览器内联 S_ALIAS 含 S0/S0P）、insightService.js:160（[S0,S0P,S1]）✅
  - 测试：stagePoolStage.test.js 7 例（S_STAGES 冻结 :11 / S_ALL_STAGES 前插 :15 / toStageCode :22 / isPoolStage 仅 S0 :28 / normalizeDealStage 无主纠偏 :35 / 推进边 :42 / S_LABEL :50 / isOpenStage(S0)=true 锁行为 :56 / 决策场景 :63）+ businessClosure.test.js:113-114/130-131（publicPool/privateLeads 派生断言）✅
- **⚠ P1 缺口（十二处之外的真实残留，需批准修复）**：`src/web/pipeline.html:188` 新建商机 `payload = { name, stage: 'lead' }` → 走 `POST /api/particles`（:200）**直接以 'lead' 字符串入库**（read 兜底 normalizeDealStage 只在读取路径生效，写入不经它）——T0 迁移后存量已无 'lead'，前端又造出脏阶段，属「获客写路径未直落公海」。**建议**：改 `stage:'S0', pool_type:'new'`（与 discovery/tender 两写入源一致）。设计清单十二处未含此文件（清单为后端/路由/前端只读口径），故属清单外遗漏。另 `src/web/named-account-targets.html:82` 指标位文案「(lead 阶段)」为 P2 文本残留。
- **P2 观察（非缺口）**：`test/http/poolConfigRoute.test.js`/`test/portal/poolConfigRender.test.js` 无 T9 阶段口径断言（职责是路由/渲染配置，设计未要求，不补）。子代理曾误报 stageTaxonomy.test.js 无 S0 断言——实际该文件即 stagePoolStage.test.js（子代理按文件名搜索未命中，文件整体含 9 组 S0/S0P 断言）。

### Task 10（全量回归 + 契约校验 + 设计文档回写）— 完成
- **契约校验**：`node scripts/validate-contract.mjs docs/2026-09-11-lead-public-pool-tenant-design.md --registry src/agent/agentSpec.js` → `{"valid":true,"errors":[]}`，`EXIT=0`。
- **设计文档订正复核**（grep 命中）：§5 `STAGE_GATES`（:247）、§6 `T0–T7`（:252/:389）、`followup-agent` 承接（:254/:267/:282/:292）、§9「已拍板」（:399）。
- **全量回归**：`node node_modules/vitest/vitest.mjs run` → **253 failed / 336 passed（589 文件）**；**730 failed / 2869 passed / 363 skipped（3962 用例）**。失败**压倒性为 DB 离线**（`ECONNREFUSED ::1:5433` / `127.0.0.1:5433`）——本机无 PG 服务，DB 依赖用例必然红，**不代表本计划回归**。已改动的非 DB 套件全绿。
  - ⚠ 有效基线不可得（无 PG）。判据改为：① 改动点全量 grep 复核仍在（见下）；② 失败签名中**无** `ReferenceError`/`SyntaxError`/`is not a function` 等代码级错误；③ 已改非 DB 套件全绿。
- **⚠ 并发写入实证（本会话踩到 3 次）**：本会话期间有**并行会话同改同一工作树**，实测 3 处 Edit 报成功但随后被还原/覆盖：
  1. `src/http/routes.js` —— 同批 5 处 Edit 中 **3 处被回退**（`stageTaxonomy` import 行、`:968`、`:1101`），保留 `:952/:1256/:1678`。若不复核 → **运行时 `isPoolStage is not defined`**（usage 在、import 无）。已重新补齐并 grep 复核。
  2. `src/sales/namedAccountBoard.js` —— import 行被回退 → `toStageCode is not defined`（14 例红）。已补齐。
  3. `test/action/leadPickRecycle.test.js` —— 本会话新建 13 例版本被并行会话 **17 例版本**覆盖（更严：含显式 `pool_id`）；同时 `seed-actions.js` 的 pick 聚合 SQL 被升级为 **D1 修复版**（`count(*) FILTER (WHERE ... picked_at >= date_trunc('day',now()))` + 锚定 `picked_at`，取代 `max(updated_at)`）。两者均绿，保留。
  - **纪律**：每 Task 完成必 grep 复核全部改动点；批内多 Edit 后整批复核（不可只看 Edit 返回）；红先查并行改动再判回归；提交前重跑不采信早先数字；数字标注时刻。
- **提交拆分**：`src/action/seed-actions.js` 混 **T4/T6/T7/T8** 多段 hunk；`src/http/routes.js` 混 **T5/T9**；`test/action/leadPoolActions.test.js` 混 **T6/T7/T8** → 三者**禁整文件 `git add`**，须 `git add -p` 或按功能线合并提交。

### Task 10 — 独立契约复查（T10 复查，2026-09-11）：T6–T10 全量复查 + 修复收口
- **静态验证**：契约校验重跑 → `{"valid":true,"errors":[]}`（EXIT=0）；红线哈希复核未变（routing=`aa7a5ad7b5ca7d12`、assembler=`12ac9bc27edc76a8`）——红线零触碰。
- **文件结构映射表 12 项全实证**：stageTaxonomy.js（S0/S0P 常量/isPoolStage/normalizeDealStage）、particleModel.js:13（flow=S_ALL_STAGES）、particleRepo.js:18（DEAL_STAGES=S_ALL_STAGES）、pool.js、executor.js、seed-actions.js、controlledConfigPages.js、routes.js、timers.js:142（超期扫 S0P+带 tenant_id）、reopenDeal.js、migration SQL、前端（businessBoard/detailSections/scoring/insight）——各 grep 锚点命中。
- **T6/T7/T8 复查汇总**（详见各 Task 段）：T6 四要素+变异 3 RED、T7 四要素+决策场景注册+变异 3 RED、T8 契约逐字一致+system 硬闸+变异 3 RED、T9 十二处全命中+迁移 SQL 吻合+P0 双侧复核——**测试有鉴别力，无恒绿假面**。
- **3 项修复（T10 收口执行，用户「继续」批准）**：
  1. **P1** `src/web/pipeline.html:188-189`：新建商机 `stage:'lead'` → **`stage:'S0', pool_type:'new'`**（直落公海，与 discovery/tender 一致）
  2. **P2 事件键统一** `seed-actions.js:1161`：`lead-reclaimed-bulk` 事件 `tenantId` → **`tenant_id`**（同族 lead-picked/recycled/returned/deal-archived 五事件全统一）
  3. **P2b 文案** `named-account-targets.html:82`：「(lead 阶段)」→「(S0/S0P/S1)」
  - 每处 git diff 单点 hunk 干净（无并行会话混入）；补充 `leadPoolActions.test.js:401-412` 事件键断言（spy emit 查 tenant_id/snake_case）。
- **回归验证**：`leadPoolActions.test.js` 29 例全绿（含新增事件键断言）；T9 套件 4 文件 24 例全绿（stagePoolStage 9 + businessClosure 9 + browserLoadable 3 + tokens-css 3）。
- **计划正文复选框回写**：61 个 `- [ ] **Step` 全部勾选（replace 全量，残留 0）——与执行记录「Task 1-10 全部完成」对齐。
- **⚠ 提交纪律（用户本地执行）**：
  - `src/action/seed-actions.js` 混 T4/T6/T7/T8（含本会话 1161 事件键）→ `git add -p` 按 hunk 拆分
  - `test/action/leadPoolActions.test.js` 混 T6/T7/T8（含本会话 401-412 事件断言）→ `git add -p`
  - `src/web/pipeline.html`、`src/web/named-account-targets.html` 各仅 1 hunk → 可整文件 add
  - 未跟踪交付物（migration-lead-pool-s0.sql / 5 个测试文件）→ 显式路径 add
  - 禁 `git add -A`；每功能线一 commit（计划 Task 1-10 各对应一次提交语义）

---

## 执行记录：E2E 验收（Task 10 之后补做，2026-09-11）

脚本：`scripts/e2e-lead-pool-actions.mjs`（对齐 `e2e-discovery-touchpoints.mjs` 范式：自起隔离 HTTP 实例 + 真实 MCP stdio + 动态端口；fixture 幂等 upsert、禁 DELETE、跑完复位）。

**结果 26/36：HTTP 面 11/11 全绿；8 项失败收敛到 1 个 P0 缺陷；2 项为该缺陷下诚实「无法判定」。**

| 组 | 结论 |
|---|---|
| Step 2 `/api/pool-config` | ✅ sales 403（配置中心系统级闸）／admin 200 三池 + tenantId／非引擎键 400／`daily_limit=0` 400／PUT 200／round-trip 一致 |
| Step 3 公海口径 P0 | ✅ S3 在跟线索**在**待办（正向基准）／S0 公海**不在**待办／看板 `publicPool`+`privateLeads` |
| Step 4 MCP 4 动作 | ❌ phase1 全被第 0 闸拦死 → phase2 级联失败 |

### 🔴 P0：`autoDecision: true` 缺 `decisionScenario` ⇒ MCP 通道死胡同

`gateway.js:165` 判据为 `def.decisionScenario`（非 `autoDecision`）→ 缺则跳过代 mint → `gateway.js:190` 返 `DECISION_NEEDED`；工具面 63 个中**无任何"生成决策"工具**，客户端无路径补 decision_id ⇒ 动作永久不可在 MCP 执行。
对照：`discovery-run`（`autoDecision` **+** `decisionScenario:'LEAD_FIT'`）→ phase1 ✅。

**影响面**（`listActions()` × MCP 暴露面脚本审计）：5 个 `autoDecision: true` 而缺 `decisionScenario` —— `crm-deal-advance`（历史）+ `crm-deal-reopen` / `crm-lead-return` / `crm-deal-archive-to-pool` / `crm-lead-reclaim-bulk`。

**修复需设计取舍**（已上呈待批，勿直接改）：
- **方案 G**（正统）：`executor.js`/`gateway.js` mint 处读取 Action 声明的 `decisionDisposition` / `decisionEntities`，语义零漂移；代价=改通用 substrate。
- **方案 H**（最小侵入，推荐）：`gateway.js` 增 `deferDecisionMint: true` 旁路（跳过 phase1 的决策拦截、仍发 confirm_token），mint 仍由 handler 完成；改动 2 行、语义零漂移；代价=MCP phase1 不再校验决策（phase2 handler mint 后仍满足第 0 闸）。

### 三处「看似绿其实假」防线的加固

1. `/api/my-todo` 行数据在 `data.components.table.rows`（非 `todos`/`items`）→ 已加**正向基准**（S3 在跟线索必须在列）。
2. `view` 参数（非 `type`；缺省 `approval`）。
3. 负向用例 S4.11/S4.12 原判据在 phase1 失败时亦通过 → 改为显式校验 `confirm_token`，否则判「前置失败：无法判定」。

### 修复结论（2026-09-11 收口）：方案 H 已实施 → E2E 37/37

用户拍板 **A+**（方案 H + 一并修历史动作 `crm-deal-advance`）。已实施并验收：

| 改动 | 内容 |
|---|---|
| `src/mcp/gateway.js` | phase1 决策拦截加旁路 `if (!params?.decision_id && !def?.deferDecisionMint)`；抽出 `actionQuestion` 供「阻断路径」与「旁路路径」共用（保留 2026-09-02 业务提问；`buildAdvanceQuestion` 因此不成死代码） |
| `src/action/seed-actions.js` | 5 个动作声明 `deferDecisionMint: true`：`crm-deal-advance` / `crm-deal-reopen` / `crm-lead-return` / `crm-deal-archive-to-pool` / `crm-lead-reclaim-bulk` |
| `src/action/registry.js` | 字段文档补 `deferDecisionMint?: boolean` 判据 |
| `test/mcp-gateway.test.js` | 2 个「断言了缺陷本身」的用例迁移（`DECISION_NEEDED` → `ok:true + confirm_token`，保留 `question` 断言）+ 新增旁路 describe（5 条声明断言 + 1 负向 + 1 不干扰） |
| `scripts/e2e-lead-pool-actions.mjs` | `phase1Ok` 契约迁移（`decision_id === null`）；S4.7–4.9 补 `r.data.decision_id`；S4.10 改**负向**（system 租户被安全闸拒绝 + 零副作用）；**新增 S4.10b**（真实租户直驱 executor 的正向 + 租户隔离） |
| 插件包（4+2 副本 + 校验规则 + README） | 写闸说明订正为「决策凭证由服务端生成，客户端无需/无法提供」；`verify-plugin-zips.py` 规则 3 → 5 条 |

**验收**：`test/mcp-gateway.test.js` **31/31**；相关 12 套件 **176/176**；**E2E 37/37（exit=0）**；`verify-plugin-zips.py` 两包全部通过（version 1.9.0）。

**语义零漂移**：mint 仍在 handler 内（archive `disposition:'REJECT'`、reclaim `entities:[{type:'CRM_PERSON'}]` 全保留）；`executor.js:51` 第 0 闸 `autoDecision` 豁免与 `:65` 代 mint 逻辑**未改**；普通写动作行为完全不变（仍 `DECISION_NEEDED`）。

**两条新守卫**（plan-execution-guardrails 台账 83/84）：① E2E 失败先分三桶——真缺陷 / 断言写在旧契约上 / 设计闸的正确拦截；② Edit 回执不可信 → 原子写入 + 立即 grep 复核。
