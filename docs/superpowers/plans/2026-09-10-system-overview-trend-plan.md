# 三大系统概览页 30 日趋势 SVG 真实化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `/system-overview/{k|m|d}` 三页 §2「近 30 日趋势」从静态占位 SVG 改为基于真实每日采样数据的 sparkline。

**Architecture:** 新增 `crm.system_overview_sample` 表（PK 复合 `(tenant_id, sample_date, metric)`），由 `scripts/sample-system-overview.mjs` 每日 upsert 三指标快照；渲染期经新增共享模块 `src/http/render/systemOverviewShared.js` 的 `getTrendSamples` 读取近 30 日序列，由纯函数 `buildTrendPolyline` 线性映射为 `<polyline>` 点串。零新增对外 API，不改配置页 / `#loop-strip` 文案 / M 页权限分支。

**Tech Stack:** Node 22 ESM、PostgreSQL (pg via `src/db.js`)、vitest、既有 `listSkillRegistry` / `getGateAttribution` / `crm.decision_precedent_rel` 数据源。

**设计文档：** `docs/2026-09-10-system-overview-trend-design.md`（已批准，契约 `valid:true`）。

---

## File Structure

- Create: `db/migration-2026-09-10-system-overview-sample.sql` — 建表 DDL（additive，新表）。
- Modify: `db/schema.sql` — 末尾追加同构 DDL（单一事实源）。
- Create: `src/http/render/systemOverviewShared.js` — `buildTrendPolyline`（纯函数）+ `getTrendSamples`（读表，支持注入 query）。
- Create: `scripts/sample-system-overview.mjs` — 每日采样 upsert 三指标。
- Modify: `src/http/render/systemOverviewK.js` — `renderTrendSvg(values)` 接真实数据。
- Modify: `src/http/render/systemOverviewM.js` — 同上（admin 分支内）。
- Modify: `src/http/render/systemOverviewD.js` — 同上。
- Modify: `test/http/system-overview-pages.test.js` — 新增趋势断言（T4 / T5 区块）。
- Operate: 每晚 10 点例行自动化（ID `a8722c99`）新增「采样」步（automation_update delete+create，因 update 模式对已存在任务报 not found）。

---

## Task 1: 建表迁移 + schema 单一事实源

**Files:**
- Create: `db/migration-2026-09-10-system-overview-sample.sql`
- Modify: `db/schema.sql`（末尾追加）

- [ ] **Step 1: 编写迁移 SQL**

`db/migration-2026-09-10-system-overview-sample.sql`:
```sql
-- 30 日趋势采样表（system-overview 概览页真实 sparkline 数据源）
-- additive：新表，不改动任何既有表结构
CREATE TABLE IF NOT EXISTS crm.system_overview_sample (
  tenant_id    TEXT    NOT NULL DEFAULT 'system',
  sample_date  DATE    NOT NULL DEFAULT CURRENT_DATE,
  metric       TEXT    NOT NULL,
  value        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sample_date, metric)
);
CREATE INDEX IF NOT EXISTS idx_crm_so_sample_lookup
  ON crm.system_overview_sample (metric, tenant_id, sample_date);
```

- [ ] **Step 2: 在 db/schema.sql 末尾追加同构 DDL**

`db/schema.sql`（文件末尾追加，保持 CREATE TABLE IF NOT EXISTS + 复合 PK）：
```sql

-- 2026-09-10 三大系统概览页 30 日趋势采样表（additive，单一事实源见 migration-2026-09-10-system-overview-sample.sql）
CREATE TABLE IF NOT EXISTS crm.system_overview_sample (
  tenant_id    TEXT    NOT NULL DEFAULT 'system',
  sample_date  DATE    NOT NULL DEFAULT CURRENT_DATE,
  metric       TEXT    NOT NULL,
  value        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sample_date, metric)
);
```

- [ ] **Step 3: 在测试/生产库应用迁移（按需）**

Run（生产连接，遵循既有时区/搜索路径约定）：
```bash
psql "$DATABASE_URL" -f db/migration-2026-09-10-system-overview-sample.sql
```
Expected: `CREATE TABLE` / `CREATE INDEX`。

- [ ] **Step 4: 提交**

```bash
git add db/migration-2026-09-10-system-overview-sample.sql db/schema.sql
git commit -m "feat(overview): add system_overview_sample table for 30d trend"
```

---

## Task 2: 共享模块 buildTrendPolyline + getTrendSamples（TDD）

**Files:**
- Create: `src/http/render/systemOverviewShared.js`
- Test: `test/http/system-overview-trend.test.js`（新建，纯函数单测）

- [ ] **Step 1: 写失败测试**

`test/http/system-overview-trend.test.js`:
```js
import { describe, it, expect } from 'vitest';
import { buildTrendPolyline, getTrendSamples } from '../../src/http/render/systemOverviewShared.js';

describe('buildTrendPolyline', () => {
  it('空数组返回空串', () => {
    expect(buildTrendPolyline([])).toBe('');
  });
  it('单点返回中点', () => {
    expect(buildTrendPolyline([10])).toBe('0.0,20.0');
  });
  it('多点线性映射到 200x40（max→y5, min→y35）', () => {
    const p = buildTrendPolyline([0, 10, 5, 20]);
    const pts = p.split(' ');
    expect(pts.length).toBe(4);
    expect(pts[0]).toBe('0.0,35.0');        // min=0 → y=35
    expect(pts[3]).toBe('200.0,5.0');       // max=20 → y=5
    expect(pts[1].startsWith('66.7,')).toBe(true); // x=66.7 处
  });
  it('恒定序列不产生除零（全部取中线）', () => {
    const p = buildTrendPolyline([7, 7, 7]);
    expect(p).toBe('0.0,20.0 100.0,20.0 200.0,20.0');
  });
});

describe('getTrendSamples (注入 query)', () => {
  it('按 metric+tenant 升序返回 value 数组', async () => {
    const fakeQuery = async () => ({ rows: [
      { value: 3 }, { value: 6 }, { value: 9 },
    ] });
    const vals = await getTrendSamples('k_method_skill', { tenantId: 'system', days: 30, deps: { query: fakeQuery } });
    expect(vals).toEqual([3, 6, 9]);
  });
  it('查询异常安全降级为空数组', async () => {
    const fakeQuery = async () => { throw new Error('no table'); };
    const vals = await getTrendSamples('k_method_skill', { tenantId: 'system', deps: { query: fakeQuery } });
    expect(vals).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
npx vitest run test/http/system-overview-trend.test.js
```
Expected: FAIL（`Cannot find module .../systemOverviewShared.js`）。

- [ ] **Step 3: 实现模块**

`src/http/render/systemOverviewShared.js`:
```js
// 三系统概览页共享：趋势 polyline 生成 + 采样读取（零新增对外 API）
import { query as defaultQuery } from '../../db.js';

// 纯函数：values → "x,y x,y ..."，viewBox 200x40，y 区间 [5,35]，x 区间 [0,200]
export function buildTrendPolyline(values, { w = 200, h = 40, padY = 5 } = {}) {
  const n = values.length;
  if (n === 0) return '';
  if (n === 1) return `0.0,${(h / 2).toFixed(1)}`;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = (max - min) || 1;
  const innerH = h - 2 * padY;
  return values.map((v, i) => {
    const x = (i / (n - 1)) * w;
    const y = (h - padY) - ((v - min) / span) * innerH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
}

// 读近 days 日采样；支持注入 query（测试用）；异常安全降级为空数组
export async function getTrendSamples(metric, { tenantId = 'system', days = 30, deps = {} } = {}) {
  const q = deps.query || defaultQuery;
  try {
    const r = await q(
      `SELECT value FROM crm.system_overview_sample
       WHERE metric = $1 AND tenant_id = $2
         AND sample_date >= CURRENT_DATE - ($3 || ' days')::interval
       ORDER BY sample_date ASC`,
      [metric, tenantId, String(days)]
    );
    return (r.rows || []).map((row) => Number(row.value));
  } catch {
    return [];
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
npx vitest run test/http/system-overview-trend.test.js
```
Expected: PASS（5 tests）。

- [ ] **Step 5: 提交**

```bash
git add src/http/render/systemOverviewShared.js test/http/system-overview-trend.test.js
git commit -m "feat(overview): add shared trend polyline + getTrendSamples"
```

---

## Task 3: 采样脚本 sample-system-overview.mjs（TDD）

**Files:**
- Create: `scripts/sample-system-overview.mjs`
- Test: `test/http/system-overview-sampler.test.js`（新建，用注入 queryWrite 断言 upsert）

- [ ] **Step 1: 写失败测试**

`test/http/system-overview-sampler.test.js`:
```js
import { describe, it, expect, vi } from 'vitest';

// 把脚本核心抽成可测：直接断言 upsert 调用参数（不连真实库）
const upserts = [];
const fakeQuery = async () => ({ rows: [{ tenant_id: 'acme' }, { tenant_id: 'globex' }] });
const fakeQueryWrite = async (_sql, params) => { upserts.push(params); return { rowCount: 1 }; };
const fakeListSkill = async () => ([
  { skill_id: 'a', methodology_id: 'm1' },
  { skill_id: 'b', methodology_id: null },
  { skill_id: 'c', methodology_id: 'm2' },
]);
const fakeGate = async () => ([{ total: 4 }, { total: 6 }]);

// 动态 import 前先 stub 依赖（ESM 顶部 import 会立即执行，故用 vi.mock 包裹）
vi.mock('../src/db.js', () => ({ query: (...a) => fakeQuery(...a), queryWrite: (...a) => fakeQueryWrite(...a) }));
vi.mock('../src/skills/skillRegistry.js', () => ({ listSkillRegistry: fakeListSkill }));
vi.mock('../src/monitor/monitorStore.js', () => ({ getGateAttribution: fakeGate }));

const { sampleAll } = await import('../scripts/sample-system-overview.mjs');

describe('sample-system-overview', () => {
  it('为每个租户 upsert 三指标（含 system 平台级）', async () => {
    await sampleAll();
    // 期望 tenant 来自 fakeQuery 的 acme/globex + system = 3 个租户 × 3 指标 = 9 行
    expect(upserts.length).toBe(9);
    const metrics = new Set(upserts.map((p) => p[2]));
    expect(metrics).toEqual(new Set(['k_method_skill', 'm_precedent_edge', 'd_l1_intercept']));
    // K 应为 methodology_id 非空的计数 = 2
    const kRow = upserts.find((p) => p[2] === 'k_method_skill' && p[0] === 'system');
    expect(kRow[3]).toBe(2);
    // D 应为 gate total 之和 = 10
    const dRow = upserts.find((p) => p[2] === 'd_l1_intercept' && p[0] === 'acme');
    expect(dRow[3]).toBe(10);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
npx vitest run test/http/system-overview-sampler.test.js
```
Expected: FAIL（模块尚未导出 `sampleAll`）。

- [ ] **Step 3: 实现脚本**

`scripts/sample-system-overview.mjs`:
```js
// 每日采样：把三系统健康指标快照 upsert 入 crm.system_overview_sample
// 触发：每晚 10 点例行自动化新增一步；或独立 cron `node scripts/sample-system-overview.mjs`
import { query, queryWrite } from '../src/db.js';
import { listSkillRegistry } from '../src/skills/skillRegistry.js';
import { getGateAttribution } from '../src/monitor/monitorStore.js';

function sumGateTotal(gates) {
  const arr = Array.isArray(gates) ? gates : (gates?.gates || []);
  return arr.reduce((s, g) => s + (Number(g.total) || 0), 0);
}

export async function sampleTenant(tenantId, today) {
  const skills = await listSkillRegistry().catch(() => []);
  const kMethod = skills.filter((s) => s.methodology_id != null).length;

  const mRes = await query(
    `SELECT COUNT(*)::int AS n
     FROM crm.decision_precedent_rel r
     JOIN crm.decision d ON r.decision_id = d.decision_id
     WHERE d.tenant_id = $1`, [tenantId]
  ).catch(() => ({ rows: [{ n: 0 }] }));
  const mPrecedent = Number(mRes.rows?.[0]?.n ?? 0);

  const gates = await getGateAttribution(tenantId).catch(() => []);
  const dL1 = sumGateTotal(gates);

  const rows = [
    ['k_method_skill', kMethod],
    ['m_precedent_edge', mPrecedent],
    ['d_l1_intercept', dL1],
  ];
  for (const [metric, value] of rows) {
    await queryWrite(
      `INSERT INTO crm.system_overview_sample (tenant_id, sample_date, metric, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, sample_date, metric) DO UPDATE SET value = EXCLUDED.value`,
      [tenantId, today, metric, value]
    );
  }
}

export async function sampleAll() {
  const today = new Date().toISOString().slice(0, 10);
  // 平台级 + 各业务租户
  const tRes = await query(`SELECT tenant_id FROM crm.tenants`).catch(() => ({ rows: [] }));
  const tenants = ['system', ...(tRes.rows || []).map((r) => r.tenant_id)];
  for (const t of tenants) {
    await sampleTenant(t, today);
  }
  return tenants.length;
}

// 直接执行入口（非 import 时运行）
if (import.meta.url === `file://${process.argv[1]}`) {
  sampleAll()
    .then((n) => { console.log(`[sample-overview] upserted ${n} tenants`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run:
```bash
npx vitest run test/http/system-overview-sampler.test.js
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add scripts/sample-system-overview.mjs test/http/system-overview-sampler.test.js
git commit -m "feat(overview): add daily sampler for 30d trend metrics"
```

---

## Task 4: 三 renderer 接真实数据（TDD）

**Files:**
- Modify: `src/http/render/systemOverviewK.js`
- Modify: `src/http/render/systemOverviewM.js`
- Modify: `src/http/render/systemOverviewD.js`
- Test: `test/http/system-overview-pages.test.js`（T5 区块，见 Task 5）

- [ ] **Step 1: 写失败测试（Task 5 一并落地，此处先列预期）**

预期：三页渲染输出含 `data-trend` 的 `<svg>`，其 `<polyline>` 的 `points` 由采样值生成（注入 fake query 后断言 points 含计算值、且不再出现旧硬编码串 `0,30 10,28`）。

- [ ] **Step 2: 改造 systemOverviewK.js**

在文件顶部 import 区追加：
```js
import { getTrendSamples, buildTrendPolyline } from './systemOverviewShared.js';
```
替换 `renderTrendSvg()` 为：
```js
function renderTrendSvg(values) {
  const points = buildTrendPolyline(values);
  const label = '近 30 日方法 SKILL 装配趋势';
  if (!points) {
    return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}"><text x="4" y="24" class="so-trend-empty">暂无采样数据</text></svg>`;
  }
  return `<svg data-trend="knowledge-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}">
    <polyline points="${points}" fill="none" stroke="var(--ac)" stroke-width="1.5"></polyline>
  </svg>`;
}
```
在 `renderKnowledge` 中读取采样并传入：
```js
export async function renderKnowledge({ deps } = {}) {
  const [skew, skills, kVals] = await Promise.all([
    safeSkew(),
    safeSkillRegistry(),
    getTrendSamples('k_method_skill', { tenantId: 'system', deps }),
  ]);
  const { html: tableHtml, details } = renderTable(skew, skills);
  const html = [
    '<section class="pg-section so-k-top">', renderTopState(skew), '</section>',
    '<section class="pg-section so-k-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(kVals), '</section>',
    '<section class="pg-section so-k-table"><h3>方法 SKILL 清单 + 维度漂移</h3>', tableHtml, details, '</section>',
    '<section class="pg-section so-k-drill"><p class="dn-note">点击任意一行查看该 SKILL 的完整字段与维度漂移明细。</p></section>',
  ].join('');
  return { schema: { type: 'monitor-overview-k' }, data: { dimSkew: skew.filter((s) => s.dim_skew).length, totalSkills: skills.length }, html };
}
```

- [ ] **Step 3: 改造 systemOverviewM.js**

顶部 import 区追加：
```js
import { getTrendSamples, buildTrendPolyline } from './systemOverviewShared.js';
```
替换 `renderTrendSvg()` 为：
```js
function renderTrendSvg(values) {
  const points = buildTrendPolyline(values);
  const label = '近 30 日先例引用趋势';
  if (!points) {
    return `<svg data-trend="memory-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}"><text x="4" y="24" class="so-trend-empty">暂无采样数据</text></svg>`;
  }
  return `<svg data-trend="memory-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}">
    <polyline points="${points}" fill="none" stroke="var(--ok)" stroke-width="1.5"></polyline>
  </svg>`;
}
```
在 `renderMemory` 的 admin 分支，`Promise.all` 中追加采样读取，并传入趋势段：
```js
export async function renderMemory({ me, deps } = {}) {
  const isAdmin = ['admin', 'sysadmin'].includes(me?.role);
  if (!isAdmin) {
    return { schema: { type: 'monitor-overview-m', scope: 'forbidden' }, data: { role: me?.role || 'guest' }, html: renderForbidden(me) };
  }
  const [counts, edges, top, distill, refMap, mVals] = await Promise.all([
    safeCounts(), safePrecedentEdges(), safePrecedentTop(10), safeDistill(), safePrecedentRefMap(),
    getTrendSamples('m_precedent_edge', { tenantId: me.tenantId || 'system', deps }),
  ]);
  const { html: topHtml, details } = renderTopTable(top, refMap);
  const html = [
    '<section class="pg-section so-m-top">', renderTopState(edges), '</section>',
    '<section class="pg-section so-m-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(mVals), '</section>',
    '<section class="pg-section so-m-pred"><h3>先例边 Top 10（被引用次数）</h3>', topHtml, details, '</section>',
    renderTriSection(counts),
    renderDistill(distill),
    '<section class="pg-section so-m-drill"><p class="dn-note">点击任一先例行查看引用它的决策清单。</p></section>',
  ].join('');
  return { schema: { type: 'monitor-overview-m' }, data: { edges, ...counts, distill, top: top.length }, html };
}
```

- [ ] **Step 4: 改造 systemOverviewD.js**

顶部 import 区追加：
```js
import { getTrendSamples, buildTrendPolyline } from './systemOverviewShared.js';
```
替换 `renderTrendSvg(l1)` 为：
```js
function renderTrendSvg(values) {
  const points = buildTrendPolyline(values);
  const label = '近 30 日 L1 拦截趋势';
  if (!points) {
    return `<svg data-trend="decision-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}"><text x="4" y="24" class="so-trend-empty">暂无采样数据</text></svg>`;
  }
  return `<svg data-trend="decision-30d" viewBox="0 0 200 40" width="200" height="40" aria-label="${label}">
    <polyline points="${points}" fill="none" stroke="var(--warn)" stroke-width="1.5"></polyline>
  </svg>`;
}
```
在 `renderDecision` 中读取采样并传入：
```js
export async function renderDecision({ me, deps } = {}) {
  const [l1, l2, l3, dVals] = await Promise.all([
    safeL1(me), safeL2(), safeL3(me),
    getTrendSamples('d_l1_intercept', { tenantId: me?.tenantId || 'system', deps }),
  ]);
  const l2Ok = l2.filter((r) => Number(r.raw?.business_success_rate ?? 0) > 0).length;
  const { html: l1Html, details: l1Details } = renderL1Table(l1);
  const { html: l2Html, details: l2Details } = renderL2Table(l2);
  const html = [
    '<section class="pg-section so-d-top">', renderTopState(l1.total, l2Ok, l2.length, l3.count), '</section>',
    '<section class="pg-section so-d-trend"><h3>近 30 日趋势</h3>', renderTrendSvg(dVals), '</section>',
    '<section class="pg-section so-d-l1"><h3>L1 拦截明细（按闸门）</h3>', l1Html, l1Details, '</section>',
    '<section class="pg-section so-d-l2"><h3>L2 场景通过率分布</h3>', l2Html, l2Details, '</section>',
    '<section class="pg-section so-d-l3"><h3>L3 校准待批处方</h3>', renderL3(l3), '</section>',
    '<section class="pg-section so-d-drill"><p class="dn-note">点击 L1 闸门行 / L2 场景行 / L3 处方查看明细下钻。</p></section>',
  ].join('');
  return { schema: { type: 'monitor-overview-d' }, data: { l1: l1.total, gates: l1.gates.length, l2Ok, totalScn: l2.length, l3: l3.count }, html };
}
```

- [ ] **Step 5: 运行全量回归（信任但验证）**

Run:
```bash
npx vitest run test/http/system-overview-pages.test.js test/http/system-overview-trend.test.js test/http/system-overview-sampler.test.js
```
Expected: 全部 PASS，无退化（既有 20 个概览契约用例仍绿）。

- [ ] **Step 6: 提交**

```bash
git add src/http/render/systemOverviewK.js src/http/render/systemOverviewM.js src/http/render/systemOverviewD.js
git commit -m "feat(overview): wire 3 renderers to real 30d trend samples"
```

---

## Task 5: 趋势契约测试（注入采样断言动态）

**Files:**
- Modify: `test/http/system-overview-pages.test.js`（追加 T5 区块）

- [ ] **Step 1: 在测试文件追加 T5 区块**

在 `test/http/system-overview-pages.test.js` 末尾追加（复用文件顶部 `describe/it/expect` 与 `app`）：
```js
// 5) 趋势区由采样数据驱动（注入 fake query，验证 polyline 动态生成）
describe('T5: 趋势 SVG 由真实采样驱动', () => {
  const fakeQuery = async () => ({ rows: [
    { value: 2 }, { value: 5 }, { value: 3 }, { value: 8 }, { value: 6 },
  ] });

  it('K 页趋势 polyline points 来自采样且非旧硬编码', async () => {
    const { html } = await import('../../src/http/render/systemOverviewK.js')
      .then((m) => m.renderKnowledge({ deps: { query: fakeQuery } }));
    expect(html).toContain('data-trend="knowledge-30d"');
    expect(html).toContain('<polyline');
    expect(html).toContain('200.0,');        // 末点 x=200
    expect(html).not.toContain('0,30 10,28'); // 旧占位点串已移除
  });

  it('M 页（admin）趋势 polyline 动态', async () => {
    const { html } = await import('../../src/http/render/systemOverviewM.js')
      .then((m) => m.renderMemory({ me: { role: 'admin', tenantId: 'acme' }, deps: { query: fakeQuery } }));
    expect(html).toContain('data-trend="memory-30d"');
    expect(html).toContain('<polyline');
    expect(html).not.toContain('0,35 10,33');
  });

  it('D 页趋势 polyline 动态', async () => {
    const { html } = await import('../../src/http/render/systemOverviewD.js')
      .then((m) => m.renderDecision({ me: { role: 'admin', tenantId: 'acme' }, deps: { query: fakeQuery } }));
    expect(html).toContain('data-trend="decision-30d"');
    expect(html).toContain('<polyline');
    expect(html).not.toContain('0,32 10,30');
  });

  it('无采样时趋势区显示「暂无采样数据」而非崩溃', async () => {
    const empty = async () => ({ rows: [] });
    const { html } = await import('../../src/http/render/systemOverviewK.js')
      .then((m) => m.renderKnowledge({ deps: { query: empty } }));
    expect(html).toContain('暂无采样数据');
  });
});
```

- [ ] **Step 2: 运行新测试**

Run:
```bash
npx vitest run test/http/system-overview-pages.test.js
```
Expected: 原 20 例 + 新增 4 例全部 PASS。

- [ ] **Step 3: 提交**

```bash
git add test/http/system-overview-pages.test.js
git commit -m "test(overview): assert trend polyline driven by sampled data"
```

---

## Task 6: 挂接夜间自动化（运维操作，非代码提交）

**操作（非 git 提交）：** 每晚 10 点例行自动化（ID `a8722c99`）新增「采样」步。

- 因 `automation_update` 的 `update` 模式对既有任务报 not found，需 **delete + create 重建**该 automation，在 steps 中追加：
  - 名称：`采样三系统概览趋势`
  - 命令：`node scripts/sample-system-overview.mjs`
  - 频率：与既有 6 步一致（每晚 22:00，rrule `FREQ=DAILY;BYHOUR=22;BYMINUTE=0`）
- 备选（无 automation 权限时）：在宿主 cron 增加：
  ```bash
  0 22 * * * cd /path/to/CRM-ai-native && node scripts/sample-system-overview.mjs >> logs/sample-overview.log 2>&1
  ```

- [ ] **Step 1: 验证脚本可独立运行（本地冒烟）**

Run（需可达测试库；表须已建，见 Task 1）：
```bash
node scripts/sample-system-overview.mjs
```
Expected: 输出 `[sample-overview] upserted N tenants`，且表中出现当日行（`SELECT count(*) FROM crm.system_overview_sample WHERE sample_date = CURRENT_DATE`）。

---

## Self-Review

1. **Spec coverage:**
   - 存储表 `system_overview_sample`（复合 PK）✓ Task 1
   - 采样脚本三指标（K/M/D）✓ Task 3
   - 渲染接真实数据（三 renderer）✓ Task 4
   - 零新增 API / 不改配置页 / M 仍 admin-only ✓ Task 4 保持分支
   - 契约测试 ✓ Task 2/3/5
   - 夜间自动化挂接 ✓ Task 6
2. **Placeholder scan:** 无 TBD/TODO；每步含实际代码与期望输出。
3. **Type consistency:** `getTrendSamples(metric, {tenantId, days, deps})` 签名在 Task 2 定义、Task 4/5 调用一致；`buildTrendPolyline(values)` 签名一致；`sampleAll` 在 Task 3 导出并被 Task 6 引用。✓

**验证清单（交付前）：**
- `node scripts/validate-contract.mjs docs/2026-09-10-system-overview-trend-design.md` → `valid:true`
- 三页过 `node scripts/ui-lint.mjs`
- 全量 `npx vitest run` 零退化
- 起服务 + 跑一次 sampler → 三页趋势区显示真实 sparkline（非静态占位）
