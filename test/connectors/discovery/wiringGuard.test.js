// test/connectors/discovery/wiringGuard.test.js — LF-5 假绿反证（本计划核心价值所在）
//
// 判据来源：本仓铁律第 1 条 —— **生产零接线 = 最大假绿源**。
//   monitorAccount.test.js 用替身 ctx 全绿，完全不能证明生产装配存在。
//   本文件断言「**生产构造方存在**」：timers 真的 import 并装配 monitorCtx、discoveryOrchestrator
//   真的调 scoreLeadFit（而非占位 0.5）、leadFitScorer 真的消费 discovery-rules.signals。
//
// ⚠ 判据纪律：剥离注释行（// 与 * 开头）——否则注释里的字样会造成假红/假绿（本仓已登记变体）。
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SRC = path.resolve(__dirname, '../../../src');

const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
// 剥离注释行：避免注释里的字样（如 qixin.js 的「自动进 intent_score」承诺）造成假红/假绿
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

describe('LF-5 生产装配判据（只断言"生产构造方存在"，不停留在函数定义）', () => {
  it('① timers.js 真实 import monitorCtx 并把它装配进 runIntegrationPollOnce', () => {
    const code = stripComments(read('scheduler/timers.js'));
    expect(code).toMatch(/import\(['"][^'"]*discovery\/monitorCtx\.js['"]\)/);
    expect(code).toMatch(/buildMonitorCtx\s*:\s*monitorCtxMod\?\.\w+/);
  });

  it('② timers.js 真实构造 monitorCtx 并携带 decisionId（第 0 闸）', () => {
    const code = stripComments(read('scheduler/timers.js'));
    // 真实代码经别名 buildMonitorCtx（= monitorCtxMod?.createMonitorCtx）调用，携 tenantId + decisionId
    expect(code).toMatch(/buildMonitorCtx\(\{\s*tenantId:/);
    expect(code).toMatch(/decisionId\s*:\s*pollDecisionId/);
  });

  it('③ 占位 0.5 已从 discoveryOrchestrator 消失（负向判据）', () => {
    const code = stripComments(read('agent/discoveryOrchestrator.js'));
    expect(code.includes('0.5, 0.5')).toBe(false);
    expect(code).toMatch(/scoreLeadFit\(/);
  });

  it('④ qixin.js 的注释承诺此刻为真：discovery-rules.signals 有真实消费方', () => {
    const scorer = stripComments(read('connectors/discovery/leadFitScorer.js'));
    expect(scorer).toMatch(/rules\.signals/);   // 判据②此前为 0 命中，LF-1 后应 ≥1
  });

  it('⑤ 反证：rubricScorer 的 9 维**不得**出现在 lead-fit 评分路径', () => {
    const scorer = stripComments(read('connectors/discovery/leadFitScorer.js'));
    for (const k of ['clarity', 'accuracy', 'fairness']) expect(scorer.includes(k)).toBe(false);
  });
});
