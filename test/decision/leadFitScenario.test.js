// test/decision/leadFitScenario.test.js
// T6（测试计划 §4）：LEAD_FIT 场景字典 —— 集成（真实 PG crm_native_test@5433）
// ⚠ 无 resolveScenario 导出、亦无 src/decision/scenarioStore.js（原稿虚构）——真实场景读取只有
//   executor.js:25-27 的私有 getScenario()（未导出）+ autonomyEngine.requireDecision()（:115-122）。
//   故本 Task 走「① 双源静态一致 + ② 真执行 db/seed.sql 场景段（幂等）后断言行属性」。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { query, queryWrite } from '../../src/db.js';

const SEED_FILES = ['db/seed.sql', 'db/test-setup.sql'];
const TAIL = 'ON CONFLICT (scenario_id, tenant_id) DO NOTHING;';
const seedUrl = (rel) => new URL(`../../${rel}`, import.meta.url);

// 抽取 crm.decision_scenario 的完整 INSERT 语句（VALUES 全行 + 收尾 ON CONFLICT）
function extractScenarioInsert(rel) {
  const sql = fs.readFileSync(seedUrl(rel), 'utf8');
  const i = sql.indexOf('INSERT INTO crm.decision_scenario');
  expect(i, `${rel} 应含 crm.decision_scenario 段`).toBeGreaterThanOrEqual(0);
  const j = sql.indexOf(TAIL, i);
  expect(j, `${rel} 场景段应以 ON CONFLICT (scenario_id, tenant_id) DO NOTHING; 收尾`).toBeGreaterThanOrEqual(0);
  return sql.slice(i, j + TAIL.length);
}

// 抽取 LEAD_FIT 那一行 —— 切到**下一行场景元组**为止。
// ⚠ 2026-09-17 修：原实现写作 `return stmt.slice(i)`，其隐含约定是「LEAD_FIT 是 VALUES 段的最后一行」。
//   该约定已被证伪：其后陆续追加了 PROSPECTING_CONFIRM（09-14，2 权重）与 PREHEAT_MARK（09-15，1 权重）
//   ⇒ 切片把三行一起吞下，`"weight":` 匹配到 5+2+1=**8** 个，断言 `toHaveLength(5)` 报
//   「expected [Array(8)] to have a length of 5 but got 8」——**看着像种子写错，实为切片依赖了会漂移的位置约定**。
//   ⇒ 判据：从 SQL 文本里"按位置约定"切片，等价于把「后续追加」变成**隐式破坏**；
//     必须按**结构边界**（下一个元组起始）切，而不是"切到语句尾"。
function leadFitRow(stmt) {
  const i = stmt.indexOf("('LEAD_FIT'");
  expect(i, 'LEAD_FIT 行应存在').toBeGreaterThanOrEqual(0);
  const rest = stmt.slice(i);
  const j = rest.indexOf("\n('"); // 下一行场景元组的起始（行首左括号）
  return j >= 0 ? rest.slice(0, j) : rest;
}

describe('LEAD_FIT decision_scenario', () => {
  it('双源（db/seed.sql + db/test-setup.sql）均含 LEAD_FIT 行：tier=LEAD / autonomous=TRUE / 5 个 ICP cond / 权重和=1', () => {
    for (const f of SEED_FILES) {
      const stmt = extractScenarioInsert(f);
      expect(stmt, `${f} 含 LEAD_FIT`).toContain("'LEAD_FIT'");
      const row = leadFitRow(stmt);
      expect(row, `${f} default_tier=LEAD + autonomous_allowed=TRUE`).toContain("'LEAD', TRUE");
      for (const cond of ['industry', 'headcount', 'geo', 'hiring_icp_role', 'funding_round']) {
        expect(row, `${f} 含 cond=${cond}`).toContain(`"cond":"${cond}"`);
      }
      const w = [...row.matchAll(/"weight":([0-9.]+)/g)].map((m) => Number(m[1]));
      expect(w, `${f} 5 条 ICP 权重`).toHaveLength(5);
      expect(w.reduce((a, b) => a + b, 0), `${f} 权重和=1`).toBeCloseTo(1, 6);
    }
  });

  it('真实 PG：执行 db/seed.sql 场景段（幂等）后 LEAD_FIT 行落库且属性正确', async () => {
    await queryWrite(extractScenarioInsert('db/seed.sql'));
    const r = await query(
      `SELECT scenario_id, stage, default_tier, autonomous_allowed, methodology_ids, eval_dimensions
         FROM crm.decision_scenario WHERE scenario_id='LEAD_FIT' AND tenant_id='system'`
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].stage).toBe('一、线索');
    expect(r.rows[0].default_tier).toBe('LEAD');
    expect(r.rows[0].autonomous_allowed).toBe(true);
    expect(r.rows[0].methodology_ids).toEqual(['BANT', 'MEDDICC', 'OPP_MATRIX']);
    expect(r.rows[0].eval_dimensions.map((d) => d.cond))
      .toEqual(['industry', 'headcount', 'geo', 'hiring_icp_role', 'funding_round']);
  });
});
