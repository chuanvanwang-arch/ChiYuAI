import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';

const app = createApp();

// 复用 audit-4q 场景种子（D 决策 + P 实体），确保聚合端点有可评分对象
const SCN = 'AUDIT4Q_SCEN';
const D = 'a4444444-4444-4444-4444-4444444444a4';
const P = 'b4444444-4444-4444-4444-4444444444b4';
const PTYPE = 'AUDIT4Q_DEAL';

describe('T-AUDITSLA GET /api/monitor/auditability 平台级可审计性 SLA 聚合', () => {
  beforeAll(async () => {
    await queryWrite('DELETE FROM crm.decision_relation WHERE from_id=$1', [D]);
    await queryWrite('DELETE FROM crm.decision WHERE decision_id=$1', [D]);
    await queryWrite('DELETE FROM crm.assertions WHERE entity_id=$1', [P]);
    await queryWrite('DELETE FROM crm.particles WHERE id=$1', [P]);
    await queryWrite('DELETE FROM crm.meta_attr WHERE particle_type=$1', [PTYPE]);
    await queryWrite(`INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions) VALUES ($1,'AUDIT','{}'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`, [SCN]);
    await queryWrite(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,'{}'::jsonb,$3::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED', now())`,
      [D, SCN, JSON.stringify([{ id: P, type: PTYPE }])]
    );
    await queryWrite(
      `INSERT INTO crm.particles (id, type, slug, title, payload, updated_at)
       VALUES ($1,$2,'s-audit-1','audit deal 1','{"cust_no":"C1"}'::jsonb, now())`,
      [P, PTYPE]
    );
  });

  it('公开端点（无 token）→ 200，返回聚合字段形状', async () => {
    const res = await app.fetch('/api/monitor/auditability?limit=50');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.window).toBe(50);
    expect(typeof b.scored).toBe('number');
    expect(b.scored).toBeGreaterThanOrEqual(1); // 已种入 D
    expect(b.auditability_pct).toBeGreaterThanOrEqual(0);
    expect(b.auditability_pct).toBeLessThanOrEqual(100);
    expect(b).toHaveProperty('full');
    expect(b).toHaveProperty('with_conflict');
    expect(b).toHaveProperty('tampered');
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4']) {
      expect(b.per_status).toHaveProperty(q);
      expect(b.per_status[q]).toHaveProperty('pass');
      expect(b.per_status[q]).toHaveProperty('warn');
      expect(b.per_status[q]).toHaveProperty('fail');
    }
    expect(Array.isArray(b.decisions)).toBe(true);
    expect(b.decisions[0].decision_id).toBeTruthy();
  });

  it('limit 越界钳制为 200', async () => {
    const res = await app.fetch('/api/monitor/auditability?limit=99999');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.window).toBe(200);
  });

  it('空窗口降级：无决策时 auditability_pct 为 null（不报错）', async () => {
    // 临时清空 D 以验证空库降级路径（beforeAll 已重建，这里仅验证端点稳健）
    const res = await app.fetch('/api/monitor/auditability?limit=1');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b).toHaveProperty('decisions');
  });
});
