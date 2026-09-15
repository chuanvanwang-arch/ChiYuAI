// test/sales/stageTaxonomy.test.js
import { test } from 'vitest';
import { S_STAGES, S_LABEL, S_ALIAS_FWD, S_TRANSITIONS, toStageCode, fromStageCode } from '../../src/sales/stageTaxonomy.js';
import assert from 'node:assert';

test('S_STAGES 含 S1-S8 且顺序正确', () => {
  assert.deepStrictEqual(S_STAGES, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
});
test('S_LABEL 提供中文名', () => {
  assert.strictEqual(S_LABEL.S1, '正式线索');
  assert.strictEqual(S_LABEL.S6, '赢单移交');
});
test('toStageCode 映射英文旧值', () => {
  assert.strictEqual(toStageCode('lead'), 'S1');
  assert.strictEqual(toStageCode('opportunity'), 'S2');
  assert.strictEqual(toStageCode('paid'), 'S6');
  assert.strictEqual(toStageCode('S3'), 'S3'); // 已是 S 码则原样
});
test('fromStageCode 反查英文', () => {
  assert.strictEqual(fromStageCode('S3'), 'quoted');
  assert.strictEqual(fromStageCode('S2'), 'opportunity');
});
test('S_TRANSITIONS 含 S2->S3 与退出边', () => {
  assert.ok(S_TRANSITIONS.some(t => t.from === 'S2' && t.to === 'S3'));
  assert.ok(S_TRANSITIONS.some(t => t.from === 'S3' && t.to === 'S7')); // 任意阶段可输单
});
