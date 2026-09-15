// test/evolution/icpSelfEvolution.test.js
// Task 11（P0#3）ICP 自进化：草稿 → 回测 → HITL
//   零 PG：①-⑤ 用替身 store（接口层）；⑦ 用 createIcpStore 注入替身 read/write/gate（实现层）。
//   ⚠ 核心红线：**无 HITL 批准绝不生效** —— 断言生效写（store.setValidated）在 propose 阶段调用次数为 0。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  proposeIcpRecalibration, approveIcpRecalibration, backtestIcpDraft, runIcpEvolutionPass,
  ICP_DRAFT_KEY, BACKTEST_VERDICTS, DRAFT_STATUS,
} from '../../src/evolution/icpSelfEvolution.js';
import { createIcpStore, ICP_DECISION_SCENARIO } from '../../src/evolution/icpStore.js';
import { MIN_SAMPLE } from '../../src/calibration/constants.js';

const srcPath = (rel) => fileURLToPath(new URL('../../' + rel, import.meta.url));
const CURRENT_ICP = { industries: ['chemical'], min_headcount: 50, geo: ['CN'], min_confidence: 0.6 };
const samplesPass = (n = 25, hits = 20) => Array.from({ length: n }, (_, i) => ({ hit: i < hits }));

// 替身 store（接口层）：只暴露 readActiveIcp / insertDraft / setValidated
function makeStore({ current = CURRENT_ICP, insertDraftResult, setValidatedResult } = {}) {
  const calls = { readActiveIcp: 0, insertDraft: 0, setValidated: 0 };
  const seen = { inserted: [], validated: [] };
  const store = {
    async readActiveIcp() { calls.readActiveIcp += 1; return current; },
    async insertDraft(d, opts) {
      calls.insertDraft += 1; seen.inserted.push({ d, opts });
      return insertDraftResult || { draftId: 'D-1', decisionId: 'DEC-DRAFT' };
    },
    async setValidated(id, validated, by, opts) {
      calls.setValidated += 1; seen.validated.push({ id, validated, by, opts });
      return setValidatedResult || { draftId: id, decisionId: 'DEC-APPROVE', validated: !!validated };
    },
  };
  return { store, calls, seen };
}

describe('Task 11 ① 草稿先落、绝不自动生效', () => {
  it('propose 返回 needsApproval 恒真 + validated=false，只调 insertDraft', async () => {
    const { store, calls } = makeStore();
    const r = await proposeIcpRecalibration(store, { icp: { industries: ['coatings'] } }, { tenantId: 't1', samples: samplesPass() });
    expect(r.needsApproval).toBe(true);       // 恒真（与回测是否通过无关）
    expect(r.validated).toBe(false);
    expect(r.draftId).toBe('D-1');
    expect(calls.insertDraft).toBe(1);
    expect(calls.setValidated).toBe(0);       // 生效写 0 次
  });

  it('回测不通过时 needsApproval 仍为 true（审批必要性不由回测决定）', async () => {
    const { store, calls } = makeStore();
    // 空样本 → verdict='count'、passed=false
    const r = await proposeIcpRecalibration(store, { icp: { industries: ['coatings'] } }, { tenantId: 't1', samples: [] });
    expect(r.report.passed).toBe(false);
    expect(r.needsApproval).toBe(true);
    expect(calls.setValidated).toBe(0);
  });
});

describe('Task 11 ② 回测报告存在且含三态判据', () => {
  it('report 含 verdict/sample_size/hit_rate', async () => {
    const { store } = makeStore();
    const r = await proposeIcpRecalibration(store, { icp: { industries: ['coatings'] } }, { tenantId: 't1', samples: samplesPass() });
    expect(BACKTEST_VERDICTS).toContain(r.report.verdict);
    expect(typeof r.report.sample_size).toBe('number');
    expect(typeof r.report.hit_rate).toBe('number');
    expect(r.report.sample_size).toBe(25);
    expect(r.report.hit_rate).toBeCloseTo(0.8, 4);
  });
});

describe('Task 11 ③ 无 HITL 批准时绝不生效（核心红线）', () => {
  it('仅 propose 后：生效写从未被调用，且生效 ICP 未被改写', async () => {
    const { store, calls, seen } = makeStore();
    await proposeIcpRecalibration(store, { icp: { industries: ['coatings'] } }, { tenantId: 't1', samples: samplesPass() });
    expect(calls.setValidated).toBe(0);
    // 落草稿时也不得夹带生效写：替身收到的 draft.icp 仅为草稿内容
    expect(seen.inserted[0].d.icp).toEqual({ industries: ['coatings'] });
    expect(seen.inserted[0].d.status).toBe('draft');
  });

  it('runIcpEvolutionPass 非 dryRun 也只产草稿，绝不生效', async () => {
    const { store, calls } = makeStore();
    const out = await runIcpEvolutionPass({ tenantId: 't1', store, samples: samplesPass(), draft: { icp: { industries: ['coatings'] } } });
    expect(out.drafts).toBe(1);
    expect(out.needsApproval).toBe(true);
    expect(calls.setValidated).toBe(0);
  });

  it('runIcpEvolutionPass 无 draft 时不产草稿（绝不自动编造配置）', async () => {
    const { store, calls } = makeStore();
    const out = await runIcpEvolutionPass({ tenantId: 't1', store });
    expect(out.skipped).toBe('no_draft_proposed');
    expect(calls.insertDraft).toBe(0);
    expect(calls.setValidated).toBe(0);
  });
});

describe('Task 11 ④ 批准后生效 + 落 decision_id', () => {
  it('approve 调 setValidated 并返回非空 decisionId', async () => {
    const { store, calls, seen } = makeStore();
    const r = await approveIcpRecalibration(store, 'D-1', 'admin', { tenantId: 't1' });
    expect(calls.setValidated).toBe(1);
    expect(seen.validated[0].validated).toBe(true);
    expect(seen.validated[0].by).toBe('admin');
    expect(r.validated).toBe(true);
    expect(r.decisionId).toBeTruthy();
    expect(r.decisionId).not.toBe('pending');
  });

  it('fail-closed：无 approver / 无 draftId 均抛错', async () => {
    const { store, calls } = makeStore();
    await expect(approveIcpRecalibration(store, 'D-1', undefined)).rejects.toThrow(/approver/);
    await expect(approveIcpRecalibration(store, null, 'admin')).rejects.toThrow(/draftId/);
    expect(calls.setValidated).toBe(0);
  });
});

describe('Task 11 ⑤ 三态回测（backtestIcpDraft 纯函数）', () => {
  it('noop：与现行零差异 → passed=false（空操作闸，防 churn）', () => {
    const r = backtestIcpDraft({ draft: { icp: { ...CURRENT_ICP } }, current: CURRENT_ICP, samples: samplesPass() });
    expect(r.verdict).toBe('noop');
    expect(r.passed).toBe(false);
    expect(Object.keys(r.deltas).length).toBe(0);
  });

  it('count：样本不足 → passed=false（防过拟合噪声，对齐 R5/R6）', () => {
    const r = backtestIcpDraft({ draft: { icp: { industries: ['coatings'] } }, current: CURRENT_ICP, samples: samplesPass(5, 5) });
    expect(r.verdict).toBe('count');
    expect(r.passed).toBe(false);
    expect(r.sample_size).toBe(5);
    expect(r.min_sample).toBe(MIN_SAMPLE);   // 复用 MIN_SAMPLE=20，非自造数值
    expect(MIN_SAMPLE).toBe(20);
  });

  it('threshold：样本充足且命中率 ≥ passLine → passed=true', () => {
    const r = backtestIcpDraft({ draft: { icp: { industries: ['coatings'] } }, current: CURRENT_ICP, samples: samplesPass(25, 20) });
    expect(r.verdict).toBe('threshold');
    expect(r.passed).toBe(true);
    expect(r.hit_rate).toBeGreaterThanOrEqual(r.pass_line);
  });

  it('threshold 但命中率不足 → passed=false', () => {
    const r = backtestIcpDraft({ draft: { icp: { industries: ['coatings'] } }, current: CURRENT_ICP, samples: samplesPass(25, 5) });
    expect(r.verdict).toBe('threshold');
    expect(r.passed).toBe(false);
  });
});

describe('Task 11 ⑥ 禁 DELETE 源码断言', () => {
  it('两个新 src 文件均无物理删除', () => {
    const banned = /DELETE\s+FROM|\.delete\s*\(/i;
    for (const rel of ['src/evolution/icpSelfEvolution.js', 'src/evolution/icpStore.js']) {
      const src = fs.readFileSync(srcPath(rel), 'utf8');
      expect(banned.test(src), `${rel} 含物理删除`).toBe(false);
    }
    expect(DRAFT_STATUS).toContain('draft');
    expect(DRAFT_STATUS).toContain('approved');
    expect(ICP_DRAFT_KEY).toBe('icp_draft');
  });
});

describe('Task 11 ⑦ 真实 store 契约（createIcpStore 注入替身，零 PG）', () => {
  function makeIo(initial = { icp: { ...CURRENT_ICP }, providers: [] }) {
    const writes = []; const gates = []; let value = structuredClone(initial); let seq = 0;
    return {
      writes, gates,
      io: {
        read: async () => ({ value: structuredClone(value) }),
        write: async (key, v, opts) => { writes.push({ key, value: structuredClone(v), opts }); value = structuredClone(v); return { ok: true }; },
        gate: async (scenario_id, ctx, entities, opts) => { gates.push({ scenario_id, ctx, entities, opts }); seq += 1; return { decision: { decision_id: `DEC-T11-${seq}` } }; },
      },
    };
  }

  it('insertDraft：gate 首参= CALIBRATION_CHANGE、icp 未动、decisionId 取自 .decision', async () => {
    const { writes, gates, io } = makeIo();
    const store = createIcpStore(io);
    const r = await store.insertDraft({ icp: { industries: ['coatings'] }, report: { verdict: 'threshold' } }, { tenantId: 't1', actor: 'u1' });

    expect(gates.length).toBe(1);
    expect(gates[0].scenario_id).toBe(ICP_DECISION_SCENARIO);
    expect(ICP_DECISION_SCENARIO).toBe('CALIBRATION_CHANGE');
    expect(writes.length).toBe(1);

    // ⚠ 专防 .decision 取值路径写错 → decisionId 恒 null 的静默假绿
    expect(writes[0].opts.decisionId).toBe('DEC-T11-1');
    expect(r.decisionId).toBe('DEC-T11-1');
    expect(r.decisionId).not.toBeNull();

    // 生效键未动 + 草稿已落
    expect(writes[0].value.icp).toEqual(CURRENT_ICP);
    expect(writes[0].value[ICP_DRAFT_KEY].items.length).toBe(1);
    expect(writes[0].value[ICP_DRAFT_KEY].items[0].status).toBe('draft');
    expect(writes[0].value[ICP_DRAFT_KEY].items[0].validated).toBe(false);
    expect(writes[0].key).toBe('discovery-rules');
  });

  it('setValidated：唯一致效写（icp 变为草稿值）+ 草稿标 approved + 不删旧草稿', async () => {
    const { writes, io } = makeIo();
    const store = createIcpStore(io);
    const r1 = await store.insertDraft({ icp: { industries: ['coatings'] } }, { tenantId: 't1', actor: 'u1' });
    const r2 = await store.setValidated(r1.draftId, true, 'admin', { tenantId: 't1' });

    expect(writes.length).toBe(2);
    // 生效 = 浅合并（增量覆盖），与既有 mergeDiscoveryRules（discoveryRules.js:49 Object.assign(out.icp,…)）同语义
    expect(writes[1].value.icp).toEqual({ ...CURRENT_ICP, industries: ['coatings'] });   // ← 致效写
    const items = writes[1].value[ICP_DRAFT_KEY].items;
    expect(items.length).toBe(1);                                        // 不删（状态标记）
    expect(items[0].status).toBe('approved');
    expect(items[0].validated).toBe(true);
    expect(items[0].approved_by).toBe('admin');
    expect(r2.decisionId).toBe('DEC-T11-2');
    expect(writes[1].opts.decisionId).toBe('DEC-T11-2');
  });

  it('多草稿 append：第二条草稿不覆盖第一条（数组语义，禁 DELETE）', async () => {
    const { writes, io } = makeIo();
    const store = createIcpStore(io);
    await store.insertDraft({ icp: { industries: ['a'] } }, { tenantId: 't1', actor: 'u1' });
    await store.insertDraft({ icp: { industries: ['b'] } }, { tenantId: 't1', actor: 'u1' });
    const items = writes[1].value[ICP_DRAFT_KEY].items;
    expect(items.length).toBe(2);
    expect(items[0].icp).toEqual({ industries: ['a'] });
    expect(items[1].icp).toEqual({ industries: ['b'] });
  });

  it('setValidated：草稿不存在 → 抛错（fail-closed，不静默写）', async () => {
    const { writes, io } = makeIo();
    const store = createIcpStore(io);
    await expect(store.setValidated('no-such-draft', true, 'admin', { tenantId: 't1' })).rejects.toThrow(/草稿不存在/);
    expect(writes.length).toBe(0);
  });

  it('readActiveIcp：读取生效态（不是草稿）', async () => {
    const { io } = makeIo({ icp: { industries: ['x'] }, [ICP_DRAFT_KEY]: { items: [{ id: 'z', icp: { industries: ['y'] } }] } });
    const store = createIcpStore(io);
    expect(await store.readActiveIcp({ tenantId: 't1' })).toEqual({ industries: ['x'] });
  });
});
