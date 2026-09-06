// test/action/memoryUpsert.test.js — Task 2：crm-memory-upsert action 注册 + handler 写回（mock appendMemory）
import { describe, test, expect, beforeAll, vi } from 'vitest';

// 拦截 memoryLog 的 appendMemory，避免在单测中真实落库；handler 用动态 import 解析同一模块路径
const appendMemory = vi.fn(async ({ topic, layer, entityId }) => ({ ok: true, row: { id: `mem-${topic}`, layer, entityId } }));
vi.mock('../../src/memory/memoryLog.js', () => ({
  appendMemory: (...args) => appendMemory(...args),
}));

const { seedActions } = await import('../../src/action/seed-actions.js');
const { getAction } = await import('../../src/action/registry.js');

beforeAll(() => seedActions());

describe('crm-memory-upsert · 注册与写回', () => {
  test('action 已注册且为 decision-agent 的写回通道', () => {
    const a = getAction('crm-memory-upsert');
    expect(a).toBeTruthy();
    expect(a.kind).toBe('write');
    expect(a.agentTool).toBe(true);
    expect(a.namespace).toBe('crm');
  });

  test('handler 调 appendMemory 并透传 topic/layer/entityId', async () => {
    appendMemory.mockClear();
    const a = getAction('crm-memory-upsert');
    const res = await a.handler(
      { topic: 'decision:enrich', kind: 'event', payload: { clue: 'x' }, layer: 'L3', entityId: 'acc-1' },
      { actor: 'decision-agent' }
    );
    expect(res.ok).toBe(true);
    expect(res.memoryId).toBe('mem-decision:enrich');
    expect(appendMemory).toHaveBeenCalledTimes(1);
    const call = appendMemory.mock.calls[0][0];
    expect(call.topic).toBe('decision:enrich');
    expect(call.layer).toBe('L3');
    expect(call.entityId).toBe('acc-1');
    expect(call.actor).toBe('decision-agent');
  });

  test('payload 显式 null 且 ctx 无 decision_id → 拒绝（不触 appendMemory）', async () => {
    appendMemory.mockClear();
    const a = getAction('crm-memory-upsert');
    expect((await a.handler({ payload: null }, {})).ok).toBe(false);
    expect(appendMemory).not.toHaveBeenCalled();
  });

  test('params 为空但 ctx 带 decision_id → 推导 topic 写回（write-through 落库）', async () => {
    appendMemory.mockClear();
    const a = getAction('crm-memory-upsert');
    const res = await a.handler({}, { actor: 'decision-agent', decision_id: 'dec-xyz', taskPayload: { intent: 'decision-execute' } });
    expect(res.ok).toBe(true);
    expect(res.topic).toBe('decision:dec-xyz');
    expect(appendMemory).toHaveBeenCalledTimes(1);
    const call = appendMemory.mock.calls[0][0];
    expect(call.payload.decision_id).toBe('dec-xyz');
  });
});
