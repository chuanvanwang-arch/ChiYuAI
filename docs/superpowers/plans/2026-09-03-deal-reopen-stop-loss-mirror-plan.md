# 商机重开(reopen) + 止损镜像(stop_loss→粒子 payload) 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为输单/丢单(S7/S8)商机提供系统级重开通道（保留原粒子身份、决策锚定），并将决策 stop_loss 单向物化到 CRM_DEAL 粒子 payload，使 crm-risk 扫描可探测"止损已触发"。

**Architecture:** 复用既有 `crm-deal-advance` 的"action 自身 mint 决策满足第 0 闸"范式，新增独立 `crm-deal-reopen` action + `reopenDeal` 函数（不动 `advanceStage` 只进不退契约）；stop_loss 镜像在 `decisionRepo.createDecision` 写路径 fail-open 回写粒子；crm-risk 扫描新增纯函数 `collectStopLossAlerts` 只读探测。决策为 stop_loss 唯一事实源。

**Tech Stack:** Node 22 ESM + PostgreSQL(5433, schema `crm`) + Express；测试用 vitest 3 跑真实 `crm_native_test` 库；事件总线 `emit`(events/bus.js)。

---

## 文件结构（改动面）

- Create: `src/sales/reopenDeal.js` — 反向重开粒子写逻辑（S7/S8→S2）。
- Modify: `src/action/seed-actions.js` — 注册 `crm-deal-reopen` action（handler mint `DEAL_REOPEN` 决策后调 `reopenDeal`）。
- Modify: `src/agent/agentSpec.js` — `followup-agent.actions` 增 `crm-deal-reopen`（横切）。
- Modify: `src/monitor/monitorStore.js` — `GATE_SCENARIOS` 增 `DEAL_REOPEN`。
- Modify: `db/seed.sql` — `crm.decision_scenario` 增 `DEAL_REOPEN` 行（含 STOP_LOSS 维）。
- Modify: `src/decision/decisionRepo.js` — `createDecision` 写路径物化 stop_loss 到粒子 payload。
- Modify: `src/scheduler/riskScanner.js` — 增 `collectStopLossAlerts` 纯函数 + 在 `runRiskScan` 调用/emit/返回 alerts。
- Modify: `plugin/skills/crm-risk/rules/detect.md` + `core/scan.md` — 增 `stop_loss_triggered` 模式。
- Test: `test/sales/reopenDeal.test.js`、`test/decision/stopLossMirror.test.js`、`test/scheduler/stopLossTriggered.test.js`、`test/agent/agentSpec.test.js`(横切断言)。

> 已前置完成：`src/agent/contractIds.js` 已补 `decision-agent → ct-decision`（设计契约校验需要）。

---

### Task 1: reopenDeal 反向重开（S7/S8→S2，DEAL_REOPEN 决策锚定）

**Files:**
- Create: `src/sales/reopenDeal.js`
- Modify: `src/action/seed-actions.js`（`registerAction` 区，紧邻 `crm-deal-advance`）
- Modify: `src/agent/agentSpec.js:35`（`followup-agent.actions`）
- Modify: `src/monitor/monitorStore.js:21`（`GATE_SCENARIOS`）
- Modify: `db/seed.sql:263` 后（`decision_scenario` INSERT 段）
- Test: `test/sales/reopenDeal.test.js`

- [ ] **Step 1: 写失败测试（reopenDeal 守卫 + 正向）**

```js
// test/sales/reopenDeal.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { reopenDeal } from '../../src/sales/reopenDeal.js';
import { createParticle } from '../../src/particles/particleRepo.js';

const pool = new pg.Pool({ user: 'agent2b', password: 'agent2b', host: '127.0.0.1', port: 5433, database: 'crm_native_test' });
async function withDeal(stage, fn) {
  const c = await pool.connect();
  try {
    await c.query("SET search_path TO crm, public");
    const r = await c.query(
      `INSERT INTO crm.particles (type, payload, state) VALUES ('CRM_DEAL', $1::jsonb, 'ACTIVE') RETURNING id`,
      [JSON.stringify({ name: 't', stage })]
    );
    const id = r.rows[0].id;
    try { await fn(id); } finally {
      await c.query('DELETE FROM crm.particles WHERE id=$1', [id]);
    }
  } finally { c.release(); }
}

describe('reopenDeal', () => {
  it('非退出态(S2)调用抛错', async () => {
    await withDeal('S2', async (id) => {
      await expect(reopenDeal(id, { reason: 'x', owner: 'u', decision_id: 'd1' }))
        .rejects.toThrow(/仅退出态/);
    });
  });
  it('S7 重开 → stage=S2 且 reopen_count=1 且 last_reopen_decision_id 落库', async () => {
    await withDeal('S7', async (id) => {
      const u = await reopenDeal(id, { reason: '客户回流', owner: 'u', decision_id: 'dec-abc' });
      expect(u.payload.stage).toBe('S2');
      expect(u.payload.reopen_count).toBe(1);
      expect(u.payload.last_reopen_decision_id).toBe('dec-abc');
      const c = await pool.connect();
      try {
        await c.query("SET search_path TO crm, public");
        const r = await c.query('SELECT payload->>'last_reopen_decision_id' AS v FROM crm.particles WHERE id=$1', [id]);
        expect(r.rows[0].v).toBe('dec-abc');
      } finally { c.release(); }
    });
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `PGDATABASE=crm_native_test npx vitest run test/sales/reopenDeal.test.js`
Expected: FAIL（`Cannot find module '../../src/sales/reopenDeal.js'` 或 `reopenDeal is not a function`）。

- [ ] **Step 3: 实现 reopenDeal（新文件）**

```js
// src/sales/reopenDeal.js — 反向重开（S7/S8→S2），保留原粒子身份，不新建粒子
// 设计：docs/specs/2026-09-03-deal-reopen-stop-loss-mirror-design.md Task 1
// 不动 advanceStage 只进不退契约（lifecycle.js:14）；决策由调用方(handler)先 mint，decision_id 传入
import { getParticle, updateParticle } from '../particles/particleRepo.js';
import { emit } from '../events/bus.js';

export const REOPENABLE_STAGES = new Set(['S7', 'S8']); // 输单 / 丢单

// decision_id 已由 action handler 经第 0 闸 mint（DEAL_REOPEN），此处只做粒子写
export async function reopenDeal(dealId, { reason, owner, decision_id } = {}) {
  const deal = await getParticle(dealId);
  if (!deal) throw new Error(`DEAL 不存在: ${dealId}`);
  const cur = deal.payload.stage;
  if (!REOPENABLE_STAGES.has(cur)) {
    throw new Error(`仅退出态(S7/S8)可重开，当前=${cur}`);
  }
  if (!decision_id) throw new Error('reopenDeal 需携带决策锚定 decision_id');
  const patch = {
    stage: 'S2',
    reopen_count: (deal.payload.reopen_count || 0) + 1,
    reopened_at: new Date().toISOString(),
    last_reopen_reason: reason || null,
    last_reopen_decision_id: decision_id,
    transitionedBecause: reason || `reopen from ${cur}`,
  };
  const updated = await updateParticle(dealId, { patch });
  emit('decision', 'deal-reopen', { deal_id: dealId, from: cur, to: 'S2', decision_id, owner });
  return { ...updated, decision_id };
}
```

- [ ] **Step 4: 注册 crm-deal-reopen action（紧邻 crm-deal-advance）**

在 `src/action/seed-actions.js` 的 `crm-deal-advance` `registerAction` 之后插入：

```js
  registerAction({
    name: 'crm-deal-reopen', kind: 'write', permission: 'auth', confirm: 'critical', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', reason: 'string' },
    parameters: {
      required: ['deal_id', 'reason'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, reason }, ctx) => {
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 写通道第 0 闸：经自主引擎 mint DEAL_REOPEN 决策（自带 re-armed stop_loss）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const res = await requireDecision(
          'DEAL_REOPEN',
          { stage: 'S2', deal_id, reopen_from: deal.payload.stage },
          [{ type: 'DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'deal-reopen', { deal_id, decision_id, mode: res.mode });
      }
      const updated = await reopenDeal(deal_id, { reason, owner: ctx.actor, decision_id });
      return { ...updated, decision_id };
    },
  });
```

> 注：`requireDecision` 已在 `seed-actions.js` 顶部导入（与 `crm-deal-advance` 同款）；`getParticle` 同文件已导入。reopen **不**加入 `WRITE_WHITELIST`（whitelist.js 维持原样）→ 默认 `human_gate`，重开需显式 HITL 确认，符合零信任。

- [ ] **Step 5: 横切 — agentSpec 注册 action**

`src/agent/agentSpec.js` 中 `followup-agent` 的 `actions` 数组增加 `'crm-deal-reopen'`（与 `crm-deal-advance` 并列）：

```js
      actions: ['data-particle-read', 'data-particle-create', 'data-particle-edge-create', 'crm-deal-advance', 'crm-deal-reopen', 'crm-account-360', 'crm-asset-attach', 'method-followup-engine', 'method-funnel-classification', 'method-behavior-standard'],
```

- [ ] **Step 6: 横切 — GATE_SCENARIOS 增 DEAL_REOPEN**

`src/monitor/monitorStore.js:21`：

```js
export const GATE_SCENARIOS = [
  'LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'SOLUTION_VALUE', 'QUOTE_PRICING',
  'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW', 'DEAL_REOPEN',
];
```

- [ ] **Step 7: 种子 — decision_scenario 增 DEAL_REOPEN 行**

`db/seed.sql` 在 `LOSS_REVIEW` 行（约 :267）之后追加：

```sql
,('DEAL_REOPEN', '商机重开', '输单/丢单后客户回流，重开并重置止损线',
 '{"cond":{"event":"reopen","stage":"S2"},"entity":"DEAL","source":"particle_event"}'::jsonb,
 ARRAY['STOP_LOSS'],
 '[{"cond":"condition","label":"重开止损条件","weight":1,"required":true},{"cond":"deadline","label":"重开止损期限","weight":0.5}]'::jsonb,
 'NORMAL', TRUE)
```

> `ON CONFLICT (scenario_id) DO NOTHING` 已存在于该 INSERT 段头部（seed.sql:226-227），重跑安全。

- [ ] **Step 8: 跑测试 + 横切断言**

Run: `PGDATABASE=crm_native_test npx vitest run test/sales/reopenDeal.test.js`
Expected: PASS（2/2）。

补充横切断言（在 `test/agent/agentSpec.test.js` 或新建断言）：

```js
import { agentSpecs } from '../../src/agent/agentSpec.js';
import { GATE_SCENARIOS } from '../../src/monitor/monitorStore.js';
it('followup-agent 注册 crm-deal-reopen', () => {
  expect(agentSpecs['followup-agent'].actions).toContain('crm-deal-reopen');
});
it('GATE_SCENARIOS 含 DEAL_REOPEN', () => {
  expect(GATE_SCENARIOS).toContain('DEAL_REOPEN');
});
```

Run: `PGDATABASE=crm_native_test npx vitest run test/agent/agentSpec.test.js`
Expected: PASS。

- [ ] **Step 9: Commit**

```bash
git add src/sales/reopenDeal.js src/action/seed-actions.js src/agent/agentSpec.js src/monitor/monitorStore.js db/seed.sql test/sales/reopenDeal.test.js test/agent/agentSpec.test.js
git commit -m "feat: 商机重开 reopenDeal + crm-deal-reopen action（S7/S8→S2，DEAL_REOPEN 锚定）"
```

---

### Task 2: stop_loss 单向物化（决策 → CRM_DEAL.payload.stop_loss）

**Files:**
- Modify: `src/decision/decisionRepo.js`（`createDecision` 写路径，INSERT 之后）
- Test: `test/decision/stopLossMirror.test.js`

- [ ] **Step 1: 写失败测试（纯函数提取 + 集成镜像）**

```js
// test/decision/stopLossMirror.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { createParticle } from '../../src/particles/particleRepo.js';

const pool = new pg.Pool({ user: 'agent2b', password: 'agent2b', host: '127.0.0.1', port: 5433, database: 'crm_native_test' });

describe('stop_loss 镜像到粒子 payload', () => {
  it('决策 stop_loss + 挂 CRM_DEAL → 粒子 payload.stop_loss 同步', async () => {
    const c = await pool.connect();
    let dealId, decId;
    try {
      await c.query("SET search_path TO crm, public");
      const d = await c.query(`INSERT INTO crm.particles (type, payload, state) VALUES ('CRM_DEAL', $1::jsonb, 'ACTIVE') RETURNING id`, [JSON.stringify({ name: 'm' })]);
      dealId = d.rows[0].id;
      const dec = await createDecision({
        scenario_id: 'QUOTE_PRICING', disposition: 'APPROVE',
        involved_entities: [{ type: 'CRM_DEAL', id: dealId }],
        stop_loss: { status: 'armed', condition: '15 天未签', deadline: '2026-09-30', trigger: '报价过期', owner: '销售' },
        tenantId: 'system',
      });
      decId = dec.decision_id;
      const r = await c.query('SELECT payload->'stop_loss' AS sl FROM crm.particles WHERE id=$1', [dealId]);
      expect(r.rows[0].sl).toMatchObject({ status: 'armed', condition: '15 天未签' });
    } finally {
      if (decId) await c.query('DELETE FROM crm.decision WHERE decision_id=$1', [decId]).catch(() => {});
      if (dealId) await c.query('DELETE FROM crm.particles WHERE id=$1', [dealId]);
      c.release();
    }
  });
  it('决策无 stop_loss → 不写粒子 stop_loss（无残留）', async () => {
    const c = await pool.connect();
    let dealId, decId;
    try {
      await c.query("SET search_path TO crm, public");
      const d = await c.query(`INSERT INTO crm.particles (type, payload, state) VALUES ('CRM_DEAL', $1::jsonb, 'ACTIVE') RETURNING id`, [JSON.stringify({ name: 'n' })]);
      dealId = d.rows[0].id;
      const dec = await createDecision({
        scenario_id: 'OPP_QUALIFY', disposition: 'APPROVE',
        involved_entities: [{ type: 'CRM_DEAL', id: dealId }],
        tenantId: 'system',
      });
      decId = dec.decision_id;
      const r = await c.query('SELECT payload->'stop_loss' AS sl FROM crm.particles WHERE id=$1', [dealId]);
      expect(r.rows[0].sl).toBeNull();
    } finally {
      if (decId) await c.query('DELETE FROM crm.decision WHERE decision_id=$1', [decId]).catch(() => {});
      if (dealId) await c.query('DELETE FROM crm.particles WHERE id=$1', [dealId]);
      c.release();
    }
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `PGDATABASE=crm_native_test npx vitest run test/decision/stopLossMirror.test.js`
Expected: FAIL（粒子 payload.stop_loss 为 null，因尚未接线）。

- [ ] **Step 3: 在 createDecision 写路径接镜像（fail-open）**

`src/decision/decisionRepo.js`：`const decision = r.rows[0];`（约 :223）之后插入：

```js
  // 【镜像】决策 stop_loss → CRM_DEAL.payload.stop_loss（fail-open：镜像失败仅留痕，不阻断决策落库）
  // 决策为 stop_loss 唯一事实源；粒子级可观测供 crm-risk 扫描探测。
  if (eightElements.stop_loss != null && Array.isArray(involved_entities) && involved_entities.length) {
    const dealEnt = involved_entities.find((e) => e && (e.type === 'CRM_DEAL' || e.type === 'DEAL'));
    if (dealEnt && dealEnt.id) {
      try {
        const { updateParticle } = await import('../particles/particleRepo.js');
        const sl = eightElements.stop_loss;
        const slPayload = {
          status: sl?.status ?? null,
          condition: sl?.condition ?? null,
          deadline: sl?.deadline ?? null,
          trigger: sl?.trigger ?? null,
          owner: sl?.owner ?? null,
        };
        await updateParticle(dealEnt.id, { patch: { stop_loss: slPayload } });
      } catch (e) {
        emit('trace', 'stop-loss-mirror-fail', { deal_id: dealEnt.id, decision_id: decision.decision_id, error: String(e?.message || e) });
        recordFailure('stop-loss-mirror-fail', e);
      }
    }
  }
```

> `emit` / `recordFailure` 在本文件已导入（见 :137-138 同款用法）。`eightElements.stop_loss` 经 `materializeEightElements` 物化（:180-183）。

- [ ] **Step 4: 跑测试确认通过**

Run: `PGDATABASE=crm_native_test npx vitest run test/decision/stopLossMirror.test.js`
Expected: PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add src/decision/decisionRepo.js test/decision/stopLossMirror.test.js
git commit -m "feat: 决策 stop_loss 落库时 fail-open 镜像到 CRM_DEAL.payload.stop_loss"
```

---

### Task 3: crm-risk 探测 stop_loss_triggered

**Files:**
- Modify: `src/scheduler/riskScanner.js`（增纯函数 + 调用）
- Modify: `plugin/skills/crm-risk/rules/detect.md` + `core/scan.md`
- Test: `test/scheduler/stopLossTriggered.test.js`

- [ ] **Step 1: 写失败测试（纯函数 collectStopLossAlerts）**

```js
// test/scheduler/stopLossTriggered.test.js
import { describe, it, expect } from 'vitest';
import { collectStopLossAlerts } from '../../src/scheduler/riskScanner.js';

describe('collectStopLossAlerts', () => {
  it('status=triggered 的 DEAL → 产出 stop_loss_triggered 告警', () => {
    const entities = [
      { id: 'd1', type: 'CRM_DEAL', payload: { stop_loss: { status: 'triggered' } } },
      { id: 'a1', type: 'CRM_ACCOUNT', payload: {} },
      { id: 'd2', type: 'CRM_DEAL', payload: { stop_loss: { status: 'armed' } } },
    ];
    expect(collectStopLossAlerts(entities)).toEqual([
      { type: 'stop_loss_triggered', deal_id: 'd1', severity: 'medium-high' },
    ]);
  });
  it('无 stop_loss 字段 → 不误报', () => {
    expect(collectStopLossAlerts([{ id: 'd3', type: 'CRM_DEAL', payload: {} }])).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run test/scheduler/stopLossTriggered.test.js`
Expected: FAIL（`collectStopLossAlerts is not exported`）。

- [ ] **Step 3: 实现纯函数 + 接入 runRiskScan（只读 + emit）**

`src/scheduler/riskScanner.js`：在 `export async function runRiskScan` 之前新增纯函数：

```js
// 探测：DEAL 止损已触发 → 告警（只读粒子 payload，不写业务数据）
export function collectStopLossAlerts(entities = []) {
  const alerts = [];
  for (const e of entities) {
    if (e.type !== 'CRM_DEAL') continue;
    const sl = e.payload && e.payload.stop_loss;
    if (sl && sl.status === 'triggered') {
      alerts.push({ type: 'stop_loss_triggered', deal_id: e.id, severity: 'medium-high' });
    }
  }
  return alerts;
}
```

在 `runRiskScan` 的 `emit('trace', 'crm-risk-scan', ...)`（约 :60）之前插入：

```js
  const alerts = collectStopLossAlerts(entities);
  for (const a of alerts) emit('crm-risk-alert', a);
```

并将 `return` 行（:64）改为：

```js
  return { scanned: entities.length, changed, degraded, llm_calls: llmCalls, llm_enabled: Boolean(batch || perAttr), alerts };
```

- [ ] **Step 4: 更新 crm-risk 规则与扫描文档**

`plugin/skills/crm-risk/rules/detect.md` 三模式表后追加一行：

```md
| `stop_loss_triggered` | DEAL.payload.stop_loss.status==='triggered' | medium-high |
```

`plugin/skills/crm-risk/core/scan.md` 步骤 3 链断裂判定后追加：

```md
   - 止损触发：DEAL.payload.stop_loss?.status === 'triggered' → 命中 `stop_loss_triggered`。
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run test/scheduler/stopLossTriggered.test.js`
Expected: PASS（2/2）。

- [ ] **Step 6: 全量受影响测试回归**

Run: `PGDATABASE=crm_native_test npx vitest run test/sales/reopenDeal.test.js test/decision/stopLossMirror.test.js test/scheduler/stopLossTriggered.test.js test/agent/agentSpec.test.js test/observability-risk-scan.test.js`
Expected: 全 PASS（含既有 risk-scan 测试因 return 增 `alerts` 字段不受影响）。

- [ ] **Step 7: Commit**

```bash
git add src/scheduler/riskScanner.js plugin/skills/crm-risk/rules/detect.md plugin/skills/crm-risk/core/scan.md test/scheduler/stopLossTriggered.test.js
git commit -m "feat: crm-risk 新增 stop_loss_triggered 探测（只读+emit，闭环打通止损触发）"
```

---

## 自审（Self-Review）

1. **Spec 覆盖**：① reopen（Task 1 全步；不动 advanceStage ✔；DEAL_REOPEN 锚定 ✔；横切 agentSpec/GATE_SCENARIOS/seed ✔）② stop_loss 镜像（Task 2 ✔；fail-open emit trace ✔）③ stop_loss_triggered（Task 3 ✔；只读+emit ✔）。闭环协同：Task 1 的 DEAL_REOPEN 决策自带 re-armed stop_loss → Task 2 自动刷新 payload → Task 3 探测（✓ 三 Task 串联）。
2. **占位符扫描**：无 TBD/TODO；每代码步均含完整实现；测试含实际断言与 PG 清理。
3. **类型一致性**：`involved_entities` 元素形态 `{type,id}` 与 `crm-deal-advance` handler（seed-actions.js:612）一致；`updateParticle(id,{patch})` 签名与 particleRepo.js:146 一致；`emit`/`recordFailure` 在 decisionRepo 已导入；`collectStopLossAlerts` 在 riskScanner 导出并在 runRiskScan 调用，命名一致。
4. **风险**：reopen 不加入 WRITE_WHITELIST（human_gate，需 HITL）；镜像 fail-open 不影响决策；crm-risk 仅 emit 不写业务数据，符合"绝对禁删/不写"纪律。
