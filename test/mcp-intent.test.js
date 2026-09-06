// test/mcp-intent.test.js — 意图校正引擎（T5/T7）：角色基线内按数据域聚焦（只聚焦、不升权）
// 设计输入：docs/superpowers/specs/2026-08-26-mcp-role-binding-design.md §5
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveEffectiveRole, DOMAIN_ALIAS } from '../src/mcp/intent.js';
import { seedActions } from '../src/action/seed-actions.js';
import { resetRegistry, listActions } from '../src/action/registry.js';

// 测试前置：seed Action 注册表（含 data_scope_domains）
beforeEach(() => { resetRegistry(); seedActions(); });

describe('resolveEffectiveRole', () => {
  it('exec(all) + crm-finance-receivables → focus=[invoice,payment], over_scope=false', async () => {
    const r = await resolveEffectiveRole('exec', 'crm-finance-receivables', {});
    expect(r.effective_role).toBe('exec');
    expect(r.focus_domain.sort()).toEqual(['invoice', 'payment']);
    expect(r.over_scope).toBe(false);
  });

  it('finance(domain[payment,contract,invoice]) + crm-customer-360[CRM_CUSTOMER,CRM_DEAL,CRM_CONTRACT] → 交集={contract}, over_scope=true', async () => {
    const r = await resolveEffectiveRole('finance', 'crm-customer-360', {});
    expect(r.focus_domain).toEqual(['contract']);
    expect(r.over_scope).toBe(true);
  });

  it('Action 无 data_scope_domains → 不收窄（focus=[]，over_scope=false）', async () => {
    const r = await resolveEffectiveRole('exec', 'crm-deal-advance', {});
    expect(r.over_scope).toBe(false);
    expect(Array.isArray(r.focus_domain)).toBe(true);
  });

  it('scopes.deny_domains 收窄生效', async () => {
    const r = await resolveEffectiveRole('exec', 'crm-finance-receivables', { deny_domains: ['payment'] });
    expect(r.focus_domain).toEqual(['invoice']);
  });
});

describe('domain alias coverage', () => {
  it('seed-actions 中所有 data_scope_domains 均能被 DOMAIN_ALIAS 归一（无 undefined 映射）', () => {
    const seen = new Set();
    for (const a of listActions()) {
      for (const d of (a.data_scope_domains || [])) {
        expect(DOMAIN_ALIAS[d], `Action ${a.name} 的域 ${d} 未被 DOMAIN_ALIAS 覆盖`).toBeDefined();
        seen.add(d);
      }
    }
    // 至少应覆盖已知的 5 个敏感/业务域，避免空扫描掩盖缺口
    expect([...seen].sort()).toEqual(['CRM_CONTRACT', 'CRM_CUSTOMER', 'CRM_DEAL', 'CRM_INVOICE', 'CRM_PAYMENT_RECORD'].sort());
  });
});