// test/account-360-integration.test.js — 客户360（S06）合并后集成冒烟（独立文件）
// 复用 plm_test 基础设施；无 DB 时仅跑 401 鉴权用例。
// 覆盖 2026-08-29 T2/T3/T4：整页登录闸 + 外部字段只读 + 空画像引导。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';
import { query } from '../src/db.js';

const app = createApp();
const salesTok = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice' });
const auth = { Authorization: 'Bearer ' + salesTok };
const SLUG = 'acct-360-it';

let dbOk = false;
try { await query('SELECT 1'); dbOk = true; } catch { dbOk = false; }

let testAccountId = '';
beforeAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.particles WHERE slug=$1`, [SLUG]);
  const r = await query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
     VALUES (gen_random_uuid(), 'system', 'CRM_ACCOUNT', $1, '360集成空画像客户', 'potential', '{}'::jsonb) RETURNING id`,
    [SLUG]
  );
  testAccountId = r.rows[0]?.id || '';
});
afterAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.particles WHERE slug=$1`, [SLUG]);
});

it('GET /api/page/account-360 缺失 token 返回 401（T2 整页登录闸）', async () => {
  const res = await app.fetch('/api/page/account-360');
  expect(res.status).toBe(401);
});

const db = (name, fn) => (dbOk ? it(name, fn) : it.skip(name, fn));

db('带 token 返回 200 + S06 html（pg-page + 七维 metric-card）', async () => {
  const res = await app.fetch('/api/page/account-360?accountId=' + encodeURIComponent(testAccountId), { headers: auth });
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.html).toContain('pg-page');
  expect(j.html).toContain('pg-metric-card');
});

db('外部采集字段（industry, external）→ input disabled + 待接入提示（T3）', async () => {
  const res = await app.fetch('/api/page/account-360?accountId=' + encodeURIComponent(testAccountId), { headers: auth });
  const j = await res.json();
  expect(j.html).toContain('data-origin-external');
  expect(j.html).toContain('disabled');
  expect(j.html).toContain('待外部源接入');
});

db('空画像客户（缺 industry/region/owner）→ profileHint 非空（T4 引导）', async () => {
  const res = await app.fetch('/api/page/account-360?accountId=' + encodeURIComponent(testAccountId), { headers: auth });
  const j = await res.json();
  expect(j.profileHint).toBeTruthy();
  expect(j.profileHint).toContain('画像缺失');
});

// 2026-09-03 死区修复回归：原 S06 用 crm.tasks（kanban 队列，0 行）做存在性探测 → tasksNonEmpty 恒 false
// →『洞察建议』reasoning 步骤永为 idle。修复后用真实活动信号（crm.events）驱动；有事件则该步骤变 ok。
db('有跟进事件的客户 → S06『洞察建议』reasoning 步骤为 ok（死区修复）', async () => {
  // 独立账户 + 一条 account 关联事件
  const accR = await query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
     VALUES (gen_random_uuid(), 'system', 'CRM_ACCOUNT', $1, '360活动客户', 'potential', '{}'::jsonb) RETURNING id`,
    ['acct-360-act-it']
  );
  const actId = accR.rows[0].id;
  try {
    await query(
      `INSERT INTO crm.events (domain, type, payload, actor, created_at)
       VALUES ('crm', 'event', $1::jsonb, 'system', now() - interval '1 hour')`,
      [JSON.stringify({ account_id: actId, title: '电话沟通', type: 'event' })]
    );
    const res = await app.fetch('/api/page/account-360?accountId=' + encodeURIComponent(actId), { headers: auth });
    const j = await res.json();
    expect(res.status).toBe(200);
    // renderer 输出 <li data-trace-step="ok">洞察建议</li>；修复前为 data-trace-step="idle"
    expect(j.html).toContain('<li data-trace-step="ok">洞察建议</li>');
  } finally {
    await query(`DELETE FROM crm.events WHERE payload->>'account_id'=$1`, [actId]);
    await query(`DELETE FROM crm.particles WHERE id=$1::uuid`, [actId]);
  }
});
