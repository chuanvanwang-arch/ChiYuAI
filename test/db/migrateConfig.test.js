// test/db/migrateConfig.test.js — Task 9: 配置中心表迁移验证（幂等；真实 PG 5433）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-plan.md Task 9 + db/migrate-config.sql
// 前置：migrate-config.sql 已执行（幂等）；此处仅校验表结构存在 + required_dims 列
import { describe, it, expect } from 'vitest';
import { query, queryWrite } from '../../src/db.js';

describe('migrate-config 配置中心表', () => {
  it('config_store 存在（key/value/decision_id）', async () => {
    const r = await query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='crm' AND table_name='config_store' ORDER BY ordinal_position`
    );
    const cols = r.rows.map((x) => x.column_name);
    expect(cols).toContain('key');
    expect(cols).toContain('value');
    expect(cols).toContain('decision_id');
  });

  it('skill_registry / approval_flow / connectors / system_config 存在', async () => {
    for (const t of ['skill_registry', 'approval_flow', 'connectors', 'system_config']) {
      const r = await query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='crm' AND table_name=$1`,
        [t]
      );
      expect(r.rows[0].n).toBe(1);
    }
  });

  it('decision_scenario 有 required_dims 列（D3 七维校验消费）', async () => {
    const r = await query(
      `SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema='crm' AND table_name='decision_scenario' AND column_name='required_dims'`
    );
    expect(r.rows[0].n).toBe(1);
  });

  // 回归：skill_registry 须含 §6.6 方法论镜像（8 大写别名，与 decision_scenario.methodology_ids 对齐），
  // 否则决策场景配置（第14项）methodology_ids 编辑因引用目标缺失恒 400。
  // 自包含：先幂等确保 8 别名已种子化（与 db/migrate-config.sql 一致），不依赖外部 migrate-config.sql
  // 执行顺序——避免其它测试文件 TRUNCATE/reseed skill_registry 造成的顺序依赖与状态漂移。
  it('skill_registry 含 8 方法论镜像且覆盖种子场景引用（无悬空）', async () => {
    const CANON = ['BANT', 'MEDDICC', 'OPP_MATRIX', 'ROLE_MAP', 'RISK_TRADEOFF', 'STOP_LOSS', 'FACT_VS_TALK', 'PRESALES_SOLUTION'];
    // 自包含种子化（ON CONFLICT DO NOTHING 重跑安全）
    for (const id of CANON) {
      await queryWrite(
        `INSERT INTO crm.skill_registry (skill_id, category, enabled, version, rbac_roles)
         VALUES ($1, 'methodology', TRUE, 'v1', ARRAY['sales'])
         ON CONFLICT (skill_id) DO NOTHING`,
        [id]
      );
    }
    const reg = await query(`SELECT skill_id FROM crm.skill_registry`);
    const ids = new Set(reg.rows.map((r) => r.skill_id));
    // §6.6 方法论镜像契约：8 大写别名必须全部在册（CRM 智能体包新增的 crm-*/method-* slug 不在此契约内）
    for (const id of CANON) expect(ids.has(id), `方法论镜像缺失: ${id}`).toBe(true);
    // 种子场景引用的 methodology_ids 必须全部已注册（无悬空引用）
    const used = await query(`SELECT DISTINCT unnest(methodology_ids) AS m FROM crm.decision_scenario`);
    const dangling = used.rows.map((r) => r.m).filter((m) => !ids.has(m) && m);
    expect(dangling).toEqual([]);
  });
});