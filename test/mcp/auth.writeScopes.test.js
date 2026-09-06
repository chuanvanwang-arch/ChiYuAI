// test/mcp/auth.writeScopes.test.js — F4-3 写 token scopes 标记
import { describe, it, expect } from 'vitest';
import { writeScopesForRole } from '../../src/mcp/auth.js';

describe('F4-3 writeScopesForRole', () => {
  it('sysadmin → 治理写标记（业务写由 executor 第1闸双闸拒）', () => {
    expect(writeScopesForRole('sysadmin')).toEqual({ write_scope: 'governance', deny_business_write: true });
  });
  it('业务角色 → 空 scopes（不加治理标记，行为不变）', () => {
    expect(writeScopesForRole('sales')).toEqual({});
    expect(writeScopesForRole('manager')).toEqual({});
    expect(writeScopesForRole('exec')).toEqual({});
  });
});
