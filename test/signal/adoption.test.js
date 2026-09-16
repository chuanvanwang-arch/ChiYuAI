// test/signal/adoption.test.js — T18 建议卡采纳/否决（过第 0 闸）
import { describe, it, expect } from 'vitest';
import { createAdoption } from '../../src/signal/adoption.js';

function makeCtx() {
  const signals = {};
  const signalStore = {
    async setStatus(tid, sid, status, extra) {
      signals[sid] = { ...(signals[sid] || {}), status, extra, tid };
      return { ok: true, alert: { signal_id: sid, status } };
    },
    async find(sid) { return signals[sid] ? { signal_id: sid, ...signals[sid] } : null; },
  };
  const outcomes = [];
  const writeOutcome = async (decisionId, { outcome_type, source, payload }) => {
    outcomes.push({ decisionId, outcome_type, source, payload });
    return { outcome_id: 'o' + outcomes.length };
  };
  return { signalStore, writeOutcome, outcomes, signals };
}

describe('T18 采纳回路', () => {
  it('采纳无 decision_id → 第 0 闸拒', async () => {
    const { signalStore, writeOutcome } = makeCtx();
    const ad = createAdoption({ signalStore, writeOutcome });
    const r = await ad.adopt({ signal_id: 's1', tenant_id: 't1', actor: 'u1' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('decision_required');
  });
  it('采纳带 decision_id → signal 置 acted + outcome 落库', async () => {
    const { signalStore, writeOutcome, outcomes } = makeCtx();
    const ad = createAdoption({ signalStore, writeOutcome });
    const r = await ad.adopt({ signal_id: 's1', tenant_id: 't1', actor: 'u1', decision_id: 'd-abc', suggestedAction: 'sync-writeback-fields' });
    expect(r.ok).toBe(true);
    expect(outcomes.length).toBe(1);
    expect(outcomes[0].decisionId).toBe('d-abc');
    expect(outcomes[0].source).toBe('suggestion-adopt');
  });
  it('否决 → 回写 decision_outcome 且行数增加（可观测）', async () => {
    const { signalStore, writeOutcome, outcomes } = makeCtx();
    const ad = createAdoption({ signalStore, writeOutcome });
    const before = outcomes.length;
    const r = await ad.reject({ signal_id: 's2', tenant_id: 't1', actor: 'u1', decision_id: 'd-rej' });
    expect(r.ok).toBe(true);
    expect(outcomes.length).toBe(before + 1);
    expect(outcomes[outcomes.length - 1].source).toBe('suggestion-reject');
  });
});
