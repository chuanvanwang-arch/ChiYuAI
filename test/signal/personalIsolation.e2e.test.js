// test/signal/personalIsolation.e2e.test.js — 行为巡检信号按人隔离的**真库**端到端取证（2026-09-17）
//
// 为什么必须是真库（对齐 tenant-scope-isolation-guard 步骤 6）：
//   替身断言只能证明「参数传了」，不能证明「owner 落库了、读谓词真的把人挡住了」。
//   隔离的失败模式是**静默不生效**——只有「他人看不到」那一行输出才是生效的证据。
//
// 三个专属租户，各验一件事（互不干扰，避免一个场景的构造把另一个场景的前提推翻）：
//   T  — 个人口径：alice 全达标 / bob 全零 → 租户**合计达标**，旧实现会漏报 bob
//   TT — 团队作用域：全员未达标 → 团队级只广播给 manager，销售员看不到
//   TD — 去重与新鲜度：同 dedup_key 不堆行，但指标必须被刷新（否则是陈旧假绿）
//
// 隔离性：专属租户 id，前后各清一次；不清空整表，不影响其他测试文件的数据。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { pool } from '../../src/db.js';
import { salesDailyScan } from '../../src/scheduler/salesDailyScan.js';
import { mergedThresholds } from '../../src/sales/salesThresholds.js';
import { createAlertWithDb, resetAlertStore } from '../../src/alerts/alertStore.js';
import { createSignalStore } from '../../src/signal/store.js';
import { signalOwnerScope } from '../../src/http/tenantScope.js';

const T = 'probe-personal-iso';
const TT = 'probe-team-scope';
const TD = 'probe-dedup-fresh';
const ALL = [T, TT, TD];
const store = createSignalStore(pool);

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
const todayNote = () => ({ at: new Date().toISOString() });
const acct = (id, owner, { today = 0, week = 0, createdDaysAgo = 30 } = {}) => ({
  id, type: 'CRM_ACCOUNT', created_at: daysAgo(createdDaysAgo),
  payload: {
    name: id, tier: '潜力', owner_id: owner,
    visit_notes: [...Array.from({ length: today }, todayNote),
      ...Array.from({ length: Math.max(0, week - today) }, () => ({ at: daysAgo(3) }))],
  },
});

// alice 全达标（今日 3 / 本周 15 / 周新增 5）；bob 全零。
// 租户合计恰好达标 → 团队级不告警 —— 这正是旧实现漏报 bob 的构造。
const ACCOUNTS = [
  acct('iso-a1', 'alice', { today: 3, week: 15, createdDaysAgo: 1 }),
  acct('iso-a2', 'alice', { createdDaysAgo: 2 }),
  acct('iso-a3', 'alice', { createdDaysAgo: 3 }),
  acct('iso-a4', 'alice', { createdDaysAgo: 4 }),
  acct('iso-a5', 'alice', { createdDaysAgo: 5 }),
  acct('iso-b1', 'bob', { createdDaysAgo: 30 }),
];
// 全员未达标（团队合计也不达标）
const TEAM_ACCOUNTS = [acct('team-c1', 'carol', { createdDaysAgo: 30 })];

// 复刻产生点的落库形态（与 src/scheduler/timers.js 的 sales-daily-scan 逐字段一致）
async function persist(tenant, accounts) {
  const hits = salesDailyScan({ accounts, deals: [], thresholds: mergedThresholds({}) });
  for (const h of hits) {
    await createAlertWithDb(pool, {
      kind: h.kind, severity: h.severity,
      target_role: h.target_role || (h.severity === 'high' ? 'exec' : 'sales'),
      tenant_id: tenant, particle_id: h.particle_id, payload: h.metric,
      owner_id: h.owner_id || null,
      dedup_key: h.dedup_key || null,
    });
  }
  return hits;
}

const scopeOf = (username, role) => signalOwnerScope({ username, role });
const listAs = (tenant, username, role) => store.list({ tenant_id: tenant, ownerScope: scopeOf(username, role) });
const clean = () => pool.query('DELETE FROM crm.signal WHERE tenant_id = ANY($1::text[])', [ALL]);

beforeAll(async () => { await clean(); resetAlertStore(); });
afterAll(async () => { await clean(); });

describe('① 个人口径：按人算，不是租户合计', () => {
  it('alice 达标 → 无告警；bob 全零 → 有告警（旧实现只判合计会漏报）', async () => {
    const hits = await persist(T, ACCOUNTS);
    // 租户合计达标 → 无团队级 hit
    expect(hits.filter(h => h.owner_id === null)).toHaveLength(0);
    // 但 bob 必须被报出来
    expect(hits.filter(h => h.owner_id === 'bob').length).toBeGreaterThan(0);

    const { rows } = await pool.query(
      `SELECT DISTINCT owner_id FROM crm.signal WHERE tenant_id=$1`, [T],
    );
    expect(rows.map(r => r.owner_id)).toEqual(['bob']); // 只有 bob 被落库，且已带责任人
  });
});

describe('② 可见面：销售员看不到团队级与他人信号', () => {
  it('alice 空 / bob 只见自己的 / 经理见团队级不见个人级', async () => {
    await persist(TT, TEAM_ACCOUNTS);

    const alice = await listAs(T, 'alice', 'sales');
    const bob = await listAs(T, 'bob', 'sales');
    const mgr = await listAs(TT, 'manager', 'manager');
    const carol = await listAs(TT, 'carol', 'sales');

    // alice 达标 → 一条都不该看到（若看到 bob 的，说明隔离没生效）
    expect(alice).toHaveLength(0);

    // bob 看到自己的个人级
    expect(bob.length).toBeGreaterThan(0);
    expect(bob.every(r => r.owner_id === 'bob')).toBe(true);

    // 经理看到团队合计（owner_id IS NULL），看不到下属个人的告警
    expect(mgr.length).toBeGreaterThan(0);
    expect(mgr.every(r => r.owner_id === null)).toBe(true);
    expect(mgr.every(r => r.target_role === 'manager')).toBe(true);

    // carol（销售员）看不到团队级 —— 团队 KPI 不再广播给全体销售
    expect(carol.length).toBeGreaterThan(0);
    expect(carol.some(r => r.owner_id === null)).toBe(false);
    expect(carol.every(r => r.owner_id === 'carol')).toBe(true);

    // 三者可见行两两不同（防"大家看到同一条"复现）
    const ids = (rs) => rs.map(r => r.signal_id).sort().join(',');
    expect(ids(alice)).not.toBe(ids(bob));
    expect(ids(carol)).not.toBe(ids(mgr));
  });

  it('管理员（ownerScope=null）仍见该租户全量 —— 管理例外未被破坏', async () => {
    const all = await listAs(T, 'admin', 'admin');
    const { rows } = await pool.query('SELECT COUNT(*)::int n FROM crm.signal WHERE tenant_id=$1', [T]);
    expect(all.length).toBe(rows[0].n);
    expect(all.length).toBeGreaterThan(0);
  });

  it('身份缺失 → fail-closed（0 行，不是全量）', async () => {
    const anon = await store.list({ tenant_id: T, ownerScope: signalOwnerScope({}) });
    expect(anon).toHaveLength(0);
  });
});

describe('③ 去重与新鲜度：不堆行，但指标必须刷新', () => {
  it('重复扫描行数不变；指标变化时 payload 跟着更新', async () => {
    await persist(TD, [acct('ded-b1', 'bob', { createdDaysAgo: 30 })]);
    const n0 = (await pool.query('SELECT COUNT(*)::int n FROM crm.signal WHERE tenant_id=$1', [TD])).rows[0].n;
    expect(n0).toBeGreaterThan(0);

    // 同输入再扫一次 → 全部命中去重，行数不增
    await persist(TD, [acct('ded-b1', 'bob', { createdDaysAgo: 30 })]);
    const n1 = (await pool.query('SELECT COUNT(*)::int n FROM crm.signal WHERE tenant_id=$1', [TD])).rows[0].n;
    expect(n1).toBe(n0);

    // bob 有了 2 次拜访 → 指标必须刷新，且仍不堆行
    await persist(TD, [acct('ded-b1', 'bob', { today: 2, week: 2, createdDaysAgo: 30 })]);
    const n2 = (await pool.query('SELECT COUNT(*)::int n FROM crm.signal WHERE tenant_id=$1', [TD])).rows[0].n;
    expect(n2).toBe(n0);

    const { rows } = await pool.query(
      `SELECT payload FROM crm.signal
        WHERE tenant_id=$1 AND owner_id='bob' AND kind='visit_shortfall' AND payload ? 'dailyVisits'`,
      [TD],
    );
    expect(Number(rows[0].payload.dailyVisits)).toBe(2); // 新值，不是首次落库时的 0
  });

  it('达标后陈旧快照被关闭（稳定 dedup_key 的必然配套）', async () => {
    const r = await store.closeStaleAggregates({ tenant_id: TD, kind: 'visit_shortfall', keep: [], reason: 'recovered' });
    expect(r.ok).toBe(true);
    expect(r.closed.length).toBeGreaterThan(0);
    const left = (await pool.query(
      `SELECT COUNT(*)::int n FROM crm.signal WHERE tenant_id=$1 AND kind='visit_shortfall' AND status IN ('open','acked')`,
      [TD],
    )).rows[0].n;
    expect(left).toBe(0);
    // 留痕：状态与原因已写，行未删除（零 DELETE）
    const { rows } = await pool.query(
      `SELECT status, closed_reason FROM crm.signal WHERE tenant_id=$1 AND kind='visit_shortfall' LIMIT 1`, [TD],
    );
    expect(rows[0].status).toBe('closed');
    expect(rows[0].closed_reason).toBe('recovered');
  });
});
