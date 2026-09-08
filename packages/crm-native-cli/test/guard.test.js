import { describe, it, expect, vi } from 'vitest';
import { assertReadOnly, WRITE_TOOLS } from '../src/guard.js';
import { mcpCall, __setFetch } from '../src/mcpClient.js';

describe('写操作红线', () => {
  it('写类工具名被识别', () => {
    for (const t of ['crm-deal-advance', 'data-particle-create', 'crm-asset-attach', 'crm-approval-approve', 'payment-budget-prehold', 'split', 'crm_login']) {
      expect(WRITE_TOOLS.has(t), `应在黑名单: ${t}`).toBe(true);
    }
  });

  it('只读工具放行', () => {
    expect(() => assertReadOnly('crm-account-360')).not.toThrow();
    expect(() => assertReadOnly('crm-funnel-classify')).not.toThrow();
  });

  it('写类工具抛错且提示 HITL 与 decision_id', () => {
    expect(() => assertReadOnly('crm-deal-advance')).toThrow(/HITL/);
    expect(() => assertReadOnly('crm-deal-advance')).toThrow(/decision_id/);
  });

  it('拦截发生在发请求之前（fetch 零调用）', async () => {
    let n = 0;
    __setFetch(async () => { n += 1; return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => '{}' }; });
    await expect((async () => { assertReadOnly('crm-deal-advance'); await mcpCall({ endpointId: 'prod', tool: 'crm-deal-advance', params: {} }); })()).rejects.toThrow(/HITL/);
    expect(n).toBe(0);
  });
});
