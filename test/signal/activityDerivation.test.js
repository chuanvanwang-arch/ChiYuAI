// test/signal/activityDerivation.test.js — 内部可观测客户异动派生（设计 §3.1 / 契约 T-D1）
// 为什么需要：主张「可以筛选新客户，比如新战略、高层变动、人员招聘」此前只有**一条权重配置**
//   （discoveryRules.js:35），全仓无任何适配器产出这些字段——典型「配置承诺 ≠ 实现」。
//   本文件锁四条可证伪语义：① 真命中；② **反例不命中**（正常实体不得被派生）；
//   ③ 置信语义显式（source=derived + confidence_basis）；④ 幂等（同 dedup_key 不新增）。
//
// ⚠ 2026-09-17 回归组（本文件 [回归] 段）：真库实测发现**判定源错位**——原实现读
//   `entity.payload.updated_at`，但该键在 crm.particles 里**从不写**（38 行 ACCOUNT 全 0 命中），
//   权威时间戳是**列** `updated_at`（schema.sql:24，updateParticle/particleRepo.js:249 每次业务写刷新）。
//   ⇒ 原实现结构上永不可能命中。回退测试只塞 payload 键，替身形状≠生产形状（判据⑤ 替身形状掩缺陷），
//     故旧版 9 例全绿却在真库零产出。修复后：判定源**单一**＝列，且替身按 SQL 的 SELECT 列表**投影**
//     返回行——SQL 若漏取该列，替身即返回 undefined，与生产缺陷同形（形状保真的三重替身）。
import { describe, it, expect } from 'vitest';
import { createActivityDerivation } from '../../src/signal/activityDerivation.js';

const NOW = Date.parse('2026-09-16T12:00:00Z');   // 与下面各行 updated_at 的相对关系即用例语义
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();

const CONFIG = {
  version: 1,
  enabled: true,
  rules: [
    { id: 'contact-ledger-change', kind: 'contact_change', entity_type: 'CRM_CONTACT', window_days: 14,
      severity: 'low', target_role: 'sales', enabled: true, bucket: 'day' },
    { id: 'relation-cooling', kind: 'relation_cooling', entity_type: 'CRM_ACCOUNT', threshold_days: 30,
      severity: 'medium', target_role: 'sales', enabled: true, bucket: 'week' },
  ],
};

// 实体统一用**生产形状**：时间戳落在**顶层列** `updated_at`，payload 内不含该键。
//   （生产 SQL: SELECT id, tenant_id, payload, updated_at FROM crm.particles WHERE type=$1 AND tenant_id=$2）
function makeCtx({ entities = [], config = CONFIG } = {}) {
  const created = [];
  const queries = [];
  return {
    created, queries,
    q: async (sql, params) => {
      queries.push({ sql, params });
      // 按 SQL 的 SELECT 列表投影列集合——替身只回传 SQL 真正取到的列（形状保真）
      const selectList = (sql.match(/select\s+([\s\S]*?)\s+from/i)?.[1] || '').toLowerCase();
      const cols = new Set(selectList.split(',').map((s) => s.trim()));
      // WHERE type=$1 过滤（类型维度）；tenant_id=$2 过滤（租户维度），与生产 SQL 谓词同构
      const type = params?.[0];
      const rows = entities
        .filter((e) => {
          const typeOk = Array.isArray(type) ? type.includes(e.type) : e.type === type;
          return typeOk && (params?.[1] == null || e.tenant_id === params[1]);
        })
        .map((e) => {
          const row = {};
          if (cols.has('id')) row.id = e.id;
          if (cols.has('tenant_id')) row.tenant_id = e.tenant_id;
          if (cols.has('payload')) row.payload = e.payload ?? {};
          if (cols.has('updated_at')) row.updated_at = e.updated_at ?? null;  // ← 未取列则 undefined
          return row;
        });
      return { rows };
    },
    store: { create: async (o) => { created.push(o); return { ok: true, deduped: false }; } },
    readConfig: async () => ({ value: config }),
  };
}

const derive = (ctx) => createActivityDerivation({ query: ctx.q, signalStore: ctx.store, readConfig: ctx.readConfig });

describe('contact_ledger_change（弱代理：客户侧联系人台账变动）', () => {
  it('窗口内 CRM_CONTACT 更新 → 命中，且带 source=derived + confidence_basis', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', updated_at: daysAgo(3), payload: { owner_id: 'alice' } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(ctx.created[0].source).toBe('derived');
    expect(ctx.created[0].kind).toBe('contact_change');
    expect(ctx.created[0].owner_id).toBe('alice');
    expect(ctx.created[0].payload.confidence_basis).toBe('internal_inference');
    expect(ctx.created[0].dedup_key).toContain('derived:contact-ledger-change:c1:');
  });

  it('窗口外的联系人更新 → 不命中（反例）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c2', type: 'CRM_CONTACT', tenant_id: 't1', updated_at: daysAgo(40), payload: {} },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(0);
    expect(ctx.created).toHaveLength(0);
  });

  it('缺 updated_at（列与 payload 皆无）→ 不命中（不把"未知时间"当"刚更新"）', async () => {
    const ctx = makeCtx({ entities: [{ id: 'c3', type: 'CRM_CONTACT', tenant_id: 't1', payload: {} }] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });
});

describe('relation_cooling（关系冷却）', () => {
  it('停滞超过阈值 → 命中 medium', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'a1', type: 'CRM_ACCOUNT', tenant_id: 't1', updated_at: daysAgo(45), payload: { owner_id: 'alice' } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(ctx.created[0].kind).toBe('relation_cooling');
    expect(ctx.created[0].severity).toBe('medium');
  });

  it('近期有更新（未超阈值）→ 不命中（反例：正常实体不得被派生）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'a2', type: 'CRM_ACCOUNT', tenant_id: 't1', updated_at: daysAgo(5), payload: {} },
    ] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });
});

// ── [回归] 2026-09-17 数据面契约修复：判定源＝crm.particles.updated_at **列** ──
// 真库取证：CRM_ACCOUNT 38 行 `payload ? 'updated_at'` = 0；列被业务写维护（system 租户 11/11 行 != created_at）。
// 旧实现读 payload ⇒ relation_cooling 结构性永零命中。以下三例是该缺陷的鉴别器。
describe('[回归] 判定源＝列 updated_at（payload 从无该键）', () => {
  it('payload 无该键、仅列有值 → 必须命中（= 生产真实形状）', async () => {
    const entity = { id: 'c9', type: 'CRM_CONTACT', tenant_id: 't1', updated_at: daysAgo(3), payload: { owner_id: 'alice' } };
    expect(entity.payload.updated_at).toBeUndefined();          // 断言形状：payload 确实无该键
    const ctx = makeCtx({ entities: [entity] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);
    expect(ctx.created[0].evidence.updated_at).toBe(entity.updated_at);   // 证据链取自列
  });

  it('SQL 必须取 updated_at 列（漏取 ⇒ 永久零命中，与生产缺陷同形）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', updated_at: daysAgo(3), payload: {} },
    ] });
    await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    const particleQ = ctx.queries.find((q) => /from\s+crm\.particles/i.test(q.sql));
    expect(particleQ).toBeTruthy();
    expect(particleQ.sql).toMatch(/\bupdated_at\b/i);
  });

  it('payload.updated_at 不参与判定（单一权威源＝列，防退回旧缺陷）', async () => {
    const ctx = makeCtx({ entities: [
      // 仅 payload 有"新鲜"时间戳、列无值 → 不得命中（旧实现会误命中）
      { id: 'c10', type: 'CRM_CONTACT', tenant_id: 't1', payload: { updated_at: daysAgo(1) } },
    ] });
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(0);
  });
});

describe('fail-closed 与幂等', () => {
  it('配置读不到 → 零产出且给出归因（不静默、不造假）', async () => {
    const ctx = makeCtx();
    ctx.readConfig = async () => null;
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(0);
    expect(r.missing[0].reason).toBe('config_missing');
  });

  it('enabled:false → 零产出', async () => {
    const ctx = makeCtx({ config: { ...CONFIG, enabled: false }, entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', updated_at: daysAgo(1), payload: {} },
    ] });
    expect((await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW })).signals).toBe(0);
  });

  it('同实体重复派生 → dedup_key 完全一致（幂等由 store.create 吸收）', async () => {
    const ctx = makeCtx({ entities: [
      { id: 'c1', type: 'CRM_CONTACT', tenant_id: 't1', updated_at: daysAgo(3), payload: {} },
    ] });
    const d = derive(ctx);
    await d.deriveOnce({ tenantId: 't1', now: NOW });
    await d.deriveOnce({ tenantId: 't1', now: NOW + 3600000 });
    expect(ctx.created[0].dedup_key).toBe(ctx.created[1].dedup_key);
  });

  it('纯函数 bucketKey（day/week/month）', async () => {
    const ctx = makeCtx();
    const d = derive(ctx);
    expect(d.bucketKey(NOW, 'day')).toBe('2026-09-16');
    expect(d.bucketKey(NOW, 'month')).toBe('2026-09');
    expect(d.bucketKey(NOW, 'week')).toMatch(/^2026-W\d{2}$/);
  });
});

// ── [补充] 2026-09-17 个人隔离延伸：派生信号的责任人须**穿透到父实体** ──
// 症结：`activityDerivation` 锚定 CRM_CONTACT（联系人自身无 owner_id），原实现 `entity.payload.owner_id`
//   ⇒ owner_id 恒 NULL ⇒ 经 store.list ownerScope 谓词广播给同租户全体销售（用户实测「很多信息是相同的」）。
//   真库取证：12 条 contact_change 全无主，其中 8 条可经 payload.account_id → 父账户 owner_id 解析。
describe('[补充] 责任人穿透：联系人自身无主时经父账户解析', () => {
  const contact = (id, payload, updated = daysAgo(3)) =>
    ({ id, type: 'CRM_CONTACT', tenant_id: 't1', updated_at: updated, payload });

  // 替身需支持父查询（形如 WHERE tenant_id=$1 AND id::text = ANY($2::text[])），与生产 SQL 参数位一致
  const ctxWithAccounts = (contacts, accounts) => {
    const ctx = makeCtx({ entities: [...contacts, ...accounts] });
    const baseQ = ctx.q;
    ctx.q = async (sql, params) => {
      if (/ANY\(\$2::text\[\]\)/i.test(sql)) {
        ctx.queries.push({ sql, params });            // 采样：父查询必须计数，否则 N+1 断言失去鉴别力
        const ids = (params?.[1] || []).map(String);
        return { rows: accounts.filter((a) => ids.includes(String(a.id))).map((a) => ({ id: String(a.id), payload: a.payload })) };
      }
      return baseQ(sql, params);
    };
    return ctx;
  };

  const ACCT_A = { id: 'acc-a', type: 'CRM_ACCOUNT', tenant_id: 't1', updated_at: daysAgo(1), payload: { owner_id: 'alice' } };
  const ACCT_B = { id: 'acc-b', type: 'CRM_ACCOUNT', tenant_id: 't1', updated_at: daysAgo(1), payload: { owner_id: 'bob' } };

  it('【鉴别用例】联系人无自身 owner、父账户有主 → 落父账户责任人（非 NULL 广播）', async () => {
    const ctx = ctxWithAccounts([contact('c1', { account_id: 'acc-a' })], [ACCT_A]);
    const r = await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(r.signals).toBe(1);                       // 守卫自检：确实派生出来了
    expect(ctx.created[0].owner_id).toBe('alice');
  });

  it('不同销售员的联系人各自归属本责任人（这是隔离的实质）', async () => {
    const ctx = ctxWithAccounts(
      [contact('c1', { account_id: 'acc-a' }), contact('c2', { account_id: 'acc-b' })],
      [ACCT_A, ACCT_B],
    );
    await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    const byId = Object.fromEntries(ctx.created.map((c) => [c.particle_id, c.owner_id]));
    expect(byId.c1).toBe('alice');
    expect(byId.c2).toBe('bob');
  });

  it('自身 owner 优先于父（不被父覆盖）', async () => {
    const ctx = ctxWithAccounts([contact('c1', { account_id: 'acc-b', owner_id: 'carol' })], [ACCT_B]);
    await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(ctx.created[0].owner_id).toBe('carol');
  });

  it('fail-closed：父不存在 / 父无主 → null（不猜测责任人，回退按角色广播）', async () => {
    const ctx = ctxWithAccounts(
      [contact('c1', { account_id: 'acc-ghost' })],
      [{ id: 'acc-x', type: 'CRM_ACCOUNT', tenant_id: 't1', updated_at: daysAgo(1), payload: {} }],
    );
    await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    expect(ctx.created[0].owner_id).toBe(null);
  });

  it('同租户同一父账户只查一次（批量解析，非逐实体 N+1 查询）', async () => {
    const ctx = ctxWithAccounts(
      [contact('c1', { account_id: 'acc-a' }), contact('c2', { account_id: 'acc-a' }), contact('c3', { account_id: 'acc-a' })],
      [ACCT_A],
    );
    await derive(ctx).deriveOnce({ tenantId: 't1', now: NOW });
    const parentQs = ctx.queries.filter((q) => /ANY\(\$2::text\[\]\)/i.test(q.sql));
    expect(parentQs).toHaveLength(1);
    expect(parentQs[0].params[1]).toEqual(['acc-a']);
    expect(ctx.created.every((c) => c.owner_id === 'alice')).toBe(true);
  });
});
