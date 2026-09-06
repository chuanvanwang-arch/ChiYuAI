// test/sales/bantcc6.test.js — P0-B BANTCC 五维 → 六维（T3）红灯用例
// 配套计划：docs/2026-08-30-sales-p0-p1-test-plan.md §3
// 事实源：to-b-sales-management 场景五标准 11（BANTCC 六维）
// 变更要点：原实现（evaluator.js）把 coach（内线）与 competition（竞争）混进同一个 C，
//          现拆为 C1=Competition 竞争情况、C2=Company & Condition 公司支持与条件，分母 5 → 6。
import { describe, it, expect } from 'vitest';
import { deterministicEval, evaluateAiAttributesFor, AI_ATTR_DEFS } from '../../src/aiAttributes/evaluator.js';

const evalBantcc = (payload) =>
  deterministicEval('CRM_DEAL', payload, { key: 'bantcc_completeness' });

// 六维信号齐全的商机（B/A/N/T/C1/C2）
const FULL = {
  expected_amount: 1200000,      // B
  decision_maker: 'CFO 张总',    // A
  needs: { product: 'A3 彩盒产线', qty: 2 }, // N
  expected_close_date: '2026-12-20',        // T
  competition: '友商 B 已入围',   // C1
  coach: '技术主管王工（支持我方）', // C2
};

describe('【T3】BANTCC 六维拆分', () => {
  it('T3-C1 六维齐全 → 齐全度 1，rationale 标记 6/6', () => {
    const r = evalBantcc(FULL);
    expect(r.value).toBe(1);
    expect(r.rationale).toMatch(/6\/6/);
  });

  it('T3-C2 仅 C1（有竞争信息）→ 1/6，detail 含 C1=1 C2=0', () => {
    const r = evalBantcc({ competition: '友商 B 已入围' });
    expect(r.value).toBeCloseTo(1 / 6, 6);
    expect(r.rationale).toContain('C1=1');
    expect(r.rationale).toContain('C2=0');
  });

  it('T3-C3 仅 C2（有内部支持）→ 1/6，detail 含 C1=0 C2=1', () => {
    const r = evalBantcc({ coach: '王工（支持我方）' });
    expect(r.value).toBeCloseTo(1 / 6, 6);
    expect(r.rationale).toContain('C1=0');
    expect(r.rationale).toContain('C2=1');
  });

  it('T3-C4 coach 不再为 C1 计分（混维已拆）', () => {
    // 仅有 coach（C2 信号），C1 必须为 0——旧实现会把 coach 计进同一个 C
    const r = evalBantcc({ coach: '王工' });
    expect(r.rationale).toContain('C1=0');
    expect(r.rationale).toContain('C2=1');
  });

  it('T3-C5 旧数据迁移回退：有旧 bantcc.c 评分时 C1/C2 各继承其值', () => {
    // 旧版落过显式五维评分 bantcc.c=1，但无 C1/C2 信号 → 各继承 1，等效分母不变
    const r = evalBantcc({ ...FULL, competition: undefined, coach: undefined, bantcc: { c: 1 } });
    expect(r.rationale).toContain('C1=1');
    expect(r.rationale).toContain('C2=1');
    expect(r.value).toBe(1); // 五维全有 + C1/C2 继承 → 6/6
  });

  it('T3-C6 显式评分优先于字段信号', () => {
    const r = evalBantcc({ ...FULL, bantcc: { c1: 0.5, c2: 0 } });
    expect(r.rationale).toContain('C1=0.5');
    expect(r.rationale).toContain('C2=0');
  });

  it('T3-C7 bantcc_detail 落 payload.ai 且为六键对象', () => {
    const entity = { type: 'CRM_DEAL', payload: { ...FULL } };
    const { ai } = evaluateAiAttributesFor(entity, { now: '2026-08-30T00:00:00Z' });
    const d = ai.bantcc_detail?.value;
    expect(d).toBeTruthy();
    expect(Object.keys(d).sort()).toEqual(['A', 'B', 'C1', 'C2', 'N', 'T']);
  });

  it('T3-C8 bantcc_detail 带 axis 与 confidence', () => {
    expect(AI_ATTR_DEFS.CRM_DEAL.bantcc_detail).toBeTruthy();
    expect(AI_ATTR_DEFS.CRM_DEAL.bantcc_detail.axis).toBe('J_Judge');
    expect(AI_ATTR_DEFS.CRM_DEAL.bantcc_detail.confidence).toBe(0.8);
  });

  it('T3-C9 门控拦截文案指出缺失维度（S3→S4 缺 T、C1）', async () => {
    const { salesStageGate } = await import('../../src/action/executor.js');
    const v = salesStageGate({
      curStage: 'S3',
      toStage: 'S4',
      dealPayload: {
        ...FULL,
        expected_close_date: undefined, // 缺 T
        competition: undefined,          // 缺 C1
        quotation_refs: ['Q-1'],
        ai: { bantcc_completeness: { value: 0.4 } },
      },
    });
    expect(v.ok).toBe(false);
    expect(v.gaps.join(';')).toContain('T');
    expect(v.gaps.join(';')).toContain('C1');
  });

  it('T3-C10 阈值边界：bantcc = 0.6 放行', async () => {
    const { salesStageGate } = await import('../../src/action/executor.js');
    const v = salesStageGate({
      curStage: 'S3',
      toStage: 'S4',
      dealPayload: { ...FULL, quotation_refs: ['Q-1'], ai: { bantcc_completeness: { value: 0.6 } } },
    });
    expect(v.ok).toBe(true);
  });

  it('T3-C11 阈值边界：bantcc = 0.59 拦截', async () => {
    const { salesStageGate } = await import('../../src/action/executor.js');
    const v = salesStageGate({
      curStage: 'S3',
      toStage: 'S4',
      dealPayload: { ...FULL, quotation_refs: ['Q-1'], ai: { bantcc_completeness: { value: 0.59 } } },
    });
    expect(v.ok).toBe(false);
  });

  it('T3-C12 迁移脚本幂等：连续两次运行第二次无变更', async () => {
    const mod = await import('../../scripts/migrate-bantcc-6dim.mjs');
    const first = await mod.migrateBantcc6Dim();
    const second = await mod.migrateBantcc6Dim();
    expect(second.changed).toBe(0);
    expect(typeof first.scanned).toBe('number');
  });
});
