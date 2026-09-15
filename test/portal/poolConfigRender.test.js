// test/portal/poolConfigRender.test.js — 池配置页字段与引擎契约对齐（T5）
// 背景：原 POOL_KEYS = ['pickRule','recycleAfterDays'] 与引擎实际消费键
//   （src/sales/pool.js checkPickRule/checkRecycleRule：daily_limit/pick_interval_hours/
//    prev_owner_only/new_data_only + recycle_days）完全不对齐 → 页面能改的键引擎不认，改了个寂寞。
// 本用例锁死：①键集对齐 ②校验边界 ③三池 TAB 渲染 ④平台模板徽标。
import { test } from 'vitest';
import assert from 'node:assert';
import { POOL_KEYS, validatePoolPatch, renderPoolTabs } from '../../src/portal/poolConfigRender.js';

test('POOL_KEYS 覆盖引擎真实消费的四个领取键 + 回收天数', () => {
  for (const k of ['daily_limit', 'pick_interval_hours', 'prev_owner_only', 'new_data_only', 'recycle_days']) {
    assert.ok(POOL_KEYS.includes(k), `缺 ${k}`);
  }
});

test('validatePoolPatch 拒绝越界 daily_limit', () => {
  const r = validatePoolPatch({ daily_limit: 0 });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join().includes('daily_limit'));
});

test('validatePoolPatch 拒绝非布尔 prev_owner_only', () => {
  const r = validatePoolPatch({ prev_owner_only: 'yes' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join().includes('prev_owner_only'));
});

test('validatePoolPatch 拒绝未知字段（防前端写引擎不认的键）', () => {
  const r = validatePoolPatch({ pickRule: 'oldest' });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.join().includes('不可编辑字段'));
});

test('renderPoolTabs 输出 new/nurture/lost 三个 TAB', () => {
  const html = renderPoolTabs({ pools: [
    { id: 'pool-new', type: 'new', label: '新线索公海', pick_rule: {}, recycle_rule: {} },
    { id: 'pool-nurture', type: 'nurture', label: '培育公海', pick_rule: {}, recycle_rule: {} },
    { id: 'pool-lost', type: 'lost', label: '战败回收公海', pick_rule: {}, recycle_rule: {} },
  ] });
  assert.ok(html.includes('data-pool="pool-new"'));
  assert.ok(html.includes('data-pool="pool-nurture"'));
  assert.ok(html.includes('data-pool="pool-lost"'));
});

test('renderPoolTabs 首池可见其余隐藏（TAB 切换依赖 hidden）', () => {
  const html = renderPoolTabs({ pools: [
    { id: 'pool-new', type: 'new', pick_rule: {}, recycle_rule: {} },
    { id: 'pool-nurture', type: 'nurture', pick_rule: {}, recycle_rule: {} },
  ] });
  const first = html.match(/data-pool="pool-new"[^>]*>/)[0];
  assert.ok(!first.includes('hidden'), '首池应可见');
  const second = html.match(/data-pool="pool-nurture"[^>]*>/)[0];
  assert.ok(second.includes('hidden'), '非首池应 hidden');
});

test('renderPoolTabs 输入框 name 与引擎键一致（写回不被静默丢弃）', () => {
  const html = renderPoolTabs({ pools: [{ id: 'pool-new', type: 'new', pick_rule: {}, recycle_rule: {} }] });
  for (const k of POOL_KEYS) {
    assert.ok(html.includes(`name="${k}"`), `输入框缺 name="${k}"`);
  }
});

test('_seeded 时渲染平台模板徽标', () => {
  const html = renderPoolTabs({ pools: [], _seeded: 'system-template' });
  assert.ok(html.includes('继承自平台模板'));
});
