// test/mcp-gateway-focus.test.js — gateway 注入 focus_domain（意图校正透传）
// 设计输入：docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md §6
import { describe, it, expect, beforeAll } from 'vitest';
import { mcpWritePhase1, mcpReadSensitivePhase1 } from '../src/mcp/gateway.js';
import { seedActions } from '../src/action/seed-actions.js';
import { issueToken } from '../src/mcp/issueToken.js';

describe('gateway focus_domain injection', () => {
  beforeAll(() => { seedActions(); });

  it('owner exec 调 crm-finance-receivables（敏感读）→ form.focus_domain=[invoice,payment], over_scope=false', async () => {
    const actor = `gw_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'exec', scopes: {} });
    const r = await mcpReadSensitivePhase1('crm-finance-receivables', { api_token: tokenPlain }, {});
    expect(r.code).toBe('CONFIRM_REQUIRED');
    expect(r.form.focus_domain.sort()).toEqual(['invoice', 'payment']);
  });

  it('owner exec 调 crm-finance-receivables 带 deny_domains 收窄 → form.focus_domain=[invoice]', async () => {
    const actor = `gw_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'exec', scopes: { deny_domains: ['payment'] } });
    const r = await mcpReadSensitivePhase1('crm-finance-receivables', { api_token: tokenPlain }, {});
    expect(r.form.focus_domain).toEqual(['invoice']);
  });

  it('owner exec 写 crm-deal-advance（无 data_scope_domains）→ form.focus_domain 为空数组，不阻断写', async () => {
    const actor = `gw_${Math.random().toString(36).slice(2, 10)}`;
    const { tokenPlain } = await issueToken({ actor, roleTag: 'exec', scopes: {} });
    const r = await mcpWritePhase1('crm-deal-advance', { api_token: tokenPlain, decision_id: 'DEC-FOCUS-001' }, {});
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.form.focus_domain)).toBe(true);
    expect(r.form.role).toBe('exec');
  });
});
