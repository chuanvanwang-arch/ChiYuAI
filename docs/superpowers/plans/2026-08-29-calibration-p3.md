# P3 决策质量校准 · required_dims 处方（七维严格度旋钮）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解锁 `required_dims` 类校准处方（七维严格度旋钮），与 P1 的 `threshold`/`weight` 处方统一抽象为旋钮策略类，支持手动发起 + 审批留痕 + 量化重放 + 升严/降级（降级标 HIGH + 二次确认）。

**Architecture:** 新增 `src/calibration/knobs/` 策略目录（`KnobStrategy` 基类 + `ThresholdStrategy`/`WeightStrategy`/`RequiredDimsStrategy` + `getStrategy` 注册表）；`store.js` 的 `approvePatch`/`rollbackPatch` 改为按 `knob` 路由到策略实例（写落点因 knob 而异：`required_dims` 写 `decision_scenario.required_dims`，其余写 `config_store['autonomy-conf']`）。校准路由新增手动发起分支（七维页调用），复用 `sevenDimensionsCheck` 做量化重放。第 0 闸（`CALIBRATION_CHANGE` 真实决策行）+ 事务原子全程保留。

**Tech Stack:** Node 22 + ESM + Express + PostgreSQL（`crm` schema，测试库 `plm_test` @5433）。测试 vitest（`fileParallelism:false`+`singleFork`，禁并发两进程）。

**设计依据：** `docs/2026-08-29-calibration-p3-design.md`（已批准）。**前置：** P0/P1/P2 已实现；`db/schema.sql:403-419` 的 `calibration_patch` 已为 P3 预留（`knob` 枚举含 `required_dims`、`from_value/to_value/expected_impact` 为 JSONB、`risk` 含 HIGH），**零 DDL 变更**。

**铁律：** 写操作必经决策第 0 闸；绝对禁止 DELETE；每 Task 一 commit（沙箱无凭证，由用户本地提交，勿 `git add -A`）；单进程跑 vitest。

---

## 文件结构

| 文件 | 动作 | 责任 |
|---|---|---|
| `src/calibration/knobs/base.js` | 新建 | `KnobStrategy` 抽象基类（接口） |
| `src/calibration/knobs/threshold.js` | 新建 | `ThresholdStrategy`（写 `config_store`） |
| `src/calibration/knobs/weight.js` | 新建 | `WeightStrategy`（写 `config_store.weights`） |
| `src/calibration/knobs/requiredDims.js` | 新建 | `RequiredDimsStrategy`（写 `decision_scenario.required_dims`，P3 核心） |
| `src/calibration/knobs/index.js` | 新建 | `getStrategy(knob)` 注册表 |
| `src/calibration/replayDims.js` | 新建 | 量化重放（复用 `sevenDimensionsCheck`） |
| `src/calibration/store.js` | 修改 | 删 L122/L161 守卫 + 写段改策略路由（`approvePatch`/`rollbackPatch`） |
| `src/http/calibrationRouter.js` | 修改 | generate 端点加手动发起分支（`required_dims_draft`），删 L181 `return p` |
| `src/portal/calibrationRender.js` | 修改 | 处方卡加 `data-risk`/`data-patch`（供降级二次确认） |
| `src/web/seven-dim.html` | 修改 | 矩阵保存改 POST 校准处方（单一写通道） |
| `src/web/sales-decision-monitor.html` | 修改 | `bindActions` 批准降级处方前 `confirm()` 二次确认 |
| `test/calibration/knobs.test.js` | 新建 | 三策略接口 + 落点正确性 |
| `test/calibration/store-p3.test.js` | 新建 | required_dims 批准/回滚 → `sevenDimensionsCheck` 复验 |
| `test/calibration/replayDims.test.js` | 新建 | 量化重放预估拦截率 |
| `test/calibration/router-p3.test.js` | 新建 | 手动发起端点 + 幂等 + risk |

---

## Task 1: 旋钮基类 + Threshold/Weight 策略迁移

**Files:**
- Create: `src/calibration/knobs/base.js`
- Create: `src/calibration/knobs/threshold.js`
- Create: `src/calibration/knobs/weight.js`
- Create: `src/calibration/knobs/index.js`
- Modify: `src/calibration/store.js:116-146`（`approvePatch`）、`src/calibration/store.js:157-184`（`rollbackPatch`）
- Test: `test/calibration/knobs.test.js`

- [x] **Step 1: 写失败测试（旋钮策略接口 + 落点）**

```js
// test/calibration/knobs.test.js
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withTx, query } from '../../src/db.js';
import { getStrategy } from '../../src/calibration/knobs/index.js';
import { readConf } from '../../src/calibration/store.js';

describe('旋钮策略 · 接口与落点', () => {
  it('getStrategy 返回三策略实例', () => {
    expect(getStrategy('threshold')).toBeTruthy();
    expect(getStrategy('weight')).toBeTruthy();
    expect(getStrategy('required_dims')).toBeTruthy();
    expect(getStrategy('bogus')).toBeNull();
  });

  it('ThresholdStrategy.apply 写 config_store autonomy-conf.threshold', async () => {
    const strat = getStrategy('threshold');
    await withTx(async (client) => {
      await strat.apply(client, { threshold: 0.91 }, { scenario_id: null, target: null, decisionId: null, current: await readConf() });
    });
    const c = await readConf();
    expect(c.threshold).toBe(0.91);
  });

  it('WeightStrategy.apply 写 config_store autonomy-conf.weights[target]', async () => {
    const strat = getStrategy('weight');
    const cur = await readConf();
    await withTx(async (client) => {
      await strat.apply(client, { weights: { method: 0.5 } }, { scenario_id: null, target: 'method', decisionId: null, current: cur });
    });
    const c = await readConf();
    expect(c.weights.method).toBe(0.5);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run：`cd /d/system/CRM-ai-native && PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/knobs.test.js`
Expected：FAIL（`src/calibration/knobs/index.js` 不存在）

- [x] **Step 3: 写基类与策略**

```js
// src/calibration/knobs/base.js
export class KnobStrategy {
  constructor(knob) { this.knob = knob; }
  async readCurrent(ctx) { throw new Error('not implemented'); }
  async apply(client, toValue, ctx) { throw new Error('not implemented'); }
  async replayImpact(ctx, toValue) { throw new Error('not implemented'); }
  riskLevel(from, to) { return 'LOW'; }
}
```

```js
// src/calibration/knobs/threshold.js
import { KnobStrategy } from './base.js';
export class ThresholdStrategy extends KnobStrategy {
  async apply(client, toValue, ctx) {
    const cur = ctx.current || { threshold: 0.8, weights: {} };
    const next = { threshold: toValue.threshold, weights: cur.weights };
    await client.query(
      `INSERT INTO crm.config_store (key,value,decision_id,updated_by,updated_at)
       VALUES ($1,$2::jsonb,$3,'system',now())
       ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
      ['autonomy-conf', JSON.stringify(next), ctx.decisionId]
    );
  }
  async replayImpact(ctx, toValue) {
    const { replayScenario } = await import('../replay.js');
    const candidate = { ...(ctx.current || { threshold: 0.8, weights: {} }), threshold: toValue.threshold };
    return replayScenario(ctx.decisions, candidate);
  }
}
```

```js
// src/calibration/knobs/weight.js
import { KnobStrategy } from './base.js';
export class WeightStrategy extends KnobStrategy {
  async apply(client, toValue, ctx) {
    const cur = ctx.current || { threshold: 0.8, weights: {} };
    const next = { threshold: cur.threshold, weights: { ...cur.weights, [ctx.target]: toValue.weights[ctx.target] } };
    await client.query(
      `INSERT INTO crm.config_store (key,value,decision_id,updated_by,updated_at)
       VALUES ($1,$2::jsonb,$3,'system',now())
       ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
      ['autonomy-conf', JSON.stringify(next), ctx.decisionId]
    );
  }
  async replayImpact(ctx, toValue) {
    const { replayScenario } = await import('../replay.js');
    const cur = ctx.current || { threshold: 0.8, weights: {} };
    const candidate = { threshold: cur.threshold, weights: { ...cur.weights, [ctx.target]: toValue.weights[ctx.target] } };
    return replayScenario(ctx.decisions, candidate);
  }
}
```

```js
// src/calibration/knobs/index.js
import { ThresholdStrategy } from './threshold.js';
import { WeightStrategy } from './weight.js';
import { RequiredDimsStrategy } from './requiredDims.js';
const REGISTRY = { threshold: ThresholdStrategy, weight: WeightStrategy, required_dims: RequiredDimsStrategy };
export function getStrategy(knob) {
  const S = REGISTRY[knob];
  return S ? new S(knob) : null;
}
```

- [x] **Step 4: 重构 store.js 写段（threshold/weight 路由到策略）**

将 `src/calibration/store.js` 的 `approvePatch`（L116-146）与 `rollbackPatch`（L157-184）的写段改为策略路由，并保留 `required_dims` 守卫（T3 才删）。改后 `approvePatch` 主体：

```js
export async function approvePatch(patch_id, { produce = produceDecision, resolved_by = null } = {}) {
  const patch = await getPatch(patch_id);
  if (!patch) throw new Error(`未知处方: ${patch_id}`);
  if (patch.status !== 'PENDING' && patch.status !== 'APPROVED') {
    throw new Error(`处方状态 ${patch.status} 不可批准（仅 PENDING/APPROVED）`);
  }
  if (patch.knob === 'required_dims') throw new Error('required_dims 处方属 P3，本期不可批准（依赖 S20）'); // T3 删除
  const strat = getStrategy(patch.knob);
  if (!strat) throw new Error(`未知 knob: ${patch.knob}`);
  const cur = await readConf();

  const dec = await produce({ scenario_id: 'CALIBRATION_CHANGE', fields: [patch.knob, patch.target].filter(Boolean) });
  await withTx(async (client) => {
    await strat.apply(client, patch.to_value, { scenario_id: patch.scenario_id, target: patch.target, decisionId: dec.decisionId, current: cur });
    await client.query(
      `UPDATE crm.calibration_patch SET status='APPLIED', resolved_at=now(), resolved_by=$2,
         decision_id=COALESCE($3, decision_id)
       WHERE patch_id=$1 RETURNING *`,
      [patch_id, resolved_by, dec.decisionId]
    );
  });
  return { patch: await getPatch(patch_id), config: await readConf(), decision: dec.decisionId };
}
```

`rollbackPatch` 同构（将 `next` 计算与 `client.query` 替换为 `strat.apply(client, patch.from_value, {...current: cur})`，并保留 L161 的 `required_dims` 守卫，T3 删除）。在 `src/calibration/store.js` 顶部 import 加：`import { getStrategy } from './knobs/index.js';`

- [x] **Step 5: 运行测试确认通过 + parity 不回归**

Run：`cd /d/system/CRM-ai-native && PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/knobs.test.js test/calibration/parity.test.js`
Expected：PASS（knobs 3 测 + parity 全绿）

- [x] **Step 6: Commit**

```bash
git add src/calibration/knobs/base.js src/calibration/knobs/threshold.js src/calibration/knobs/weight.js src/calibration/knobs/index.js src/calibration/store.js test/calibration/knobs.test.js
git commit -m "feat(calibration): 旋钮策略抽象 + 迁移 threshold/weight 到策略类"
```

---

## Task 2: RequiredDimsStrategy

**Files:**
- Create: `src/calibration/knobs/requiredDims.js`
- Test: `test/calibration/knobs.test.js`（追加）

- [x] **Step 1: 写失败测试**

在 `test/calibration/knobs.test.js` 末尾追加：

```js
import { RequiredDimsStrategy } from '../../src/calibration/knobs/requiredDims.js';

describe('RequiredDimsStrategy', () => {
  it('readCurrent 读 decision_scenario.required_dims', async () => {
    const s = new RequiredDimsStrategy('required_dims');
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id='OPP'`,
        [JSON.stringify([{ dim: 'identity', on_missing: 'warn' }])]);
    });
    const cur = await s.readCurrent('OPP');
    expect(cur).toEqual([{ dim: 'identity', on_missing: 'warn' }]);
  });

  it('apply 写 decision_scenario.required_dims（不写 config_store）', async () => {
    const s = new RequiredDimsStrategy('required_dims');
    const before = await readConf();
    await withTx(async (client) => {
      await s.apply(client, [{ dim: 'identity', on_missing: 'block' }], { scenario_id: 'OPP' });
    });
    const after = await readConf();
    expect(after).toEqual(before); // config_store 不变
    const r = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id='OPP'`);
    expect(r.rows[0].required_dims).toEqual([{ dim: 'identity', on_missing: 'block' }]);
  });

  it('riskLevel：block→warn 降级返回 HIGH', () => {
    const s = new RequiredDimsStrategy('required_dims');
    expect(s.riskLevel([{ dim: 'identity', on_missing: 'block' }], [{ dim: 'identity', on_missing: 'warn' }])).toBe('HIGH');
  });
  it('riskLevel：warn→block 升严返回 MEDIUM', () => {
    const s = new RequiredDimsStrategy('required_dims');
    expect(s.riskLevel([{ dim: 'identity', on_missing: 'warn' }], [{ dim: 'identity', on_missing: 'block' }])).toBe('MEDIUM');
  });
  it('riskLevel：移除 dim 要求返回 HIGH', () => {
    const s = new RequiredDimsStrategy('required_dims');
    expect(s.riskLevel([{ dim: 'identity', on_missing: 'block' }], [])).toBe('HIGH');
  });
});
```

- [x] **Step 2: 运行确认失败**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/knobs.test.js`
Expected：FAIL（`requiredDims.js` 不存在）

- [x] **Step 3: 写 RequiredDimsStrategy**

```js
// src/calibration/knobs/requiredDims.js
import { KnobStrategy } from './base.js';
import { query } from '../../db.js';

export class RequiredDimsStrategy extends KnobStrategy {
  async readCurrent(scenarioId) {
    const r = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id=$1`, [scenarioId]);
    const v = r.rows[0]?.required_dims;
    return Array.isArray(v) ? v : [];
  }

  async apply(client, toValue, ctx) {
    await client.query(
      `UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id=$2`,
      [JSON.stringify(toValue), ctx.scenario_id]
    );
  }

  async replayImpact(ctx, toValue) {
    const { replayDims } = await import('../replayDims.js');
    return replayDims(ctx.scenarioId, toValue, ctx.windowDays || 30);
  }

  // from/to 为 [{dim,on_missing}]；降级（block→非 block / 移除 dim）→ HIGH，否则 MEDIUM
  riskLevel(from = [], to = []) {
    const fm = new Map((from || []).map((d) => [d.dim, d.on_missing]));
    const tm = new Map((to || []).map((d) => [d.dim, d.on_missing]));
    let high = false;
    for (const [dim, om] of tm) {
      const f = fm.get(dim);
      if (f === 'block' && om !== 'block') high = true;
    }
    for (const dim of fm.keys()) if (!tm.has(dim)) high = true;
    return high ? 'HIGH' : 'MEDIUM';
  }
}
```

- [x] **Step 4: 运行确认通过**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/knobs.test.js`
Expected：PASS（8 测）

- [x] **Step 5: Commit**

```bash
git add src/calibration/knobs/requiredDims.js test/calibration/knobs.test.js
git commit -m "feat(calibration): RequiredDimsStrategy（写 decision_scenario + riskLevel）"
```

---

## Task 3: store.js 解锁 required_dims 守卫

**Files:**
- Modify: `src/calibration/store.js:122`（删守卫）、`src/calibration/store.js:123`（删 unknown 检查）、`src/calibration/store.js:161`（删守卫）
- Test: `test/calibration/store-p3.test.js`（新建）

- [x] **Step 1: 写失败测试（端到端：批准→sevenDimensionsCheck 拦截）**

```js
// test/calibration/store-p3.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { query, withTx } from '../../src/db.js';
import { createPatch, approvePatch, rollbackPatch, getPatch } from '../../src/calibration/store.js';
import { sevenDimensionsCheck } from '../../src/sevenDimensions/engine.js';

describe('store · required_dims 处方批准/回滚', () => {
  beforeEach(async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP'`);
    });
  });

  it('批准 required_dims 处方 → decision_scenario 生效 → sevenDimensionsCheck 拦截', async () => {
    const patch = await createPatch({
      scenario_id: 'OPP', knob: 'required_dims', target: null,
      from_value: [], to_value: [{ dim: 'identity', on_missing: 'block' }],
      evidence: { source: 'test' }, expected_impact: { sample_size: 0 }, risk: 'MEDIUM',
    });
    await approvePatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    const p = await getPatch(patch.patch_id);
    expect(p.status).toBe('APPLIED');
    const chk = await sevenDimensionsCheck('OPP', { identity: null });
    expect(chk.allowed).toBe(false); // block 生效
  });

  it('降级（block→warn）批准标 HIGH 且放宽拦截', async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id='OPP'`,
        [JSON.stringify([{ dim: 'identity', on_missing: 'block' }])]);
    });
    const patch = await createPatch({
      scenario_id: 'OPP', knob: 'required_dims', target: null,
      from_value: [{ dim: 'identity', on_missing: 'block' }], to_value: [{ dim: 'identity', on_missing: 'warn' }],
      evidence: { source: 'test' }, expected_impact: { sample_size: 0 }, risk: 'HIGH',
    });
    await approvePatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    const chk = await sevenDimensionsCheck('OPP', { identity: null });
    expect(chk.allowed).toBe(true); // 放宽后允许写
  });

  it('回滚恢复 from_value', async () => {
    const patch = await createPatch({
      scenario_id: 'OPP', knob: 'required_dims', target: null,
      from_value: [], to_value: [{ dim: 'identity', on_missing: 'block' }],
      evidence: { source: 'test' }, expected_impact: { sample_size: 0 }, risk: 'MEDIUM',
    });
    await approvePatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    await rollbackPatch(patch.patch_id, { produce: async () => ({ decisionId: null }), resolved_by: 'sysadmin' });
    const p = await getPatch(patch.patch_id);
    expect(p.status).toBe('ROLLED_BACK');
    const r = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id='OPP'`);
    expect(r.rows[0].required_dims).toEqual([]);
  });
});
```

- [x] **Step 2: 运行确认失败（守卫抛错）**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/store-p3.test.js`
Expected：FAIL（store.js:122 `required_dims 处方属 P3，本期不可批准`）

- [x] **Step 3: 删守卫**

删除 `src/calibration/store.js`：
- L122 `if (patch.knob === 'required_dims') throw new Error('required_dims 处方属 P3，本期不可批准（依赖 S20）');`
- L123 `if (patch.knob !== 'threshold' && patch.knob !== 'weight') throw new Error(`未知 knob: ${patch.knob}`);`（已由 `getStrategy` 返回 null 覆盖，保留 `if (!strat) throw` 即可——见 Step 4）
- L161 `if (patch.knob === 'required_dims') throw new Error('required_dims 处方属 P3，本期不可回滚');`

在 `approvePatch` 中 `const strat = getStrategy(patch.knob); if (!strat) throw new Error(`未知 knob: ${patch.knob}`);` 已存在（Task 1 加），故删 L123 后由该判据承接。`rollbackPatch` 同样确保 `const strat = getStrategy(patch.knob); if (!strat) ...` 存在（Task 1 已加）。

- [x] **Step 4: 运行确认通过**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/store-p3.test.js`
Expected：PASS（3 测）

- [x] **Step 5: Commit**

```bash
git add src/calibration/store.js test/calibration/store-p3.test.js
git commit -m "feat(calibration): 解锁 required_dims 处方批准/回滚（删 P3 守卫）"
```

---

## Task 4: calibrationRouter 手动发起端点 + 删 L181

**Files:**
- Modify: `src/http/calibrationRouter.js:147-212`（generate 加手动分支）、`src/http/calibrationRouter.js:180-181`（删 `return p`）
- Test: `test/calibration/router-p3.test.js`（新建）

- [x] **Step 1: 写失败测试**

```js
// test/calibration/router-p3.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query, withTx } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

function appWith(role = 'sysadmin') {
  const app = createApp();
  const t = issueToken({ username: 'sysadmin', role, sub: 'sysadmin' });
  return { app, auth: { Authorization: `Bearer ${t}` } };
}

describe('校准路由 · 手动发起 required_dims 处方', () => {
  beforeEach(async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP'`);
    });
  });

  it('POST generate 带 required_dims_draft → 生成 PENDING 处方 + risk', async () => {
    const { app, auth } = appWith();
    const res = await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.created).toBe(1);
    expect(j.risk).toBe('MEDIUM');
    expect(j.patch.knob).toBe('required_dims');
  });

  it('幂等：同 scenario_id + to_value PENDING 跳过', async () => {
    const { app, auth } = appWith();
    await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    const res2 = await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    const j2 = await res2.json();
    expect(j2.created).toBe(0);
    expect(j2.skipped).toBe(1);
  });

  it('非 sysadmin 被 403', async () => {
    const { app, auth } = appWith('sales');
    const res = await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [x] **Step 2: 运行确认失败**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/router-p3.test.js`
Expected：FAIL（手动分支未实现）

- [x] **Step 3: 实现手动发起分支 + 删 L181**

在 `src/http/calibrationRouter.js` 顶部 import 加：`import { replayDims } from '../calibration/replayDims.js';`（T5 创建，此处先引用；若 T5 未先建，本 Task 前先建空壳——见 Task 5 顺序说明）`import { RequiredDimsStrategy } from '../calibration/knobs/requiredDims.js';` `import { validateRequiredDimsPatch } from '../portal/sevenDimRender.js';`

在 `generate` handler 内、**现有自动归因逻辑之前**插入手动分支（L147 后、L151 前）：

```js
router.post('/api/calibration/patches/generate', async (req, res) => {
  try {
    const me = await ensureAdmin(req, res);
    if (!me) return;
    // P3 手动发起：七维页传入 required_dims_draft → 生成 required_dims 处方（不走自动归因）
    if (req.body?.required_dims_draft != null) {
      return await generateRequiredDims(req, res, me);
    }
    // ---- 现有自动归因路径（threshold/weight，不变）----
    const scenario_id = req.body?.scenario_id || null;
    ...
```

新增助手函数（在 `createCalibrationRouter` 内或模块级）：

```js
async function generateRequiredDims(req, res, me) {
  const scenario_id = req.body.scenario_id || null;
  if (!scenario_id) return res.status(400).json({ error: 'manual required_dims 处方须传 scenario_id' });
  const v = validateRequiredDimsPatch(req.body.required_dims_draft);
  if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
  const cur = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id=$1`, [scenario_id]);
  const from_value = cur.rows[0]?.required_dims || [];
  const to_value = v.normalized;
  const risk = new RequiredDimsStrategy('required_dims').riskLevel(from_value, to_value);
  const impact = await replayDims(scenario_id, to_value, Number(req.body.window_days) || 30);
  const dup = await query(
    `SELECT 1 FROM crm.calibration_patch WHERE scenario_id=$1 AND knob='required_dims' AND to_value=$2::jsonb AND status='PENDING' LIMIT 1`,
    [scenario_id, JSON.stringify(to_value)]
  );
  if (dup.rows.length) return res.json({ created: 0, skipped: 1, patch: null, risk, expected_impact: impact });
  const patch = await createPatch({
    scenario_id, knob: 'required_dims', target: null,
    from_value, to_value, evidence: { source: 'manual-seven-dim', by: me.username || 'sysadmin' },
    expected_impact: impact, risk,
  });
  return res.json({ created: 1, skipped: 0, patch, risk, expected_impact: impact });
}
```

同时删除 L180-181 的 `else { return p; // required_dims 属 P3，本期规则不产出 }`（自动归因路径仍只产出 threshold/weight，`required_dims` 不在 `att.patches` 中，无影响）。

- [x] **Step 4: 运行确认通过 + 现有自动路径不回归**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/router-p3.test.js test/calibration/router.test.js`
Expected：PASS

- [x] **Step 5: Commit**

```bash
git add src/http/calibrationRouter.js test/calibration/router-p3.test.js
git commit -m "feat(calibration): 手动发起 required_dims 处方端点 + 删 P3 return"
```

---

## Task 5: replayDims 量化重放

**Files:**
- Create: `src/calibration/replayDims.js`
- Test: `test/calibration/replayDims.test.js`（新建）

- [x] **Step 1: 写失败测试**

```js
// test/calibration/replayDims.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { withTx, query } from '../../src/db.js';
import { replayDims } from '../../src/calibration/replayDims.js';

describe('replayDims 量化重放', () => {
  beforeEach(async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP'`);
      await client.query(`DELETE FROM crm.decision WHERE scenario_id='OPP' AND trigger_context ? 'identity'`);
    });
  });

  it('升 block 后历史缺失 ctx 被计入拦截率', async () => {
    await withTx(async (client) => {
      await client.query(
        `INSERT INTO crm.decision (scenario_id, trigger_context, decider_type, state)
         VALUES ('OPP', '{"identity": null}'::jsonb, 'HUMAN', 'CONFIRMED')`);
    });
    const r = await replayDims('OPP', [{ dim: 'identity', on_missing: 'block' }], 30);
    expect(r.sample_size).toBe(1);
    expect(r.intercepted_before).toBe(0); // 当前无 required_dims → 不拦
    expect(r.intercepted_after).toBe(1);  // 升 block → 拦
    expect(r.estimated_block_rate).toBe(1);
    expect(r.estimated_block_rate_delta).toBe(1);
  });

  it('trigger_context 无 identity 字段 → 不受影响', async () => {
    await withTx(async (client) => {
      await client.query(`INSERT INTO crm.decision (scenario_id, trigger_context, decider_type, state) VALUES ('OPP', '{"other":1}'::jsonb, 'HUMAN', 'CONFIRMED')`);
    });
    const r = await replayDims('OPP', [{ dim: 'identity', on_missing: 'block' }], 30);
    expect(r.intercepted_after).toBe(0);
  });
});
```

- [x] **Step 2: 运行确认失败**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/replayDims.test.js`
Expected：FAIL（`replayDims.js` 不存在）

- [x] **Step 3: 实现 replayDims**

```js
// src/calibration/replayDims.js
import { query } from '../db.js';
import { sevenDimensionsCheck } from '../sevenDimensions/engine.js';

// 复放用 query：拦截 sevenDimensionsCheck 的 required_dims 读取，返回 toRequiredDims
function makeReplayQuery(toRequiredDims, realQ) {
  return async (sql, params) => {
    if (/required_dims FROM decision_scenario/.test(sql)) {
      return { rows: [{ required_dims: toRequiredDims }] };
    }
    return realQ(sql, params);
  };
}

export async function replayDims(scenarioId, toRequiredDims, windowDays = 30) {
  const r = await query(
    `SELECT decision_id, trigger_context FROM crm.decision
     WHERE scenario_id=$1 AND created_at >= now() - ($2::int || ' days')::interval
     ORDER BY created_at DESC`,
    [scenarioId, windowDays]
  );
  const rows = r.rows;
  const total = rows.length;
  let intercepted_before = 0;
  let intercepted_after = 0;
  for (const row of rows) {
    const ctx = row.trigger_context && typeof row.trigger_context === 'object' ? row.trigger_context : {};
    const before = await sevenDimensionsCheck(scenarioId, ctx);
    const after = await sevenDimensionsCheck(scenarioId, ctx, { query: makeReplayQuery(toRequiredDims, query) });
    if (!before.allowed) intercepted_before += 1;
    if (!after.allowed) intercepted_after += 1;
  }
  const rate = (n) => (total ? n / total : 0);
  return {
    sample_size: total,
    intercepted_before,
    intercepted_after,
    estimated_block_rate: rate(intercepted_after),
    estimated_block_rate_delta: rate(intercepted_after) - rate(intercepted_before),
  };
}
```

> 注意：`makeReplayQuery` 依赖 `engine.js:12` 的 SQL 片段 `required_dims FROM decision_scenario`。若引擎 SQL 改动需同步此处（已在文件头注释声明耦合）。

- [x] **Step 4: 运行确认通过**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/replayDims.test.js`
Expected：PASS（2 测）

- [x] **Step 5: Commit**

```bash
git add src/calibration/replayDims.js test/calibration/replayDims.test.js
git commit -m "feat(calibration): replayDims 量化重放（预估七维拦截率）"
```

> 顺序说明：Task 4 引用 `replayDims`，故本 Task 应在 Task 4 之前或同批完成。若分开提交，建议顺序 T1→T2→T5→T3→T4（先有 replayDims 再接路由）。

---

## Task 6: 七维页单一写通道

**Files:**
- Modify: `src/web/seven-dim.html:47-63`（矩阵保存改发起处方）

- [x] **Step 1: 改保存按钮（直写 → 发起校准处方）**

将 `src/web/seven-dim.html` 的矩阵保存按钮（L47-62）`btn.onclick` 内：

```js
const r = await fetch('/api/config/seven-dim', {
  method: 'PUT', headers: HDR,
  body: JSON.stringify({ scenario_id: tr.dataset.id, required_dims: v.normalized }),
});
const j = await r.json();
alert(r.ok ? `已保存（决策 ${String(j.decision || '').slice(0, 8)}…）` : ('失败：' + (j.error || r.status)));
load();
```

改为：

```js
const r = await fetch('/api/calibration/patches/generate', {
  method: 'POST', headers: HDR,
  body: JSON.stringify({ scenario_id: tr.dataset.id, required_dims_draft: v.normalized }),
});
const j = await r.json();
alert(r.ok
  ? `已生成校准处方（${j.created ? '待 sysadmin 批准生效' : '已存在'}）`
  : ('失败：' + (j.error || r.status)));
load();
```

> 全局默认严格度保存（L35-46 的 `sd7-strict-save`）**保持不变**（它写 `config_store['seven-dim']`，属 S20 全局严格度，不走校准处方）。

- [x] **Step 2: 验证 GET 展示不受影响**

Run：`cd /d/system/CRM-ai-native && PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/portal-pipeline.test.js` + 人工核对 `GET /api/config/seven-dim` 仍返回 `scenarios[].required_dims`（读取路径未改）。
Expected：无回归

- [x] **Step 3: Commit**

```bash
git add src/web/seven-dim.html
git commit -m "feat(ui): 七维矩阵保存改为发起校准处方（单一写通道）"
```

---

## Task 7: 前端风险标注（降级二次确认）

**Files:**
- Modify: `src/portal/calibrationRender.js`（处方卡加 `data-risk`/`data-patch`）
- Modify: `src/web/sales-decision-monitor.html:605-617`（`bindActions` 批准降级前 `confirm`）

- [x] **Step 1: 在 renderPatchCard 加 data 属性**

在 `src/portal/calibrationRender.js` 的 `renderPatchCard`（处方卡容器）输出加 `data-patch="${p.patch_id}" data-risk="${p.risk}"`（原 `cal-risk-${p.risk}` 样式类保留）。具体在卡片根元素 `<div class="cal-patch cal-risk-${p.risk}">` 改为 `<div class="cal-patch cal-risk-${p.risk}" data-patch="${esc(p.patch_id)}" data-risk="${esc(p.risk)}">`（行号约 L51-84，按实际结构加）。

- [x] **Step 2: bindActions 批准降级二次确认**

将 `src/web/sales-decision-monitor.html` 的 `bindActions`（L605-617）中 approve 接线改为：

```js
wire('approve', async (id) => {
  const card = document.querySelector(`[data-cal-approve="${id}"]`)?.closest('[data-patch]');
  const risk = card?.dataset?.risk;
  if (risk === 'HIGH' && !confirm('此处方将放宽拦截（block→warn / 移除 dim 要求），确认？')) return;
  await post(`/api/calibration/patches/${id}/approve`, {});
});
wire('reject', (id) => post(`/api/calibration/patches/${id}/reject`, {}));
wire('rollback', (id) => post(`/api/calibration/patches/${id}/rollback`, {}));
```

- [x] **Step 3: 验证**

Run：`PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run test/calibration/` + 人工在监控页校准 tab 对某 HIGH 风险处方点批准应弹 `confirm`。
Expected：无回归 + 降级二次确认生效

- [x] **Step 4: Commit**

```bash
git add src/portal/calibrationRender.js src/web/sales-decision-monitor.html
git commit -m "feat(ui): 降级处方标 HIGH + 批准前二次确认"
```

---

## Task 8: 测试 + 全量回归

**Files:**
- Test: 既有 `test/calibration/parity.test.js`（扩展：三 knob 经策略写回逐字一致）
- Run: 全量

- [x] **Step 1: 扩展 parity 测试（锁死抽象重构不破坏 P1 行为）**

在 `test/calibration/parity.test.js` 追加：经 `getStrategy('threshold').apply` / `getStrategy('weight').apply` 写回后，读 `readConf()` 与 `DEFAULT_CONF` 在阈值/权重维度逐字一致（即重构前后行为等价）。具体断言阈值可改回 0.8、权重和 ≈ 1.0。

- [x] **Step 2: 全量回归（单进程）**

Run：`cd /d/system/CRM-ai-native && PGDATABASE=plm_test node node_modules/vitest/vitest.mjs run 2>&1 | tail -20`
Expected：**零失败**（167 files，约 1286+ passed；本次新增 8 测试计入）

- [x] **Step 3: 提交设计文档 + 计划（用户本地）→ 见下方提交指引**

> 设计文档 `docs/2026-08-29-calibration-p3-design.md` 与计划 `docs/superpowers/plans/2026-08-29-calibration-p3.md` 由用户在本地提交（本 Task 仅提交测试/源码）。

- [x] **Step 4: Commit 测试与源码**

```bash
git add test/calibration/ test/portal-pipeline.test.js
git commit -m "test(calibration): P3 测试覆盖 + parity 扩展（全量回归归零）"
```

---

## 提交指引（沙箱无凭证，用户本地执行，勿 git add -A）

P3 全部 Task 完成后，工作树含：设计文档 + 计划 + 6 个源码/测试改动批次。建议分两批提交：

```bash
# 1) 设计/计划文档
git add docs/2026-08-29-calibration-p3-design.md docs/superpowers/plans/2026-08-29-calibration-p3.md
git commit -m "design: P3 决策质量校准 required_dims 处方（旋钮抽象重构）"

# 2) 源码 + 测试（8 个 Task commit 已在实现阶段逐次提交）
git add src/calibration/knobs/ src/calibration/replayDims.js src/calibration/store.js \
        src/http/calibrationRouter.js src/portal/calibrationRender.js \
        src/web/seven-dim.html src/web/sales-decision-monitor.html \
        test/calibration/knobs.test.js test/calibration/store-p3.test.js \
        test/calibration/replayDims.test.js test/calibration/router-p3.test.js
git commit -m "feat(calibration): P3 required_dims 处方完整实现 + 测试"
```

---

## 自查（Spec Coverage / Placeholder / Type Consistency）

- **Spec coverage：** §1 旋钮抽象 → T1/T2；§2 零 DDL → 已确认（无 DDL Task）；§4 三策略 → T1/T2；§5 store 重构 → T1/T3；§6 路由手动发起 + 删 L181 → T4；§7 量化重放 → T5；§8 七维页单一通道 → T6；§9 前端风险标注 → T7；§10 第0闸 → 各 Task 沿用 `produce`/`withTx`；§11 测试 → T1/T2/T3/T4/T5/T8；§12 验收 → T8 全量归零。
- **Placeholder scan：** 无 TBD/TODO/「类似 Task N」；每步含真实代码或命令。
- **Type consistency：** `getStrategy(knob)` 全程一致；`apply(client, toValue, ctx)` 签名三策略统一（ctx 含 `scenario_id/target/decisionId/current`）；`riskLevel(from, to)` 数组 `[{dim,on_missing}]` 一致；`replayDims(scenarioId, toValue, windowDays)` 签名与 `RequiredDimsStrategy.replayImpact` 调用一致。
- **风险点：** `replayDims` 的 `makeReplayQuery` 字符串匹配耦合 `engine.js:12` SQL（已在文件注释声明）；`trigger_context` 是否含七维字段由种子数据决定，缺失仅导致 sample 受限（非阻塞，符合设计 §7）。
