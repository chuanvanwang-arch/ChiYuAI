// test/decision/confidence.test.js — T8 decision.confidence 反算（纯单测）
import { describe, it, expect } from 'vitest';
import { computeConfidence } from '../../src/decision/confidence.js';

describe('T8 computeConfidence（G5 反算）', () => {
  it('业务成功 → 高置信', () => {
    expect(computeConfidence({ outcomeVerified: 'won' })).toBe(0.9);
    expect(computeConfidence({ outcomeVerified: 'paid' })).toBe(0.9);
  });
  it('业务失败 → 低置信', () => {
    expect(computeConfidence({ outcomeVerified: 'lost' })).toBe(0.3);
    expect(computeConfidence({ outcomeVerified: 'partial' })).toBe(0.3);
  });
  it('停滞 → 中置信', () => {
    expect(computeConfidence({ outcomeVerified: 'stalled' })).toBe(0.5);
  });
  it('人工推翻 → 低置信', () => {
    expect(computeConfidence({ humanDisposition: 'OVERRIDDEN' })).toBe(0.2);
    expect(computeConfidence({ humanDisposition: 'CORRECTED' })).toBe(0.2);
  });
  it('人工确认 → 高置信', () => {
    expect(computeConfidence({ humanDisposition: 'CONFIRMED' })).toBe(0.85);
  });
  it('无信号 → 回退引擎置信度或中性 0.6', () => {
    expect(computeConfidence({})).toBe(0.6);
    expect(computeConfidence({ engineConfidence: 0.42 })).toBe(0.42);
  });
  it('业务结果优先于人工即时判', () => {
    expect(computeConfidence({ outcomeVerified: 'lost', humanDisposition: 'CONFIRMED' })).toBe(0.3);
  });
});
