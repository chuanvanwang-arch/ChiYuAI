import { describe, it, expect, beforeEach } from 'vitest';
import { withTx, query } from '../../src/db.js';
import { replayDims } from '../../src/calibration/replayDims.js';

// isolation-audit:ignore crm.decision —— 子表清理见下方 purgeScenarioDecisions，
//   用 DECISION_CHILD_TABLES 表驱动（动态表名 `crm.${table}`），静态扫描无法解析，
//   已按「子表 → 主表」覆盖 information_schema 实测的全部 9 张 FK 子表。
// crm.decision 的 FK 子表清单（information_schema 实测共 12 张表外键引用 crm.decision，
// 2026-09-03 补齐：此前只列 9 张，漏 decision_skill_quality / tasks 未列全 / particles——重放
// QA 或上游造决策时这三张也会引用 decision_id，漏删即撞 FK）。
// 背景（2026-09-02 真缺陷）：原 beforeEach 只 `DELETE FROM crm.decision`，不删子表。
//   只要上游文件留下过 OPP_QUALIFY 的决策事件（如 autonomyEngine.js:143 的「升级人工」路径
//   requireDecision 会写 decision_event 的 made/escalated 两条），本次清理就撞
//   `decision_event_decision_id_fkey` → 整个文件 3 个用例全红。
//   表现为「时红时绿」，实则是**确定性**：取决于跑之前库里有没有残留，与执行顺序无关
//   （单跑该文件即可稳定复现）。
// 修复：定向清理按「子表 → 主表」顺序，只针对本场景时间窗内的决策，不动其它场景。
// 注意：tasks 本身还有 CASCADE 子表 task_audit（删 tasks 时自动级联，无需手动清）。
const DECISION_CHILD_TABLES = [
  ['calibration_patch', 'decision_id'],
  ['decision_context_snapshot', 'decision_id'],
  ['decision_event', 'decision_id'],
  ['decision_outcome', 'decision_id'],
  ['decision_precedent_rel', 'decision_id'],
  ['decision_precedent_rel', 'precedent_id'],
  ['decision_provenance', 'decision_id'],
  ['decision_relation', 'from_id'],
  ['decision_rule', 'decision_id'],
  ['decision_skill_quality', 'decision_id'],
  ['particles', 'decision_id'],
  ['tasks', 'decision_id'],
];
const WINDOW = `interval '30 days'`; // 与 replayDims 的 30 天窗口保持一致

async function purgeScenarioDecisions(client, scenarioId) {
  const sel = `SELECT decision_id FROM crm.decision WHERE scenario_id=$1 AND created_at >= now() - ${WINDOW}`;
  for (const [table, col] of DECISION_CHILD_TABLES) {
    await client.query(`DELETE FROM crm.${table} WHERE ${col} IN (${sel})`, [scenarioId]);
  }
  // decision_relation.to_id 是 TEXT（BG-03 方案 B，无 FK 约束但语义同键）→ 单独按 ::text 清，避免留孤儿边
  await client.query(
    `DELETE FROM crm.decision_relation WHERE to_id::text IN (SELECT decision_id::text FROM crm.decision WHERE scenario_id=$1 AND created_at >= now() - ${WINDOW})`,
    [scenarioId]
  );
  await client.query(
    `DELETE FROM crm.decision WHERE scenario_id=$1 AND created_at >= now() - ${WINDOW}`,
    [scenarioId]
  );
}

describe('replayDims 量化重放', () => {
  beforeEach(async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP_QUALIFY'`);
      await purgeScenarioDecisions(client, 'OPP_QUALIFY');
    });
  });

  it('升 block 后历史缺失 ctx 被计入拦截率', async () => {
    await withTx(async (client) => {
      await client.query(
        `INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
         VALUES ('OPP_QUALIFY', '{"identity": null}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'APPROVE', 'HUMAN', 'test', 'HIGH', 'CONFIRMED')`);
    });
    const r = await replayDims('OPP_QUALIFY', [{ dim: 'identity', on_missing: 'block' }], 30);
    expect(r.sample_size).toBe(1);
    expect(r.intercepted_before).toBe(0); // 当前无 required_dims → 不拦
    expect(r.intercepted_after).toBe(1);  // 升 block → 拦
    expect(r.estimated_block_rate).toBe(1);
    expect(r.estimated_block_rate_delta).toBe(1);
  });

  it('trigger_context identity 字段存在且非 null → 不拦截', async () => {
    await withTx(async (client) => {
      await client.query(`INSERT INTO crm.decision (scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state) VALUES ('OPP_QUALIFY', '{"identity":"ABC Corp"}'::jsonb, '[]'::jsonb, '[]'::jsonb, 'APPROVE', 'HUMAN', 'test', 'HIGH', 'CONFIRMED')`);
    });
    const r = await replayDims('OPP_QUALIFY', [{ dim: 'identity', on_missing: 'block' }], 30);
    expect(r.intercepted_after).toBe(0);
  });

  it('样本不足（0 条）不报错，拦截率为 0', async () => {
    const r = await replayDims('OPP_QUALIFY', [{ dim: 'identity', on_missing: 'block' }], 30);
    expect(r.sample_size).toBe(0);
    expect(r.estimated_block_rate).toBe(0);
    expect(r.estimated_block_rate_delta).toBe(0);
  });
});
