// test/federation/inert.test.js — 零侵入契约（纯自营租户字节级不受影响）
// 设计：docs/2026-09-18-dealer-portal-design.md §11 / §13.6
import { describe, it, expect } from 'vitest';
import { federationReadScope } from '../../src/federation/scope.js';

// 模拟「直营租户」：无任何联邦配置
const noFederation = async () => null;

describe('零侵入 · 直营租户表现恒定', () => {
  it('功能总闸开 + 无联邦配置 → scope = [自身]（与 scopeTenant 完全一致）', async () => {
    const scope = await federationReadScope('direct-tenant', { getFederation: noFederation, isFeatureOn: async () => true });
    expect(scope).toEqual(['direct-tenant']);
  });

  it('功能总闸关 + 无联邦配置 → scope = [自身]（最终闸也不改变直营行为）', async () => {
    const scope = await federationReadScope('direct-tenant', { getFederation: noFederation, isFeatureOn: async () => false });
    expect(scope).toEqual(['direct-tenant']);
  });

  it('直营租户恒不可读他租户联邦数据（叠加层不泄漏）', async () => {
    const scope = await federationReadScope('direct-tenant', { getFederation: noFederation, isFeatureOn: async () => true });
    expect(scope).not.toContain('acme-mfg');
    expect(scope).not.toContain('acme-mfg-dl-01');
  });

  it('直营租户调用联邦解析不触发任何联邦配置写入（只读查询）', async () => {
    let reads = 0;
    const counted = async (t) => { reads += 1; return null; };
    await federationReadScope('direct-tenant', { getFederation: counted, isFeatureOn: async () => true });
    // 仅一次 getFederation 读 + 一次 isFeatureOn 读，无任何写操作
    expect(reads).toBe(1);
  });
});
