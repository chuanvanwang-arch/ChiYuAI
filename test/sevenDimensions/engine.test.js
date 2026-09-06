// test/sevenDimensions/engine.test.js — Task 4: sevenDimensionsCheck 引擎（注入 fake query，无真实 PG）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §2.4 七维校验引擎（D3）
import { describe, it, expect } from 'vitest';
import { sevenDimensionsCheck } from '../../src/sevenDimensions/engine.js';

// fake query：返回测试定义的 required_dims；scenario 不存在 → rows 空
function fakeQuery(requiredDims) {
  return async () => ({ rows: [{ required_dims: requiredDims }] });
}

describe('sevenDimensionsCheck 引擎（D3 完整性校验）', () => {
  it('required 维缺失且 on_missing=block → level=block, allowed=false', async () => {
    const r = await sevenDimensionsCheck('scene-quote', { structure: null, semantics: 'ok' }, {
      query: fakeQuery([
        { dim: 'identity', on_missing: 'block' },
        { dim: 'structure', on_missing: 'block' },
        { dim: 'semantics', on_missing: 'warn' },
      ]),
    });
    expect(r.allowed).toBe(false);
    expect(r.level).toBe('block');
    expect(r.missing.map((m) => m.dim)).toEqual(['identity', 'structure']);
  });

  it('缺失仅 warn → level=warn, allowed=true（可写但打标）', async () => {
    const r = await sevenDimensionsCheck('scene-quote', { identity: 'id-1' }, {
      query: fakeQuery([
        { dim: 'identity', on_missing: 'warn' },
        { dim: 'structure', on_missing: 'warn' },
      ]),
    });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('warn');
    expect(r.missing.map((m) => m.dim)).toEqual(['structure']);
  });

  it('七维全齐 → level=ok, allowed=true, missing 空', async () => {
    const ctx = { identity: 'a', structure: 'b', semantics: 'c', time_config: 'd', decision_history: 'e', operational_state: 'f', governance: 'g' };
    const r = await sevenDimensionsCheck('scene-quote', ctx, { query: fakeQuery(DIM_REQ_ALL) });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('ok');
    expect(r.missing).toEqual([]);
  });

  it('scenario 不存在或列缺失（迁移前）→ 无 required 维，不阻断（ok）', async () => {
    const r = await sevenDimensionsCheck('unknown-scene', {}, { query: async () => ({ rows: [] }) });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('ok');
  });

  it('required_dims 存字符串形态（简配）→ 按 warn 处理', async () => {
    const r = await sevenDimensionsCheck('scene-quote', { governance: 'x' }, {
      query: fakeQuery(['identity', 'governance']),
    });
    expect(r.allowed).toBe(true);
    expect(r.level).toBe('warn');
    expect(r.missing.map((m) => m.dim)).toEqual(['identity']);
  });
});

// 全七维要求的测试夹具（含 on_missing）
const DIM_REQ_ALL = [
  { dim: 'identity', on_missing: 'block' },
  { dim: 'structure', on_missing: 'block' },
  { dim: 'semantics', on_missing: 'block' },
  { dim: 'time_config', on_missing: 'block' },
  { dim: 'decision_history', on_missing: 'block' },
  { dim: 'operational_state', on_missing: 'block' },
  { dim: 'governance', on_missing: 'block' },
];