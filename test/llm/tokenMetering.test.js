// test/llm/tokenMetering.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/alerts/tokenAccounting.js', () => ({
  recordTokens: vi.fn(async () => ({ ok: true })),
}));
const { recordTokens } = await import('../../src/alerts/tokenAccounting.js');
const { callChat } = await import('../../src/llm/client.js');

describe('callChat token 真实计量', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('解析 usage 并带 tenant_id+actor 回写 token_accounting', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    }));
    const cfg = { base: 'https://x/v1/chat/completions', apiKey: 'k', model: 'm' };
    const out = await callChat(cfg, [{ role: 'user', content: 'x' }], {
      metering: { tenantId: 't1', actor: 'alice', action: 'agent-think' },
    });
    expect(out).toBe('hi');
    expect(recordTokens).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 't1', actor: 'alice', action: 'agent-think',
      tokensIn: 10, tokensOut: 5, source: 'llm',
    }));
  });
});
