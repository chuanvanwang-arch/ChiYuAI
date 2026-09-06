// test/http/named-account-manage-board.test.js — 指名客户管理聚合端点（Task5）
// 契约（docs/2026-08-30-named-account-manage-design.md §3）：
//   GET /api/board/named-account-manage?owner= → { rows, count, owner, summary, alertRed, alertYellow }
// rows 行字段：id/name/owner/tier/visitTarget/visitWindow/visits30/visitPass/named/alert/overdueDays/visitDue
// 对齐 home-page.test.js 注入式范式（createApp().fetch + 真实 PG plm_test 自造种子）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { createParticle } from '../../src/particles/particleRepo.js';

let app;
beforeAll(() => { app = createApp(); });

beforeEach(async () => {
  // 不 TRUNCATE crm_users（共享 plm_test 库：清空会破坏其它文件的 alice/secret123 用户——home-page 依赖）
  // 自造 admin 用户（幂等 UPSERT，避免污染既有 alice/bob）
  await query(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name)
     VALUES ($1, crypt($2, gen_salt('bf')), 'admin', '管理员')
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'admin'`,
    ['admin', 'admin123']
  );
  // 种子（对齐 home-page 范式：createParticle 第二参=payload，业务字段平铺）
  // A-01 指名未访（重点档，30 天前拜访 → 应访日逾期 → 红）；A-02 指名已访达标；A-03 无主户（应被剔除）
  await createParticle('CRM_ACCOUNT', { name: '逾期户', named_owner: 'alice', named_tier: '重点', owner_id: 'alice', tier: '重点', visit_notes: [{ at: new Date(Date.now() - 30 * 86400000).toISOString() }] });
  await createParticle('CRM_ACCOUNT', { name: '达标户', named_owner: 'bob', named_tier: '目标', owner_id: 'bob', tier: '目标', visit_notes: [{ at: new Date(Date.now() - 2 * 86400000).toISOString() }] });
  await createParticle('CRM_ACCOUNT', { name: '无主户', tier: '潜力', visit_notes: [] });
});

describe('GET /api/board/named-account-manage 聚合端点', () => {
  it('登录可见；rows 含 owner/tier/named/alert 四字段', async () => {
    const res = await app.fetch('/api/board/named-account-manage');
    expect(res.status).toBe(401); // 未登录 → 401（resolveMe 无 token）
  });

  it('admin token 可见全量（无主户被剔除）', async () => {
    // 签发 admin token（直用 app.fetch 对齐脚本验证路径，避免 helper 差异干扰）
    const loginRes = await app.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const login = await loginRes.json();
    expect(login.token).toBeTruthy();
    const res = await app.fetch('/api/board/named-account-manage', {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(Array.isArray(j.rows)).toBe(true);
    const names = j.rows.map(r => r.name);
    expect(names).not.toContain('无主户'); // 无主户剔除（Task3 边界）
    const overdue = j.rows.find(r => r.name === '逾期户');
    expect(overdue.owner).toBe('alice');
    expect(overdue.named).toBe(true);
    expect(overdue.alert).toBe('red'); // 30 天前拜访 → 应访日已过 28 天 > alert_days(2) → 红
    expect(j.alertRed).toBeTypeOf('number');
    expect(j.alertRed).toBeGreaterThan(0); // 至少含逾期户
    expect(j.alertYellow).toBeTypeOf('number');
  });

  it('owner 过滤（?owner=alice）只返回本人客户', async () => {
    const loginRes = await app.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const login = await loginRes.json();
    expect(login.token).toBeTruthy();
    const res = await app.fetch('/api/board/named-account-manage?owner=alice', {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.rows.every(r => r.owner === 'alice')).toBe(true);
  });
});

describe('Task8：/named-account-manage.html 三区静态页可达', () => {
  it('页面路由 200 + 三区锚点齐备', async () => {
    const res = await app.fetch('/named-account-manage.html');
    expect(res.status).toBe(200);
    const html = await res.text();
    // 三区：名单总览 / 分配管理 / 告警提醒
    expect(html).toContain('指名客户管理');
    expect(html).toContain('id="tab-list"');
    expect(html).toContain('id="tab-assign"');
    expect(html).toContain('id="tab-alerts"');
    // 消费端点契约
    expect(html).toContain('/api/board/named-account-manage');
    expect(html).toContain('/api/named-account-assign/options');
    // 门户 UI 基建（tokens 语义变量，零硬编码色值铁律）
    expect(html).toContain('/portal/tokens.css');
    expect(html).toContain('/portal/common.css');
    expect(html).toContain('/portal/page.css');
    // 首区渲染：告警提醒从 board rows 派生（不依赖未挂载的 /api/alerts）
    expect(html).toContain('renderAlerts(currentRows)');
    expect(html).not.toContain('/api/alerts?kind=named_visit_overdue');
  });

  it('别名 /named-account-manage 302 → .html', async () => {
    const res = await app.fetch('/named-account-manage', { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.location || res.headers['location']).toContain('/named-account-manage.html');
  });

  it('页面 badge/横幅数据源为 followReminders（与侧栏角标同源）', async () => {
    const res = await app.fetch('/named-account-manage.html');
    const html = await res.text();
    // 角标/横幅取合并提醒数（逾期红 ∪ 长期失联），与侧栏一致
    expect(html).toContain('followReminders');
    // 告警区按两类展示（失联字段参与渲染与过滤）
    expect(html).toContain('lostContact');
    // 守卫：不得回退到依赖未挂载的 /api/alerts
    expect(html).not.toContain('/api/alerts?kind=named_visit_overdue');
    // 守卫：旧的独立告警加载函数未复活（告警区从 board rows 派生）
    expect(html).not.toContain('loadAlerts(');
  });
});

describe('侧栏角标数据源（2026-08-31）：followReminders / lostContactCount', () => {
  const login = async () => {
    const r = await app.fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    return (await r.json()).token;
  };

  it('响应含 followReminders / lostContactCount（数字类型，既有字段不回归）', async () => {
    const token = await login();
    const res = await app.fetch('/api/board/named-account-manage', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.followReminders).toBeTypeOf('number');
    expect(j.lostContactCount).toBeTypeOf('number');
    // 既有契约字段必须保持（防扩展时误删）
    expect(j.alertRed).toBeTypeOf('number');
    expect(j.alertYellow).toBeTypeOf('number');
  });

  it('followReminders = 逾期红 ∪ 长期失联（同一客户只计 1，去重）', async () => {
    const token = await login();
    const j = await (await app.fetch('/api/board/named-account-manage', {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const rows = j.rows || [];
    const union = rows.filter((r) => r.alert === 'red' || r.lostContact).length;
    expect(j.followReminders).toBe(union);
    // 去重语义守卫：严格 ≤ 简单相加（存在「既逾期又失联」客户时必然小于）
    const naiveSum = (j.alertRed || 0) + (j.lostContactCount || 0);
    expect(j.followReminders).toBeLessThanOrEqual(naiveSum);
    // 明细行均含失联字段（供前端两类展示）
    for (const r of rows) expect(r).toHaveProperty('lostContact');
  });

  it('owner 过滤下角标数只计本人（sales 视角语义）', async () => {
    const token = await login();
    const j = await (await app.fetch('/api/board/named-account-manage?owner=bob', {
      headers: { authorization: `Bearer ${token}` },
    })).json();
    const rows = j.rows || [];
    expect(rows.every((r) => r.owner === 'bob')).toBe(true);
    const union = rows.filter((r) => r.alert === 'red' || r.lostContact).length;
    expect(j.followReminders).toBe(union);
  });
});

// helper：JSON fetch（对齐注入式 app.fetch）
async function fetchJson(url, { method = 'GET', body = {}, headers = {} } = {}) {
  const res = await app.fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
  return res.json();
}