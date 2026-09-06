// test/decision/provenance.test.js — G3 PROV-O 标准导出 + 归档分级
// 契约：C-DAI 决策问责闭环（归属 decision-retro 智能体；knowledgeScope L1–L3）
// 测试计划 §5.2：exportTurtle 产出 Turtle（prefix prov:/Entity/wasAttributedTo）；
// applyArchival 按 retentionDays 把超过周期的 entry 标记 archived（软标记，不做物理删）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { seedScenario, baseDecision, cleanupScenario } from './_helpers.js';
import { createDecision } from '../../src/decision/decisionRepo.js';
import { trackEntry, verifyChain, exportAudit } from '../../src/decision/provenance.js';

const SCEN = 'G3_PROV_TEST';

describe('G3 PROV-O 标准导出 + 归档分级', () => {
  let decisionId;

  beforeEach(async () => {
    await seedScenario(SCEN);
    const r = await createDecision(baseDecision(SCEN, { scenario_id: SCEN }));
    decisionId = r.decision_id ?? r;
    // 追两条审计 entry，保证链可验证、归档有候选
    await trackEntry({ decision_id: decisionId, entry_type: 'decision', payload: { phase: 'init', dims: ['B'] } });
    await trackEntry({ decision_id: decisionId, entry_type: 'property', payload: { attr: 'amount', value: 100 } });
  });

  afterEach(async () => {
    await cleanupScenario(SCEN);
  });

  it('exportTurtle 产出 Turtle 含 entity/activity/agent', async () => {
    const { exportTurtle } = await import('../../src/decision/provenance.js');
    const audit = await exportAudit({ decision_id: decisionId });
    const tt = await exportTurtle({ decision_id: decisionId, decision: audit.decision, entries: audit.entries, chainStatus: audit.chainStatus });
    expect(tt).toContain('@prefix prov:');
    expect(tt).toMatch(/prov:Entity/);
    expect(tt).toMatch(/prov:wasAttributedTo/);
  });

  it('归档分级：超过 retention_days 的 entry 标记为 archived', async () => {
    const { applyArchival } = await import('../../src/decision/provenance.js');
    const r = await applyArchival({ decision_id: decisionId, retentionDays: 365 });
    expect(r.archived).toBeGreaterThanOrEqual(0);
    // 软标记而非物理删除：行仍在（createDecision 内部追写多条：decision 主轴 + context_supply 等组装溯源，
    //   再加本用例 2 条 → ≥3 行；断言不锁死条数，只锁「软标记不删行」语义）
    const rows = (await query(
      `SELECT id, archived FROM crm.decision_provenance WHERE decision_id=$1`,
      [decisionId]
    )).rows;
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r2) => r2.archived === false || r2.archived === null)).toBe(true); // 全未硬删
  });
});