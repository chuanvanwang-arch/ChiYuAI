// test/decision/tenantScenarioProvisioning.test.js
// E7-2（2026-09-17）护栏：租户维度决策场景字典的**按需物化**（ensureTenantScenario）
//   + 读取侧**租户谓词**（loadScenarioConfig）——两者必须成对（物化会让同名场景多租户并存）。
//
// 取证纪律：
//  ① 全部用例跑在**真实测试库**上（把断言打到真实约束/真实列集，不用替身）——
//     替身无法证明「FK 真的会被满足」，也无法发现「新增列未进克隆清单」这类漂移。
//  ② 一律置于 `withTx` 内并**强制回滚** ⇒ 零残留、**无需 DELETE**（本仓红线）。
//     故读/写都注入事务客户端（`writer` / `reader` 形参），避免走连接池看不到未提交数据。
//  ③ 合成租户 id **刻意不复用 `acme-*`**（见 test/fixtures/testTenantIds.js 的 09-09 重构说明）。
import { describe, it, expect } from 'vitest';
import { withTx } from '../../src/db.js';
import {
  ensureTenantScenario, loadScenarioConfig, SCENARIO_CLONE_COLUMNS,
} from '../../src/decision/decisionRepo.js';

const SCENARIO = 'PARTICLE_CREATE'; // system 模板必存在的场景（db/seed-decision-scenarios.sql）
const TENANT_A = 'test-tenant-scenario-a';
const TENANT_B = 'test-tenant-scenario-b';
const NEVER = 'test-tenant-never-provisioned';

const txIO = (c) => (sql, params) => c.query(sql, params);

// 在事务内跑 fn，然后强制回滚（哨兵异常），fn 的返回值照常带出。
// 非哨兵异常原样抛出 —— 这正是「缺陷复现」用例要断言的路径。
const SENTINEL = '__intentional_rollback__';
async function inRollbackTx(fn) {
  let out;
  await withTx(async (c) => {
    out = await fn(c);
    throw new Error(SENTINEL);
  }).catch((e) => {
    if (!String(e?.message || e).includes(SENTINEL)) throw e;
  });
  return out;
}

// 最小合法 decision 行：只给「NOT NULL 且无默认值」的列（其余走列默认），
// 目的是把**复合外键**打到真实约束上，而不是走 createDecision 的重链路（embedding/评分/AGE 图）。
const MIN_DECISION_SQL = `INSERT INTO crm.decision
  (scenario_id, trigger_context, involved_entities, conditions_evaluated,
   disposition, decider_type, rationale, business_tier, tenant_id)
  VALUES ($1, '{}'::jsonb, '[]'::jsonb, '[]'::jsonb,
          'APPROVE', 'AUTONOMOUS_AGENT', 'probe', 'NORMAL', $2)`;

describe('E7-2 租户场景字典供给（ensureTenantScenario / loadScenarioConfig）', () => {
  it('前提自检：合成租户在库内无任何场景行（含无上轮泄漏）', async () => {
    const r = await inRollbackTx(async (c) => {
      const q = await c.query(
        'SELECT count(*)::int n FROM crm.decision_scenario WHERE tenant_id = ANY($1)',
        [[TENANT_A, TENANT_B, NEVER]]
      );
      return q.rows[0].n;
    });
    expect(r).toBe(0);
  });

  it('缺陷复现：本租户无场景行 ⇒ decision 插入必违 decision_scenario_tenant_fkey', async () => {
    await expect(
      inRollbackTx(async (c) => { await c.query(MIN_DECISION_SQL, [SCENARIO, TENANT_A]); })
    ).rejects.toThrow(/decision_scenario_tenant_fkey/);
  });

  it('物化后同事务可插入 decision（外键被真实满足，非"声明式"满足）', async () => {
    const r = await inRollbackTx(async (c) => {
      const created = await ensureTenantScenario(TENANT_A, SCENARIO, txIO(c));
      const ins = await c.query(MIN_DECISION_SQL, [SCENARIO, TENANT_A]);
      return { created, inserted: ins.rowCount };
    });
    expect(r.created).toBe(1);
    expect(r.inserted).toBe(1);
  });

  it('幂等：重复物化新增 0 行（ON CONFLICT (scenario_id, tenant_id) DO NOTHING）', async () => {
    const second = await inRollbackTx(async (c) => {
      await ensureTenantScenario(TENANT_A, SCENARIO, txIO(c));
      return ensureTenantScenario(TENANT_A, SCENARIO, txIO(c));
    });
    expect(second).toBe(0);
  });

  it('system 租户不被物化（平台模板自身无"租户副本"语义）；空值短路', async () => {
    const r = await inRollbackTx(async (c) => ({
      sys: await ensureTenantScenario('system', SCENARIO, txIO(c)),
      nil: await ensureTenantScenario(null, SCENARIO, txIO(c)),
      noScenario: await ensureTenantScenario(TENANT_A, null, txIO(c)),
    }));
    expect(r.sys).toBe(0);
    expect(r.nil).toBe(0);
    expect(r.noScenario).toBe(0);
  });

  it('克隆保真 + 列集漂移守卫：除 tenant_id/created_at 外逐列与 system 模板相同', async () => {
    const r = await inRollbackTx(async (c) => {
      await ensureTenantScenario(TENANT_A, SCENARIO, txIO(c));
      const cols = await c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='crm' AND table_name='decision_scenario'
            AND column_name NOT IN ('tenant_id','created_at')
          ORDER BY column_name`
      );
      const schemaCols = cols.rows.map((x) => x.column_name);
      const mine = (await c.query(
        'SELECT to_jsonb(t) r FROM crm.decision_scenario t WHERE scenario_id=$1 AND tenant_id=$2',
        [SCENARIO, TENANT_A]
      )).rows[0]?.r;
      const sysRow = (await c.query(
        "SELECT to_jsonb(t) r FROM crm.decision_scenario t WHERE scenario_id=$1 AND tenant_id='system'",
        [SCENARIO]
      )).rows[0]?.r;
      for (const o of [mine, sysRow]) { if (o) { delete o.tenant_id; delete o.created_at; } }
      const keys = new Set([...Object.keys(mine || {}), ...Object.keys(sysRow || {})]);
      const mismatched = [...keys].filter((k) => JSON.stringify(mine?.[k]) !== JSON.stringify(sysRow?.[k]));
      return {
        // ① 新增列未进克隆清单（漂移）② 反向：清单里有、库里没有的列
        driftNotCloned: schemaCols.filter((x) => !SCENARIO_CLONE_COLUMNS.includes(x)),
        driftStale: SCENARIO_CLONE_COLUMNS.filter((x) => !schemaCols.includes(x)),
        mismatched, bothPresent: !!mine && !!sysRow, cloned: !!mine,
      };
    });
    expect(r.bothPresent).toBe(true);
    expect(r.cloned).toBe(true);
    // 漂移守卫：任一列被加到 crm.decision_scenario 而没进 SCENARIO_CLONE_COLUMNS ⇒ 此断言变红
    expect(r.driftNotCloned).toEqual([]);
    expect(r.driftStale).toEqual([]);
    expect(r.mismatched).toEqual([]);
  });

  it('读取谓词：两个租户各自校准场景后，loadScenarioConfig 必须各读各的（禁跨租户混读）', async () => {
    const r = await inRollbackTx(async (c) => {
      await ensureTenantScenario(TENANT_A, SCENARIO, txIO(c));
      await ensureTenantScenario(TENANT_B, SCENARIO, txIO(c));
      // 模拟「租户按后台配置校准自己的场景行」——focus_rulers 正是行业差异化载体
      await c.query(`UPDATE crm.decision_scenario SET focus_rulers='["sentinel_A"]'::jsonb
                      WHERE scenario_id=$1 AND tenant_id=$2`, [SCENARIO, TENANT_A]);
      await c.query(`UPDATE crm.decision_scenario SET focus_rulers='["sentinel_B"]'::jsonb
                      WHERE scenario_id=$1 AND tenant_id=$2`, [SCENARIO, TENANT_B]);
      const a = await loadScenarioConfig(SCENARIO, TENANT_A, txIO(c));
      const b = await loadScenarioConfig(SCENARIO, TENANT_B, txIO(c));
      const sys = await loadScenarioConfig(SCENARIO, 'system', txIO(c));
      return {
        a: JSON.stringify(a?.focus_rulers), b: JSON.stringify(b?.focus_rulers),
        sys: JSON.stringify(sys?.focus_rulers),
      };
    });
    expect(r.a).toContain('sentinel_A');
    // 关键鉴别力：去掉租户谓词后，两次调用会返回**同一行** ⇒ 本断言必然变红
    expect(r.b).toContain('sentinel_B');
    expect(r.sys).not.toContain('sentinel_');
  });

  it('缺行回退 system 模板（与 requireDecision 的解析口径一致，不因缺行返回 null）', async () => {
    const r = await inRollbackTx(async (c) => {
      const got = await loadScenarioConfig(SCENARIO, NEVER, txIO(c));
      return { nonNull: !!got, stage: got?.stage || null, scenarioId: got?.scenario_id || null };
    });
    expect(r.nonNull).toBe(true);
    expect(r.scenarioId).toBe(SCENARIO);
    expect(r.stage).toBeTruthy();
  });
});
