// test/sales/visitNote.test.js — P0-0 字段名兼容收口（T1）红灯用例
// 配套计划：docs/2026-08-30-sales-p0-p1-test-plan.md §1
// 背景：visit_notes 存在新旧两套字段名（新 objective/result/next，旧 t_objective/t_result/t_next）。
//       2026-08-30 两次回归均因「改字段名只改了部分消费方」而起，故本文件用断言锁死兼容契约。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { pickNote } from '../../src/sales/visitNote.js';
import { evaluateBehaviorChecklist } from '../../src/sales/behaviorChecklist.js';
import { deterministicEval } from '../../src/aiAttributes/evaluator.js';
import { accountRow } from '../../src/sales/namedAccountBoard.js';
import { DEFAULTS } from '../../src/sales/namedAccountTargets.js';

const NOW = new Date().toISOString();

// 同一条拜访记录的两种写法（新 / 旧），语义完全等价
const NOTE_NEW = {
  at: NOW,
  type: 'visit',
  customer_type: 'target',
  appointment: true,
  objective: '确认方案范围与预算',
  result: '客户认可 A3 方案，原话：就按这个报',
  achieved: '达到',
  next: '下周三报价',
  prepare: '已看客户年报',
  review: '已复盘',
  new_contact: true,
  collaboration: '售前同事张三',
};
const NOTE_OLD = {
  at: NOW,
  t_type: 'visit',
  t_customer_type: 'target',
  t_objective: '确认方案范围与预算',
  t_result: '客户认可 A3 方案，原话：就按这个报',
  t_achieved: '达到',
  t_next: '下周三报价',
  prepare: '已看客户年报',
  review: '已复盘',
  t_new_contact: true,
  t_collaboration: '售前同事张三',
};

describe('【T1】visitNote 字段名兼容收口', () => {
  it('T1-C1 pickNote 新写法优先于旧写法', () => {
    const n = { objective: 'A', t_objective: 'B' };
    expect(pickNote(n, 'objective')).toBe('A');
  });

  it('T1-C2 pickNote 回退到 t_ 前缀旧写法', () => {
    expect(pickNote({ t_objective: 'B' }, 'objective')).toBe('B');
  });

  it('T1-C3 pickNote 空值不误命中旧写法', () => {
    // objective 为空字符串时不得回退到 t_objective（否则旧数据会被错误复活）
    expect(pickNote({ objective: '', t_objective: 'B' }, 'objective')).toBe('');
  });

  it('T1-C4 pickNote 全缺或入参为空返回 undefined', () => {
    expect(pickNote({}, 'objective')).toBeUndefined();
    expect(pickNote(null, 'objective')).toBeUndefined();
    expect(pickNote(undefined, 'objective')).toBeUndefined();
  });

  it('T1-C5 sales_visit_value 新旧写法判定等价', () => {
    const a = deterministicEval('CRM_ACCOUNT', { visit_notes: [NOTE_NEW] }, { key: 'sales_visit_value' });
    const b = deterministicEval('CRM_ACCOUNT', { visit_notes: [NOTE_OLD] }, { key: 'sales_visit_value' });
    expect(a.value).toBe(true);
    expect(b.value).toBe(a.value);
  });

  it('T1-C6 21 条（evaluator degraded 版）新旧写法 items 全等', () => {
    const a = deterministicEval('CRM_ACCOUNT', { visit_notes: [NOTE_NEW] }, { key: 'sales_behavior_checklist' });
    const b = deterministicEval('CRM_ACCOUNT', { visit_notes: [NOTE_OLD] }, { key: 'sales_behavior_checklist' });
    expect(a.value.items).toEqual(b.value.items);
  });

  it('T1-C7 21 条（behaviorChecklist 完整版）新旧写法 items 全等', () => {
    const a = evaluateBehaviorChecklist({ visit_notes: [NOTE_NEW] }, [], []);
    const b = evaluateBehaviorChecklist({ visit_notes: [NOTE_OLD] }, [], []);
    expect(a.pass).toBe(b.pass);
    expect(a.items).toEqual(b.items);
  });

  it('T1-C8 拜访明细映射新旧写法等价', () => {
    const mk = (note) => ({ id: 'A-1', title: '甲', payload: { visit_notes: [note] } });
    const a = accountRow(mk(NOTE_NEW), [], [], DEFAULTS);
    const b = accountRow(mk(NOTE_OLD), [], [], DEFAULTS);
    expect(a.visits[0].objective).toBe('确认方案范围与预算');
    expect(a.visits[0]).toEqual(b.visits[0]);
  });

  it('T1-C9 三处消费方源码不再直读 t_* 字段', () => {
    // 源码扫描断言：防止后续新增消费方时再次漏改（前两次回归的根因）
    const files = [
      '../../src/aiAttributes/evaluator.js',
      '../../src/sales/behaviorChecklist.js',
      '../../src/sales/namedAccountBoard.js',
    ];
    const banned = /t_objective|t_result|t_next|t_achieved|t_type|t_new_contact|t_collaboration|t_appointment/;
    for (const rel of files) {
      const abs = fileURLToPath(new URL(rel, import.meta.url));
      const src = readFileSync(abs, 'utf8');
      // 允许出现在注释与说明文字中（解释兼容历史），但不得出现在「取值表达式」里
      const codeLines = src
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)) // 排除整行注释
        .join('\n');
      const hit = codeLines.match(banned);
      expect(hit, `${rel} 仍直读 ${hit?.[0]}`).toBeNull();
    }
  });
});
