// test/conflict.test.js — P4 冲突保留：三源地址并存、标记冲突、不覆盖
// G4 扩展：resolveConflict 五策略（timestamp/source_priority/confidence_weighted/merge/human_arbitration）
// + source_credibility 列；human_arbitration 经决策第0闸（produceDecision, scenario_id=CALIBRATION_CHANGE）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureAssertionsSchema, recordAssertion, detectConflicts, adoptValue, resolveConflict, ensureCredibilityColumn } from '../src/decision/conflict.js';

beforeEach(async () => {
  await ensureAssertionsSchema();
  await query('TRUNCATE crm.assertions RESTART IDENTITY CASCADE');
});

describe('P4 冲突保留', () => {
  it('上海/北京/深圳三源地址 → 保留三条、标记冲突、不覆盖', async () => {
    await recordAssertion('ACC1', 'address', '上海市', 'src-sh');
    await recordAssertion('ACC1', 'address', '北京市', 'src-bj');
    await recordAssertion('ACC1', 'address', '深圳市', 'src-sz');
    const c = await detectConflicts('ACC1', 'address');
    expect(c.assertions.length).toBe(3);
    expect(c.hasConflict).toBe(true);
    expect(c.needsReview).toBe(true);
  });

  it('adoptValue 选定权威值后其他源标记 invalid，但物理保留', async () => {
    await recordAssertion('ACC1', 'address', '上海市', 'src-sh');
    await recordAssertion('ACC1', 'address', '北京市', 'src-bj');
    const after = await adoptValue('ACC1', 'address', '上海市');
    expect(after.assertions.length).toBe(2); // 仍保留两条，不删
    const shanghai = after.assertions.find((a) => a.value === '上海市');
    const beijing = after.assertions.find((a) => a.value === '北京市');
    expect(shanghai.valid).toBe(true);
    expect(beijing.valid).toBe(false);
  });

  it('G4 timestamp 策略：取最新值', async () => {
    await recordAssertion('ACC1', 'address', '上海市', 'src-sh');
    await recordAssertion('ACC1', 'address', '北京市', 'src-bj');
    const latest = await query(`SELECT * FROM crm.assertions WHERE entity_id='ACC1' AND attr='address' ORDER BY created_at DESC LIMIT 1`);
    const r = await resolveConflict('ACC1', 'address', 'timestamp');
    expect(r.winner.source_id).toBe(latest.rows[0].source_id);
    expect(r.winner.value).toBe('北京市'); // 后写为最新
  });

  it('G4 human_arbitration 策略：必须产出 decision 行（第0闸）', async () => {
    await ensureCredibilityColumn();
    await recordAssertion('ACC1', 'address', '上海市', 'src-sh');
    await recordAssertion('ACC1', 'address', '北京市', 'src-bj');
    const r = await resolveConflict('ACC1', 'address', 'human_arbitration', {
      produceDecision: async (input) => ({ decision_id: '11111111-2222-3333-4444-555555555555', ...input }),
    });
    expect(r.decisionId).toBe('11111111-2222-3333-4444-555555555555');
    expect(r.assertions.length).toBe(2); // 不物理删除
  });

  it('G4 source_credibility 列影响 confidence_weighted 裁决', async () => {
    await ensureCredibilityColumn();
    await recordAssertion('ACC1', 'address', '上海市', 'src-sh');
    await recordAssertion('ACC1', 'address', '北京市', 'src-bj');
    await query(`UPDATE crm.assertions SET source_credibility=0.9 WHERE source_id='src-sh'`);
    const r = await resolveConflict('ACC1', 'address', 'confidence_weighted');
    expect(r.winner.source_id).toBe('src-sh'); // 高 credible 源胜出
  });
});
