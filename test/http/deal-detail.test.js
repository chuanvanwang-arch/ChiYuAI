// test/http/deal-detail.test.js — S07 商机作战视图 真实数据渲染（TDD：先绿后改）
// 验证：/api/page/deal-detail?dealId= 返回 renderPage(S07_SCHEMA) 产物，含真实商机字段/关联单据/赢率
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造 商机 + 关联报价 最小闭环（deal_id 挂接）
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('d3333333-3333-3333-3333-333333333333','system','CRM_DEAL','deal-contracted','食品礼盒全年框架','ACTIVE',
     '{"name":"食品礼盒全年框架","stage":"contracted","expected_amount":1500000,"probability":0.85,"account_id":"a1111111-1111-1111-1111-111111111101","owner":"王川"}',
     '2026-06-10T09:00:00+08:00','2026-07-28T09:00:00+08:00'),
    ('f1111111-1111-1111-1111-111111111111','system','CRM_QUOTATION','quote-food','食品礼盒框架报价','ACTIVE',
     '{"name":"食品礼盒框架报价","deal_id":"d3333333-3333-3333-3333-333333333333","valid_until":"2026-12-31","amount":1500000,"approval_status":"approved"}',
     '2026-06-11T09:00:00+08:00','2026-07-28T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S07 商机作战视图 受控渲染（真实数据）', () => {
  it('GET /api/page/deal-detail?dealId= 返回 pg-page 详情页产物', async () => {
    const { status, body } = await getJson('/api/page/deal-detail?dealId=d3333333-3333-3333-3333-333333333333');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="detail"');
    expect(body.html).toContain('pg-attr-field');
    expect(body.html).toContain('pg-subtable');
    expect(body.html).toContain('pg-metric-card');
  });

  it('属性字段注入真实商机值（名称/金额/阶段来自真实 deal payload）', async () => {
    const { body } = await getJson('/api/page/deal-detail?dealId=d3333333-3333-3333-3333-333333333333');
    expect(body.html).toContain('食品礼盒全年框架'); // deal_name
    expect(body.html).toContain('contracted');        // stage
    expect(body.html).toContain('1500000');           // expected_amount
  });

  it('赢率 metric-card 来自真实 probability（0.85 → 85.00，非占位 —）', async () => {
    const { body } = await getJson('/api/page/deal-detail?dealId=d3333333-3333-3333-3333-333333333333');
    expect(body.html).toContain('赢率');
    expect(body.html).toContain('85.00');
  });

  it('关联子表含真实报价（按 payload.deal_id 挂接，非编造）', async () => {
    const { body } = await getJson('/api/page/deal-detail?dealId=d3333333-3333-3333-3333-333333333333');
    expect(body.html).toContain('食品礼盒框架报价');
    expect(body.html).toContain('CRM_QUOTATION');
  });

  it('静态页 /deal-detail.html 含 #deal-root 注入锚点', async () => {
    const res = await app.fetch('/deal-detail.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="deal-root"');
  });

  it('无 id 时默认取首条商机（防空白回归）', async () => {
    const { status, body } = await getJson('/api/page/deal-detail');
    expect(status).toBe(200);
    expect(body.html).toContain('pg-attr-field');
    expect(body.html).toContain('食品礼盒全年框架'); // 默认首条
  });

  // T5（死信息活体化）：S07 reasoning-trace 注入真状态
  it('S07 reasoning-trace 真状态（种子无 MEDDICC/决策历史/跟进任务 → MEDDICC warn / 决策历史 warn / 推进 idle）', async () => {
    const { body } = await getJson('/api/page/deal-detail?dealId=d3333333-3333-3333-3333-333333333333');
    const steps = body.data?.components?.['reasoning-trace']?.steps;
    expect(Array.isArray(steps)).toBe(true);
    expect(steps.length).toBe(3);
    expect(steps.map(s => s.label)).toEqual(['MEDDICC 评估', '决策历史', '推进建议']);
    // 种子 deal 无 meddiccKeys 任何字段、无 decision_refs/decision_id、无关联 followup 任务
    expect(steps[0].status).toBe('warn');  // meddiccFilled=false
    expect(steps[1].status).toBe('warn');  // hasDecisionHistory=false
    expect(steps[2].status).toBe('idle');  // hasFollowupTask=false
    // 渲染层消费注入态
    expect(body.html).toContain('data-trace-step="warn"');
    expect(body.html).toContain('data-trace-step="idle"');
  });
});
