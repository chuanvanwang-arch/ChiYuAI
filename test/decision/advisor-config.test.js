// 配置化契约（对话驱动决策建议 T9）
import { describe, it, expect } from 'vitest';
import { DEFAULT_SCENARIO_MAP } from '../../src/decision/dialogAdvisor.js';
import { DEFAULT_ADVISOR_CONFIG } from '../../src/decision/scenarioAdvisors.js';
import { readFileSync } from 'node:fs';

describe('配置化契约', () => {
  it('8 大销售场景全部在默认映射表中（缺一即坐标判定有盲区）', () => {
    const ids = DEFAULT_SCENARIO_MAP.map((e) => e.scenario_id);
    for (const need of ['LEAD_FOLLOW_UP', 'OPP_QUALIFY', 'CLIENT_STRATEGY', 'SOLUTION_VALUE', 'QUOTE_PRICING', 'SIGN_RISK', 'POST_CONTRACT', 'LOSS_REVIEW']) {
      expect(ids).toContain(need);
    }
  });
  it('默认阈值齐全且均为数值（禁 null 静默置 0）', () => {
    for (const [k, v] of Object.entries(DEFAULT_ADVISOR_CONFIG)) expect(typeof v).toBe('number');
  });
  it('seed.sql 已播种两项配置（后台可改的唯一落点）', () => {
    const sql = readFileSync(new URL('../../db/seed.sql', import.meta.url), 'utf8');
    expect(sql).toContain('dialog-scenario-map');
    expect(sql).toContain('dialog-advisor-config');
  });
});
