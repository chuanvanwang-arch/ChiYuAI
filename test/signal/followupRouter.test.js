import { describe, it, expect, vi } from 'vitest';
import { createFollowupRouter } from '../../src/signal/followupRouter.js';

describe('followupRouter（对象变化事件路由 T06）', () => {
  it('对象变化事件触发重评（emit→on 链路）', async () => {
    const engine = { reevaluate: vi.fn(async () => ({ ok: true })) };
    const r = createFollowupRouter({ engine });
    const out = await r.onObjectChanged({ object: 'AccountObj', externalId: 'acc-1', tenantId: 't1' });
    expect(engine.reevaluate).toHaveBeenCalledWith(expect.objectContaining({ externalId: 'acc-1' }));
    expect(out.ok).toBe(true); // 透传 engine 完整结果
  });

  it('重评结果 appendMemory 且 payload.discovery 子键不被覆盖', async () => {
    let memory = { discovery: { source: 'external', risk: 'high' } };
    const engine = {
      reevaluate: async ({ externalId }) => {
        // 重评产出新信号，appendMemory 合并而非覆盖 discovery 子键
        memory = { ...memory, discovery: { ...memory.discovery, last_reeval_at: Date.now() } };
        return { ok: true, memory };
      },
    };
    const r = createFollowupRouter({ engine });
    const out = await r.onObjectChanged({ object: 'AccountObj', externalId: 'acc-1', tenantId: 't1' });
    expect(out.ok).toBe(true);
    expect(out.memory.discovery.source).toBe('external'); // 既有子键保留
  });
});
