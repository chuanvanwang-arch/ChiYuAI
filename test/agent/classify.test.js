// test/agent/classify.test.js — classifyRequirement 纯函数分诊（src/agent/classify.js）
// 覆盖：跟进/报价/战略级三档意图 + 过短 + 全不命中 两类 needsClarification
import { describe, it, expect } from 'vitest';
import { classifyRequirement } from '../../src/agent/classify.js';

describe('classifyRequirement', () => {
  it('跟进类动作词 → followup / L1', () => {
    const r = classifyRequirement('跟进本周逾期的三个商机');
    expect(r.intent).toBe('followup');
    expect(r.level).toBe('L1');
    expect(r.needsClarification).toBe(false);
  });

  it('报价/测算类动作词 → quote / L2', () => {
    const r = classifyRequirement('给蒙电100台做报价测算');
    expect(r.intent).toBe('quote');
    expect(r.level).toBe('L2');
    expect(r.needsClarification).toBe(false);
  });

  it('含战略级量级词（无复盘动作词）→ major / L3', () => {
    const r = classifyRequirement('拉起战略客户年度规划');
    expect(r.intent).toBe('major');
    expect(r.level).toBe('L3');
    expect(r.needsClarification).toBe(false);
  });

  // D1 修复（2026-09-01）：复盘是明确动作意图，优先级高于量级词。
  // 旧行为把「拉起战略客户年度复盘」判为 major（该句本就是 classify 澄清示例承诺的能力，却无规则承接）。
  it('复盘动作词优先于量级词 → retro / L2', () => {
    const r = classifyRequirement('拉起战略客户年度复盘');
    expect(r.intent).toBe('retro');
    expect(r.level).toBe('L2');
    expect(r.needsClarification).toBe(false);
  });

  it('过短指令（<4 字）→ needsClarification + 引导 notes', () => {
    const r = classifyRequirement('报价');
    expect(r.intent).toBeNull();
    expect(r.level).toBeNull();
    expect(r.needsClarification).toBe(true);
    expect(Array.isArray(r.notes)).toBe(true);
    expect(r.notes.length).toBeGreaterThan(0);
  });

  it('全不命中 → needsClarification + 需识别任务类型的引导', () => {
    const r = classifyRequirement('今天天气不错');
    expect(r.needsClarification).toBe(true);
    expect(r.notes.join('')).toContain('未能识别');
  });
});
