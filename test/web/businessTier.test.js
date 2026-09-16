import { test, expect } from 'vitest';
import { renderBusinessTier, tierRank, tierBadge, tierStatus, createBusinessTierRouter } from '../../src/portal/businessTier.js';

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
  const calls = { list: 0, upsert: 0, produce: 0, revoke: 0 };
  const router = createBusinessTierRouter({
    listTiers: async () => {
      calls.list++;
      return [{ dimension: 'customer', dimension_value: 'v', tier: 'HIGH' }];
    },
    upsertTier: async (d, v, t) => {
      calls.upsert++;
      return { dimension: d, dimension_value: v, tier: t };
    },
    revokeTier: async (d, v, reason) => {
      calls.revoke++;
      // 默认模拟"命中一行"；用 deps.revokeMiss 模拟"不存在/已撤回"（返回 null）
      if (deps?.revokeMiss) return null;
      return { dimension: d, dimension_value: v, tier: 'HIGH', revoked_at: '2026-09-16T00:00:00Z', revoked_reason: reason };
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

test('handler PUT: expires_at 非法 → 400（不能静默存成 Invalid Date = 永不过期）', async () => {
  const { router, calls } = makeRouter();
  const res = fakeRes();
  await router.handlers.put(
    { body: { dimension: 'customer', dimension_value: 'v', tier: 'HIGH', expires_at: '不是日期' } },
    res
  );
  expect(res.statusCode).toBe(400);
  expect(calls.upsert).toBe(0); // 关键：非法输入不得落库
});

// ---- A4 撤回（2026-09-16）----
// 这里是**状态派生**与**撤回入口**的哨兵；"撤回后不再参与判定"的端到端证明在
// test/business-tier-tenant.integration.test.js（必须打真 DB——mock 证明不了 SQL 过滤生效）。
test('tierStatus: revoked > expired > active 派生（不设 status 列，单一事实源）', () => {
  const now = new Date('2026-09-16T00:00:00Z');
  expect(tierStatus({}, now)).toBe('active');
  expect(tierStatus({ expires_at: '2026-12-31T00:00:00Z' }, now)).toBe('active');
  expect(tierStatus({ expires_at: '2026-01-01T00:00:00Z' }, now)).toBe('expired');
  expect(tierStatus({ revoked_at: '2026-09-01T00:00:00Z' }, now)).toBe('revoked');
  // 两者同时成立 → 撤回优先（撤回是主动行为，比时间流逝更能解释"为什么没生效"）
  expect(tierStatus({ revoked_at: '2026-09-01T00:00:00Z', expires_at: '2026-01-01T00:00:00Z' }, now)).toBe('revoked');
});

test('renderBusinessTier: 生效行给撤回按钮，撤回行灰显且不给按钮', () => {
  const html = renderBusinessTier([
    { dimension: 'customer', dimension_value: 'A客户', tier: 'HIGH', approved_by: 'alice' },
    { dimension: 'project', dimension_value: 'B项目', tier: 'LEAD', revoked_at: '2026-09-01T00:00:00Z', revoked_reason: '政策变更' },
  ]);
  expect(html).toContain('status-active');
  expect(html).toContain('status-revoked');
  expect(html).toContain('row-inactive');
  expect(html).toContain('alice');
  // 只有一个撤回按钮（生效行）——已撤回行重复撤回无意义
  expect(html.match(/btn-revoke/g) || []).toHaveLength(1);
});

test('renderBusinessTier: dimension_value 转义（PUT body 直入 → 防存储型 XSS）', () => {
  const html = renderBusinessTier([
    { dimension: 'customer', dimension_value: '<img src=x onerror=alert(1)>', tier: 'HIGH' },
  ]);
  expect(html).not.toContain('<img src=x');
  expect(html).toContain('&lt;img');
});

test('handler revoke: 合法触发 produceDecision + revokeTier，且复用第0闸凭据', async () => {
  const { router, calls } = makeRouter();
  const res = fakeRes();
  await router.handlers.revoke(
    { body: { dimension: 'customer', dimension_value: 'v', reason: '政策变更' } },
    res
  );
  expect(calls.produce).toBe(1);
  expect(calls.revoke).toBe(1);
  expect(res.statusCode).toBe(200);
  expect(res.body.row.revoked_reason).toBe('政策变更');
  expect(res.body.decision).toBe('dec-1');
});

test('handler revoke: 缺字段 400；非法 dimension 400', async () => {
  const { router } = makeRouter();
  const r1 = fakeRes();
  await router.handlers.revoke({ body: { dimension: 'customer' } }, r1);
  expect(r1.statusCode).toBe(400);
  const r2 = fakeRes();
  await router.handlers.revoke({ body: { dimension: 'zzz', dimension_value: 'v' } }, r2);
  expect(r2.statusCode).toBe(400);
});

test('handler revoke: 未命中（不存在或已撤回）→ 404 而非静默成功', async () => {
  const { router } = makeRouter({ revokeMiss: true });
  const res = fakeRes();
  await router.handlers.revoke({ body: { dimension: 'customer', dimension_value: 'nope' } }, res);
  expect(res.statusCode).toBe(404);
});
