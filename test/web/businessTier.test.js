import { test, expect } from 'vitest';
import { renderBusinessTier, tierRank, tierBadge, createBusinessTierRouter } from '../../src/portal/businessTier.js';

// ---- 渲染纯函数 ----
test('tierRank: HIGH>NORMAL>LEAD, 未知=0', () => {
  expect(tierRank('HIGH')).toBe(3);
  expect(tierRank('NORMAL')).toBe(2);
  expect(tierRank('LEAD')).toBe(1);
  expect(tierRank('UNKNOWN')).toBe(0);
  expect(tierRank(null)).toBe(0);
});

test('tierBadge: 三色 class', () => {
  expect(tierBadge('HIGH')).toContain('tier-high');
  expect(tierBadge('NORMAL')).toContain('tier-normal');
  expect(tierBadge('LEAD')).toContain('tier-lead');
});

test('renderBusinessTier: 注入 2 行含 dimension 与 tier badge', () => {
  const html = renderBusinessTier([
    { dimension: 'customer', dimension_value: '战略客户', tier: 'HIGH' },
    { dimension: 'project', dimension_value: '百万级', tier: 'NORMAL' },
  ]);
  expect(html).toContain('战略客户');
  expect(html).toContain('百万级');
  expect(html).toContain('tier-high');
  expect(html).toContain('tier-normal');
  expect(html).toContain('business-tier-row');
});

test('renderBusinessTier: 空数组降级未配置', () => {
  const html = renderBusinessTier([]);
  expect(html).toContain('尚未配置');
  expect(html).not.toContain('business-tier-row');
});

// ---- handler（注入式）----
function makeRouter(deps) {
  const calls = { list: 0, upsert: 0, produce: 0 };
  const router = createBusinessTierRouter({
    listTiers: async () => {
      calls.list++;
      return [{ dimension: 'customer', dimension_value: 'v', tier: 'HIGH' }];
    },
    upsertTier: async (d, v, t) => {
      calls.upsert++;
      return { dimension: d, dimension_value: v, tier: t };
    },
    produceDecision: async () => {
      calls.produce++;
      return { decisionId: 'dec-1', ok: true };
    },
  });
  return { router, calls };
}

function fakeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

test('handler GET: 返回全表行', async () => {
  const { router, calls } = makeRouter();
  const res = fakeRes();
  await router.handlers.get({}, res);
  expect(calls.list).toBe(1);
  expect(res.body.rows).toHaveLength(1);
  expect(res.body.rows[0].tier).toBe('HIGH');
});

test('handler PUT: 缺字段 400', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  await router.handlers.put({ body: { dimension: 'customer' } }, res);
  expect(res.statusCode).toBe(400);
});

test('handler PUT: 非法 dimension 400', async () => {
  const { router } = makeRouter();
  const res = fakeRes();
  await router.handlers.put({ body: { dimension: 'x', dimension_value: 'v', tier: 'HIGH' } }, res);
  expect(res.statusCode).toBe(400);
});

test('handler PUT: 合法触发 produceDecision + upsertTier', async () => {
  const { router, calls } = makeRouter();
  const res = fakeRes();
  await router.handlers.put(
    { body: { dimension: 'customer', dimension_value: '战略客户', tier: 'HIGH' } },
    res
  );
  expect(calls.produce).toBe(1);
  expect(calls.upsert).toBe(1);
  expect(res.statusCode).toBe(200);
  expect(res.body.row.tier).toBe('HIGH');
  expect(res.body.decision).toBe('dec-1');
});
