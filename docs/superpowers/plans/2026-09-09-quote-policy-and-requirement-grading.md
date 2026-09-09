# 报价政策断链接入 + 需求分级与书面确认 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把租户报价政策（毛利红线/报价基线/折扣权限）接入对话决策建议链路，并让需求 MUST/SHOULD/NICE 分级与书面确认态进入条件体检与闸门；红线命中只提示+预填审批发起参数，绝不自动写。

**Architecture:** 抽出后端纯函数层 `offerPolicyMath.js`（毛利计算，与门户 `offerPolicyRender.marginView` 同口径，避免后端引入浏览器 UI 模块）+ `offerPolicyFacts.js`（政策解析、折扣授权判定、审批预填、请求折扣解析）。`gatherQuoteFacts` 在 `scenarioAdvisors.js` 中扩展为可选消费租户政策与授权矩阵；`adviseService.advise` 负责异步解析政策/矩阵/角色并透传；`buildAdviceCard` 在 B 档生成 `approval_prefill`。需求分级复用 `CRM_METHODOLOGY_EVIDENCE`（`methodology_id='REQUIREMENT'`），由 `adviseService` 把 MUST 维度注入 `eval_dimensions` 实现 C 档降级。

**Tech Stack:** Node.js ESM + PostgreSQL（pg，schema `crm`）+ Vitest。契约键见 `src/agent/contractIds.js`。

---

## 文件结构（创建/修改清单）

**新建**
- `src/decision/offerPolicyMath.js` — 后端毛利计算纯函数（`resolvePriceBands`/`costTotal`/`marginView`），与门户口径一致，不依赖任何 UI 模块。
- `src/decision/offerPolicyFacts.js` — `resolveOfferPolicy`(DB)、`discountAuthorityCheck`(纯)、`buildApprovalPrefill`(纯)、`resolveRequestedDiscount`(纯)。
- `src/decision/requirementConditions.js` — `buildRequirementConditions`(DB)、`collectRequirementEvidence`(DB)。
- `src/decision/decisionRetro.js` — `buildRequirementRetro`(纯)、`runDailyRetro`(DB)。
- `scripts/seed-quote-policy-config.mjs` — 向 `config_store` 写入 `price-authority` 与 `requirement-dimensions`（system 模板，租户读时自动克隆）。
- `test/decision/offerPolicyFacts.test.js`、`test/decision/requirementConditions.test.js`、`test/decision/decisionRetro.test.js`、`test/decision/adviceCard-approval.test.js`、`test/decision/adviseService-quote.test.js`。

**修改**
- `src/decision/scenarioAdvisors.js` — `gatherQuoteFacts` 扩展（消费 `offerPolicy`/`discountMatrix`/`requestedDiscountPct`/`ctx.role`），保持向后兼容。
- `src/decision/adviseService.js` — 解析政策/矩阵/角色/请求折扣 → 透传；MUST 需求注入；红线命中时由 `buildAdviceCard` 产 `approval_prefill`；deal 存在时始终并算报价红线（覆盖 review/sign 场景，T8）。
- `src/decision/adviceCard.js` — B 档附加 `approval_prefill`。
- `src/decision/policyVersion.js` — `POLICY_KEYS` 增加 `'price-authority'`（决策 D5 已批准，后果：增键后所有后续决策解析出新策略版本）。
- `src/decision/methodologyEvidence.js` — 新增 `assertRequirementEvidence` 薄封装（methodology_id 固定 `'REQUIREMENT'`）。

---

### Task 1: 折扣授权矩阵判定（纯函数）— `discountAuthorityCheck`

**契约**: `ct-quote-calc` · agent `quote-engine`

**Files:**
- Create: `src/decision/offerPolicyFacts.js`
- Create: `test/decision/offerPolicyFacts.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/decision/offerPolicyFacts.test.js
import { describe, it, expect } from 'vitest';
import { discountAuthorityCheck } from '../../src/decision/offerPolicyFacts.js';

const MATRIX = {
  default_max_discount_pct: 10,
  roles: {
    sales: { max_discount_pct: 10 },
    presales: { max_discount_pct: 15 },
    manager: { max_discount_pct: 30 },
    director: { max_discount_pct: 100 },
  },
};

describe('discountAuthorityCheck', () => {
  it('sales 申请 8 折(20% off) 超权限 → exceeded', () => {
    const r = discountAuthorityCheck('sales', 20, MATRIX);
    expect(r.evaluated).toBe(true);
    expect(r.exceeded).toBe(true);
    expect(r.roleCap).toBe(10);
    expect(r.gapPct).toBe(10);
  });
  it('manager 申请 30% 在权限内 → 不超', () => {
    const r = discountAuthorityCheck('manager', 30, MATRIX);
    expect(r.exceeded).toBe(false);
  });
  it('无角色 → 走 default 上限', () => {
    const r = discountAuthorityCheck(null, 12, MATRIX);
    expect(r.role).toBeNull();
    expect(r.roleCap).toBe(10);
    expect(r.exceeded).toBe(true);
  });
  it('矩阵或折扣缺失 → fail-open 不阻断', () => {
    expect(discountAuthorityCheck('sales', null, MATRIX).evaluated).toBe(false);
    expect(discountAuthorityCheck('sales', 20, null).evaluated).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/offerPolicyFacts.test.js`
Expected: FAIL（`Cannot find module '../../src/decision/offerPolicyFacts.js'`）

- [ ] **Step 3: 最小实现**

```js
// src/decision/offerPolicyFacts.js
// 报价事实/授权/审批预填的纯函数与 DB 解析层（后端，零 UI 依赖）
import { queryParticles } from '../particles/particleRepo.js';
import { readConfig } from '../config/configStore.js';
import { actorRole } from '../context/scope.js';
import { marginView } from './offerPolicyMath.js';

// —— 折扣授权矩阵判定（纯）——
// matrix: { default_max_discount_pct:number, roles: { [role]: { max_discount_pct:number } } }
export function discountAuthorityCheck(role, requestedDiscountPct, matrix) {
  if (!matrix || requestedDiscountPct == null || Number.isNaN(Number(requestedDiscountPct))) {
    return { evaluated: false, exceeded: false, reason: 'matrix 或 requestedDiscountPct 缺失 → fail-open 不阻断' };
  }
  const pct = Number(requestedDiscountPct);
  const roles = matrix.roles || {};
  const cap = (role && roles[role] && Number.isFinite(Number(roles[role].max_discount_pct)))
    ? Number(roles[role].max_discount_pct)
    : Number(matrix.default_max_discount_pct ?? 0);
  const exceeded = pct > cap;
  return {
    evaluated: true,
    exceeded,
    role: role || null,
    requestedDiscountPct: pct,
    roleCap: cap,
    gapPct: exceeded ? Number((pct - cap).toFixed(2)) : 0,
    reason: exceeded
      ? `折扣 ${pct}% 超出 ${role || '默认'} 权限上限 ${cap}%`
      : `折扣 ${pct}% 在 ${role || '默认'} 权限上限 ${cap}% 内`,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- test/decision/offerPolicyFacts.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/decision/offerPolicyFacts.js test/decision/offerPolicyFacts.test.js
git commit -m "feat(quote): add discountAuthorityCheck pure fn (ct-quote-calc)"
```

---

### Task 2: 后端毛利计算纯函数 `offerPolicyMath` + 租户政策解析

**契约**: `ct-quote-calc` · agent `quote-engine`

**Files:**
- Create: `src/decision/offerPolicyMath.js`
- Modify: `src/decision/offerPolicyFacts.js`（补 `resolveOfferPolicy`/`buildApprovalPrefill`/`resolveRequestedDiscount`）
- Modify: `test/decision/offerPolicyFacts.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/decision/offerPolicyFacts.test.js` 追加：

```js
import { resolveOfferPolicy, buildApprovalPrefill, resolveRequestedDiscount } from '../../src/decision/offerPolicyFacts.js';
import { marginView } from '../../src/decision/offerPolicyMath.js';

describe('offerPolicyMath.marginView parity', () => {
  it('与门户口径一致：成本 80000 报价 100000 → marginRate 0.2', () => {
    const policy = { payload: { cost_structure: '[{"cost":80000}]', price_bands: '{"floor":85000}', margin_redline: 0.2 } };
    const mv = marginView(policy, 100000);
    expect(mv.cost).toBe(80000);
    expect(mv.marginRate).toBeCloseTo(0.2, 5);
    expect(mv.floor).toBe(85000);
    expect(mv.redline).toBe(0.2);
  });
});

describe('resolveRequestedDiscount', () => {
  it('直接取 discount_pct', () => {
    expect(resolveRequestedDiscount({ payload: { discount_pct: 20 } })).toBe(20);
  });
  it('由 list_price/amount 反算', () => {
    expect(resolveRequestedDiscount({ payload: { list_price: 100000, amount: 80000 } })).toBe(20);
  });
  it('两者皆无 → null（只提示需审批，不判具体角色）', () => {
    expect(resolveRequestedDiscount({ payload: {} })).toBeNull();
  });
});

describe('buildApprovalPrefill', () => {
  it('B 档预填 crm-approval-start 参数，不自动写', () => {
    const p = buildApprovalPrefill({
      scenario_id: 'QUOTE_PRICING', deal_id: 'deal-1',
      redlines: [{ label: '毛利红线', detail: '毛利 12% < 20%' }],
    });
    expect(p.flow_id).toBe('CRM_APPROVAL_FLOW');
    expect(p.business_type).toBe('QUOTE_PRICING');
    expect(p.business_id).toBe('deal-1');
    expect(p.action).toBe('crm-approval-start');
    expect(p.note).toContain('不自动发起');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/offerPolicyFacts.test.js`
Expected: FAIL（`Cannot find module '../../src/decision/offerPolicyMath.js'`）

- [ ] **Step 3: 实现 `offerPolicyMath.js` 与 `offerPolicyFacts.js` 其余函数**

```js
// src/decision/offerPolicyMath.js
// 后端毛利计算纯函数。与门户 src/portal/offerPolicyRender.js 的 marginView 保持同口径，
// 但本模块零 UI 依赖（门户模块 import 了浏览器全局 sessionStorage，禁止在后端引入）。
// 若门户口径变更，须同步本文件（单一事实源约束见设计文档 §4 风险登记）。

export function resolvePriceBands(policy) {
  const raw = policy?.payload?.price_bands;
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!/^[{[]/.test(s)) return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function costTotal(policy) {
  const raw = policy?.payload?.cost_structure;
  let items = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    try { items = JSON.parse(s); } catch { return null; }
  }
  if (!Array.isArray(items)) return null;
  return items.reduce((sum, it) => sum + (Number(it?.cost) || 0), 0);
}

// marginView(policy, dealPrice) → { cost, margin, marginRate, floor, redline, pass }
// 注意：redline 直接采用 payload.margin_redline（门户同口径：0.2 表示 20%）。
export function marginView(policy, dealPrice) {
  const bands = resolvePriceBands(policy);
  const cost = costTotal(policy);
  const price = Number(dealPrice);
  if (!isFinite(price) || cost == null) return null;
  const margin = price - cost;
  const marginRate = price > 0 ? margin / price : 0;
  const redline = Number(policy?.payload?.margin_redline);
  const pass = isFinite(redline) ? marginRate >= redline : true;
  return {
    cost, margin, marginRate,
    floor: bands?.floor ?? null,
    redline: isFinite(redline) ? redline : null,
    pass,
  };
}
```

在 `src/decision/offerPolicyFacts.js` 顶部已 import `marginView` from `./offerPolicyMath.js`，并补：

```js
// 解析租户当前生效的报价政策（优先级：deal 关联 > subtype=standard active > 其余 active）
// fail-open：任何异常返回 null（决策侧退回 advisorConfig 出厂下限，不阻断）
export async function resolveOfferPolicy(tenantId = 'system', { dealId = null } = {}) {
  try {
    const items = await queryParticles({
      type: 'CRM_OFFER_POLICY', tenantId, excludeStates: ['expired'], limit: 50,
    });
    if (!items.length) return null;
    const active = items.filter((p) => p.state === 'active');
    const pool = active.length ? active : items;
    if (dealId) {
      const linked = pool.find((p) => String(p.payload?.deal_id) === String(dealId));
      if (linked) return linked;
    }
    const standard = pool.find((p) => p.payload?.subtype === 'standard');
    return standard || pool[0];
  } catch {
    return null;
  }
}

// 红线命中 → 预填 crm-approval-start 参数（系统不自动写，由销售/客户端显式发起）
export function buildApprovalPrefill({ scenario_id, deal_id, redlines = [] } = {}) {
  const reasons = Array.isArray(redlines)
    ? redlines.map((r) => `${r.label}：${r.detail}`).join('；')
    : '';
  return {
    flow_id: 'CRM_APPROVAL_FLOW',
    business_type: scenario_id || 'QUOTE_PRICING',
    business_id: deal_id || null,
    approvers: [], // 留空 → 由审批引擎按流配置解析；显式指定须覆盖全节点（engine 侧 fail-closed）
    reason: reasons || '触碰业务红线，须走审批流',
    note: '系统不自动发起审批。请销售或客户端显式调用 crm-approval-start（携带 HITL confirmation token），生成 decision_id 后方可继续报价写操作。',
    action: 'crm-approval-start',
  };
}

// 从 deal 解析请求折扣百分比（优先 discount_pct，其次 list_price/amount 反算）
export function resolveRequestedDiscount(deal) {
  const p = deal?.payload || {};
  if (p.discount_pct != null && p.discount_pct !== '') return Number(p.discount_pct);
  if (Number(p.list_price) > 0 && Number(p.amount) > 0) {
    return Number((((Number(p.list_price) - Number(p.amount)) / Number(p.list_price)) * 100).toFixed(2));
  }
  return null;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- test/decision/offerPolicyFacts.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/decision/offerPolicyMath.js src/decision/offerPolicyFacts.js test/decision/offerPolicyFacts.test.js
git commit -m "feat(quote): add offerPolicyMath + resolveOfferPolicy/buildApprovalPrefill (ct-quote-calc)"
```

---

### Task 3: `gatherQuoteFacts` 接入租户政策与授权矩阵

**契约**: `ct-quote-calc` · agent `quote-engine`

**Files:**
- Modify: `src/decision/scenarioAdvisors.js`
- Modify: `test/decision/advisor-quote.test.js`

- [ ] **Step 1: 写失败测试**

在 `test/decision/advisor-quote.test.js` 追加：

```js
import { discountAuthorityCheck } from '../../src/decision/offerPolicyFacts.js';

describe('gatherQuoteFacts 接租户政策', () => {
  const policy = { payload: { cost_structure: '[{"cost":80000}]', price_bands: '{"floor":85000}', margin_redline: 0.2 } };
  it('租户红线 20% 生效：报价 10 万毛利 20% 达标 → 无红线', () => {
    const r = gatherQuoteFacts(
      { payload: { amount: 100000, cost: 80000 } },
      { advisorConfig: { margin_floor_pct: 20 }, offerPolicy: policy },
    );
    expect(r.redlines).toEqual([]);
    expect(r.facts.margin_source).toBe('policy');
  });
  it('低于租户红线 → margin_redline 红线含差距数值', () => {
    const r = gatherQuoteFacts(
      { payload: { amount: 100000, cost: 90000 } }, // 毛利 10% < 20%
      { advisorConfig: { margin_floor_pct: 20 }, offerPolicy: policy },
    );
    expect(r.redlines[0].cond).toBe('margin_redline');
    expect(r.redlines[0].detail).toContain('差');
  });
  it('折扣超权限 → discount_authority_exceeded 红线', () => {
    const matrix = { default_max_discount_pct: 10, roles: { sales: { max_discount_pct: 10 } } };
    const r = gatherQuoteFacts(
      { payload: { amount: 100000, discount_pct: 20 } },
      { advisorConfig: { margin_floor_pct: 20 }, ctx: { role: 'sales' }, discountMatrix: matrix, requestedDiscountPct: 20 },
    );
    expect(r.redlines[0].cond).toBe('discount_authority_exceeded');
    expect(r.redlines[0].gap_pct).toBe(10);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/advisor-quote.test.js`
Expected: FAIL（新断言不过；旧断言仍过）

- [ ] **Step 3: 修改 `scenarioAdvisors.js`**

在文件顶部 import 区增加：

```js
import { marginView } from './offerPolicyMath.js';
import { discountAuthorityCheck } from './offerPolicyFacts.js';
```

将 `gatherQuoteFacts` 整体替换为：

```js
export function gatherQuoteFacts(deal, {
  advisorConfig = DEFAULT_ADVISOR_CONFIG,
  ctx = {},
  offerPolicy = null,
  discountMatrix = null,
  requestedDiscountPct = null,
} = {}) {
  const cfg = { ...DEFAULT_ADVISOR_CONFIG, ...(advisorConfig || {}) };
  const amount = Number(deal?.payload?.amount) || 0;
  const hasCost = deal?.payload?.cost !== undefined && deal?.payload?.cost !== null;
  const cost = hasCost ? Number(deal.payload.cost) : amount * cfg.cost_estimate_ratio;
  const marginPct = amount > 0 ? ((amount - cost) / amount) * 100 : 0;
  const redlines = [];
  let marginSource = hasCost ? 'actual' : 'estimated';
  let floor = null;
  let redlinePct = null;

  if (offerPolicy) {
    const mv = marginView(offerPolicy, amount);
    if (mv) {
      floor = mv.floor;
      redlinePct = mv.redline;
      marginSource = 'policy';
      if (mv.pass === false) {
        const gap = Number(((Number(mv.redline) - mv.marginRate) * 100).toFixed(2));
        redlines.push({
          cond: 'margin_redline', label: '毛利红线',
          detail: `毛利率 ${Number((mv.marginRate * 100).toFixed(1))}% < 租户红线 ${Number((mv.redline * 100).toFixed(1))}%（差 ${gap} 个百分点）`,
        });
      }
    }
  } else if (marginPct < Number(cfg.margin_floor_pct)) {
    // 无政策时退回出厂下限（向后兼容既有测试）
    redlines.push({
      cond: 'margin_redline', label: '毛利红线',
      detail: `毛利率 ${marginPct.toFixed(1)}% < 下限 ${cfg.margin_floor_pct}%`,
    });
  }

  // 折扣权限红线（角色缺失 → 仅按 default 上限提示需审批，D6 降级）
  const role = ctx?.role || null;
  if (requestedDiscountPct != null && discountMatrix) {
    const d = discountAuthorityCheck(role, requestedDiscountPct, discountMatrix);
    if (d.evaluated && d.exceeded) {
      redlines.push({
        cond: 'discount_authority_exceeded', label: '折扣超权限',
        detail: d.reason,
        gap_pct: d.gapPct, role: d.role, role_cap: d.roleCap, requested: d.requestedDiscountPct,
      });
    }
  }

  return {
    facts: {
      price_vs_floor: amount > 0 ? `报价 ${amount}，成本 ${cost.toFixed(0)}，毛利率 ${marginPct.toFixed(1)}%` : null,
      margin_pct: Number(marginPct.toFixed(2)),
      margin_source: marginSource,
      price_floor: floor,
      margin_redline: redlinePct,
    },
    redlines,
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- test/decision/advisor-quote.test.js`
Expected: PASS（旧 3 例 + 新 3 例）

- [ ] **Step 5: 提交**

```bash
git add src/decision/scenarioAdvisors.js test/decision/advisor-quote.test.js
git commit -m "feat(quote): gatherQuoteFacts consumes tenant offer policy + discount matrix"
```

---

### Task 4: 政策来源优先级与配置化接线（`price-authority` 入 `POLICY_KEYS` + seed）

**契约**: `ct-retro-decision` · agent `decision-retro`

**Files:**
- Modify: `src/decision/policyVersion.js`
- Create: `scripts/seed-quote-policy-config.mjs`
- Test: `test/decision/quote-policy-config.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/decision/quote-policy-config.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeConfig, readConfig } from '../../src/config/configStore.js';

const T = 'plan-t4-' + Date.now();
const PRICE_AUTH = { default_max_discount_pct: 10, roles: { sales: { max_discount_pct: 10 }, manager: { max_discount_pct: 30 } } };
const REQ_DIMS = { levels: ['MUST','SHOULD','NICE'], dimensions: [
  { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
  { dim_key: 'REQ_DISCOUNT_AUTHORITY', label: '折扣权限确认', level: 'MUST' },
  { dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' },
] };

describe('quote policy config seeding', () => {
  beforeAll(async () => {
    await writeConfig('price-authority', PRICE_AUTH, { tenantId: 'system' });
    await writeConfig('requirement-dimensions', REQ_DIMS, { tenantId: 'system' });
  });
  afterAll(async () => {
    await writeConfig('price-authority', PRICE_AUTH, { tenantId: T });
  });
  it('system 模板写入后，租户读时 autoSeed 落到本租户', async () => {
    const r = await readConfig('price-authority', { tenantId: T });
    expect(r?.value?.default_max_discount_pct).toBe(10);
  });
  it('requirement-dimensions 含 MUST 维度', async () => {
    const r = await readConfig('requirement-dimensions', { tenantId: 'system' });
    const must = (r?.value?.dimensions || []).filter((d) => d.level === 'MUST');
    expect(must.length).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/quote-policy-config.test.js`
Expected: PASS（writeConfig/readConfig 已存在）→ 此测试验证 seed 数据形态，先行建立基线。

- [ ] **Step 3: `price-authority` 纳入 `POLICY_KEYS`**

在 `src/decision/policyVersion.js` 的 `POLICY_KEYS` 数组增加 `'price-authority'`，并补注释：

```js
export const POLICY_KEYS = [
  'autonomy-conf', 'sales-thresholds', 'hindsight-deviation',
  'context-guard', 'context-routing', 'event-retro', 'agent-event-trigger',
  'price-authority', // 2026-09-09 新增：折扣授权矩阵是决策依据须可追溯；增键后所有后续决策解析出新版本（policyVersion.js:27 明示的预期行为，已获用户批准）
];
```

- [ ] **Step 4: 创建 seed 脚本**

```js
// scripts/seed-quote-policy-config.mjs
// 向 config_store 写入报价政策相关配置（system 模板；租户读时由 configStore.autoSeed 克隆）。
import { writeConfig } from '../src/config/configStore.js';

const PRICE_AUTHORITY = {
  default_max_discount_pct: 10,
  roles: {
    sales: { max_discount_pct: 10 },
    presales: { max_discount_pct: 15 },
    manager: { max_discount_pct: 30 },
    director: { max_discount_pct: 100 },
  },
};

const REQUIREMENT_DIMENSIONS = {
  levels: ['MUST', 'SHOULD', 'NICE'],
  dimensions: [
    { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
    { dim_key: 'REQ_DISCOUNT_AUTHORITY', label: '折扣权限确认', level: 'MUST' },
    { dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' },
    { dim_key: 'REQ_BUDGET', label: '预算落实', level: 'SHOULD' },
    { dim_key: 'REQ_TIMELINE', label: '交付时间表', level: 'SHOULD' },
    { dim_key: 'REQ_TRIAL', label: '试用安排', level: 'NICE' },
  ],
};

async function main() {
  await writeConfig('price-authority', PRICE_AUTHORITY, { tenantId: 'system' });
  await writeConfig('requirement-dimensions', REQUIREMENT_DIMENSIONS, { tenantId: 'system' });
  console.log('seeded price-authority + requirement-dimensions');
}

main().catch((e) => { console.error(e); process.exit(1); });
```

Run: `node scripts/seed-quote-policy-config.mjs`
Expected: 输出 `seeded price-authority + requirement-dimensions`

- [ ] **Step 5: 运行测试确认通过**

Run: `npm run test -- test/decision/quote-policy-config.test.js`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add src/decision/policyVersion.js scripts/seed-quote-policy-config.mjs test/decision/quote-policy-config.test.js
git commit -m "feat(quote): add price-authority to POLICY_KEYS + seed config (ct-retro-decision)"
```

---

### Task 5: 需求维度清单配置化与采集入口

**契约**: `ct-intake-route` · agent `intake-router`

**Files:**
- Modify: `src/decision/methodologyEvidence.js`（新增 `assertRequirementEvidence`）
- Create: `src/decision/requirementConditions.js`（`collectRequirementEvidence` 薄封装）
- Test: `test/decision/requirementConditions.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/decision/requirementConditions.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { assertRequirementEvidence, loadMethodologyEvidence } from '../../src/decision/methodologyEvidence.js';
import { collectRequirementEvidence } from '../../src/decision/requirementConditions.js';
import { writeConfig } from '../../src/config/configStore.js';

const T = 'plan-t5-' + Date.now();
beforeAll(async () => {
  await writeConfig('requirement-dimensions', {
    levels: ['MUST', 'SHOULD', 'NICE'],
    dimensions: [
      { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
      { dim_key: 'REQ_TRIAL', label: '试用安排', level: 'NICE' },
    ],
  }, { tenantId: 'system' });
});
afterAll(async () => { await writeConfig('requirement-dimensions', { dimensions: [] }, { tenantId: T }); });

describe('collectRequirementEvidence', () => {
  it('写入 REQUIREMENT 证据并可回读', async () => {
    await collectRequirementEvidence('deal-t5', [
      { dim_key: 'REQ_PRICE_BASELINE', met: true, evidence_ref: 'doc-1' },
      { dim_key: 'REQ_TRIAL', met: false },
    ], { tenantId: T, assertedBy: 'alice', decisionId: 'dec-1', source: 'manual' });
    const ev = await loadMethodologyEvidence({ subject_id: 'deal-t5', methodology_ids: ['REQUIREMENT'], tenantId: T });
    expect(ev.REQ_PRICE_BASELINE?.met).toBe(true);
    expect(ev.REQ_PRICE_BASELINE?.evidence_ref).toBe('doc-1');
    expect(ev.REQ_TRIAL?.met).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/requirementConditions.test.js`
Expected: FAIL（`Cannot find module '../../src/decision/requirementConditions.js'`）

- [ ] **Step 3: 实现**

`src/decision/methodologyEvidence.js` 末尾追加：

```js
// REQUIREMENT 方法论薄封装：methodology_id 固定 'REQUIREMENT'，便于 7 通道与 intake/followup 统一采集。
export async function assertRequirementEvidence({
  subject_id, dim_key, met, value = null, source = 'manual',
  evidence_ref = null, asserted_by = null, evidence_reason = null,
  tenantId = 'system', decision_id = null,
} = {}) {
  return assertEvidence({
    subject_id, methodology_id: 'REQUIREMENT', dim_key, met, value,
    source, evidence_ref, asserted_by, evidence_reason, tenantId, decision_id,
  });
}
```

`src/decision/requirementConditions.js`：

```js
// 需求分级证据采集（REQUIREMENT 方法论）。写证据是写操作 → 必须携带 decision_id（第 0 闸凭据）。
import { assertRequirementEvidence } from './methodologyEvidence.js';
import { readConfig } from '../config/configStore.js';

// dims: [{ dim_key, met, evidence_ref?, value? }]
export async function collectRequirementEvidence(subject_id, dims = [], {
  tenantId = 'system', assertedBy = null, decisionId = null, source = 'manual',
} = {}) {
  const out = [];
  for (const d of dims) {
    if (!d?.dim_key) continue;
    const ev = await assertRequirementEvidence({
      subject_id, dim_key: d.dim_key, met: d.met,
      value: d.value ?? null, source,
      evidence_ref: d.evidence_ref ?? null, asserted_by: assertedBy,
      tenantId, decision_id: decisionId,
    }).catch((e) => ({ error: String(e?.message || e) }));
    out.push(ev);
  }
  return out;
}

// 从配置读取 MUST 维度清单（供体检注入与采集入口提示使用）
export async function listMustDimensions({ tenantId = 'system' } = {}) {
  const r = await readConfig('requirement-dimensions', { tenantId }).catch(() => null);
  const dims = (r?.value?.dimensions || []).filter((d) => d.level === 'MUST');
  return dims;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- test/decision/requirementConditions.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/decision/methodologyEvidence.js src/decision/requirementConditions.js test/decision/requirementConditions.test.js
git commit -m "feat(requirement): REQUIREMENT evidence collection entry (ct-intake-route)"
```

---

### Task 6: 书面确认态进入条件体检与闸门（MUST 缺 → C 档）

**契约**: `ct-decision` · agent `decision-agent`

**Files:**
- Create: `src/decision/requirementConditions.js`（补 `buildRequirementConditions`）
- Modify: `src/decision/adviseService.js`
- Test: `test/decision/adviceCard-approval.test.js`、`test/decision/adviseService-quote.test.js`

- [ ] **Step 1: 写失败测试**

`test/decision/adviceCard-approval.test.js`：

```js
import { describe, it, expect } from 'vitest';
import { buildAdviceCard } from '../../src/decision/adviceCard.js';

describe('buildAdviceCard B 档预填', () => {
  it('红线命中 → tier B + approval_flow + approval_prefill', () => {
    const card = buildAdviceCard({
      scenario: { scenario_id: 'QUOTE_PRICING', default_tier: 'HIGH', eval_dimensions: [] },
      coordinate: { scenario_id: 'QUOTE_PRICING', stage: 'S3', deal_id: 'deal-x' },
      facts: {},
      redlines: [{ cond: 'margin_redline', label: '毛利红线', detail: '毛利 10% < 20%' }],
    });
    expect(card.tier).toBe('B');
    expect(card.approval_flow).toBe('CRM_APPROVAL_FLOW');
    expect(card.approval_prefill?.action).toBe('crm-approval-start');
    expect(card.approval_prefill?.business_id).toBe('deal-x');
  });
});
```

`test/decision/adviseService-quote.test.js`（DB 集成）：

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { advise } from '../../src/decision/adviseService.js';
import { queryWrite, query } from '../../src/db.js';
import { writeConfig } from '../../src/config/configStore.js';
import { assertRequirementEvidence } from '../../src/decision/methodologyEvidence.js';

const T = 'plan-t6-' + Date.now();
let dealId;
beforeAll(async () => {
  await writeConfig('price-authority', { default_max_discount_pct: 10, roles: { sales: { max_discount_pct: 10 } } }, { tenantId: 'system' });
  await writeConfig('requirement-dimensions', { levels: ['MUST'], dimensions: [{ dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' }] }, { tenantId: 'system' });
  const r = await queryWrite(
    `INSERT INTO crm.particles (type, tenant_id, state, payload) VALUES ('CRM_DEAL',$1,'active',$2::jsonb) RETURNING id`,
    [T, JSON.stringify({ amount: 100000, cost: 90000, discount_pct: 20 })],
  );
  dealId = r.rows[0].id;
});
afterAll(async () => { if (dealId) await queryWrite(`DELETE FROM crm.particles WHERE id=$1`, [dealId]).catch(()=>{}); });

describe('advise QUOTE_PRICING 红线 B 档', () => {
  it('低于毛利红线 + 折扣超权限 → B 档含预填', async () => {
    const r = await advise({ utterance: '客户要求 8 折', ctx: { tenantId: T, role: 'sales' }, deal: { id: dealId, payload: { amount: 100000, cost: 90000, discount_pct: 20 } }, stage: 'S3' });
    expect(r.ok).toBe(true);
    expect(r.advice.tier).toBe('B');
    expect(r.advice.approval_prefill?.action).toBe('crm-approval-start');
  });
  it('deal 未确认 MUST 书面批文 → C 档降级', async () => {
    // 同 deal 但折扣在权限内、毛利达标：应因 REQUIREMENT MUST 缺失降级 C
    const r = await advise({ utterance: '报价 9 折', ctx: { tenantId: T, role: 'manager' }, deal: { id: dealId, payload: { amount: 100000, cost: 90000, discount_pct: 10 } }, stage: 'S3' });
    // manager 折扣 10% 在权限内，但 REQUIREMENT MUST 未确认 → requiredMissing → C
    expect(r.advice.tier).toBe('C');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/adviceCard-approval.test.js test/decision/adviseService-quote.test.js`
Expected: FAIL

- [ ] **Step 3: `buildAdviceCard` 加 `approval_prefill`**

在 `src/decision/adviceCard.js` 顶部 import：

```js
import { buildApprovalPrefill } from './offerPolicyFacts.js';
```

在 `return { ... }` 前（tier 判定之后）追加：

```js
  const approval_prefill = (tier === 'B')
    ? buildApprovalPrefill({
        scenario_id: coordinate.scenario_id || scenario.scenario_id || null,
        deal_id: coordinate.deal_id || null,
        redlines,
      })
    : null;
```

并在返回对象中新增 `approval_prefill,`（置于 `approval_flow` 之后）。

- [ ] **Step 4: `requirementConditions.js` 补 `buildRequirementConditions`**

```js
import { loadMethodologyEvidence } from './methodologyEvidence.js';
import { readConfig } from '../config/configStore.js';

// 把 MUST 需求维度注入条件体检：未确认(met!=true 或 无 evidence_ref) → requiredMissing → C 档
export async function buildRequirementConditions(dealId, tenantId = 'system') {
  if (!dealId) return { evalDimensions: [], facts: {} };
  const cfg = await readConfig('requirement-dimensions', { tenantId }).then((r) => r?.value || null).catch(() => null);
  const must = (cfg?.dimensions || []).filter((d) => d.level === 'MUST');
  if (!must.length) return { evalDimensions: [], facts: {} };
  const ev = await loadMethodologyEvidence({ subject_id: dealId, methodology_ids: ['REQUIREMENT'], tenantId }).catch(() => ({}));
  const evalDimensions = [];
  const facts = {};
  for (const d of must) {
    const cond = `REQUIREMENT:${d.dim_key}`;
    const e = ev[d.dim_key];
    evalDimensions.push({ cond, label: d.label || d.dim_key, weight: 10, required: true });
    // 满足 = met 为 true 且有书面出处（evidence_ref）
    facts[cond] = (e && e.met === true && e.evidence_ref) ? true : null;
  }
  return { evalDimensions, facts };
}
```

- [ ] **Step 5: `adviseService.advise` 接线**

在 `src/decision/adviseService.js` import 区补充：

```js
import { resolveOfferPolicy, buildApprovalPrefill } from './offerPolicyFacts.js';
import { discountAuthorityCheck } from './offerPolicyFacts.js';
import { actorRole } from '../context/scope.js';
import { readConfig } from '../config/configStore.js';
import { buildRequirementConditions } from './requirementConditions.js';
```

（注：`buildApprovalPrefill` 实际由 `buildAdviceCard` 内部调用，此处 import 仅保留 `resolveOfferPolicy`/`discountAuthorityCheck`/`actorRole`/`readConfig`/`buildRequirementConditions`；如未用到可省略。）

修改 `advise` 函数体（替换原 try 段内 advisor 调用与 buildAdviceCard 调用）：

```js
export async function advise({ utterance = '', ctx = {}, scenario = null, deal = null, stage = null } = {}) {
  try {
    const coordinate = resolveCoordinate({ utterance, stage });
    const scenario_id = coordinate.scenario_id || scenario?.scenario_id || null;
    const advisor = scenario_id ? pickAdvisor(scenario_id) : null;
    const tenantId = ctx?.tenantId || 'system';

    // 角色解析（缺 → null，折扣判定走 default 上限，D6 降级）
    const role = ctx?.role || (await actorRole(ctx).then((r) => r?.role_tag || null).catch(() => null));

    const isQuote = scenario_id === 'QUOTE_PRICING' || scenario_id === 'INVOICE_APPROVE';
    const offerPolicy = isQuote
      ? await resolveOfferPolicy(tenantId, { dealId: deal?.id || null }).catch(() => null)
      : null;
    const discountMatrix = isQuote
      ? await readConfig('price-authority', { tenantId }).then((r) => r?.value || null).catch(() => null)
      : null;
    const requestedDiscountPct = deal ? resolveRequestedDiscount(deal) : null;

    const gathered = advisor && deal
      ? advisor(deal, { advisorConfig: buildAdvisorConfig(ctx?.advisorConfig), ctx: { ...ctx, role }, offerPolicy, discountMatrix, requestedDiscountPct })
      : { facts: {}, redlines: [] };

    // 红线跨场景复用：review/sign 场景持 deal 时也并算报价红线（T8）
    if (deal && !isQuote) {
      const q = gatherQuoteFacts(deal, { advisorConfig: buildAdvisorConfig(ctx?.advisorConfig), ctx: { ...ctx, role }, offerPolicy, discountMatrix, requestedDiscountPct });
      for (const rl of q.redlines) if (!gathered.redlines.some((x) => x.cond === rl.cond)) gathered.redlines.push(rl);
    }

    const scenarioRow = await loadScenarioRow(scenario_id, tenantId);
    const reqc = deal ? await buildRequirementConditions(deal.id, tenantId) : { evalDimensions: [], facts: {} };
    const mergedScenario = {
      ...(scenarioRow || {}), ...(scenario || {}), scenario_id,
      eval_dimensions: [...(scenarioRow?.eval_dimensions || []), ...reqc.evalDimensions],
    };

    const card = buildAdviceCard({
      scenario: mergedScenario,
      coordinate: { ...coordinate, scenario_id, deal_id: deal?.id || null },
      facts: { ...(gathered.facts || {}), ...reqc.facts },
      redlines: gathered.redlines || [],
    });

    const hits = coordinate.candidates?.[0]?.hits || [];
    return { ok: true, advice: { ...card, hits } };
  } catch (e) {
    return {
      ok: true,
      advice: { tier: 'C', disposition: null, scenario_id: null, stage: stage || null, gaps: [], redlines: [], reasons: [] },
      degraded: { reason: String(e?.message || e) },
    };
  }
}
```

注意：`scenarioAdvisors.js` 已 export `gatherQuoteFacts`，adviseService 已有 `import { pickAdvisor, DEFAULT_ADVISOR_CONFIG } from './scenarioAdvisors.js'`；需再补 `import { gatherQuoteFacts } from './scenarioAdvisors.js'`。

- [ ] **Step 6: 运行测试确认通过**

Run: `npm run test -- test/decision/adviceCard-approval.test.js test/decision/adviseService-quote.test.js`
Expected: PASS

- [ ] **Step 7: 提交**

```bash
git add src/decision/adviceCard.js src/decision/adviseService.js src/decision/requirementConditions.js test/decision/adviceCard-approval.test.js test/decision/adviseService-quote.test.js
git commit -m "feat(decision): wire tenant policy + requirement MUST gate into advise (ct-decision)"
```

---

### Task 7: 复盘沉淀可检索业务案例

**契约**: `ct-retro-decision` · agent `decision-retro`

**Files:**
- Create: `src/decision/decisionRetro.js`
- Test: `test/decision/decisionRetro.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/decision/decisionRetro.test.js
import { describe, it, expect } from 'vitest';
import { buildRequirementRetro, runDailyRetro } from '../../src/decision/decisionRetro.js';
import { queryWrite } from '../../src/db.js';
import { assertRequirementEvidence } from '../../src/decision/methodologyEvidence.js';

const T = 'plan-t7-' + Date.now();

describe('buildRequirementRetro', () => {
  it('汇总 MUST 未确认 Top3 与红线命中率', () => {
    const r = buildRequirementRetro({
      requirementByDeal: {
        d1: { mustUnconfirmed: ['REQ_WRITTEN_APPROVAL', 'REQ_PRICE_BASELINE'] },
        d2: { mustUnconfirmed: ['REQ_WRITTEN_APPROVAL'] },
      },
      redlineHits: 3, totalAdvices: 10,
    });
    expect(r.mustUnconfirmedTop3[0].dealId).toBe('d1');
    expect(r.mustUnconfirmedTop3.length).toBe(2);
    expect(r.redlineHitRate).toBe(30);
    expect(r.cases.length).toBeGreaterThan(0);
  });
});

describe('runDailyRetro (DB)', () => {
  it('从 REQUIREMENT 证据产出可检索案例', async () => {
    await assertRequirementEvidence({ subject_id: 'deal-t7', dim_key: 'REQ_WRITTEN_APPROVAL', met: false, tenantId: T, decision_id: 'x' }).catch(()=>{});
    const rep = await runDailyRetro(T);
    expect(Array.isArray(rep.mustUnconfirmedTop3)).toBe(true);
    const hit = rep.mustUnconfirmedTop3.find((d) => d.dealId === 'deal-t7');
    expect(hit?.mustUnconfirmed || []).toContain('REQ_WRITTEN_APPROVAL');
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/decisionRetro.test.js`
Expected: FAIL

- [ ] **Step 3: 实现 `decisionRetro.js`**

```js
// 复盘：从 REQUIREMENT 证据聚合 MUST 未确认 Top3（可检索业务案例）+ 红线审批发起数（红线命中代理指标）
import { query } from '../db.js';
import { loadMethodologyEvidence } from './methodologyEvidence.js';
import { readConfig } from '../config/configStore.js';

// 纯函数：输入聚合结果 → 报告
export function buildRequirementRetro({ requirementByDeal = {}, redlineHits = 0, totalAdvices = 0 } = {}) {
  const deals = Object.entries(requirementByDeal)
    .map(([dealId, v]) => ({ dealId, mustUnconfirmed: v.mustUnconfirmed || [] }))
    .filter((d) => d.mustUnconfirmed.length > 0)
    .sort((a, b) => b.mustUnconfirmed.length - a.mustUnconfirmed.length)
    .slice(0, 3);
  const redlineHitRate = totalAdvices > 0 ? Number(((redlineHits / totalAdvices) * 100).toFixed(1)) : 0;
  return {
    generatedAt: new Date().toISOString(),
    mustUnconfirmedTop3: deals,
    redlineApprovalInstances: redlineHits,
    redlineHitRate,
    cases: deals.map((d) => ({ type: 'requirement-gap', dealId: d.dealId, dims: d.mustUnconfirmed })),
  };
}

// DB 聚合：遍历租户 REQUIREMENT 证据，统计 MUST 未确认；红线代理 = 该租户 CRM_APPROVAL_FLOW 发起实例数
export async function runDailyRetro(tenantId = 'system') {
  const cfg = await readConfig('requirement-dimensions', { tenantId }).then((r) => r?.value || null).catch(() => null);
  const must = (cfg?.dimensions || []).filter((d) => d.level === 'MUST').map((d) => d.dim_key);
  if (!must.length) return buildRequirementRetro({});

  // 取该租户全部 REQUIREMENT 证据主体
  const r = await query(
    `SELECT payload->>'subject_id' AS subject_id, payload->>'dim_key' AS dim_key,
            payload->>'met' AS met, payload->>'evidence_ref' AS evidence_ref, state
       FROM crm.particles
      WHERE type='CRM_METHODOLOGY_EVIDENCE' AND tenant_id=$1
        AND payload->>'methodology_id'='REQUIREMENT' AND state='asserted'`,
    [tenantId],
  );
  const byDeal = {};
  for (const row of r.rows) {
    const sid = row.subject_id;
    if (!sid) continue;
    byDeal[sid] = byDeal[sid] || { mustUnconfirmed: [] };
    if (must.includes(row.dim_key) && !(row.met === 'true' && row.evidence_ref)) {
      if (!byDeal[sid].mustUnconfirmed.includes(row.dim_key)) byDeal[sid].mustUnconfirmed.push(row.dim_key);
    }
  }
  // 红线代理：审批流发起实例数（business_type 含 QUOTE/SIGN 视为报价/签单红线）
  const inst = await query(
    `SELECT COUNT(*)::int AS n FROM crm.approval_instance WHERE tenant_id=$1`,
    [tenantId],
  ).catch(() => ({ rows: [{ n: 0 }] }));
  return buildRequirementRetro({ requirementByDeal: byDeal, redlineHits: inst.rows[0]?.n || 0, totalAdvices: 0 });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- test/decision/decisionRetro.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/decision/decisionRetro.js test/decision/decisionRetro.test.js
git commit -m "feat(retro): daily requirement retro + retrievable cases (ct-retro-decision)"
```

---

### Task 8: review-gate 终审消费红线依据

**契约**: `ct-review-gate` · agent `review-gate`

**Files:**
- Test: `test/decision/adviseService-quote.test.js`（追加 review 场景用例）
- Modify: `src/decision/adviseService.js`（已在 Task 6 Step 5 实现 deal 存在时并算报价红线，本任务补 review 场景测试与 `gatherReviewFacts` 透传红线）

- [ ] **Step 1: 写失败测试**

在 `test/decision/adviseService-quote.test.js` 追加：

```js
describe('advise REVIEW_GATE 消费红线', () => {
  it('review 场景持 deal 且毛利破线 → 红线进入卡', async () => {
    const r = await advise({ utterance: '复核这单', ctx: { tenantId: T, role: 'manager' }, deal: { id: dealId, payload: { amount: 100000, cost: 90000 } }, stage: 'S5' });
    // 毛利 10% 破租户红线 → 至少含 margin_redline 红线
    expect(r.advice.redlines.some((x) => x.cond === 'margin_redline')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败（若 review 场景未透传）**

Run: `npm run test -- test/decision/adviseService-quote.test.js`
Expected: Task 6 Step 5 已实现并算逻辑，本例应已 PASS；若未 PASS 回查 Task 6 Step 5 的 `!isQuote` 分支。

- [ ] **Step 3: 确认 `gatherReviewFacts` 不丢弃红线**

`scenarioAdvisors.gatherReviewFacts` 已返回 `redlines: []`（阶段卡点）。Task 6 的 `advise` 在 `!isQuote` 分支已把报价红线并入，review/sign 场景因此能看到红线。无需改 `gatherReviewFacts` 本身；本任务仅用测试固化该行为。

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- test/decision/adviseService-quote.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add test/decision/adviseService-quote.test.js
git commit -m "test(review): review-gate consumes quote redlines (ct-review-gate)"
```

---

### Task 9: followup-agent 采集 SHOULD/NICE 证据

**契约**: `ct-followup` · agent `followup-agent`

**Files:**
- Test: `test/decision/requirementConditions.test.js`（追加 SHOULD/NICE 采集用例）
- Modify: `src/decision/requirementConditions.js`（补 `collectFollowupRequirement`）

- [ ] **Step 1: 写失败测试**

在 `test/decision/requirementConditions.test.js` 追加：

```js
import { collectFollowupRequirement } from '../../src/decision/requirementConditions.js';

describe('collectFollowupRequirement', () => {
  it('SHOULD/NICE 维度可独立采集（非 MUST 不强制）', async () => {
    const out = await collectFollowupRequirement('deal-t9', [
      { dim_key: 'REQ_BUDGET', met: true, evidence_ref: 'b-1' },
      { dim_key: 'REQ_TRIAL', met: false },
    ], { tenantId: T, assertedBy: 'bob', decisionId: 'dec-9', source: 'auto' });
    expect(out.length).toBe(2);
    const ev = await loadMethodologyEvidence({ subject_id: 'deal-t9', methodology_ids: ['REQUIREMENT'], tenantId: T });
    expect(ev.REQ_BUDGET?.met).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npm run test -- test/decision/requirementConditions.test.js`
Expected: FAIL（`collectFollowupRequirement` 不存在）

- [ ] **Step 3: 实现 `collectFollowupRequirement`**

在 `src/decision/requirementConditions.js` 追加：

```js
// followup-agent 采集 SHOULD/NICE 维度（非 MUST，不进体检红线，仅沉淀证据供复盘）
export async function collectFollowupRequirement(subject_id, dims = [], {
  tenantId = 'system', assertedBy = null, decisionId = null, source = 'auto',
} = {}) {
  return collectRequirementEvidence(subject_id, dims, { tenantId, assertedBy, decisionId, source });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npm run test -- test/decision/requirementConditions.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/decision/requirementConditions.js test/decision/requirementConditions.test.js
git commit -m "feat(followup): collect SHOULD/NICE requirement evidence (ct-followup)"
```

---

## 自检（Plan 作者自审）

**1. 规格覆盖对照（设计文档 9 任务）**
- T1 折扣授权矩阵判定 → Task 1 ✅
- T2 报价事实采集接入租户政策 → Task 2 + Task 3 ✅
- T3 建议卡红线细项 + 一键发起 → Task 3（gatherQuoteFacts 差距数值）+ Task 6（adviceCard approval_prefill）✅
- T4 政策来源优先级 + 配置化接线 → Task 4（POLICY_KEYS + seed）✅
- T5 需求维度清单配置化 + 采集入口 → Task 5 ✅
- T6 书面确认态进体检/闸门 → Task 6（buildRequirementConditions + C 档降级）✅
- T7 复盘沉淀可检索案例 → Task 7 ✅
- T8 review-gate 终审消费红线 → Task 8 ✅
- T9 followup-agent 采 SHOULD/NICE → Task 9 ✅

**2. 占位符扫描**：无 TBD/TODO；每个代码步骤均含可复制实现；测试为真实断言（含 DB 集成）。

**3. 类型/命名一致性**
- `discountAuthorityCheck(role, requestedDiscountPct, matrix)` 在 Task 1 定义、Task 3 调用，签名一致。
- `buildApprovalPrefill({scenario_id, deal_id, redlines})` Task 2 定义、Task 6 由 adviceCard 调用，参数一致。
- `resolveRequestedDiscount(deal)` Task 2 定义、Task 6 advise 调用，一致。
- `buildRequirementConditions(dealId, tenantId)` Task 6 定义并在 advise 调用，一致。
- `CRM_METHODOLOGY_EVIDENCE` 的 `methodology_id='REQUIREMENT'` 贯穿 Task 5/6/7/9。
- `approval_prefill` 字段名在 adviceCard 产出、测试断言中一致。

**4. 遗留风险（已记入设计文档，本计划不解决）**
- `marginView` 的 `redline` 直接采用 `payload.margin_redline`（门户同口径，按 0.2 表示 20%）。若存量数据以 `20` 存储会被判恒破线 —— 属存量数据治理问题，不在本计划范围；seed 脚本示例以 `0.2` 写入。
- `offerPolicyMath` 与门户 `offerPolicyRender` 为镜像实现，避免后端引 UI 模块；门户口径变更须同步本文件（已在文件头注释标注）。
- `price-authority` 入 `POLICY_KEYS` 后所有后续决策解析出新策略版本（已获用户批准，预期行为）。
- 红线审批发起仍为人工/HITL 显式调用 `crm-approval-start`，系统不自动写（符合设计 §10）。
