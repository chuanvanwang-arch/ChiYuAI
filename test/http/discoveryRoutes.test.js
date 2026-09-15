// test/http/discoveryRoutes.test.js — Task 13: 线索发现只读候选池端点（注入式 DI，零 PG）
// 范式：test/http/configRouter.test.js（createXxxRouter(deps) + router.handlers 直调，不连库）
// 断言面：只读候选池投影 / 已评分过滤 / auth 403 / 租户透传 / 零写零删 / 错误路径 500
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createDiscoveryRouter } from '../../src/http/discoveryRoutes.js';

// fake 依赖：resolveMe 替身 + list 替身（不触真实 DB）
function makeDeps({ me = { ok: true, role: 'sales', tenantId: 't1' }, rows = [], throwList = false } = {}) {
  let observedTenantId = null;
  const list = async (m, q, tenantId) => {
    observedTenantId = tenantId || null;
    if (throwList) throw new Error('boom');
    return rows;
  };
  return {
    resolveMe: () => me,
    list,
    get observedTenantId() { return observedTenantId; },
  };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.body = o; return res; };
  return res;
}

// 富集六元（buildEnrichmentPayload 同形状）：provider / confidence / ts / layer / source
const enrich = {
  funding_round: { provider: 'attio', confidence: 0.9, ts: 't', layer: 'L2', source: 'ontologySync' },
  tech_adopt: { provider: 'builtin', confidence: 0.8, ts: 't', layer: 'L2', source: 'provider_adapter' },
};

// 已评分 row：icp_fit_score 是嵌套对象 {value, judge}
const scoredRow = {
  id: 'acc-1',
  slug: 'acme',
  payload: {
    name: 'Acme Inc',
    discovery: {
      name: 'Acme Inc',
      icp_fit_score: { value: 0.5, judge: { axis: 'capability', rule_ref: 'scenario:lead-fit#ruler:industry', j_score: 0.5 } },
      intent_score: { value: 0.7, judge: {} },
      signals: [{ type: 'funding_round' }, { type: 'tech_adopt' }],
      why_narrative: '由 discovery scenario 判定为目标客户',
    },
    enrichment: enrich,
  },
};

describe('createDiscoveryRouter 只读候选池端点（零写零删）', () => {
  it('只读返回候选池：嵌套 .value 取 0.5，sources 从 enrichment 汇总', async () => {
    const deps = makeDeps({ rows: [scoredRow] });
    const router = createDiscoveryRouter({ resolveMe: deps.resolveMe, list: deps.list });
    const res = fakeRes();
    await router.handlers.candidates({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].account_id).toBe('acc-1');
    expect(res.body.items[0].icp_fit_score).toBe(0.5); // 嵌套对象取 .value
    expect(res.body.items[0].sources).toEqual(['ontologySync', 'provider_adapter']);
    expect(res.body.items[0].providers).toEqual(['attio', 'builtin']);
    expect(res.body.items[0].rule_ref).toBe('scenario:lead-fit#ruler:industry');
    expect(res.body.items[0].j_score).toBe(0.5);
  });

  it('已评分过滤：未评分 row 被滤掉；icp_fit_score 0 保留', async () => {
    const unScored = {
      id: 'acc-2',
      payload: { name: 'NoScore Co', discovery: { signals: [], why_narrative: '' } },
    };
    const zeroScored = {
      id: 'acc-3',
      payload: { name: 'Zero Co', discovery: { icp_fit_score: { value: 0, judge: {} }, signals: [] } },
    };
    const deps = makeDeps({ rows: [scoredRow, unScored, zeroScored] });
    const router = createDiscoveryRouter({ resolveMe: deps.resolveMe, list: deps.list });
    const res = fakeRes();
    await router.handlers.candidates({ query: {} }, res);
    expect(res.body.items.map((x) => x.account_id)).toEqual(['acc-1', 'acc-3']);
    expect(res.body.items[1].icp_fit_score).toBe(0); // 0 是有效候选
  });

  it('auth 闸：resolveMe {ok:false} → 403；{ok:true, role:sales} → 200', async () => {
    const bad = makeDeps({ me: { ok: false } });
    const badRouter = createDiscoveryRouter({ resolveMe: bad.resolveMe, list: bad.list });
    const badRes = fakeRes();
    await badRouter.handlers.candidates({ query: {} }, badRes);
    expect(badRes.statusCode).toBe(403);
    expect(badRes.body.error).toBe('auth required');

    const good = makeDeps({ me: { ok: true, role: 'sales', tenantId: 't1' } });
    const goodRouter = createDiscoveryRouter({ resolveMe: good.resolveMe, list: good.list });
    const goodRes = fakeRes();
    await goodRouter.handlers.candidates({ query: {} }, goodRes);
    expect(goodRes.statusCode).toBe(200);
  });

  it('租户透传：applyTenantOverride 求出的 tenantId 传给 list（me.tenantId=t1 → list 收到 t1）', async () => {
    const deps = makeDeps({ me: { ok: true, role: 'sales', tenantId: 't1' }, rows: [] });
    const router = createDiscoveryRouter({ resolveMe: deps.resolveMe, list: deps.list });
    const res = fakeRes();
    await router.handlers.candidates({ query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(deps.observedTenantId).toBe('t1');
  });

  it('源文件零写零删：无 DELETE FROM / .delete( / 无 POST / PUT / DELETE 路由', () => {
    const src = readFileSync(new URL('../../src/http/discoveryRoutes.js', import.meta.url), 'utf8');
    expect(/DELETE\s+FROM|\.delete\s*\(/i.test(src)).toBe(false);
    expect(/router\.post\s*\(|router\.put\s*\(|router\.delete\s*\(/.test(src)).toBe(false);
    expect(/router\.get\s*\(/.test(src)).toBe(true); // 只读面仅有 GET
  });

  it('错误路径：list 替身 throw → 500 {error}', async () => {
    const deps = makeDeps({ rows: [], throwList: true });
    const router = createDiscoveryRouter({ resolveMe: deps.resolveMe, list: deps.list });
    const res = fakeRes();
    await router.handlers.candidates({ query: {} }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('boom');
  });
});
