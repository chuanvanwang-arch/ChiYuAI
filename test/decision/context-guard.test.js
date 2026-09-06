// test/decision/context-guard.test.js — T-D5 写时上下文守卫（配置化，TDD 红→绿）
// 背景：硬编码阻断版实测打挂 24 个既有用例 → 改为 config_store 驱动的 warn/block 模式（阈值配置化铁律）。
import { describe, it, expect } from 'vitest';
import { missingContextFields, readGuardMode, checkContextGuard, GUARD_CONFIG_KEY } from '../../src/decision/contextGuard.js';

describe('T-D5 上下文守卫（纯函数）', () => {
  it('missingContextFields：完整上下文无缺失', () => {
    expect(missingContextFields({ trigger_context: { a: 1 }, conditions_evaluated: [{ n: 'x' }] })).toEqual([]);
  });
  it('missingContextFields：trigger_context/conditions 全缺 → 报两项', () => {
    expect(missingContextFields({ trigger_context: {}, conditions_evaluated: [] }))
      .toEqual(['trigger_context', 'conditions_evaluated']);
  });
  it('missingContextFields：trigger_context 非对象（数组/null）视为缺失', () => {
    expect(missingContextFields({ trigger_context: null, conditions_evaluated: [{ n: 'x' }] }))
      .toEqual(['trigger_context']);
  });
});

describe('T-D5 守卫模式（配置化）', () => {
  it('block 模式：上下文缺失 → 拒写抛 missing_context', async () => {
    await expect(checkContextGuard(
      { scenario_id: 'X', trigger_context: {}, conditions_evaluated: [] },
      async () => 'block',
    )).rejects.toThrow(/missing_context/);
  });

  it('warn 模式（默认）：上下文缺失 → 不阻断，返回 warned', async () => {
    const r = await checkContextGuard(
      { scenario_id: 'X', trigger_context: {}, conditions_evaluated: [] },
      async () => 'warn',
    );
    expect(r.ok).toBe(true);
    expect(r.warned).toBe(true);
    expect(r.missing).toContain('trigger_context');
  });

  it('配置缺失/读取失败 → 保守回退 warn（不阻断主链路）', async () => {
    expect(await readGuardMode(async () => null)).toBe('warn');
    expect(await readGuardMode(async () => { throw new Error('db down'); })).toBe('warn');
  });

  it('配置值非法（非 warn/block）→ 回退默认 warn，防脏配置全线阻断', async () => {
    expect(await readGuardMode(async () => 'BLOCK!!!')).toBe('warn');
    expect(await readGuardMode(async () => ({ mode: 'block' }))).toBe('block');
  });

  it('配置键为 config_store.decision-context-guard（单一事实源）', async () => {
    expect(GUARD_CONFIG_KEY).toBe('decision-context-guard');
  });
});
