// test/account-insight-integration.test.js — 客户洞察 集成冒烟（独立文件）
// 与既有 auth.test.js / http.test.js 共用 plm_test 基础设施；无 DB 时自动跳过 DB 用例，仅跑 401 鉴权用例。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../src/http/server.js';
import { issueToken } from '../src/http/auth.js';
import { query } from '../src/db.js';

const app = createApp();
const salesTok = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice' });
const finTok = issueToken({ username: 'fin1', role: 'finance', display_name: '财务' });
const auth = { Authorization: 'Bearer ' + salesTok };
const SLUG = 'acct-insight-it';

// 模块加载期即探测 DB 可用性（顶层 await），确保下方用例注册时 dbOk 已确定
let dbOk = false;
try { await query('SELECT 1'); dbOk = true; } catch { dbOk = false; }

let testAccountId = '';
beforeAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.particles WHERE slug=$1`, [SLUG]);
  const r = await query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
     VALUES (gen_random_uuid(), 'system', 'CRM_ACCOUNT', $1, '洞察集成测试客户', 'ACTIVE', '{"name":"洞察集成测试客户"}'::jsonb) RETURNING id`,
    [SLUG]
  );
  testAccountId = r.rows[0]?.id || '';
});
afterAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.particles WHERE slug=$1`, [SLUG]);
});

// 无 DB 依赖：始终执行
it('GET /api/page/account-insight 缺失 token 返回 401', async () => {
  const res = await app.fetch('/api/page/account-insight');
  expect(res.status).toBe(401);
});

// 依赖 DB：DB 不可达时自动跳过（与项目既有集成测试同套 plm_test 基础设施）
const db = (name, fn) => (dbOk ? it(name, fn) : it.skip(name, fn));

db('无 accountId 返回 200 + 首户 html（含角色）', async () => {
  const res = await app.fetch('/api/page/account-insight', { headers: auth });
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.html).toContain('pg-page');
  expect(j.role).toBe('sales');
});

// 数字化指标重设计（2026-08-28）：金额已由「表格列」迁移到「kpi-strip / pipeline / progress-card」组件，
// 端到端权限断言同步改为校验数据层抹除结果，而非旧的 <th>金额</th> 表格列头。
db('响应 html 含三类数字化指标组件', async () => {
  const res = await app.fetch('/api/page/account-insight', { headers: auth });
  const j = await res.json();
  for (const cls of ['pg-kpi-strip', 'pg-pipeline', 'pg-progress-card', 'pg-bar']) {
    expect(j.html).toContain(cls);
  }
});

db('sales 响应 html 含权限占位（回款类指标被抹除）', async () => {
  const res = await app.fetch('/api/page/account-insight', { headers: auth });
  const j = await res.json();
  // kpi-strip 中 paidAmt/unpaidAmt/payRate 对 sales 隐藏 → 渲染「字段对当前角色隐藏」
  expect(j.html).toContain('字段对当前角色隐藏');
  // pipeline 回款段金额对 sales 隐藏 → 渲染 🔒 占位
  expect(j.html).toContain('pg-stage-amt" data-state="hidden"');
});

db('finance 响应 html 无权限占位（金额全可见）', async () => {
  const res = await app.fetch('/api/page/account-insight', { headers: { Authorization: 'Bearer ' + finTok } });
  const j = await res.json();
  expect(j.html).toContain('pg-kpi-strip');
  expect(j.html).not.toContain('字段对当前角色隐藏');
  expect(j.html).not.toContain('pg-stage-amt" data-state="hidden"');
});

db('GET /api/particles?type=CRM_ACCOUNT 返回账户列表（客户选择器数据源）', async () => {
  const res = await app.fetch('/api/particles?type=CRM_ACCOUNT', { headers: auth });
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(Array.isArray(j.items)).toBe(true);
  expect(j.items.some(a => a.type === 'CRM_ACCOUNT')).toBe(true);
});

db('GET /api/page/account-insight?accountId= 返回指定账户及 accountTitle', async () => {
  const res = await app.fetch('/api/page/account-insight?accountId=' + encodeURIComponent(testAccountId), { headers: auth });
  const j = await res.json();
  expect(res.status).toBe(200);
  expect(j.accountId).toBe(testAccountId);
  expect(j.accountTitle).toBe('洞察集成测试客户');
});

// 2026-09-03：决策通常只关联 CRM_DEAL，未把 CRM_ACCOUNT 写入 involved_entities。
// 此测试确保 account-insight 能通过该账户下的 dealIds 级联查到关联决策。
db('关联 DEAL 的决策应出现在客户洞察决策链中', async () => {
  // 创建一个归属 testAccountId 的商机
  const dealR = await query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
     VALUES (gen_random_uuid(), 'system', 'CRM_DEAL', $1, '洞察测试商机', 'ACTIVE',
             jsonb_build_object('account_id', $2::text, 'stage', 'opportunity')) RETURNING id`,
    ['deal-insight-it', testAccountId]
  );
  const dealId = dealR.rows[0].id;

  // 创建一条只关联 DEAL、不关联 ACCOUNT 的决策
  const decR = await query(
    `INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated,
       disposition, decider_type, decider_role, rationale, business_tier, state, decided_at)
     VALUES ('OPP_QUALIFY', '{}'::jsonb, $1::jsonb, '[]'::jsonb,
       'ESCALATE', 'AUTONOMOUS_AGENT', 'sales', '集成测试决策', 'NORMAL', 'DECIDED', now())
     RETURNING decision_id`,
    [JSON.stringify([{ type: 'CRM_DEAL', id: dealId }])]
  );
  const decisionId = decR.rows[0].decision_id;

  try {
    const res = await app.fetch('/api/page/account-insight?accountId=' + encodeURIComponent(testAccountId), { headers: auth });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.html).toContain('决策链');
    expect(j.html).toContain('OPP_QUALIFY');
    expect(j.html).toContain('ESCALATE');
    expect(j.html).toContain('DECIDED');
  } finally {
    // 测试隔离清理：先删决策边/结果等子表，再删决策与商机
    await query(`DELETE FROM crm.decision_relation WHERE from_id=$1::uuid OR to_id=$1::text`, [decisionId]);
    await query(`DELETE FROM crm.decision_event WHERE decision_id=$1::uuid`, [decisionId]);
    await query(`DELETE FROM crm.decision WHERE decision_id=$1::uuid`, [decisionId]);
    await query(`DELETE FROM crm.particles WHERE id=$1::uuid`, [dealId]);
  }
});

// 决策执行足迹端到端：crm.tasks 真空（绑错源），故该折叠卡 2026-09-03 由 crm.tasks 切换到
// crm.decision_event。本测试断言新数据源在 S35 HTML 上能渲染出「执行足迹」标题与 AI 建议列。
db('决策执行足迹：用 made+escalated 事件换掉原 crm.tasks 真空源', async () => {
  const dealR = await query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload)
     VALUES (gen_random_uuid(), 'system', 'CRM_DEAL', $1, '足迹测试商机', 'ACTIVE',
             jsonb_build_object('account_id', $2::text, 'stage', 'opportunity')) RETURNING id`,
    ['deal-trace-it', testAccountId]
  );
  const dealId = dealR.rows[0].id;
  const decR = await query(
    `INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated,
       disposition, decider_type, decider_role, rationale, business_tier, state, decided_at)
     VALUES ('QUOTE_PRICING', '{}'::jsonb, $1::jsonb, '[]'::jsonb,
       'APPROVE', 'AUTONOMOUS_AGENT', 'sales', '足迹测试', 'HIGH', 'DECIDED', now())
     RETURNING decision_id`,
    [JSON.stringify([{ type: 'CRM_DEAL', id: dealId }])]
  );
  const decisionId = decR.rows[0].decision_id;
  // 插 made + escalated 两条事件，覆盖两种典型 event_type
  await query(
    `INSERT INTO crm.decision_event (event_type, scenario_id, decision_id, payload, created_at)
     VALUES ('made', 'QUOTE_PRICING', $1::uuid, '{"state":"HUMAN","disposition":"APPROVE","business_tier":"HIGH","confidence":0.85}'::jsonb, now() - interval '1 minute')`,
    [decisionId]
  );
  await query(
    `INSERT INTO crm.decision_event (event_type, scenario_id, decision_id, payload, created_at)
     VALUES ('escalated', 'QUOTE_PRICING', $1::uuid, '{"suggested":"APPROVE","confidence":0.85,"business_tier":"HIGH"}'::jsonb, now())`,
    [decisionId]
  );
  try {
    const res = await app.fetch('/api/page/account-insight?accountId=' + encodeURIComponent(testAccountId), { headers: auth });
    const j = await res.json();
    expect(res.status).toBe(200);
    // 新折叠卡标题 + table 标题 + AI 建议 / 置信度 列头（含「执行足迹」「AI 建议」「置信度」）
    expect(j.html).toContain('决策执行足迹');
    expect(j.html).toContain('执行足迹');
    expect(j.html).toContain('AI 建议');
    expect(j.html).toContain('置信度');
    // made/escalated 业务化标签必须呈现，证明 event_type 已翻译
    expect(j.html).toContain('AI 已决策');
    expect(j.html).toContain('已升级人工');
  } finally {
    await query(`DELETE FROM crm.decision_event WHERE decision_id=$1::uuid`, [decisionId]);
    await query(`DELETE FROM crm.decision_relation WHERE from_id=$1::uuid OR to_id=$1::text`, [decisionId]);
    await query(`DELETE FROM crm.decision WHERE decision_id=$1::uuid`, [decisionId]);
    await query(`DELETE FROM crm.particles WHERE id=$1::uuid`, [dealId]);
  }
});
