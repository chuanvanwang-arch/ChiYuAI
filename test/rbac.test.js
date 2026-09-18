// test/rbac.test.js — 经销商联邦 RBAC 闸 + 角色注册
import { describe, it, expect } from 'vitest';
import { canManageDealers, isFeatureOn } from '../src/rbac.js';
import { SEED_PROFILES } from '../src/context/roleProfiles.js';

function fakeStore(enabled = false) {
  const row = enabled ? { value: { enabled: true } } : null;
  return async (key, { tenantId } = {}) => (key === 'feature:dealer-portal' && tenantId === 'system' ? row : null);
}

describe('角色注册（roleProfiles）', () => {
  it('SEED_PROFILES 含 channel_manager / dealer_user 且 data_scope=tenant', () => {
    const tags = SEED_PROFILES.map((p) => p.role_tag);
    expect(tags).toContain('channel_manager');
    expect(tags).toContain('dealer_user');
    const cm = SEED_PROFILES.find((p) => p.role_tag === 'channel_manager');
    const du = SEED_PROFILES.find((p) => p.role_tag === 'dealer_user');
    expect(cm.data_scope.model).toBe('tenant');
    expect(du.data_scope.model).toBe('tenant');
  });
});

describe('canManageDealers 闸', () => {
  it('功能总闸关闭 → 一律 false', async () => {
    const rc = fakeStore(false);
    expect(await canManageDealers({ role: 'channel_manager', tenantId: 'acme-mfg' }, 'acme-mfg', { readConfig: rc })).toBe(false);
  });

  it('总闸开 + channel_manager 在本厂商租户 → true', async () => {
    const rc = fakeStore(true);
    expect(await canManageDealers({ role: 'channel_manager', tenantId: 'acme-mfg' }, 'acme-mfg', { readConfig: rc })).toBe(true);
  });

  it('普通 sales 角色 → false', async () => {
    const rc = fakeStore(true);
    expect(await canManageDealers({ role: 'sales', tenantId: 'acme-mfg' }, 'acme-mfg', { readConfig: rc })).toBe(false);
  });

  it('厂商角色跨租户管经销商 → false', async () => {
    const rc = fakeStore(true);
    expect(await canManageDealers({ role: 'ten_admin', tenantId: 'other-vendor' }, 'acme-mfg', { readConfig: rc })).toBe(false);
  });

  it('dealer_user 不可管经销商（仅厂商侧角色可）', async () => {
    const rc = fakeStore(true);
    expect(await canManageDealers({ role: 'dealer_user', tenantId: 'acme-mfg-dl-01' }, 'acme-mfg', { readConfig: rc })).toBe(false);
  });
});

describe('isFeatureOn', () => {
  it('默认 false；配置 enabled=true 后 true', async () => {
    expect(await isFeatureOn({ readConfig: fakeStore(false) })).toBe(false);
    expect(await isFeatureOn({ readConfig: fakeStore(true) })).toBe(true);
  });
});
