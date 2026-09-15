// test/sales/stagePoolStage.test.js — S0 公海 / S0P 私海待校验 阶段模型
// ⚠ 纯常量测试：只 import stageTaxonomy.js（零 DB / 零 executor），避免 PG 耦合
import { test } from 'vitest';
import assert from 'node:assert';
import {
  S_STAGES, S_ALL_STAGES, S_PRE_DEAL_STAGES, S_POOL_STAGE, S_PICKED_STAGE,
  S_LABEL, S_TRANSITIONS, S_TERMINAL_STAGES, toStageCode, isPoolStage, isOpenStage,
  normalizeDealStage, STAGE_DEFAULT_SCENARIO,
} from '../../src/sales/stageTaxonomy.js';

test('S_STAGES 保持 S1-S8（漏斗口径零漂移）', () => {
  assert.deepStrictEqual(S_STAGES, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
});

test('S_ALL_STAGES 前插 S0/S0P，S_PRE_DEAL_STAGES=[S0,S0P]', () => {
  assert.deepStrictEqual(S_ALL_STAGES, ['S0', 'S0P', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
  assert.deepStrictEqual(S_PRE_DEAL_STAGES, ['S0', 'S0P']);
  assert.strictEqual(S_POOL_STAGE, 'S0');
  assert.strictEqual(S_PICKED_STAGE, 'S0P');
});

test('toStageCode 识别 S0/S0P，旧值 lead 仍映射 S1', () => {
  assert.strictEqual(toStageCode('S0'), 'S0');
  assert.strictEqual(toStageCode('S0P'), 'S0P');
  assert.strictEqual(toStageCode('lead'), 'S1');
});

test('isPoolStage 仅 S0 为真（S0P 属私海，须计入待办）', () => {
  assert.strictEqual(isPoolStage('S0'), true);
  assert.strictEqual(isPoolStage('S0P'), false);
  assert.strictEqual(isPoolStage('S1'), false);
  assert.strictEqual(isPoolStage('lead'), false);
});

test('normalizeDealStage：无主 S1 纠偏为 S0（迁移遗漏兜底）', () => {
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S1' } }), 'S0');
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S1', owner_id: 'u1' } }), 'S1');
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S0P', owner_id: 'u1' } }), 'S0P');
  assert.strictEqual(normalizeDealStage({ payload: { stage: 'S0' } }), 'S0');
});

test('推进边：S0P->S1 存在；S0->S1 / S0->S2 / S0->S0P 均不存在', () => {
  assert.ok(S_TRANSITIONS.some((t) => t.from === 'S0P' && t.to === 'S1'));
  assert.ok(!S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S1'));
  assert.ok(!S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S2'));
  assert.ok(!S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S0P'));  // 认领不经 advance，避免绕过 PickRule
  assert.ok(S_TRANSITIONS.some((t) => t.from === 'S0' && t.to === 'S8'));    // 公海可直接判无效
});

test('S_LABEL 含公海/私海线索/正式线索', () => {
  assert.strictEqual(S_LABEL.S0, '公海');
  assert.strictEqual(S_LABEL.S0P, '私海线索');
  assert.strictEqual(S_LABEL.S1, '正式线索');
});

test('isOpenStage("S0") 仍为 true —— fail-open 已知面，由调用方用 isPoolStage 排除', () => {
  // 锁行为而非锁意图：isPoolStage 是「排除公海」的正确判据（Task 9 接线）。
  // 此断言存在的价值：若未来有人把 S0 塞进 S_TERMINAL_STAGES 来「顺手修」，此处立刻变红。
  assert.strictEqual(isOpenStage('S0'), true);
  assert.strictEqual(S_TERMINAL_STAGES.includes('S0'), false);
});

test('S0/S0P 决策场景 = LEAD_FOLLOW_UP，S1 保持不动（偏离 B）', () => {
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S0, 'LEAD_FOLLOW_UP');
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S0P, 'LEAD_FOLLOW_UP');
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S1, 'LEAD_FOLLOW_UP');
  assert.strictEqual(STAGE_DEFAULT_SCENARIO.S4, 'QUOTE_PRICING'); // 既有键零漂移
});
