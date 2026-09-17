// test/leadPoolPage.test.js — 公海池菜单页链路单测（T1–T6）
// 真实范式：createApp() + issueToken + 真连 crm_native_test + beforeEach TRUNCATE
// 不依赖任何假设性脚手架（无 createTestApp/seedTenant）。
// 造数用 queryWrite 原生 INSERT（绕过 createParticle 的 resolvePrototype/meta 校验慢路径）。
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/http/server.js';
import { query, queryWrite } from '../src/db.js';
import { issueToken } from '../src/http/auth.js';
import { createLeadFromTender } from '../src/connectors/tenderConnector.js';

const app = createApp();
const mkDeal = (tenantId, name, stage, source = 'discovery') =>
  queryWrite(
    `INSERT INTO particles (tenant_id, type, slug, title, state, payload, decision_id)
     VALUES ($1, 'CRM_DEAL', 'crm-deal', $2, 'ACTIVE', $3::jsonb, NULL) RETURNING id`,
    [tenantId, name, JSON.stringify({ name, stage, source })]
  );
const getDeal = async (id) =>
  (await query(`SELECT payload FROM particles WHERE id=$1`, [id])).rows[0].payload;

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('GET /api/lead-pool', () => {
  it('返回 truncated/total 且跨租户不可见', async () => {
    const tokA = issueToken({ username: 'salesA', role: 'sales', tenantId: 'tA' });
    const tokB = issueToken({ username: 'salesB', role: 'sales', tenantId: 'tB' });
    for (let i = 0; i < 120; i++) await mkDeal('tA', `A${i}`, 'S0');
    for (let i = 0; i < 5; i++) await mkDeal('tB', `B${i}`, 'S0');
    const rA = await app.fetch('/api/lead-pool', { headers: { authorization: `Bearer ${tokA}` } });
    expect(rA.status).toBe(200);
    const jA = await rA.json();
    expect(jA.returned).toBe(100);
    expect(jA.truncated).toBe(true);
    expect(jA.total).toBe(120);
    expect(jA.items.every((x) => x.id && typeof x.in_pool_days === 'number')).toBe(true);
    const rB = await app.fetch('/api/lead-pool', { headers: { authorization: `Bearer ${tokB}` } });
    expect((await rB.json()).total).toBe(5);
  }, 30000);

  it('非 S0 阶段不入公海列表', async () => {
    const tok = issueToken({ username: 'salesC', role: 'sales', tenantId: 'tC' });
    await mkDeal('tC', 'lead', 'S0');
    await mkDeal('tC', 's1', 'S1');
    const j = await (await app.fetch('/api/lead-pool', { headers: { authorization: `Bearer ${tok}` } })).json();
    expect(j.total).toBe(1);
    expect(j.items[0].name).toBe('lead');
  }, 30000);

  it('返回 rules 与 my_pick_today', async () => {
    const tok = issueToken({ username: 'salesD', role: 'sales', tenantId: 'tD' });
    await mkDeal('tD', 'a', 'S0');
    const j = await (await app.fetch('/api/lead-pool', { headers: { authorization: `Bearer ${tok}` } })).json();
    expect(j.rules && typeof j.rules.daily_limit === 'number').toBe(true);
    expect(typeof j.my_pick_today).toBe('number');
    expect(typeof j.my_can_pick).toBe('boolean');
  }, 30000);

  it('P0-1c：items 含 freshness 且按信号 ts 分档（hot/warm/stale/unknown）', async () => {
    const tok = issueToken({ username: 'salesE', role: 'sales', tenantId: 'tE' });
    const now = Date.now();
    // 三条 S0：hot（2d 前信号）、stale（120d 前信号）、无信号
    await queryWrite(
      `INSERT INTO particles (tenant_id, type, slug, title, state, payload)
       VALUES ($1,'CRM_DEAL','crm-deal',$2,'ACTIVE',$3::jsonb)`,
      ['tE', 'hot-lead', JSON.stringify({
        name: 'hot-lead', stage: 'S0', source: 'discovery',
        signals: [{ type: 'funding_round', ts: new Date(now - 2 * 86400000).toISOString() }],
      })]
    );
    await queryWrite(
      `INSERT INTO particles (tenant_id, type, slug, title, state, payload)
       VALUES ($1,'CRM_DEAL','crm-deal',$2,'ACTIVE',$3::jsonb)`,
      ['tE', 'stale-lead', JSON.stringify({
        name: 'stale-lead', stage: 'S0', source: 'tender',
        signals: [{ type: 'tender_match', ts: new Date(now - 120 * 86400000).toISOString() }],
      })]
    );
    await queryWrite(
      `INSERT INTO particles (tenant_id, type, slug, title, state, payload)
       VALUES ($1,'CRM_DEAL','crm-deal',$2,'ACTIVE',$3::jsonb)`,
      ['tE', 'no-signal-lead', JSON.stringify({ name: 'no-signal-lead', stage: 'S0', source: 'manual' })]
    );
    const j = await (await app.fetch('/api/lead-pool', { headers: { authorization: `Bearer ${tok}` } })).json();
    const byName = Object.fromEntries(j.items.map((x) => [x.name, x.freshness]));
    expect(byName['hot-lead']).toBe('hot');
    expect(byName['stale-lead']).toBe('stale');
    expect(byName['no-signal-lead']).toBe('unknown');
  }, 30000);
});

describe('POST /api/lead-pool/:id/pick', () => {
  it('未登录 401', async () => {
    const r = await app.fetch('/api/lead-pool/deal_x/pick', { method: 'POST' });
    expect(r.status).toBe(401);
  });

  // 2026-09-18 收窄断言范围：原测试名把「缺租户」与「system 视界」混为一谈，但其 fixture
  //   （issueToken 无 tenantId）实际只覆盖前者。显式 system 租户**不应** fail-closed
  //   —— 它与 Action 层语义一致（executor.js「显式 system 租户恒全权益」），
  //   专测见 test/http/leadPoolPickTenantGate.test.js（含两层闸一致性）。
  it('缺租户（token 无 tenantId）fail-closed（不静默得 system 全权益）', async () => {
    const noTenant = issueToken({ username: 'ghost', role: 'sales' }); // 无 tenantId → resolveMe 兜底 system
    const r = await app.fetch('/api/lead-pool/deal_x/pick', {
      method: 'POST', headers: { authorization: `Bearer ${noTenant}` },
    });
    expect(r.status).toBe(400);
    const j = await r.json();
    expect(j.ok).toBe(false);
    expect(j.gate).toBe('plan_entitlement_missing_tenant');
  });

  it('S0 认领成功 → S0P + owner 设置', async () => {
    const tok = issueToken({ username: 'picker', role: 'sales', tenantId: 'tP' });
    const id = (await mkDeal('tP', 'toPick', 'S0')).rows[0].id;
    const r = await app.fetch(`/api/lead-pool/${id}/pick`, {
      method: 'POST', headers: { authorization: `Bearer ${tok}` },
    });
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.ok).toBe(true);
    const after = await getDeal(id);
    expect(after.stage).toBe('S0P');
    expect(after.owner_id).toBe('picker');
  }, 30000);
});

describe('crm-lead-pick 并发安全（CAS）', () => {
  it('并行两次认领同一条 S0，仅 1 次成功', async () => {
    const tok = issueToken({ username: 'conc', role: 'sales', tenantId: 'tC2' });
    const id = (await mkDeal('tC2', 'conc', 'S0')).rows[0].id;
    const fire = () => app.fetch(`/api/lead-pool/${id}/pick`, {
      method: 'POST', headers: { authorization: `Bearer ${tok}` },
    }).then((r) => r.json());
    const [a, b] = await Promise.all([fire(), fire()]);
    const okCount = [a, b].filter((x) => x.ok === true).length;
    expect(okCount).toBe(1);
    const after = await getDeal(id);
    expect(after.stage).toBe('S0P');
    expect(after.owner_id).toBe('conc');
  }, 30000);
});

describe('pooled_at 写入与回填（T4）', () => {
  it('存量回填幂等：重复执行无新增变更', async () => {
    const tokA = issueToken({ username: 'pa', role: 'sales', tenantId: 'tPA' });
    for (let i = 0; i < 10; i++) await mkDeal('tPA', `pa${i}`, 'S0'); // mkDeal 不写 pooled_at
    const atSql = `UPDATE crm.particles SET payload = payload || jsonb_build_object('pooled_at', to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) WHERE type='CRM_DEAL' AND payload->>'stage'='S0' AND payload->>'pooled_at' IS NULL;`;
    const nullCount = async () => (await query(
      `SELECT count(*)::int n FROM crm.particles WHERE tenant_id=$1 AND payload->>'stage'='S0' AND payload->>'pooled_at' IS NULL`,
      ['tPA']
    )).rows[0].n;
    await queryWrite(atSql, []);
    const after1 = await nullCount();
    await queryWrite(atSql, []); // 再跑一次
    const after2 = await nullCount();
    expect(after1).toBe(0);
    expect(after2).toBe(0);
  }, 30000);

  it('in_pool_days 用 pooled_at（非 created_at）', async () => {
    const tok = issueToken({ username: 'pb', role: 'sales', tenantId: 'tPB' });
    const past = new Date(Date.now() - 2 * 86400000).toISOString();
    await queryWrite(
      `INSERT INTO particles (tenant_id, type, slug, title, state, payload, decision_id)
       VALUES ($1, 'CRM_DEAL', 'crm-deal', $2, 'ACTIVE', $3::jsonb, NULL) RETURNING id`,
      ['tPB', 'oldpool', JSON.stringify({ name: 'oldpool', stage: 'S0', source: 'discovery', pooled_at: past })]
    );
    const j = await (await app.fetch('/api/lead-pool', { headers: { authorization: `Bearer ${tok}` } })).json();
    const item = j.items.find((x) => x.name === 'oldpool');
    expect(item).toBeTruthy();
    expect(item.in_pool_days).toBeGreaterThanOrEqual(1);
  }, 30000);

  it('获客写入源（标讯）落 S0 带 pooled_at', async () => {
    const deal = await createLeadFromTender({
      tender: { id: 'tnd-1', title: '标讯线索A', amount: 100000, region: '华东', knowledge_id: 'k-1' },
      tenantId: 'tPC',
    });
    const p = (await query(`SELECT payload FROM crm.particles WHERE id=$1`, [deal.id])).rows[0].payload;
    expect(p.stage).toBe('S0');
    expect(p.pooled_at).toBeTruthy();
  }, 30000);
});

describe('lead-pool.html 页面（T5 + 需求① 私海回退闭环）', () => {
  it('存在且含公海池关键交互节点', async () => {
    const html = readFileSync('src/web/lead-pool.html', 'utf8');
    expect(html).toContain("import { injectLayout } from '/portal/layout.js'");
    expect(html).toContain('/api/lead-pool');
    expect(html).toContain('/api/lead-pool/${id}/pick');
    expect(html).toContain('pool-config.html'); // 空态互链
  });

  it('含「我的私海」Tab + 回退公海按钮（需求① 认领/回退闭环前端）', () => {
    const html = readFileSync('src/web/lead-pool.html', 'utf8');
    expect(html).toContain('data-panel="panel-mine"');
    expect(html).toContain('/api/lead-pool/mine');       // 私海只读端点（S0P 归属=我）
    expect(html).toContain("fetch('/api/action/crm-lead-return'"); // 回退写走既有 Action
    expect(html).toContain('reason_code');               // 回退原因必选（RETURN_REASONS）
    expect(html).toContain('no_project');                // 原因枚举与后端 RETURN_REASONS 同源
  });

  it('Express 已注册 /lead-pool.html 路由，GET 返回 HTML', async () => {
    const r = await app.fetch('/lead-pool.html');
    expect(r.status).toBe(200);
    const ct = r.headers['content-type'] || '';
    expect(ct).toMatch(/text\/html/);
    const body = await r.text();
    expect(body).toContain('公海池');
  });
});
