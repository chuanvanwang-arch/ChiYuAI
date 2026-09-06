# S20 七维矩阵改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 S20「七维设计」从无运行时作用的全局 0–5 打分，改造为蓝图契约的「场景×七维矩阵」，写入 `decision_scenario.required_dims`，使七维完整性闸门首次真正生效。

**Architecture:** 保留蓝图规定的 `GET/PUT /api/config/seven-dim` 作为配置面端点，但校验、决策（第0闸）、写库三件事全部复用 `src/portal/decisionScenario.js` 内核，确保 `decision_scenario` 表只有一条写路径、校验口径不漂移。全局默认严格度留在 `config_store['seven-dim'] = {default_strictness}`，按场景的 required 维落在 `decision_scenario.required_dims`。

**Tech Stack:** Node 22 + ESM + Express 4 + PostgreSQL（pg）+ vitest 3

**设计依据：** `docs/2026-08-28-s20-seven-dim-matrix-design.md`（已批准）

**测试命令约定：** 沙箱内禁 `npx`，统一用
`node node_modules/vitest/vitest.mjs run <files>`

---

## 文件清单

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/portal/decisionScenario.js` | 改 | 增加 `required_dims` 编辑能力（白名单 + 校验 + COL_CAST），导出 `scenarioDeps` |
| `src/http/sevenDimRouter.js` | 新建 | S20 矩阵端点（角色闸 + 第0闸 + 复用内核） |
| `src/portal/sevenDimRender.js` | 重写 | 矩阵渲染 + `validateRequiredDimsPatch`（浏览器安全，零服务端 import） |
| `src/web/seven-dim.html` | 改 | 矩阵页（全局严格度 + 场景行逐行保存） |
| `src/http/routes.js` | 改 | 换挂载（第 95 行） |
| `src/sevenDimensions/engine.js` | 改 | 删除 `sevenDimConfigCheck`（旧 0–5 形状所造） |
| `src/pages/S20.schema.js` | 改 | 同步为矩阵形态 |
| `scripts/seed-seven-dim.mjs` | 新建 | 幂等预置脚本 |
| `test/web/decisionScenario.test.js` | 改 | `EDITABLE_FIELDS` 断言 + `required_dims` 校验用例 |
| `test/http/sevenDimRouter.test.js` | 新建 | 端点契约全覆盖 |
| `test/portal/sevenDimRender.test.js` | 重写 | 矩阵渲染 + 校验 + parity |
| `test/http/configRouter.test.js` | 改 | 移除 `sevenDimConfigCheck` 相关 3 条断言与 import |

---

## Task 1: `decisionScenario.js` 增加 `required_dims` 编辑能力

**Files:**
- Modify: `src/portal/decisionScenario.js:7`（import）、`:10-12`（EDITABLE_FIELDS）、`:13`（ON_MISSING）、`:60-67`（validate 分支）、`:111-118`（COL_CAST）、文件末（导出）
- Test: `test/web/decisionScenario.test.js`

> 前置说明：`test/web/decisionScenario.test.js:45-47` 断言 `EDITABLE_FIELDS` 恰为 6 项，增加字段会使其失败——本 Task 同步更新该断言。

- [ ] **Step 1: 写失败测试**

在 `test/web/decisionScenario.test.js` 的 `test('validateScenarioPatch 全白名单字段归类正确', ...)` 之后追加：

```js
test('validateScenarioPatch required_dims 合法 → 通过', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'identity', on_missing: 'block' }, { dim: 'structure' }] });
  expect(r.ok).toBe(true);
  expect(r.normalized.required_dims).toEqual([
    { dim: 'identity', on_missing: 'block' },
    { dim: 'structure', on_missing: 'warn' },
  ]);
});

test('validateScenarioPatch required_dims 未知维度 → 拒绝', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'context', on_missing: 'warn' }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('未知维度');
});

test('validateScenarioPatch required_dims 重复维度 → 拒绝', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'identity' }, { dim: 'identity' }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('重复');
});

test('validateScenarioPatch required_dims 非法 on_missing → 拒绝', () => {
  const r = validateScenarioPatch({ required_dims: [{ dim: 'identity', on_missing: 'nuke' }] });
  expect(r.ok).toBe(false);
  expect(r.errors.join()).toContain('on_missing');
});

test('validateScenarioPatch required_dims 非数组 → 拒绝', () => {
  expect(validateScenarioPatch({ required_dims: 'identity' }).ok).toBe(false);
});
```

同时把 `test('validateScenarioPatch 全白名单字段归类正确', ...)` 的断言改为：

```js
  expect(EDITABLE_FIELDS).toEqual([
    'description', 'methodology_ids', 'eval_dimensions', 'default_tier', 'autonomous_allowed', 'dispositions',
    'required_dims',
  ]);
  expect(ON_MISSING).toEqual(['warn', 'block']);
```

并在文件顶部 import 中追加 `ON_MISSING`：

```js
import {
  validateScenarioPatch,
  renderDecisionScenarios,
  createDecisionScenarioRouter,
  EDITABLE_FIELDS,
  TIERS,
  DISPOSITIONS,
  ON_MISSING,
} from '../../src/portal/decisionScenario.js';
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/web/decisionScenario.test.js
```

Expected: FAIL —— `ON_MISSING` 未导出、`required_dims` 未进白名单。

- [ ] **Step 3: 实现**

`src/portal/decisionScenario.js` 第 7 行后追加 import：

```js
import { DIM_KEYS } from '../sevenDimensions/constants.js';
```

第 10-12 行 `EDITABLE_FIELDS` 增加 `'required_dims',`：

```js
export const EDITABLE_FIELDS = [
  'description', 'methodology_ids', 'eval_dimensions', 'default_tier', 'autonomous_allowed', 'dispositions',
  'required_dims',
];
```

第 13 行后追加：

```js
export const ON_MISSING = ['warn', 'block'];
```

在 `validateScenarioPatch` 的 `return { ok: errors.length === 0, errors, normalized: n };` 之前插入：

```js
  if ('required_dims' in patch) {
    const arr = patch.required_dims;
    if (!Array.isArray(arr)) errors.push('required_dims 须为数组');
    else {
      const seen = new Set();
      const norm = [];
      let bad = null;
      for (const d of arr) {
        if (!d || typeof d.dim !== 'string' || !DIM_KEYS.includes(d.dim)) {
          bad = `未知维度: ${d?.dim}（仅 ${DIM_KEYS.join('/')}）`;
          break;
        }
        if (seen.has(d.dim)) { bad = `维度重复: ${d.dim}`; break; }
        seen.add(d.dim);
        const om = d.on_missing || 'warn';
        if (!ON_MISSING.includes(om)) { bad = `${d.dim} 的 on_missing 须为 ${ON_MISSING.join('/')}`; break; }
        norm.push({ dim: d.dim, on_missing: om });
      }
      if (bad) errors.push(bad);
      else n.required_dims = norm;
    }
  }
```

`COL_CAST`（约 111-118 行）增加一项：

```js
      required_dims: 'jsonb',
```

文件末尾追加导出（供 `sevenDimRouter` 复用写库内核）：

```js
export { defaultDeps as scenarioDeps };
```

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/web/decisionScenario.test.js
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/portal/decisionScenario.js test/web/decisionScenario.test.js
git commit -m "feat(seven-dim): decisionScenario 支持 required_dims 编辑（白名单+校验+jsonb cast）"
```

---

## Task 2: 新建 `src/http/sevenDimRouter.js`

**Files:**
- Create: `src/http/sevenDimRouter.js`
- Create: `test/http/sevenDimRouter.test.js`

- [ ] **Step 1: 写失败测试**

新建 `test/http/sevenDimRouter.test.js`：

```js
// test/http/sevenDimRouter.test.js — S20 场景×七维矩阵端点契约
import { describe, it, expect } from 'vitest';
import { createSevenDimRouter } from '../../src/http/sevenDimRouter.js';

function makeDeps({ role = 'admin' } = {}) {
  const rows = {
    QUOTE_PRICING: { scenario_id: 'QUOTE_PRICING', stage: '四、商务报价', default_tier: 'HIGH', autonomous_allowed: false, required_dims: [] },
  };
  return {
    listScenarios: async () => Object.values(rows).map((r) => ({ ...r })),
    readStrictness: async () => 'warn',
    writeStrictness: async (v) => { deps.__strict = v; },
    updateScenario: async (id, patch) => {
      if (!rows[id]) return null;
      rows[id] = { ...rows[id], ...patch };
      return rows[id];
    },
    produceDecision: async () => ({ decisionId: 'dec-7' }),
    resolveMe: async () => ({ ok: true, role }),
  };
}
let deps;

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}

describe('GET /api/config/seven-dim', () => {
  it('返回 7 维定义 + 场景矩阵 + 全局默认严格度', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.dims).toHaveLength(7);
    expect(res.body.dims.map((d) => d.key)).toContain('decision_history');
    expect(res.body.scenarios[0].scenario_id).toBe('QUOTE_PRICING');
    expect(res.body.default_strictness).toBe('warn');
  });

  it('非 sysadmin → 403', async () => {
    deps = makeDeps({ role: 'sales' });
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.get({ headers: {} }, res);
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toBe('需要 sysadmin 权限');
  });
});

describe('PUT /api/config/seven-dim', () => {
  it('单场景矩阵更新 → 落库 + 附 decision', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put(
      { headers: {}, body: { scenario_id: 'QUOTE_PRICING', required_dims: [{ dim: 'identity', on_missing: 'block' }] } },
      res,
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.required_dims).toEqual([{ dim: 'identity', on_missing: 'block' }]);
    expect(res.body.decision).toBe('dec-7');
  });

  it('omitted on_missing → 默认 warn', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { scenario_id: 'QUOTE_PRICING', required_dims: [{ dim: 'semantics' }] } }, res);
    expect(res.body.required_dims).toEqual([{ dim: 'semantics', on_missing: 'warn' }]);
  });

  it('未知维度 → 400', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { scenario_id: 'QUOTE_PRICING', required_dims: [{ dim: 'context' }] } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('未知 scenario_id → 404', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { scenario_id: 'NO_SUCH', required_dims: [] } }, res);
    expect(res.statusCode).toBe(404);
  });

  it('缺 scenario_id 且缺 default_strictness → 400', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { required_dims: [] } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('全局 default_strictness 更新 → 落 config_store + 附 decision', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { default_strictness: 'block' } }, res);
    expect(res.statusCode).toBe(200);
    expect(deps.__strict).toBe('block');
    expect(res.body.decision).toBe('dec-7');
  });

  it('非法 default_strictness → 400', async () => {
    deps = makeDeps();
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { default_strictness: 'nuke' } }, res);
    expect(res.statusCode).toBe(400);
  });

  it('非 sysadmin PUT → 403', async () => {
    deps = makeDeps({ role: 'sales' });
    const router = createSevenDimRouter(deps);
    const res = fakeRes();
    await router.handlers.put({ headers: {}, body: { default_strictness: 'warn' } }, res);
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/http/sevenDimRouter.test.js
```

Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现**

新建 `src/http/sevenDimRouter.js`：

```js
// src/http/sevenDimRouter.js — S20 七维矩阵端点（配置面）
// 契约：GET /api/config/seven-dim → {dims, scenarios, default_strictness}
//       PUT /api/config/seven-dim → {scenario_id, required_dims} | {default_strictness}
// 两闸：sysadmin 角色闸 + 写经第0闸（config_change 决策事件）
// 单一写入口：校验/决策/写库全部复用 src/portal/decisionScenario.js 内核，避免口径漂移
import { Router } from 'express';
import { query } from '../db.js';
import { SEVEN_DIMS } from '../sevenDimensions/constants.js';
import { validateScenarioPatch, scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';

const CONFIG_KEY = 'seven-dim';
export const STRICTNESS = ['warn', 'block'];

const defaultDeps = {
  listScenarios: async () =>
    (await query(
      `SELECT scenario_id, stage, default_tier, autonomous_allowed, required_dims
       FROM crm.decision_scenario ORDER BY stage, scenario_id`
    )).rows,
  readStrictness: async () => {
    const r = await query(`SELECT value FROM crm.config_store WHERE key=$1`, [CONFIG_KEY]);
    const v = r.rows[0]?.value?.default_strictness;
    return STRICTNESS.includes(v) ? v : 'warn';
  },
  writeStrictness: async (v, decisionId) => {
    await query(
      `INSERT INTO crm.config_store (key, value, decision_id, updated_by, updated_at)
       VALUES ($1, $2::jsonb, $3, 'system', now())
       ON CONFLICT (key) DO UPDATE SET value=$2::jsonb, decision_id=$3, updated_at=now()`,
      [CONFIG_KEY, JSON.stringify({ default_strictness: v }), decisionId]
    );
  },
  updateScenario: (id, patch) => scenarioDeps.updateScenario(id, patch),
  produceDecision: (ctx) => scenarioDeps.produceDecision(ctx),
  resolveMe: (req) => realResolveMe(req),
};

function roleOk(role) {
  return role === 'admin' || role === 'sysadmin';
}

export function createSevenDimRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  async function ensureAdmin(req, res) {
    const me = await D.resolveMe(req).catch(() => ({ ok: false }));
    if (!me?.ok || !roleOk(me.role)) {
      res.status(403).json({ error: '需要 sysadmin 权限' });
      return false;
    }
    return true;
  }

  const handlers = {
    get: async (req, res) => {
      try {
        if (!(await ensureAdmin(req, res))) return;
        res.json({
          dims: SEVEN_DIMS.map((d) => ({ key: d.key, label: d.label, desc: d.desc })),
          scenarios: await D.listScenarios(),
          default_strictness: await D.readStrictness(),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        if (!(await ensureAdmin(req, res))) return;
        const { scenario_id, required_dims, default_strictness } = req.body || {};

        // A) 全局默认严格度（不传 scenario_id）
        if (scenario_id == null && default_strictness != null) {
          if (!STRICTNESS.includes(default_strictness)) {
            return res.status(400).json({ error: `default_strictness 须为 ${STRICTNESS.join('/')}` });
          }
          const decision = await D.produceDecision({ scenario_id: null, fields: ['default_strictness'] });
          await D.writeStrictness(default_strictness, decision?.decisionId || null);
          return res.json({ default_strictness, decision: decision?.decisionId || null, updated: true });
        }

        // B) 单场景矩阵
        if (!scenario_id) return res.status(400).json({ error: 'scenario_id 必填（或仅传 default_strictness）' });
        if (!Array.isArray(required_dims)) return res.status(400).json({ error: 'required_dims 须为数组' });

        const v = validateScenarioPatch({ required_dims });
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });

        const decision = await D.produceDecision({ scenario_id, fields: ['required_dims'] });
        const row = await D.updateScenario(scenario_id, v.normalized);
        if (!row) return res.status(404).json({ error: `未知 scenario_id: ${scenario_id}` });
        res.json({
          scenario_id,
          required_dims: row.required_dims,
          decision: decision?.decisionId || null,
          updated: true,
        });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/config/seven-dim', handlers.get);
  router.put('/api/config/seven-dim', handlers.put);
  router.handlers = handlers;
  return router;
}
```

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/http/sevenDimRouter.test.js
```

Expected: PASS（9 例）

- [ ] **Step 5: Commit**

```bash
git add src/http/sevenDimRouter.js test/http/sevenDimRouter.test.js
git commit -m "feat(seven-dim): S20 矩阵端点（角色闸+第0闸，复用 decisionScenario 内核）"
```

---

## Task 3: 重写 `src/portal/sevenDimRender.js`（矩阵渲染）

**Files:**
- Rewrite: `src/portal/sevenDimRender.js`
- Rewrite: `test/portal/sevenDimRender.test.js`

> 硬约束：`/sevenDimensions/*` 未被静态托管，浏览器端**禁止 import `constants.js`**。`SEVEN_KEYS` 本地保留，与引擎 `DIM_KEYS` 的一致性由 parity 测试守卫。

- [ ] **Step 1: 写失败测试**

重写 `test/portal/sevenDimRender.test.js` 为：

```js
// test/portal/sevenDimRender.test.js — S20 七维矩阵渲染（parity + 校验 + 渲染）
import { describe, it, expect } from 'vitest';
import {
  SEVEN_KEYS, SEVEN_LABELS, ON_MISSING,
  toDimMap, toRequiredDims, validateRequiredDimsPatch, renderSevenDimMatrix,
} from '../../src/portal/sevenDimRender.js';
import { SEVEN_DIMS, DIM_KEYS } from '../../src/sevenDimensions/constants.js';

describe('单一事实源 parity（禁止另写维表）', () => {
  it('SEVEN_KEYS 与 constants.DIM_KEYS 逐键一致', () => {
    expect(SEVEN_KEYS).toEqual(DIM_KEYS);
    expect(SEVEN_KEYS).toEqual(SEVEN_DIMS.map((d) => d.key));
  });
  it('SEVEN_LABELS 覆盖全部维', () => {
    for (const k of SEVEN_KEYS) expect(SEVEN_LABELS[k]).toBeTruthy();
  });
});

describe('toDimMap / toRequiredDims 往返', () => {
  it('required_dims → map → required_dims 无损', () => {
    const rd = [{ dim: 'identity', on_missing: 'block' }, { dim: 'semantics', on_missing: 'warn' }];
    expect(toDimMap(rd)).toEqual({ identity: 'block', semantics: 'warn' });
    expect(toRequiredDims(toDimMap(rd))).toEqual(rd);
  });
  it('非法/缺失 on_missing 降级为 warn', () => {
    expect(toDimMap([{ dim: 'identity', on_missing: 'nuke' }])).toEqual({ identity: 'warn' });
    expect(toDimMap([{ dim: 'identity' }])).toEqual({ identity: 'warn' });
  });
  it('非数组输入不崩溃', () => {
    expect(toDimMap(null)).toEqual({});
    expect(toDimMap({ risk: 'low' })).toEqual({});
  });
  it('未配置的维不出现在 required_dims', () => {
    expect(toRequiredDims({ identity: 'warn', structure: '' })).toEqual([{ dim: 'identity', on_missing: 'warn' }]);
  });
});

describe('validateRequiredDimsPatch', () => {
  it('合法通过', () => {
    const v = validateRequiredDimsPatch([{ dim: 'identity', on_missing: 'block' }, { dim: 'structure' }]);
    expect(v.ok).toBe(true);
    expect(v.normalized).toEqual([{ dim: 'identity', on_missing: 'block' }, { dim: 'structure', on_missing: 'warn' }]);
  });
  it('空数组合法（清空全部要求）', () => {
    expect(validateRequiredDimsPatch([]).ok).toBe(true);
  });
  it('未知维度 → 拒绝', () => {
    expect(validateRequiredDimsPatch([{ dim: 'context' }]).ok).toBe(false);
  });
  it('重复维度 → 拒绝', () => {
    expect(validateRequiredDimsPatch([{ dim: 'identity' }, { dim: 'identity' }]).ok).toBe(false);
  });
  it('非数组 → 拒绝', () => {
    expect(validateRequiredDimsPatch('identity').ok).toBe(false);
  });
});

describe('renderSevenDimMatrix', () => {
  const payload = {
    dims: SEVEN_DIMS.map((d) => ({ key: d.key, label: d.label, desc: d.desc })),
    scenarios: [
      { scenario_id: 'QUOTE_PRICING', stage: '四、商务报价', default_tier: 'HIGH', autonomous_allowed: false,
        required_dims: [{ dim: 'identity', on_missing: 'block' }] },
      { scenario_id: 'LEAD_FOLLOW_UP', stage: '一、线索', default_tier: 'LEAD', autonomous_allowed: true, required_dims: [] },
    ],
    default_strictness: 'warn',
  };

  it('渲染表头 7 维 + 全局严格度 select', () => {
    const html = renderSevenDimMatrix(payload);
    expect(html).toContain('id="sd7-strict"');
    for (const k of SEVEN_KEYS) expect(html).toContain(`data-dim="${k}"`);
  });

  it('每行渲染场景 + 已配置的严格度选中', () => {
    const html = renderSevenDimMatrix(payload);
    expect(html).toContain('data-id="QUOTE_PRICING"');
    expect(html).toContain('data-id="LEAD_FOLLOW_UP"');
    expect(html).toContain('value="block" selected');
    expect(html).toContain('四、商务报价');
    expect(html).toContain('HIGH');
  });

  it('空场景列表仍渲染表格（空态可操作）', () => {
    const html = renderSevenDimMatrix({ ...payload, scenarios: [] });
    expect(html).toContain('id="sd7-matrix"');
    expect(html).toContain('暂无决策场景');
  });

  it('dims 缺省时回退本地 SEVEN_KEYS', () => {
    const html = renderSevenDimMatrix({ scenarios: payload.scenarios, default_strictness: 'block' });
    for (const k of SEVEN_KEYS) expect(html).toContain(`data-dim="${k}"`);
  });

  it('阶段名 HTML 转义', () => {
    const html = renderSevenDimMatrix({ ...payload, scenarios: [{ scenario_id: 'X', stage: '<img src=x>', default_tier: 'HIGH', required_dims: [] }] });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&lt;img');
  });
});
```

- [ ] **Step 2: 运行确认失败**

```bash
node node_modules/vitest/vitest.mjs run test/portal/sevenDimRender.test.js
```

Expected: FAIL —— `toDimMap` 等未导出。

- [ ] **Step 3: 实现**

重写 `src/portal/sevenDimRender.js`：

```js
// sevenDimRender.js — S20 七维矩阵渲染（浏览器 ESM；零服务端 import）
// 硬约束：/sevenDimensions/* 未被静态托管，禁止 import constants.js（会 404 致整页脚本不执行）。
// 维度定义由 GET /api/config/seven-dim 的 dims 字段下发；本地 SEVEN_KEYS 仅用于校验，
// 与引擎 constants.DIM_KEYS 的一致性由 test/portal/sevenDimRender.test.js parity 断言守卫。
export const SEVEN_KEYS = ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'];
export const SEVEN_LABELS = {
  identity: '身份', structure: '结构', semantics: '语义',
  time_config: '时间', decision_history: '决策史', operational_state: '运行态', governance: '治理',
};
export const ON_MISSING = ['warn', 'block'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// required_dims([{dim,on_missing}]) → {dim: on_missing}；非法/缺失 on_missing 降级 'warn'
export function toDimMap(requiredDims) {
  const m = {};
  if (!Array.isArray(requiredDims)) return m;
  for (const d of requiredDims) {
    if (d && typeof d.dim === 'string') m[d.dim] = ON_MISSING.includes(d.on_missing) ? d.on_missing : 'warn';
  }
  return m;
}

// {dim: on_missing} → required_dims[]；空串/非法值视为「未要求」
export function toRequiredDims(map = {}) {
  return SEVEN_KEYS
    .filter((k) => ON_MISSING.includes(map[k]))
    .map((k) => ({ dim: k, on_missing: map[k] }));
}

export function validateRequiredDimsPatch(requiredDims) {
  if (!Array.isArray(requiredDims)) return { ok: false, errors: ['required_dims 须为数组'] };
  const seen = new Set();
  const errors = [];
  const normalized = [];
  for (const d of requiredDims) {
    if (!d || typeof d.dim !== 'string' || !SEVEN_KEYS.includes(d.dim)) {
      errors.push(`未知维度: ${d?.dim}（仅 ${SEVEN_KEYS.join('/')}）`);
      break;
    }
    if (seen.has(d.dim)) { errors.push(`维度重复: ${d.dim}`); break; }
    seen.add(d.dim);
    const om = d.on_missing || 'warn';
    if (!ON_MISSING.includes(om)) { errors.push(`${d.dim} 的 on_missing 须为 ${ON_MISSING.join('/')}`); break; }
    normalized.push({ dim: d.dim, on_missing: om });
  }
  return { ok: errors.length === 0, errors, normalized };
}

export function renderSevenDimMatrix({ dims = [], scenarios = [], default_strictness = 'warn' } = {}) {
  const cols = dims.length ? dims : SEVEN_KEYS.map((k) => ({ key: k, label: SEVEN_LABELS[k] || k, desc: '' }));
  const head = cols.map((d) => `<th title="${esc(d.desc || '')}">${esc(d.label || d.key)}</th>`).join('');

  const rows = (scenarios || []).map((s) => {
    const m = toDimMap(s.required_dims);
    const cells = cols.map((d) => {
      const cur = m[d.key] || '';
      const opts = [`<option value="">—</option>`]
        .concat(ON_MISSING.map((o) => `<option value="${o}" ${cur === o ? 'selected' : ''}>${o}</option>`))
        .join('');
      return `<td><select data-dim="${esc(d.key)}">${opts}</select></td>`;
    }).join('');
    const auto = s.autonomous_allowed ? '自主' : '人工';
    return `<tr data-id="${esc(s.scenario_id)}">
      <th scope="row">${esc(s.stage || s.scenario_id)} <span class="tier">${esc(s.default_tier || '')}</span> <span class="auto">${auto}</span></th>
      ${cells}
      <td><button class="btn save" data-id="${esc(s.scenario_id)}">保存</button></td>
    </tr>`;
  }).join('');

  const emptyHint = (scenarios || []).length ? '' : '<p class="empty">暂无决策场景</p>';
  const strictOpts = ON_MISSING
    .map((o) => `<option value="${o}" ${default_strictness === o ? 'selected' : ''}>${o}</option>`)
    .join('');

  return `<div class="sd7-global">
      <label>全局默认严格度</label>
      <select id="sd7-strict">${strictOpts}</select>
      <button class="btn" id="sd7-strict-save">保存</button>
    </div>
    ${emptyHint}
    <table id="sd7-matrix"><thead><tr><th>场景 / 阶段</th>${head}<th></th></tr></thead><tbody>${rows}</tbody></table>`;
}
```

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/portal/sevenDimRender.test.js
```

Expected: PASS（14 例）

- [ ] **Step 5: Commit**

```bash
git add src/portal/sevenDimRender.js test/portal/sevenDimRender.test.js
git commit -m "feat(seven-dim): 渲染改为场景×七维矩阵（三态 select + parity 守卫）"
```

---

## Task 4: 改 `src/web/seven-dim.html` 为矩阵页

**Files:**
- Modify: `src/web/seven-dim.html`（整段 `<script type="module">` 替换）

- [ ] **Step 1: 替换页面脚本**

将 `src/web/seven-dim.html` 中 `<script type="module">...</script>` 整段替换为：

```html
<script type="module">
import { renderSevenDimMatrix, toRequiredDims, validateRequiredDimsPatch } from '/portal/sevenDimRender.js';
import { injectLayout } from '/portal/layout.js';
injectLayout();
const TOKEN = localStorage.getItem('crm_token');
const app = document.getElementById('app');
if (!TOKEN) location.href = '/home.html';

const HDR = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

async function load() {
  try {
    const r = await fetch('/api/config/seven-dim', { headers: { Authorization: `Bearer ${TOKEN}` } });
    const j = await r.json();
    if (!r.ok) { app.innerHTML = `<p class="muted">加载失败：${j.error || r.status}</p>`; return; }
    app.innerHTML = renderSevenDimMatrix(j);
    bind();
  } catch (e) { app.innerHTML = `<p class="muted">${e.message}</p>`; }
}

function bind() {
  const strictSave = document.getElementById('sd7-strict-save');
  if (strictSave) {
    strictSave.onclick = async () => {
      const v = document.getElementById('sd7-strict').value;
      const r = await fetch('/api/config/seven-dim', {
        method: 'PUT', headers: HDR, body: JSON.stringify({ default_strictness: v }),
      });
      const j = await r.json();
      alert(r.ok ? '已保存全局默认严格度' : ('失败：' + (j.error || r.status)));
      load();
    };
  }
  for (const btn of document.querySelectorAll('#sd7-matrix button.save')) {
    btn.onclick = async () => {
      const tr = btn.closest('tr');
      const map = {};
      for (const sel of tr.querySelectorAll('select[data-dim]')) map[sel.dataset.dim] = sel.value;
      const required_dims = toRequiredDims(map);
      const v = validateRequiredDimsPatch(required_dims);
      if (!v.ok) { alert('校验失败：' + v.errors.join('; ')); return; }
      const r = await fetch('/api/config/seven-dim', {
        method: 'PUT', headers: HDR,
        body: JSON.stringify({ scenario_id: tr.dataset.id, required_dims: v.normalized }),
      });
      const j = await r.json();
      alert(r.ok ? `已保存（决策 ${String(j.decision || '').slice(0, 8)}…）` : ('失败：' + (j.error || r.status)));
      load();
    };
  }
}

load();
</script>
```

同时把页面副标题（第 13 行 `<p class="muted">`）改为：

```html
<p class="muted">决策场景上下文完整性校验 · 场景×七维矩阵（未要求 / warn / block）· 写经第0闸 + sysadmin</p>
```

- [ ] **Step 2: 语法自检**

```bash
node --check src/web/seven-dim.html 2>/dev/null || echo "HTML 非 JS，跳过 node --check；改用浏览器加载测试"
node node_modules/vitest/vitest.mjs run test/web/browserLoadable.test.js
```

Expected: `browserLoadable.test.js` PASS（若该测试覆盖 seven-dim.html，则需确认其 import 仍可解析）

- [ ] **Step 3: Commit**

```bash
git add src/web/seven-dim.html
git commit -m "feat(seven-dim): 七维配置页改为场景×七维矩阵"
```

---

## Task 5: 换挂载 + 删除 `sevenDimConfigCheck` + 同步测试

**Files:**
- Modify: `src/http/routes.js:33`（import）、`:95`（挂载）
- Modify: `src/sevenDimensions/engine.js`（删 `sevenDimConfigCheck`）
- Modify: `test/http/configRouter.test.js`（删 import + 3 条断言）

> 说明：删除 `sevenDimConfigCheck` 会让 `test/http/configRouter.test.js` 失效（import 不存在），必须同一 Task 内改完，否则中途测试红。

- [ ] **Step 1: 改 `routes.js`**

第 33 行：

```js
import { sevenDimConfigCheck } from '../sevenDimensions/engine.js';
```

改为：

```js
import { createSevenDimRouter } from './sevenDimRouter.js';
```

第 95 行：

```js
  app.use(createConfigRouter({ key: 'seven-dim', role: 'sysadmin', decisionScene: 'scene-quote' }));
```

改为：

```js
  app.use(createSevenDimRouter());
```

- [ ] **Step 2: 删除 `engine.js` 中的 `sevenDimConfigCheck`**

删除 `src/sevenDimensions/engine.js` 第 39-56 行整段（注释块 + `export async function sevenDimConfigCheck`），并删除第 8 行 import 中的 `DIM_KEYS`（保留 `SEVEN_DIMS` 若仍在用；检查后仅保留实际使用的）：

```js
import { SEVEN_DIMS, DIM_KEYS } from './constants.js';
```

若 `SEVEN_DIMS` 在文件中未被使用，改为：

```js
import { DIM_KEYS } from './constants.js';
```

> 实际操作：先 grep 确认 `SEVEN_DIMS` / `DIM_KEYS` 在 `engine.js` 中的使用点，只保留被使用的那个。

- [ ] **Step 3: 同步 `test/http/configRouter.test.js`**

删除第 6 行：

```js
import { sevenDimConfigCheck } from '../../src/sevenDimensions/engine.js';
```

删除文件末尾整个 `describe('seven-dim 端点 · scene-quote 完整性拦截（sevenDimConfigCheck 注入）', ...)` 块（约 135-174 行）。

- [ ] **Step 4: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/http/configRouter.test.js test/http/sevenDimRouter.test.js test/portal/sevenDimRender.test.js test/web/decisionScenario.test.js
```

Expected: PASS（12 + 9 + 14 + 原 decisionScenario 用例）

- [ ] **Step 5: Commit**

```bash
git add src/http/routes.js src/sevenDimensions/engine.js test/http/configRouter.test.js
git commit -m "refactor(seven-dim): 端点换为矩阵路由，移除旧 0-5 sevenDimConfigCheck"
```

---

## Task 6: 同步 `src/pages/S20.schema.js`

**Files:**
- Modify: `src/pages/S20.schema.js:16-41`

- [ ] **Step 1: 改 schema**

把 7 个 `attrType: 'boolean'` 的维度字段改为三态 select（与已有 `strictness` 的 select 写法一致，`validator.js` 仅校验 `attrType` 在 19 类型集内，不校验 options）：

```js
    { kind: 'attr-field', attrSlug: 'identity', attrType: 'select', label: '身份维', attr: { slug: 'identity', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'structure', attrType: 'select', label: '结构维', attr: { slug: 'structure', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'semantics', attrType: 'select', label: '语义维', attr: { slug: 'semantics', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'time_config', attrType: 'select', label: '时间与配置维', attr: { slug: 'time_config', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'decision_history', attrType: 'select', label: '决策历史维', attr: { slug: 'decision_history', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'operational_state', attrType: 'select', label: '运行状态维', attr: { slug: 'operational_state', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'governance', attrType: 'select', label: '治理维', attr: { slug: 'governance', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'strictness', attrType: 'select', label: '严格度(未要求/warn/block)', attr: { slug: 'strictness', data_origin: 'manual', options: ['', 'warn', 'block'] } },
```

并更新文件头注释第 3-4 行，说明落点为 `decision_scenario.required_dims`：

```js
// 端点：createSevenDimRouter（routes.js 挂 /api/config/seven-dim；sysadmin 闸 + 写经第0闸）
//       GET → {dims, scenarios, default_strictness}；PUT → {scenario_id, required_dims} | {default_strictness}
//       落点：按场景写 decision_scenario.required_dims(JSONB [{dim,on_missing}])；
//       全局默认严格度落 config_store['seven-dim'].default_strictness
```

- [ ] **Step 2: 运行确认 schema 合法**

```bash
node --input-type=module -e "import('./src/pages/S20.schema.js').then(()=>console.log('S20 schema OK')).catch(e=>{console.error(e.message);process.exit(1)})"
```

Expected: `S20 schema OK`

- [ ] **Step 3: Commit**

```bash
git add src/pages/S20.schema.js
git commit -m "docs(seven-dim): S20 schema 同步为三态矩阵形态"
```

---

## Task 7: 幂等预置脚本

**Files:**
- Create: `scripts/seed-seven-dim.mjs`

- [ ] **Step 1: 写脚本**

新建 `scripts/seed-seven-dim.mjs`：

```js
// scripts/seed-seven-dim.mjs — S20 七维矩阵预置（幂等）
// 仅对 required_dims 为空的场景写入；已配置的场景跳过，绝不覆盖管理员调整。
// 全部 on_missing='warn'：打 missing_context 标记、禁 AI 脑补，但不拒写。
// 用法：node scripts/seed-seven-dim.mjs
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'plm',
  options: '-c search_path=crm,public',
});

const ALL7 = ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'];

const PRESET = {
  LEAD_FOLLOW_UP: ['identity', 'structure'],
  OPP_QUALIFY: ['identity', 'structure', 'semantics', 'governance'],
  SOLUTION_VALUE: ['identity', 'structure', 'semantics', 'decision_history', 'operational_state', 'governance'],
  QUOTE_PRICING: ALL7,
  SIGN_RISK: ALL7,
  POST_CONTRACT: ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'governance'],
  LOSS_REVIEW: ['identity', 'structure', 'semantics', 'decision_history', 'governance'],
  ATTR_SCHEMA_CHANGE: ['identity', 'structure', 'governance'],
  SC_DEMO_DISCOUNT: ['identity', 'structure', 'governance'],
  SC_DEMO_TERMS: ['identity', 'structure', 'governance'],
};
const FALLBACK = ['identity', 'structure', 'governance'];

const rows = (await pool.query(`SELECT scenario_id, required_dims FROM crm.decision_scenario`)).rows;
let seeded = 0;
let skipped = 0;

for (const r of rows) {
  const already = Array.isArray(r.required_dims) && r.required_dims.length > 0;
  if (already) { console.log(`skip   ${r.scenario_id}（已配置 ${r.required_dims.length} 维）`); skipped++; continue; }
  const dims = PRESET[r.scenario_id] || FALLBACK;
  const val = JSON.stringify(dims.map((d) => ({ dim: d, on_missing: 'warn' })));
  await pool.query(`UPDATE crm.decision_scenario SET required_dims=$2::jsonb WHERE scenario_id=$1`, [r.scenario_id, val]);
  console.log(`seed   ${r.scenario_id} → ${dims.length} 维（warn）`);
  seeded++;
}

// 全局默认严格度：覆盖旧的 0–5 形状（无消费方、非蓝图契约），改为 default_strictness
await pool.query(
  `INSERT INTO crm.config_store (key, value, updated_by)
   VALUES ('seven-dim', '{"default_strictness":"warn"}'::jsonb, 'system')
   ON CONFLICT (key) DO UPDATE SET value='{"default_strictness":"warn"}'::jsonb, updated_at=now()`
);
console.log(`\n完成：seeded=${seeded} skipped=${skipped}；default_strictness=warn`);

await pool.end();
```

- [ ] **Step 2: 运行脚本**

```bash
node scripts/seed-seven-dim.mjs
```

Expected 输出（当前库 10 个场景全空）：

```
seed   LEAD_FOLLOW_UP → 2 维（warn）
seed   OPP_QUALIFY → 4 维（warn）
seed   SOLUTION_VALUE → 6 维（warn）
seed   QUOTE_PRICING → 7 维（warn）
seed   SIGN_RISK → 7 维（warn）
seed   POST_CONTRACT → 6 维（warn）
seed   LOSS_REVIEW → 5 维（warn）
seed   ATTR_SCHEMA_CHANGE → 3 维（warn）
seed   SC_DEMO_DISCOUNT → 3 维（warn）
seed   SC_DEMO_TERMS → 3 维（warn）

完成：seeded=10 skipped=0；default_strictness=warn
```

- [ ] **Step 3: 验证幂等（重跑应全 skip）**

```bash
node scripts/seed-seven-dim.mjs
```

Expected: `完成：seeded=0 skipped=10`

- [ ] **Step 4: Commit**

```bash
git add scripts/seed-seven-dim.mjs
git commit -m "feat(seven-dim): 幂等预置脚本（按阶段语义设 required_dims，全 warn）"
```

---

## Task 8: 引擎行为验证 + 全量回归

**Files:**
- Create: `test/sevenDimensions/engine.preset.test.js`

- [ ] **Step 1: 写引擎行为测试**

新建 `test/sevenDimensions/engine.preset.test.js`：

```js
// test/sevenDimensions/engine.preset.test.js — 七维闸门启用后的行为（warn 不阻断 / block 阻断）
import { describe, it, expect } from 'vitest';
import { sevenDimensionsCheck } from '../../src/sevenDimensions/engine.js';

const PRESET_QUOTE = ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'];

function fakeQuery(requiredDims) {
  return async () => ({ rows: [{ required_dims: requiredDims }] });
}
const qAllWarn = fakeQuery(PRESET_QUOTE.map((d) => ({ dim: d, on_missing: 'warn' })));
const qOneBlock = fakeQuery([
  { dim: 'identity', on_missing: 'block' },
  { dim: 'structure', on_missing: 'warn' },
]);

describe('sevenDimensionsCheck 启用后行为', () => {
  it('全 warn + 空上下文 → allowed=true 但 level=warn（不阻断）', async () => {
    const r = await sevenDimensionsCheck('QUOTE_PRICING', {}, { query: qAllWarn });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('warn');
    expect(r.missing).toHaveLength(7);
  });

  it('全 warn + 上下文齐全 → level=ok', async () => {
    const ctx = {
      identity: 'acct-1', structure: ['DEAL'], semantics: 'won=签约',
      time_config: '2026Q3', decision_history: ['dec-1'], operational_state: '交付中', governance: 'manager',
    };
    const r = await sevenDimensionsCheck('QUOTE_PRICING', ctx, { query: qAllWarn });
    expect(r.level).toBe('ok');
    expect(r.missing).toHaveLength(0);
  });

  it('含 block 维且缺失 → allowed=false（拒写）', async () => {
    const r = await sevenDimensionsCheck('QUOTE_PRICING', {}, { query: qOneBlock });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe('block');
  });

  it('含 block 维但已提供 → 放行', async () => {
    const r = await sevenDimensionsCheck('QUOTE_PRICING', { identity: 'acct-1' }, { query: qOneBlock });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('warn'); // structure 仍缺（warn）
  });

  it('required_dims 为空 → 不阻断（改造前既有行为）', async () => {
    const r = await sevenDimensionsCheck('ANY', {}, { query: fakeQuery([]) });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('ok');
  });

  it('查询异常（列不存在/场景不存在）→ 降级不阻断', async () => {
    const r = await sevenDimensionsCheck('ANY', {}, { query: async () => { throw new Error('no column'); } });
    expect(r.allowed).toBe(true);
  });
});
```

- [ ] **Step 2: 运行确认通过**

```bash
node node_modules/vitest/vitest.mjs run test/sevenDimensions/engine.preset.test.js
```

Expected: PASS（6 例）

- [ ] **Step 3: 全量回归**

```bash
node node_modules/vitest/vitest.mjs run
```

Expected: 与基线持平（基线：1048 passed / 5 failed / 2 skipped；5 个已知失败为 `interaction-index`、`migrateConfig`、`readableConfig`×3，均非本次引入）。若新增失败，逐一判定是否本次引入。

- [ ] **Step 4: 重启 server 并端到端验证**

`routes.js` 启动时加载，**必须重启**才生效。

```bash
node src/http/server.js   # 后台重启
```

```bash
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin123"}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch(e){console.log('')}})")

# GET：应返回 7 维 + 10 场景 + default_strictness=warn
curl -s http://127.0.0.1:3000/api/config/seven-dim -H "Authorization: Bearer $TOKEN" | head -c 400

# PUT：把 QUOTE_PRICING 的 identity 升为 block
curl -s -X PUT http://127.0.0.1:3000/api/config/seven-dim -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"scenario_id":"QUOTE_PRICING","required_dims":[{"dim":"identity","on_missing":"block"}]}'

# 非 admin（alice/secret123）→ 403
```

Expected：GET 200 且含 `"default_strictness":"warn"` 与 7 个 dim；PUT 200 且返回 decision；alice 403。

浏览器验证：`http://localhost:3000/seven-dim.html`（admin 登录）应显示 7 行 × 7 列矩阵，可逐格切换并保存。

- [ ] **Step 5: Commit**

```bash
git add test/sevenDimensions/engine.preset.test.js
git commit -m "test(seven-dim): 引擎启用后行为验证（warn 不阻断 / block 阻断）"
```

---

## 自审记录（Self-Review）

**1. Spec 覆盖检查**

| 设计文档章节 | 对应 Task |
|---|---|
| §2 数据模型（required_dims / config_store） | Task 1、2、7 |
| §3 端点契约（GET/PUT、400/404/403、第0闸） | Task 2 |
| §4 页面（矩阵 + 全局 select + 空态可操作 + 渲染约束） | Task 3、4 |
| §5 预置矩阵（显式 7×7，全 warn，幂等） | Task 7 |
| §6 迁移与清理（删 sevenDimConfigCheck、换挂载、改测试、S20 schema） | Task 5、6 |
| §7 测试（parity / 端点 / 引擎 / 回归） | Task 1、2、3、8 |
| §8 验收 | Task 8 Step 4 |

无遗漏。

**2. 占位符扫描**：无 TBD / TODO / "similar to Task N"；每个改代码的 Step 均含完整代码块。

**3. 类型一致性**
- `validateRequiredDimsPatch`（前端）与 `validateScenarioPatch`（后端）返回同构 `{ok, errors, normalized}`，`normalized` 均为 `[{dim, on_missing}]`。
- `ON_MISSING` 在 `decisionScenario.js`（后端）与 `sevenDimRender.js`（前端）各定义一份且值相同（`['warn','block']`）——前端因浏览器约束无法 import 后端，两处一致性由 Task 1（`expect(ON_MISSING).toEqual(['warn','block'])`）与 Task 3 的 parity 断言分别守卫。
- `toDimMap` / `toRequiredDims` / `validateRequiredDimsPatch` / `renderSevenDimMatrix` 命名在 Task 3 定义、Task 4 使用，一致。
- `createSevenDimRouter` 在 Task 2 定义、Task 5 挂载，一致；`scenarioDeps` 在 Task 1 导出、Task 2 使用，一致。

**4. 已知约束**
- 沙箱无 git 凭证且 `.git` 曾异常，commit 步骤需**用户在本地执行**；提交前 `git status` 确认范围，勿 `git add -A`。
- `routes.js` 改动需重启 server 生效。
