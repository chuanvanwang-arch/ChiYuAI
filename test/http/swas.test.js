// test/http/swas.test.js — T5 SWAS Action HTTP 端点（红灯先行）
// 依据：docs/2026-08-30-sales-p0-p1-test-plan.md §5 T5-C7/C8
//       docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §4.3
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';
import { createParticle, getParticle } from '../../src/particles/particleRepo.js';

let app;
beforeEach(() => { app = createApp(); });

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
});

const adminToken = issueToken({ username: 'admin-demo', role: 'admin', display_name: '管理演示' });
const auth = (t) => ({ Authorization: `Bearer ${t}` });
const post = (path, body, token) => app.fetch(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? auth(token) : {}) },
  body: JSON.stringify(body),
});
const json = async (res) => { const t = await res.text(); try { return JSON.parse(t); } catch { return {}; } };

describe('POST /api/action/crm-deal-swas-update（T5 SWAS Action）', () => {
  it('【T5-C7】无 decision_id → 第0闸拦截 {ok:false, gate:decision_required}', async () => {
    const deal = await createParticle('CRM_DEAL', { name: '商机SWAS', stage: 'opportunity' }, { tenantId: 'system' });
    const res = await post('/api/action/crm-deal-swas-update', {
      deal_id: deal.id,
      swas: { status: 'P2', win_strategy: '成本优势', action: [{ what: 'a' }], schedule: { order_date: '2026-12' } },
    }, adminToken);
    expect(res.status).toBe(400);
    const b = await json(res);
    expect(b.ok).toBe(false);
    expect(b.gate).toBe('decision_required');
  });

  it('【T5-C8】带 decision_id → 写入落库 payload.swas 含写入内容', async () => {
    // 2026-09-03 QA 缺陷修复：原用例用假 decision_id 'dec-sw-1' → 写路径持久化到
    //   particles.decision_id（FK 引用 crm.decision）撞 UUID 约束。改为先 INSERT 真实
    //   decision 行取 UUID，再透传，断言落在「带决策绑定写入」被测行为上。
    const d = await query(
      `INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
       VALUES ('OPP_QUALIFY', '{}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'APPROVE', 'HUMAN', 'test', 'LOW', 'CONFIRMED')
       RETURNING decision_id`
    );
    const decisionId = d.rows[0].decision_id;
    const deal = await createParticle('CRM_DEAL', { name: '商机SWAS', stage: 'opportunity' }, { tenantId: 'system' });
    const swas = {
      status: 'P2', win_strategy: '总成本拥有优势+财务总监内线',
      action: [{ what: '约技术交流', who: '我方售前', when: '本周五' }],
      schedule: { order_date: '2026-12', bid_date: '2026-Q4' },
    };
    const res = await post('/api/action/crm-deal-swas-update', {
      deal_id: deal.id, swas, decision_id: decisionId,
    }, adminToken);
    expect(res.status).toBe(200);
    const b = await json(res);
    expect(b.ok).toBe(true);
    // 落库校验：读回粒子 payload.swas
    const updated = await getParticle(deal.id);
    expect(updated.payload.swas.status).toBe('P2');
    expect(updated.payload.swas.win_strategy).toBe('总成本拥有优势+财务总监内线');
    expect(updated.payload.swas.schedule.order_date).toBe('2026-12');
    // 回顾留痕自动写入
    expect(updated.payload.swas.reviewed_at).toBeTruthy();
    expect(updated.payload.swas.reviewed_by).toBe('admin-demo');
  });
});
