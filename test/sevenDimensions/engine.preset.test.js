// test/sevenDimensions/engine.preset.test.js — 七维闸门启用后的行为（warn 不阻断 / block 阻断）
import { describe, it, expect } from 'vitest';
import { sevenDimensionsCheck } from '../../src/sevenDimensions/engine.js';

const PRESET_QUOTE = ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'];

function fakeQuery(requiredDims) {
  return async () => ({ rows: [{ required_dims: requiredDims }] });
}
const qAllWarn = fakeQuery(PRESET_QUOTE.map((d) => ({ dim: d, on_missing: 'warn' })));
const qOneBlock = fakeQuery([
  { dim: 'identity', on_missing: 'block' },
  { dim: 'structure', on_missing: 'warn' },
]);

describe('sevenDimensionsCheck 启用后行为', () => {
  it('全 warn + 空上下文 → allowed=true 但 level=warn（不阻断）', async () => {
    const r = await sevenDimensionsCheck('QUOTE_PRICING', {}, { query: qAllWarn });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('warn');
    expect(r.missing).toHaveLength(7);
  });

  it('全 warn + 上下文齐全 → level=ok', async () => {
    const ctx = {
      identity: 'acct-1', structure: ['DEAL'], semantics: 'won=签约',
      time_config: '2026Q3', decision_history: ['dec-1'], operational_state: '交付中', governance: 'manager',
    };
    const r = await sevenDimensionsCheck('QUOTE_PRICING', ctx, { query: qAllWarn });
    expect(r.level).toBe('ok');
    expect(r.missing).toHaveLength(0);
  });

  it('含 block 维且缺失 → allowed=false（拒写）', async () => {
    const r = await sevenDimensionsCheck('QUOTE_PRICING', {}, { query: qOneBlock });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe('block');
  });

  it('含 block 维但已提供 → 放行', async () => {
    const r = await sevenDimensionsCheck('QUOTE_PRICING', { identity: 'acct-1' }, { query: qOneBlock });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('warn'); // structure 仍缺（warn）
  });

  it('required_dims 为空 → 不阻断（改造前既有行为）', async () => {
    const r = await sevenDimensionsCheck('ANY', {}, { query: fakeQuery([]) });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('ok');
  });

  it('查询异常（列不存在/场景不存在）→ 降级不阻断', async () => {
    const r = await sevenDimensionsCheck('ANY', {}, { query: async () => { throw new Error('no column'); } });
    expect(r.allowed).toBe(true);
  });
});