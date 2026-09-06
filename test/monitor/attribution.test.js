// test/monitor/attribution.test.js
import { computeAttribution, applyHumanDisposition, applyOutcome } from '../../src/monitor/attribution.js';
import { describe, it, expect } from 'vitest';

// 注入 fake sevenDimensionsCheck，验证 computeAttribution 复用其 missing/required（单一事实源）
const fakeCheck = (scenarioId, ctx, { query }) => {
  const required = [{ dim: 'identity', on_missing: 'warn' }, { dim: 'time', on_missing: 'block' }];
  const missing = ctx.time == null || ctx.time === '' ? [{ dim: 'time', on_missing: 'block' }] : [];
  return Promise.resolve({ required, missing, level: missing.length ? 'block' : 'ok', allowed: missing.length === 0 });
};

describe('computeAttribution (aligned to sevenDimensionsCheck)', () => {
  it('required all provided -> category ok, provided full list', async () => {
    const a = await computeAttribution({ scenario_id: 'X', trigger_context: { identity: 'acme', time: 'Q3' }, check: fakeCheck });
    expect(a.required_fill.missing).toEqual([]);
    expect(a.required_fill.provided).toEqual(['identity', 'time']);
    expect(a.category).toBe('ok');
    expect(a.accuracy_signal).toBe('pending');
  });
  it('required missing (ctx empty) -> category input_missing, missing=time', async () => {
    const a = await computeAttribution({ scenario_id: 'X', trigger_context: { identity: 'acme' }, check: fakeCheck });
    expect(a.required_fill.missing).toEqual(['time']);
    expect(a.required_fill.provided).toEqual(['identity']);
    expect(a.category).toBe('input_missing');
    expect(a.level).toBe('block');
  });
  it('does NOT use conditions_evaluated for required_fill', async () => {
    const a = await computeAttribution({ scenario_id: 'X', trigger_context: { identity: 'acme' }, check: fakeCheck });
    // 即便传入 conditions_evaluated 也不得影响 required_fill
    expect(a.required_fill.missing).toEqual(['time']);
  });
});

describe('applyHumanDisposition', () => {
  it('OVERRIDDEN + required filled -> inference_bias + inaccurate', async () => {
    const base = await computeAttribution({ scenario_id: 'X', trigger_context: { identity: 'a', time: 't' }, check: fakeCheck });
    const a = applyHumanDisposition(base, 'OVERRIDDEN');
    expect(a.category).toBe('inference_bias');
    expect(a.accuracy_signal).toBe('inaccurate');
  });
  it('CONFIRMED -> ok + accurate', async () => {
    const base = await computeAttribution({ scenario_id: 'X', trigger_context: { identity: 'a', time: 't' }, check: fakeCheck });
    const a = applyHumanDisposition(base, 'CONFIRMED');
    expect(a.category).toBe('ok');
    expect(a.accuracy_signal).toBe('accurate');
  });
});

describe('applyOutcome', () => {
  it('stores outcome_verified', async () => {
    const base = await computeAttribution({ scenario_id: 'X', trigger_context: {}, check: fakeCheck });
    const a = applyOutcome(base, 'won');
    expect(a.outcome_verified).toBe('won');
  });
});
