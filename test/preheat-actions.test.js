// test/preheat-actions.test.js — P1-3 触达前预热工作流（payload.preheat 子状态机 + HITL）
// 设计输入：docs/2026-09-15-anysite-borrowing-analysis.md §4.3
// 铁律：HITL——无人工确认不产生任何对外动作；AI 仅排期与提醒；不改 stage 状态机
import { describe, it, expect, beforeAll } from 'vitest';
import { preheatTransition, PREHEAT_STATES, buildPreheatPlan } from '../src/action/preheatActions.js';
import { getAction } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';

beforeAll(() => {
  seedActions();
});

describe('preheat state machine (payload 子状态)', () => {
  it('① 合法流转 waiting→scheduled→engaged→ready', () => {
    let s = 'waiting';
    for (const e of ['schedule', 'engage', 'ready']) {
      s = preheatTransition(s, e, e === 'engage' ? { hitl_confirm: true } : {});
    }
    expect(s).toBe('ready');
  });
  it('② 非法转移抛错', () => {
    expect(() => preheatTransition('waiting', 'ready')).toThrow();
  });
  it('③ 无人工确认不可 engage（HITL）', () => {
    expect(() => preheatTransition('scheduled', 'engage')).toThrow(/hitl/);
  });
  it('④ 状态集合冻结含四态', () => {
    expect(PREHEAT_STATES).toEqual(['waiting', 'scheduled', 'engaged', 'ready']);
  });
  it('⑤ buildPreheatPlan 按信号新鲜度排序（fresh 优先 asap）', () => {
    const plan = buildPreheatPlan(
      [
        { name: '旧信号', signal_ts: null },
        { name: '新信号', signal_ts: Date.now() },
      ],
      {}
    );
    expect(plan[0].name).toBe('新信号');   // 有 ts → asap 排前
    expect(plan[0].due).toBe('asap');
    expect(plan[0].step).toBe(1);
  });
});

describe('preheat Actions 登记（seed-actions.js）', () => {
  it('⑥ preheat-schedule 只读已注册', () => {
    const a = getAction('preheat-schedule');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('read');
  });
  it('⑦ preheat-mark 写操作需 HITL（confirm）', () => {
    const a = getAction('preheat-mark');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('write');     // 写经第 0 闸
    expect(a.confirm).toBeTruthy();   // HITL 确认
  });
  it('⑧ preheat-status 只读查询已注册', () => {
    const a = getAction('preheat-status');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('read');
  });
});
