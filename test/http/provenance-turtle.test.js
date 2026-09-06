import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

const app = createApp();
const token = issueToken({ role: 'admin', display_name: 't', username: 'tester' });
const AUTH = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// 复用 audit-4q 场景种子，确保 provenance-turtle 端点与 audit-4q 同源、单一事实源
const SCN = 'AUDIT4Q_SCEN';
const D = 'a4444444-4444-4444-4444-4444444444a4';
const P = 'b4444444-4444-4444-4444-4444444444b4';
const PTYPE = 'AUDIT4Q_DEAL';

describe('T-PROVTTL GET /api/decision/:id/provenance-turtle W3C PROV-O Turtle 导出', () => {
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

  it('无 token → 401', async () => {
    const res = await app.fetch(`/api/decision/${D}/provenance-turtle`);
    expect(res.status).toBe(401);
  });

  it('有 token → 200 返回 W3C PROV-O Turtle 文本', async () => {
    const res = await app.fetch(`/api/decision/${D}/provenance-turtle`, { headers: AUTH });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.decision_id).toBe(D);
    expect(typeof b.turtle).toBe('string');
    expect(b.turtle.length).toBeGreaterThan(0);
    // PROV-O 标准断言：前缀声明 + 决策实体三元组
    expect(b.turtle).toContain('@prefix prov: <http://www.w3.org/ns/prov#>.');
    expect(b.turtle).toContain('crm:decision_' + D + ' a prov:Entity');
    expect(b.turtle).toContain('prov:wasAttributedTo');
    // 链状态字段存在（UNKNOWN/OK/BROKEN 之一）
    expect(['UNKNOWN', 'OK', 'BROKEN']).toContain(b.chain_status);
  });

  it('?download=1 → 附件下载 text/turtle', async () => {
    const res = await app.fetch(`/api/decision/${D}/provenance-turtle?download=1`, { headers: AUTH });
    expect(res.status).toBe(200);
    // app.fetch 适配器的 res.headers 是 Node 原生 IncomingMessage.headers（小写键，非 Headers 实例）
    expect(res.headers['content-type']).toContain('text/turtle');
    expect(res.headers['content-disposition']).toContain(`provenance-${D}.ttl`);
    const txt = await res.text();
    expect(txt).toContain('crm:decision_' + D + ' a prov:Entity');
  });

  it('不存在的决策 → 404', async () => {
    const res = await app.fetch('/api/decision/e0000000-0000-0000-0000-000000000000/provenance-turtle', { headers: AUTH });
    expect(res.status).toBe(404);
  });
});
