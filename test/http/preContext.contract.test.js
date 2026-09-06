// test/http/preContext.contract.test.js
// 契约（认知决策子系统 v3 设计 §3.5 / §7）：GET /api/decision/pre-context 须返回 Knowledge 三件套
//   concept_checklist（methodology_dimension 注入）
//   rule_knowledge（decision_rule 启用清单，Knowledge 第三载体）
//   methodology_evidence（当前证据三态：达标 met:true / 不达标 met:false / 未采集=维缺失）
// 实证「前后台真链接」：后端注入三件套（src/http/decisionReadRoutes.js:97-140），
//   前端 sales-decision-monitor.html:820 knowledgeSectionsHtml 消费三件套（:821-823）。
// 范式对齐 named-account-manage-board.test.js（createApp().fetch + 真实 PG plm_test 自造种子）。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { createParticle } from '../../src/particles/particleRepo.js';

const SCENARIO = 'TEST_PRECONTEXT_OPP';
const RULE_CODE = 'TEST_RULE_NO_SIDE_DEAL';
const MIDS = ['BANT', 'MEDDICC']; // 仅绑两个方法论，简化三态断言

let app, adminToken;

beforeAll(async () => {
  app = createApp();
  // 自造 admin（幂等，避免破坏 alice/bob）
  await query(
    `INSERT INTO crm.crm_users (username, password_hash, role, display_name)
     VALUES ($1, crypt($2, gen_salt('bf')), 'admin', '管理员')
     ON CONFLICT (username) DO UPDATE SET password_hash=EXCLUDED.password_hash, role='admin'`,
    ['admin', 'admin123']
  );
  const login = await (await app.fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })).json();
  adminToken = login.token;
  expect(adminToken).toBeTruthy();
});

beforeEach(async () => {
  // methodology_template（FK 父表）+ methodology_dimension 行（驱动 concept_checklist 非空）
  await query(
    `INSERT INTO crm.methodology_template (methodology_id, name, structure) VALUES
       ('BANT','BANT 预算授权需求时效','{}'::jsonb),
       ('MEDDICC','MEDDICC 多维度量化标准','{}'::jsonb)
     ON CONFLICT (methodology_id) DO NOTHING`
  );
  await query(
    `INSERT INTO crm.methodology_dimension (methodology_id, dim_key, label, weight, required) VALUES
       ('BANT','B','预算',1,true), ('BANT','A','决策权',1,true),
       ('MEDDICC','C1','竞争',1,true), ('MEDDICC','C2','公司支持',1,true)
     ON CONFLICT (methodology_id, dim_key) DO NOTHING`
  );
  // 场景（绑定 BANT+MEDDICC；trigger/eval_dimensions 为 NOT NULL 列，须显式给）
  await query(
    `INSERT INTO crm.decision_scenario (scenario_id, stage, trigger, methodology_ids, eval_dimensions)
     VALUES ($1, 'lead', '{}'::jsonb, $2::text[], '{}'::jsonb)
     ON CONFLICT (scenario_id, tenant_id) DO UPDATE SET methodology_ids=EXCLUDED.methodology_ids`,
    [SCENARIO, MIDS]
  );
  // 启用决策规则（驱动 rule_knowledge 非空 = Knowledge 第三载体）
  await query(
    `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled)
     VALUES ($1, 'TYPE.action', '{"entity":"CRM_DEAL"}'::jsonb, '{"require":"decision_id"}'::jsonb, true)
     ON CONFLICT (code) DO UPDATE SET enabled=true`,
    [RULE_CODE]
  );
});

describe('GET /api/decision/pre-context — Knowledge 三件套注入（后端实证）', () => {
  it('未登录 → 401', async () => {
    const res = await app.fetch(`/api/decision/pre-context?scenario_id=${SCENARIO}`);
    expect(res.status).toBe(401);
  });

  it('缺 scenario_id → 400', async () => {
    const res = await app.fetch('/api/decision/pre-context', {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('场景级注入：无主体也返回 concept_checklist + rule_knowledge（三件套恒注入）', async () => {
    const res = await app.fetch(`/api/decision/pre-context?scenario_id=${SCENARIO}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.thinking_skeleton).toBeTruthy(); // P0-① 思维骨架恒在
    // Knowledge ①：概念清单（methodology_dimension 注入）
    expect(Array.isArray(j.concept_checklist?.checklist)).toBe(true);
    expect(j.concept_checklist.checklist.length).toBeGreaterThan(0);
    expect(j.concept_checklist.checklist.some((c) => c.methodology_id === 'BANT')).toBe(true);
    // Knowledge ③：启用规则清单（decision_rule 注入）
    expect(Array.isArray(j.rule_knowledge)).toBe(true);
    expect(j.rule_knowledge.length).toBeGreaterThan(0);
    expect(j.rule_knowledge.some((r) => r.code === RULE_CODE)).toBe(true);
    // 无主体 → 证据视图为空对象（fail-open，不报错）
    expect(j.methodology_evidence).toBeDefined();
    expect(j.methodology_evidence).toBeTypeOf('object');
  });

  it('主体级注入：带实体 → methodology_evidence 三态正确（B 达标 / A 未采集≠不达标）', async () => {
    // 造 DEAL：仅有 expected_amount（B 维字段信号），无 bantcc 评分 → B=达标(met:true)；A/C1/C2 无信号=未采集
    const deal = await createParticle('CRM_DEAL', { name: '契约测试商机', stage: 'S1', expected_amount: 100000 });
    const dealId = deal.id;
    const res = await app.fetch(
      `/api/decision/pre-context?scenario_id=${SCENARIO}&entities=${encodeURIComponent(JSON.stringify([{ type: 'CRM_DEAL', id: dealId }]))}`,
      { headers: { authorization: `Bearer ${adminToken}` } }
    );
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.concept_checklist.checklist.length).toBeGreaterThan(0);
    expect(j.rule_knowledge.some((r) => r.code === RULE_CODE)).toBe(true);
    // 三件套之一：当前证据现状（对象形态，仅含已采维度）
    expect(j.methodology_evidence).toBeTypeOf('object');
    // F5 三态防复发：B 维有字段信号 → 达标（met:true）
    expect(j.methodology_evidence.B).toBeTruthy();
    expect(j.methodology_evidence.B.met).toBe(true);
    // A 维无信号 → 未采集（维不存在于返回对象，绝不记 met:false）—— F5 核心防复发点
    expect(j.methodology_evidence.A).toBeUndefined();
  });
});

describe('前端 sales-decision-monitor.html 消费三件套（前后台链接实证）', () => {
  it('页面含三件套消费代码 + 三态防复发分支', async () => {
    const res = await app.fetch('/sales-decision-monitor.html', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    // 后端字段被前端读取（证明数据链路接通，非「存在但零注入」）
    expect(html).toContain('knowledgeSectionsHtml');
    expect(html).toContain('j.concept_checklist');
    expect(html).toContain('j.rule_knowledge');
    expect(html).toContain('j.methodology_evidence');
    // 三态防复发前端实现：未采集=neutral 分支存在（F5 的 UI 侧防复发，:818 铁律注释 + :841 标签）
    expect(html).toContain('未采集');
    expect(html).toContain('已达标');
    expect(html).toContain('不达标');
  });
});
