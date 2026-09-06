// test/rule/ruleEngine.test.js — G2 规则 DB 化 + rule_hit 落库（TDD 红→绿）
// 测试计划 §5.1：decision_rule 表驱动 ruleEngine.check（新）；rule_hit 落库率 100%（含 block）。
// 对齐真实 schema（schema.sql:486-552 决策质量闭环 DDL）：本套件自建 decision_rule/rule_hit 表，
//   测试库 plm_test 由 seed-test-config 幂等补表（步骤⑬，见下方实现）。
import { describe, it, expect, beforeEach } from 'vitest';
import { queryWrite, query } from '../../src/db.js';
import { ruleEngine, loadRulesFromDb, resetRuleCache, evaluateRules } from '../../src/ruleEngine.js';

// 自建专属规则（不依赖 DB 种子；ruleEngine 新增 loadRulesFromDb 从 decision_rule 读）
beforeEach(async () => {
  // 先清内存缓存（防御：即使下方 TRUNCATE 因外部状态异常未生效，evaluateRules 仍回退 BUILTIN，
  // 不依赖 dbRules 的隐式 null 回退被上游污染打断）
  resetRuleCache();
  await queryWrite(`TRUNCATE crm.decision_rule, crm.rule_hit RESTART IDENTITY CASCADE`);
});

describe('G2 decision_rule + rule_hit（规则 DB 化 + 留痕）', () => {
  it('规则从 DB 加载后生效（DB 化取代硬编码）', async () => {
    await queryWrite(
      `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled)
       VALUES ('stage_forward_only','CRM_DEAL.advance','{}'::jsonb,'{}'::jsonb,true)`,
    );
    await loadRulesFromDb();
    const r = await ruleEngine.check('CRM_DEAL', 'advance', { from: 'lead', to: 'lost' });
    expect(r.ok).toBe(false);
    expect(r.reasons).toContain('stage_forward_only');
  });

  it('block 决策留痕 rule_hit 落库（100%）', async () => {
    await queryWrite(
      `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled)
       VALUES ('stage_forward_only','CRM_DEAL.advance','{}'::jsonb,'{}'::jsonb,true)`,
    );
    await loadRulesFromDb();
    const r = await ruleEngine.check('CRM_DEAL', 'advance', { from: 'lead', to: 'lost' });
    expect(r.ok).toBe(false);
    const hits = (await query(`SELECT * FROM crm.rule_hit WHERE blocked=true`)).rows;
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0].rule_code).toBe('stage_forward_only');
  });

  it('禁用规则不生效（enabled=false 跳过）', async () => {
    await queryWrite(
      `INSERT INTO crm.decision_rule (code, match_type, match_payload, check_payload, enabled)
       VALUES ('stage_forward_only','CRM_DEAL.advance','{}'::jsonb,'{}'::jsonb,false)`,
    );
    await loadRulesFromDb();
    const r = await ruleEngine.check('CRM_DEAL', 'advance', { from: 'lead', to: 'lost' });
    expect(r.ok).toBe(true); // 禁用 → 不拦截
  });
});

// P-1 T2（2026-09-02）：S4 供给侧改用 evaluateRules 只读评估治理边界。
// 目的：① 动作名对齐规则注册（'advance' 而非 'context-assembly'）② 只读不落 rule_hit（避免与写闸重复留痕）
//   ③ 适用规则即「治理已校验」信号，违规以 result='blocked' 呈现。
describe('P-1 T2 — evaluateRules 只读供给（S4 治理边界）', () => {
  // 显式确保回退 BUILTIN：本块用例不插 DB 规则，依赖 dbRules===null 的 BUILTIN 兜底。
  // 若全量中某上游文件经共享模块残留 dbRules 数组态，此处强制清空，使用例与运行顺序无关。
  beforeEach(() => resetRuleCache());
  it('动作名对齐 advance：适用 stage_forward_only 且只读（不落 rule_hit）', async () => {
    const before = (await query(`SELECT count(*)::int c FROM crm.rule_hit`)).rows[0].c;
    const { applied } = evaluateRules('CRM_DEAL', 'advance', { from: 'opportunity', to: 'quoted' });
    expect(applied.map((a) => a.code)).toContain('stage_forward_only');
    const sfo = applied.find((a) => a.code === 'stage_forward_only');
    expect(sfo.ok).toBe(true);
    // 只读契约：evaluateRules 不得产生 rule_hit 留痕（与 check() 区分）
    // 用「前后增量」而非绝对计数，免疫上游文件残留的 rule_hit 行
    const after = (await query(`SELECT count(*)::int c FROM crm.rule_hit`)).rows[0].c;
    expect(after - before).toBe(0);
  });
  it('阶段回退 → stage_forward_only ok:false（治理违规可呈现为 blocked）', async () => {
    const { applied } = evaluateRules('CRM_DEAL', 'advance', { from: 'quoted', to: 'opportunity' });
    const sfo = applied.find((a) => a.code === 'stage_forward_only');
    expect(sfo.ok).toBe(false);
    expect(sfo.reasons).toContain('stage_forward_only');
  });
  it('旧动作名 context-assembly 无规则匹配（证明修复必要性：恒空 → 治理维恒 false）', async () => {
    const { applied } = evaluateRules('CRM_DEAL', 'context-assembly', {});
    expect(applied).toHaveLength(0);
  });
});