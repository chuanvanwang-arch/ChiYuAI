// test/http/decisionDisposition.test.js — 人工处置端点（校准 P0）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §3
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';
import { createDecision } from '../../src/decision/decisionRepo.js';

let app;
beforeAll(() => { app = createApp(); });
beforeEach(async () => {
  await query('TRUNCATE crm.decision, crm.decision_event RESTART IDENTITY CASCADE');
});

const bearer = (role) => `Bearer ${issueToken({ username: 'tester', role, display_name: '测试员' })}`;

function post(path, body, role = 'sales') {
  return app.fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: bearer(role) },
    body: JSON.stringify(body),
  });
}

async function seedDecision() {
  return createDecision({
    scenario_id: 'LEAD_FOLLOW_UP', trigger_context: {}, involved_entities: [],
    conditions_evaluated: [], disposition: 'APPROVE', decider_type: 'AUTONOMOUS_AGENT',
    rationale: '测试用决策', business_tier: 'LEAD', state: 'AUTONOMOUS',
  });
}

describe('POST /api/decisions/:id/disposition', () => {
  it('无 token → 401', async () => {
    const res = await app.fetch('/api/decisions/00000000-0000-0000-0000-000000000000/disposition', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ disposition: 'APPROVE' }),
    });
    expect(res.status).toBe(401);
  });

  it('改判（与建议不等）→ 200 + overridden=true + state=REVERSED', async () => {
    const d = await seedDecision();
    const res = await post(`/api/decisions/${d.decision_id}/disposition`, { disposition: 'REJECT', note: '预算不符' });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.overridden).toBe(true);
    expect(j.state).toBe('REVERSED');
  });

  it('认可（与建议一致）→ 200 + overridden=false + state=CONFIRMED', async () => {
    const d = await seedDecision();
    const res = await post(`/api/decisions/${d.decision_id}/disposition`, { disposition: 'APPROVE' });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.overridden).toBe(false);
    expect(j.state).toBe('CONFIRMED');
  });

  // 2026-09-01 基线同步：多租户改造新增 assertDecisionTenant（routes.js:2046），
  // 契约注释明写「false = 跨租户或不存在，调用方应回 403」→ 未知 id 的判定因此分两路：
  //   · admin/sysadmin（scopeTenant='*'）绕过闸 → 落到 recordHumanDisposition → 404（资源不存在，disposition.js:27）
  //   · sales（scopeTenant=自身租户）查不到该行 → 403（无权访问该租户决策）
  // 原用例只断言 sales→404，与新增租户闸语义冲突（恒 403），此处拆成两条显式固化。
  it('未知 decision_id：admin → 404；sales → 403（多租户闸）', async () => {
    const nf = await post('/api/decisions/00000000-0000-0000-0000-000000000000/disposition', { disposition: 'APPROVE' }, 'admin');
    expect(nf.status).toBe(404);

    const denied = await post('/api/decisions/00000000-0000-0000-0000-000000000000/disposition', { disposition: 'APPROVE' });
    expect(denied.status).toBe(403);
  });

  it('缺 disposition → 400', async () => {
    const d = await seedDecision();
    const bad = await post(`/api/decisions/${d.decision_id}/disposition`, {}, 'admin');
    expect(bad.status).toBe(400);
  });
});