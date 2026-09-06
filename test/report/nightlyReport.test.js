import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { query } from '../../src/db.js';
import { renderNightlyMarkdown, saveNightlyReport, ensureNightlyReportTable, extractRetroMetrics } from '../../src/report/nightlyReport.js';

const DATE = '20260905';
const TODAY = new Date().toISOString().slice(0, 10); // 与 saveNightlyReport 内部的 run_date=new Date() 对齐（避免日历越日致测试脆弱）

describe('nightlyReport', () => {
  beforeAll(async () => { await ensureNightlyReportTable(); });

  it('renderNightlyMarkdown 含三段标题与计数', () => {
    const md = renderNightlyMarkdown({
      date: DATE,
      retro: { report_id: 'r1', decisions_scanned: 10, clusters: [{ root_cause_explanation: 'x', degraded: false }], draft_patches: [{ target: 'a' }], llm_enabled: true, llm_effective: 5 },
      routing: { closed: 2, patches: [{ target: 'b' }], nextArms: [], insufficient: [], errors: [] },
      param: { inspected: 22, healthy: 20, drift: 2, unknown: 0, patches: [{ target: 'rubric-thresholds.good', from_value: 0.75, to_value: 0.6 }] },
    });
    expect(md).toContain('## ① 决策复盘');
    expect(md).toContain('## ② 路由收口');
    expect(md).toContain('## ③ 参数体检');
    expect(md).toContain('运行总数');
    expect(md).toContain('失败原因');
    expect(md).toContain('建议调整措施');
    expect(md).toContain('22'); // param inspected
    expect(md).toContain('rubric-thresholds.good');
  });

  it('renderNightlyMarkdown 兼容持久化形态（summary 包裹，无顶层 decisions_scanned）', () => {
    const persistedRetro = {
      run_at: '2026-09-05T07:35:53.353Z',
      summary: { clusters: 11, llm_effective: 6, drafts: 15, llm_enabled: true, by_root_cause: { DIM_MISSING: 4, NEED_DIM_ORDER: 5 } },
      clusters: [
        { count: 39, llm_used: true, confidence: 0.72, scenario_id: 'LEAD_FOLLOW_UP', draft_patches: [{ target: 'LEAD_FOLLOW_UP', knob: 'meta_attr_map', from_value: {}, to_value: { lead_id: 'lead.id' }, label: '补全映射' }], root_cause_explanation: '维度缺失' },
        { count: 3, llm_used: false, confidence: 0.3, scenario_id: 'CALIBRATION_CHANGE', draft_patches: [], root_cause_explanation: '样本不足' },
      ],
    };
    const md = renderNightlyMarkdown({
      date: DATE,
      retro: persistedRetro,
      routing: { closed: 0, patches: [], nextArms: [], insufficient: [], errors: [] },
      param: { inspected: 22, healthy: 20, drift: 2, unknown: 0, patches: [] },
    });
    expect(md).toContain('运行总数（分析簇）：11');
    expect(md).toContain('llm_effective=6');
    expect(md).toContain('失败（未获 LLM / 降级簇）：5');
    expect(md).toContain('根因分布');
    expect(md).toContain('LEAD_FOLLOW_UP：{} → {"lead_id":"lead.id"}');
    expect(md).toContain('22');
  });

  it('extractRetroMetrics 兼容持久化形态（summary 包裹）', () => {
    const m = extractRetroMetrics({
      summary: { clusters: 11, llm_effective: 6, drafts: 15 },
      clusters: [{ llm_used: true }, { llm_used: false }, { llm_used: false }],
    });
    expect(m.total).toBe(11);
    expect(m.ok).toBe(6);
    expect(m.drift).toBe(5);
    expect(m.draftCount).toBe(15);
  });

  it('saveNightlyReport upsert 幂等（重跑 run_date 不增行）', async () => {
    const seg = { retro: { report_id: 'r1' }, routing: { closed: 0 }, param: { inspected: 22, healthy: 20, drift: 2, patches: [] } };
    await saveNightlyReport(seg);
    const c1 = (await query(`SELECT count(*)::int n FROM crm.nightly_report WHERE run_date='${TODAY}'`)).rows[0].n;
    await saveNightlyReport(seg); // 同 run_date 重跑
    const c2 = (await query(`SELECT count(*)::int n FROM crm.nightly_report WHERE run_date='${TODAY}'`)).rows[0].n;
    expect(c1).toBe(1);
    expect(c2).toBe(1); // 幂等：仍为 1 行（ON CONFLICT DO UPDATE）
  });

  afterAll(async () => { await query(`DELETE FROM crm.nightly_report WHERE run_date='${TODAY}'`); });
});
