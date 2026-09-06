// test/propagation/retro-knob.test.js
// Task 5（RED→GREEN）：retro 扩展 knob=config_store + draft_patch 带 tenant_id
// 设计依据：docs/2026-09-04-param-propagation-hub-design.md §4.4、§8 P1
// 铁律：零信任（本测试 dryRun，不写库）；MIN_SAMPLE=20 闸需在测试数据中满足。
import { describe, it, expect, vi } from 'vitest';

// 以 importActual 保留 db 其余导出（queryWrite/pool），仅覆盖 query 为可控桩
vi.mock('../../src/db.js', async (importActual) => {
  const actual = await importActual();
  return { ...actual, query: vi.fn() };
});

import { query } from '../../src/db.js';
import { runDecisionRetro } from '../../src/decision/retro.js';

// 注入 llmFactory：返回一个返回 config_store 旋钮处方的 LLM
function llmFactoryReturning(patch) {
  return async () => async () => ({
    root_cause_class: 'DATA_QUALITY_PRECEDENT',
    root_cause_explanation: '先例召回偏紧',
    draft_patches: [patch],
    confidence: 0.7,
    predicted_impact: '提升命中',
  });
}

// 构造满足 MIN_SAMPLE(=20) 的窗口决策（同 scenario、同租户 t-a），触发 LLM 归因 + 处方
function makeDecisions(n, tenantId) {
  const arr = [];
  for (let i = 0; i < n; i++) {
    arr.push({
      decision_id: `d${i}`,
      scenario_id: 'S1',
      tenant_id: tenantId,
      attribution: { category: 'precedent_missing', required_fill: {}, edge_compliance: {} },
      feedback: { usable: true, major_deviation: false },
    });
  }
  return arr;
}

describe('retro config_store knob', () => {
  it('产出 knob=config_store 且带 tenant_id 的 draft_patch', async () => {
    const decisions = makeDecisions(20, 't-a');
    query.mockImplementation(async (sql) => {
      if (sql.includes('FROM crm.decision WHERE decided_at')) return { rows: decisions };
      return { rows: [] };
    });

    const report = await runDecisionRetro({
      windowHours: 24,
      dryRun: true, // 不落库，纯逻辑验证
      llmFactory: llmFactoryReturning({
        knob: 'config_store',
        target: 'precedent-conf.minSimilarity',
        from_value: 0.45,
        to_value: 0.4,
        risk: 'LOW',
        label: '放宽先例阈值',
        evidence: { hit_rate: '0.21' },
      }),
    });

    const p = report.draft_patches.find((x) => x.knob === 'config_store');
    expect(p).toBeTruthy();
    expect(p.target).toBe('precedent-conf.minSimilarity');
    expect(p.tenant_id).toBe('t-a');
    // 根因类应透传，供后续 acceptSuggestion 决策第0闸使用
    expect(p.root_cause_class).toBe('DATA_QUALITY_PRECEDENT');
  });
});
