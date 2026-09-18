// test/federation/scope.test.js — 读作用域解析（零侵入 + 1:N 联邦）
import { describe, it, expect } from 'vitest';
import { federationReadScope, canReadTenant } from '../../src/federation/scope.js';

const FED = {
  vendor_tenant: 'acme-mfg',
  dealers: [
    { dealer_tenant: 'acme-mfg-dl-01', status: 'active' },
    { dealer_tenant: 'acme-mfg-dl-02', status: 'active' },
    { dealer_tenant: 'acme-mfg-dl-03', status: 'suspended' },
  ],
};

const getFederation = async (t) => {
  if (t === 'acme-mfg') return FED;
  if (t === 'acme-mfg-dl-01') return FED; // 经销商反查命中同一联邦
  return null; // 直营租户无联邦
};
const featureOn = async () => true;

describe('federationReadScope · 零侵入保证', () => {
  it('无联邦配置 → 仅自身租户（与 scopeTenant 行为一致）', async () => {
    const scope = await federationReadScope('direct-tenant', { getFederation, isFeatureOn: featureOn });
    expect(scope).toEqual(['direct-tenant']);
  });

  it('平台级 kill-switch 关闭 → 全平台退化为单租户', async () => {
    const scope = await federationReadScope('acme-mfg', { getFederation, isFeatureOn: async () => false });
    expect(scope).toEqual(['acme-mfg']);
  });
});

describe('federationReadScope · 1:N 联邦', () => {
  it('厂商视角 → 可读自身 + 所有 active 经销商（suspended 排除）', async () => {
    const scope = await federationReadScope('acme-mfg', { getFederation, isFeatureOn: featureOn });
    expect(scope).toEqual(['acme-mfg', 'acme-mfg-dl-01', 'acme-mfg-dl-02']);
  });

  it('经销商视角 → 可读自身 + 厂商（push 视图）', async () => {
    const scope = await federationReadScope('acme-mfg-dl-01', { getFederation, isFeatureOn: featureOn });
    expect(scope).toEqual(['acme-mfg-dl-01', 'acme-mfg']);
  });

  it('不在任何联邦的租户 → 仅自身', async () => {
    const scope = await federationReadScope('other-tenant', { getFederation, isFeatureOn: featureOn });
    expect(scope).toEqual(['other-tenant']);
  });
});

describe('canReadTenant · 越权语义', () => {
  it('自身恒可读', async () => {
    expect(await canReadTenant('acme-mfg-dl-01', 'acme-mfg-dl-01', { getFederation, isFeatureOn: featureOn })).toBe(true);
  });
  it('厂商可读其经销商', async () => {
    expect(await canReadTenant('acme-mfg', 'acme-mfg-dl-02', { getFederation, isFeatureOn: featureOn })).toBe(true);
  });
  it('经销商之间不可互读（无授权）', async () => {
    expect(await canReadTenant('acme-mfg-dl-01', 'acme-mfg-dl-02', { getFederation, isFeatureOn: featureOn })).toBe(false);
  });
  it('直营租户不可读厂商联邦数据', async () => {
    expect(await canReadTenant('direct-tenant', 'acme-mfg', { getFederation, isFeatureOn: featureOn })).toBe(false);
  });
});
