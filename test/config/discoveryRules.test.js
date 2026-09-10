// test/config/discoveryRules.test.js
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DISCOVERY_RULES, mergeDiscoveryRules, mergedDiscoveryRules,
} from '../../src/config/discoveryRules.js';

describe('discovery-rules · 出厂默认（T1 ① ②）', () => {
  it('五键齐：icp / providers / signals / duplicate_criteria / playbooks', () => {
    for (const k of ['icp', 'providers', 'signals', 'duplicate_criteria', 'playbooks']) {
      expect(DEFAULT_DISCOVERY_RULES[k]).toBeDefined();
    }
    expect(Array.isArray(DEFAULT_DISCOVERY_RULES.providers)).toBe(true);
    expect(Array.isArray(DEFAULT_DISCOVERY_RULES.playbooks)).toBe(true);
  });
  it('付费源出厂 enabled:false；系统默认源 enabled:true（D1）', () => {
    const byId = Object.fromEntries(DEFAULT_DISCOVERY_RULES.providers.map((p) => [p.id, p]));
    for (const id of ['clearbit', 'linkedin']) expect(byId[id].enabled).toBe(false);
    for (const id of ['email-verify', 'web-research', 'tender', 'gaode']) expect(byId[id].enabled).toBe(true);
  });
  it('三档 scope 正确：system / system-candidate / paid', () => {
    const byId = Object.fromEntries(DEFAULT_DISCOVERY_RULES.providers.map((p) => [p.id, p]));
    expect(byId.gaode.scope).toBe('system');
    expect(byId.attio.scope).toBe('system-candidate');
    expect(byId.clearbit.scope).toBe('paid');
  });
  it('查重条件为配置驱动列组（对齐 Twenty duplicateCriteria）', () => {
    expect(DEFAULT_DISCOVERY_RULES.duplicate_criteria.CRM_ACCOUNT).toEqual(
      [['external_id'], ['domain'], ['linkedin_url'], ['name']]
    );
  });
});

describe('discovery-rules · 合并与租户隔离（T1 ③ ④）', () => {
  it('mergeDiscoveryRules 按 id 覆盖 provider.enabled，不增删条数，且不改出厂默认', () => {
    const merged = mergeDiscoveryRules(DEFAULT_DISCOVERY_RULES, {
      icp: { min_confidence: 0.9 },
      providers: [{ id: 'attio', enabled: true }],
    });
    expect(merged.icp.min_confidence).toBe(0.9);
    expect(merged.providers.length).toBe(DEFAULT_DISCOVERY_RULES.providers.length);
    expect(merged.providers.find((p) => p.id === 'attio').enabled).toBe(true);
    expect(DEFAULT_DISCOVERY_RULES.icp.min_confidence).toBe(0.6); // 纯函数：出厂默认未被污染
    expect(DEFAULT_DISCOVERY_RULES.providers.find((p) => p.id === 'attio').enabled).toBe(false);
  });
  it('mergedDiscoveryRules 租户感知：A 的定制不出现在 B（注入式 deps，无 PG）', async () => {
    const store = { A: { value: { icp: { min_confidence: 0.95 } } }, B: null };
    const deps = { readConfig: async (key, { tenantId }) => store[tenantId] || null };
    const a = await mergedDiscoveryRules({ tenantId: 'A' }, deps);
    const b = await mergedDiscoveryRules({ tenantId: 'B' }, deps);
    expect(a.icp.min_confidence).toBe(0.95);
    expect(b.icp.min_confidence).toBe(DEFAULT_DISCOVERY_RULES.icp.min_confidence);
  });
  it('未配置租户懒克隆出厂默认（readConfig → null 时回退）', async () => {
    const deps = { readConfig: async () => null };
    const r = await mergedDiscoveryRules({ tenantId: 'fresh' }, deps);
    expect(r.providers.length).toBe(DEFAULT_DISCOVERY_RULES.providers.length);
  });
  it('读配置异常 fail-open：回退出厂默认而非抛出', async () => {
    const deps = { readConfig: async () => { throw new Error('pg down'); } };
    const r = await mergedDiscoveryRules({ tenantId: 'x' }, deps);
    expect(r.signals.funding_round.weight).toBeGreaterThan(0);
  });
});
