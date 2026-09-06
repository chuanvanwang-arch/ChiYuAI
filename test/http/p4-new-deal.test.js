// test/http/p4-new-deal.test.js — P4 后端 TDD：真实新增写通道（第0闸决策闸）
// 设计输入：docs/specs/2026-08-27-ui-nav-standards-design.md §P4
// 论证：POST /api/particles 端点（src/http/routes.js:177）对 CRM_DEAL 走 LEAD_FOLLOW_UP 第0闸；
//   无先例的低风险线索 → 保守升级 HITL（403），产出 HUMAN 态决策供审批流消费，且不自动落库粒子（无决策不写）。
//   （2026-08-28 设计裁定：扭转此前「低位场景无条件自主放行」；有先例同类方可自主放行 201）
// 依赖真实 PG（5433）：beforeEach TRUNCATE 隔离，防污染 http.test.js 的读直连断言。
import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

beforeEach(async () => { await query(`TRUNCATE particles, edges, events CASCADE`); });

describe('P4 new-deal write channel', () => {
  it('POST /api/particles CRM_DEAL 无先例 → 403 升级 HITL（第0闸；不自动落库，待人工确认）', async () => {
    const app = createApp();
    const token = issueToken({ username: 't-sales', role: 'sales', display_name: '销售' });
    const res = await app.fetch('/api/particles', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ type: 'CRM_DEAL', payload: { name: 'P4 验证商机', stage: 'lead' } }),
    });
    expect(res.status).toBe(403); // 第0闸：无先例保守升级，非 201 自主放行
    const body = await res.json();
    expect(body.error).toContain('第0闸');
    expect(body.decision).toBeTruthy(); // 升级也产出决策（HUMAN 态），供审批流消费
    expect(body.tier).toBeTruthy();
    // 落库验证：升级未自动创建粒子（无决策不写——需人工确认后回写）
    const r2 = await app.fetch('/api/particles?type=CRM_DEAL');
    const j2 = await r2.json();
    expect(j2.items.some(p => p.payload?.name === 'P4 验证商机')).toBe(false);
  });
});
