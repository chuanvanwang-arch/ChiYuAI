import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { emit } from '../../src/events/bus.js';
import { registerAutoSuggest, unregisterAutoSuggest } from '../../src/calibration/autoSuggest.js';

describe('T21 registerAutoSuggest（事件总线接线）', () => {
  let captured = null;
  let registered = null;

  beforeEach(() => {
    captured = null;
    registered = registerAutoSuggest({
      scenarios: ['SCN_REG'],
      emitSuggestions: (s) => { captured = s; },
    });
  });
  afterEach(() => unregisterAutoSuggest());

  it('注册成功', () => {
    expect(registered.ok).toBe(true);
  });

  it('非白名单 scenario 的 decision 事件 → 不触发（事件过滤）', async () => {
    emit('decision', 'decision-created', { scenario_id: 'OTHER_SCN' });
    // 同步总线 → 立即断言
    expect(captured).toBeNull();
  });

  it('白名单 scenario + 事件类型命中 → 触发 suggestForScenario（无 DB 数据 → 零处方不 emit）', async () => {
    emit('decision', 'decision-created', { scenario_id: 'SCN_REG' });
    // 同步触发，但 suggestForScenario 是异步 DB 读；稍候
    await new Promise((r) => setTimeout(r, 300));
    // 无样本 → 守卫 R6 → patches 空 → defaultEmit 不发射
    expect(captured).toBeNull();
  });

  it('无关事件类型（如 trace）→ 不触发', () => {
    emit('decision', 'trace-done', { scenario_id: 'SCN_REG' });
    expect(captured).toBeNull();
  });
});