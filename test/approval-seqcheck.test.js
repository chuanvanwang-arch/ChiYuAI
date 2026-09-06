// test/approval-seqcheck.test.js — 顺序闸纯函数本地单测（无 PG 依赖）
// 审批引擎 SEQUENTIAL 实证：只允许最小 seq 的 TODO 任务被签，越序拒绝
import { describe, it, expect } from 'vitest';
import { seqCheck } from '../src/approval/engine.js';

function task(id, seq, approver) {
  return { id, payload: { seq, approver } };
}

describe('审批顺序闸 seqCheck（纯函数，SEQUENTIAL 实证）', () => {
  it('最小 seq 的任务可签（首签）', () => {
    const tasks = [task('t1', 1, 'role:manager'), task('t2', 2, 'role:director')];
    expect(seqCheck(tasks, 't1')).toBe(true);
  });

  it('越序任务被拒（第二人企图先签）', () => {
    const tasks = [task('t1', 1, 'role:manager'), task('t2', 2, 'role:director')];
    expect(() => seqCheck(tasks, 't2')).toThrow(/顺序闸|越序/);
  });

  it('前序签完后（TODO 只剩最大 seq）末位可签', () => {
    const tasks = [task('t2', 2, 'role:director')];  // t1 已签 → 仅剩 t2
    expect(seqCheck(tasks, 't2')).toBe(true);
  });

  it('seq 缺失兜底：无 seq 视为最大值（不可先签）', () => {
    const legacy = { id: 't0', payload: { approver: 'role:legacy' } };  // 无 seq（旧数据）
    const tasks = [legacy, task('t1', 1, 'role:manager')];
    expect(() => seqCheck(tasks, 't0')).toThrow(/顺序闸/);
    expect(seqCheck(tasks, 't1')).toBe(true);
  });

  it('任务不存在抛错（防误签已处理任务）', () => {
    const tasks = [task('t1', 1, 'role:manager')];
    expect(() => seqCheck(tasks, 't99')).toThrow(/不存在|已处理/);
  });
});