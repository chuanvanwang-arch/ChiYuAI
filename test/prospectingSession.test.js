// test/prospectingSession.test.js — 拓客会话状态机（T2）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §1.1/§1.3
// 5 态：searching → listing → selecting → pending_confirm → pooled
// 非法转移抛错；TTL 30 分钟；并发隔离（同租户同 actor 仅一活跃会话）；容量上限 100
import { describe, it, expect } from 'vitest';
import {
  createProspectingSession, getSession, updateSession, expireSession, transition, _getSessionsInMemory,
} from '../src/action/prospectingSession.js';

describe('prospecting-session 状态机（T2）', () => {
  it('① 合法转移链：searching→listing→selecting→pending_confirm→pooled', () => {
    expect(transition('searching', 'list_ready')).toBe('listing');
    expect(transition('listing', 'select')).toBe('selecting');
    expect(transition('selecting', 'confirm_ready')).toBe('pending_confirm');
    expect(transition('pending_confirm', 'confirm')).toBe('pooled');
  });
  it('② 非法转移抛错', () => {
    expect(() => transition('searching', 'confirm')).toThrow();
    expect(() => transition('pooled', 'select')).toThrow();
  });
  it('③ create/get 幂等重建', () => {
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    const s = getSession(sid);
    expect(s.state).toBe('searching');
    expect(s.tenantId).toBe('acme');
    expect(s.actor).toBe('alice');
  });
  it('④ updateSession 局部补丁且不越界', () => {
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    updateSession(sid, { candidates: [{ id: 'c1' }] });
    const s = getSession(sid);
    expect(s.candidates.length).toBe(1);
    expect(s.actor).toBe('alice');
  });
  it('⑤ 超时失效（30 分钟）', () => {
    // 注入未来时间戳 → 直接失效（纯函数友好：内部用 now 可覆盖）
    const sid = createProspectingSession({ tenantId: 'acme', actor: 'alice', _now: Date.now() - 31 * 60 * 1000 });
    expect(getSession(sid)).toBeNull();
  });
  it('⑥ 并发隔离：同 actor 只留一个活跃会话', () => {
    const s1 = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    const s2 = createProspectingSession({ tenantId: 'acme', actor: 'alice' });
    expect(getSession(s1)).toBeNull(); // 旧会话被覆盖
    expect(getSession(s2)).not.toBeNull();
  });
});
