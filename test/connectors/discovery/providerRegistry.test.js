// test/connectors/discovery/providerRegistry.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerProvider, resolveAdapters, loadAdapters, _resetRegistry, listProviderIds,
} from '../../../src/connectors/discovery/providerRegistry.js';

const mkFactory = (id) => (cfg) => ({ id, costTier: cfg.costTier, cfg, async enrich() { return {}; } });
const RULES = {
  providers: [
    { id: 'cheap', costTier: 1, enabled: true },
    { id: 'mid', costTier: 2, enabled: true },
    { id: 'paid', costTier: 3, enabled: false },
    { id: 'unregistered', costTier: 1, enabled: true },
  ],
};

describe('providerRegistry', () => {
  beforeEach(() => _resetRegistry());

  it('只实例化 enabled 且已注册的适配器，按 costTier 升序', () => {
    registerProvider('cheap', mkFactory('cheap'));
    registerProvider('mid', mkFactory('mid'));
    registerProvider('paid', mkFactory('paid'));
    const out = resolveAdapters(RULES);
    expect(out.map((a) => a.id)).toEqual(['cheap', 'mid']); // paid disabled + unregistered 跳过
    expect(listProviderIds()).toContain('paid');
  });

  it('allowIds 可选过滤（C1 编排按 playbook 收窄数据源）', () => {
    registerProvider('cheap', mkFactory('cheap'));
    registerProvider('mid', mkFactory('mid'));
    expect(resolveAdapters(RULES, { allowIds: ['mid'] }).map((a) => a.id)).toEqual(['mid']);
  });

  it('适配器工厂收到该租户的 provider 配置', () => {
    registerProvider('cheap', mkFactory('cheap'));
    const [a] = resolveAdapters(RULES);
    expect(a.cfg.id).toBe('cheap');
    expect(a.cfg.costTier).toBe(1);
  });

  it('loadAdapters 走租户感知 mergedDiscoveryRules（A 租户启用不影响 B 租户）', async () => {
    registerProvider('attio', mkFactory('attio'));
    registerProvider('email-verify', mkFactory('email-verify'));
    const readConfig = async (key, { tenantId }) => ({
      value: tenantId === 'A' ? { providers: [{ id: 'attio', enabled: true }] } : {},
    });
    const A = await loadAdapters({ tenantId: 'A' }, { readConfig });
    const B = await loadAdapters({ tenantId: 'B' }, { readConfig });
    expect(A.map((a) => a.id)).toContain('attio');
    expect(B.map((a) => a.id)).not.toContain('attio');
  });

  it('rules 缺 providers 时不抛，返空数组', () => {
    expect(resolveAdapters({})).toEqual([]);
    expect(resolveAdapters(undefined)).toEqual([]);
  });
});
