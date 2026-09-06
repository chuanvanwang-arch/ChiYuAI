import { describe, it, expect, beforeEach } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { inspectParticlePayload, intervalToMs, traceRootCause } from '../../src/decision/traceRootCause.js';

// ───────────────────────── 纯函数单测（无需 PG） ─────────────────────────
describe('T25 inspectParticlePayload（④ 跳三检纯函数）', () => {
  it('字段不一致：payload 孤儿字段命名错配 → field_mismatch', () => {
    const r = inspectParticlePayload({
      payload: { cust_no: 'C1' },
      metaAttrs: [{ attr_slug: 'customer_no', required: false, enabled: true }],
    });
    expect(r.field_mismatch).toBe(true);
    expect(r.orphanFields).toContain('cust_no');
    expect(r.info_incomplete).toBe(false);
    expect(r.input_stale).toBe(false);
  });

  it('信息不完整：enabled 且 required 字段缺失/空 → info_incomplete', () => {
    const r = inspectParticlePayload({
      payload: {},
      metaAttrs: [{ attr_slug: 'customer_name', required: true, enabled: true }],
    });
    expect(r.info_incomplete).toBe(true);
    expect(r.field_mismatch).toBe(false);
    expect(r.missingRequired).toContain('customer_name');
  });

  it('输入不及时：粒子更新距决策超过 sla → input_stale', () => {
    const decided = new Date('2026-01-02T00:00:00Z').getTime();
    const updated = new Date('2025-12-31T00:00:00Z').getTime(); // 早 2 天，明确超过 24h
    const r = inspectParticlePayload({
      payload: { customer_name: 'X' },
      metaAttrs: [{ attr_slug: 'customer_name', required: true, enabled: true, source_refresh_sla: '24 hours' }],
      decidedAtMs: decided,
      particleUpdatedAtMs: updated,
    });
    expect(r.input_stale).toBe(true);
  });

  it('全清：字段齐 + 必填满 + 时效内 → 三项皆 false', () => {
    const now = Date.now();
    const r = inspectParticlePayload({
      payload: { customer_name: 'X' },
      metaAttrs: [{ attr_slug: 'customer_name', required: true, enabled: true, source_refresh_sla: '24 hours' }],
      decidedAtMs: now,
      particleUpdatedAtMs: now - 3600_000, // 1 小时前，未超 24h
    });
    expect(r.field_mismatch).toBe(false);
    expect(r.info_incomplete).toBe(false);
    expect(r.input_stale).toBe(false);
  });
});

describe('T25 intervalToMs 解析', () => {
  it('解析 hours / days / hms', () => {
    expect(intervalToMs('24 hours')).toBe(86400_000);
    expect(intervalToMs('1h')).toBe(3600_000);
    expect(intervalToMs('1 day 02:00:00')).toBe(26 * 3600_000);
    expect(intervalToMs(5000)).toBe(5000);
    expect(intervalToMs(null)).toBe(null);
  });
});

// ───────────────────────── DB 集成测试（plm_test） ─────────────────────────
const SCN = 'TRACE_TEST_SCENARIO_V1';
const D = 'd9000000-0000-0000-0000-0000000000d9';
const P = 'e9000000-0000-0000-0000-0000000000e9';
const PTYPE = 'TRACE_DEAL_TEST';

describe('T25 traceRootCause 四层溯源（DB）', () => {
  beforeEach(async () => {
    await queryWrite('TRUNCATE crm.decision_relation RESTART IDENTITY CASCADE');
    await queryWrite('TRUNCATE crm.decision_outcome RESTART IDENTITY CASCADE');
    await queryWrite('DELETE FROM crm.decision WHERE decision_id=$1', [D]);
    await queryWrite('DELETE FROM crm.particles WHERE id=$1', [P]);
    await queryWrite('DELETE FROM crm.meta_attr WHERE particle_type=$1', [PTYPE]);
    await queryWrite(`INSERT INTO crm.decision_scenario(scenario_id, stage, trigger, eval_dimensions) VALUES ($1,'TRACE','{}'::jsonb,'[]'::jsonb) ON CONFLICT (scenario_id, tenant_id) DO NOTHING`, [SCN]);

    await queryWrite(
      `INSERT INTO crm.decision
        (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state, decided_at)
       VALUES ($1,$2,'{}'::jsonb,$3::jsonb,'[]'::jsonb,'PROCEED','AUTONOMOUS_AGENT','r','NORMAL','REQUIRED', now())`,
      [D, SCN, JSON.stringify([{ id: P, type: PTYPE }])]
    );
    // 自联边（满足 FK + 验证 M 层 7 边快照可取）
    // to_id 已放宽为 TEXT：uuid 列与 text 列不可复用同一参数（PG 推断 inconsistent types），
    //   显式 ::text 转换 + 分列绑定（from_id 仍 uuid，to_id 转 text）
    await queryWrite(
      `INSERT INTO crm.decision_relation (from_id, to_id, rel_type, serves_dimension)
       VALUES ($1, $2::text, 'REFERENCED_PRECEDENT', 'decision_history') ON CONFLICT DO NOTHING`,
      [D, D]
    );
    // 粒子：cust_no（孤儿字段）+ 缺 customer_name（必填）+ 过时（updated_at 早 2 天）
    await queryWrite(
      `INSERT INTO crm.particles (id, type, slug, title, payload, updated_at)
       VALUES ($1,$2,'trace-deal-1','trace deal 1','{"cust_no":"C1"}'::jsonb, now() - interval '2 days')`,
      [P, PTYPE]
    );
    await queryWrite(
      `INSERT INTO crm.meta_attr (particle_type, attr_slug, title, attr_type, required, enabled, source_refresh_sla)
       VALUES ($1,'customer_name','客户名','text',true,true,'24 hours')`,
      [PTYPE]
    );
  });

  it('返回 J→M→K→粒子库 四层链，④ 跳命中 字段不一致+信息不完整+输入不及时', async () => {
    const t = await traceRootCause(D);
    expect(t).not.toBeNull();
    expect(t.decision_id).toBe(D);
    // ① J
    expect(t.layer_j).toHaveProperty('attribution');
    expect(t.layer_j).toHaveProperty('decided_at');
    // ②/③ M：7 边快照可取
    expect(t.layer_m.edge_count).toBe(1);
    expect(t.layer_m.edges[0].rel_type).toBe('REFERENCED_PRECEDENT');
    // ④ K→粒子库
    expect(t.layer_k.particles.length).toBe(1);
    const pc = t.layer_k.particles[0].checks;
    expect(pc.field_mismatch).toBe(true);
    expect(pc.info_incomplete).toBe(true);
    expect(pc.input_stale).toBe(true);
    // 聚合：任一粒子命中即 true
    expect(t.particle_checks.field_mismatch).toBe(true);
    expect(t.particle_checks.info_incomplete).toBe(true);
    expect(t.particle_checks.input_stale).toBe(true);
  });

  it('无该决策 → 返回 null', async () => {
    const t = await traceRootCause('d0000000-0000-0000-0000-000000000000');
    expect(t).toBeNull();
  });
});
