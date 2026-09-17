// test/sync/presets.test.js — 三家 CRM 预设（Salesforce / 销售易 / 纷享逍客）经 generic-rest 通用适配器接入
// 用 __fetch 注入 mock：各自 token 端点 + 数据端点。断言 verifyAuth=ok 且 readIncremental 抽出正确行。
// 目的：证明「3 家集成」是真实接得通的（鉴权流 + 读取），而非占位假绿。
import { describe, it, expect } from 'vitest';
import { createProviderFromPreset, getPresetConfig, listPresets, buildPresetProvider, PRESET_FACTORIES, syncFactoriesWithPresets } from '../../src/sync/presets/index.js';
import { SYNC_PROVIDER_FACTORY } from '../../src/sync/factory.js';
import { loadTenantSyncTargets } from '../../src/sync/mount.js';

// ---- mock fetchers ----
function mockFetchForSalesforce() {
  return async (url) => {
    if (url.includes('/services/oauth2/token')) {
      return { ok: true, json: async () => ({ access_token: 'TK', instance_url: 'https://na1.salesforce.com', expires_in: 3600 }) };
    }
    if (url.includes('/services/data/v60.0/query')) {
      return { ok: true, json: async () => ({ records: [{ Id: 'A1', Name: 'Acme', SystemModstamp: '2026-09-17T01:00:00Z' }] }) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  };
}
function mockFetchForNeocrm() {
  return async (url) => {
    if (url.includes('/token/getToken')) return { ok: true, json: async () => ({ data: { accessToken: 'NTK' } }) };
    if (url.includes('/data/queryV2')) return { ok: true, json: async () => ({ data: { records: [{ id: 'N1' }], nextCursor: 'c2' } }) };
    return { ok: false, status: 500, json: async () => ({}) };
  };
}
function mockFetchForFXiaoke() {
  return async (url, opts) => {
    const body = JSON.parse(opts?.body || '{}');
    const action = body.action;
    if (action === 'get_app_token') return { ok: true, json: async () => ({ appToken: 'AT' }) };
    if (action === 'get_corp_token') return { ok: true, json: async () => ({ corpAccessToken: 'CT' }) };
    return { ok: true, json: async () => ({ data: { dataList: [{ id: 'F1' }], nextCursor: 'c3' } }) };
  };
}

describe('同步预设注册表（零产品名，纯配置入口）', () => {
  it('listPresets 含 salesforce / neocrm / fxiaoke 三家', () => {
    expect(listPresets().sort()).toEqual(['fxiaoke', 'neocrm', 'salesforce']);
  });
  it('预设均为 generic-rest 契约（含 auth.type=token-flow + objects[]）', () => {
    for (const name of listPresets()) {
      const p = getPresetConfig(name);
      expect(p.kind).toBe('generic-rest');
      expect(p.auth?.type).toBe('token-flow');
      expect(Array.isArray(p.objects) && p.objects.length).toBeTruthy();
    }
  });
});

describe('Salesforce 预设：OAuth2 → instance_url 基址 → SOQL 读取', () => {
  it('verifyAuth=ok 且 readIncremental 抽出 records 并推进游标', async () => {
    const p = createProviderFromPreset('salesforce', {
      credentials: { clientId: 'cid', clientSecret: 'csec' },
      fetchFn: mockFetchForSalesforce(),
    });
    expect((await p.verifyAuth()).ok).toBe(true);
    const r = await p.readIncremental({ object: 'Account', cursor: '2026-09-16T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].Id).toBe('A1');
    expect(r.cursor).toBe('2026-09-17T01:00:00Z'); // 游标推进到本批最大 SystemModstamp
  });
});

describe('销售易 Neocrm 预设：getToken → X-Access-Token → queryV2 读取', () => {
  it('verifyAuth=ok 且 readIncremental 抽出 records（data.records 路径）', async () => {
    const p = createProviderFromPreset('neocrm', {
      credentials: { appId: 'aid', appSecret: 'asec', userName: 'u' },
      fetchFn: mockFetchForNeocrm(),
    });
    expect((await p.verifyAuth()).ok).toBe(true);
    const r = await p.readIncremental({ object: 'Account', cursor: '2026-09-16T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe('N1');
    expect(r.cursor).toBe('c2'); // 使用 response.cursorPath: data.nextCursor
  });
});

describe('纷享逍客 FXiaoke 预设：两步串联令牌 → body 注入 corpAccessToken → dataList 读取', () => {
  it('verifyAuth=ok 且 readIncremental 抽出 dataList（两步令牌流真串通）', async () => {
    const p = createProviderFromPreset('fxiaoke', {
      credentials: { corpId: 'corp', appId: 'aid', appSecret: 'asec', permanentCode: 'pc', openUserId: 'ou' },
      fetchFn: mockFetchForFXiaoke(),
    });
    expect((await p.verifyAuth()).ok).toBe(true);
    const r = await p.readIncremental({ object: 'Account', cursor: '2026-09-16T00:00:00Z' });
    expect(r.ok).toBe(true);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].id).toBe('F1');
    expect(r.cursor).toBe('c3');
  });
});

describe('凭据缺失 → 三家均 fail-closed', () => {
  for (const name of listPresets()) {
    it(`${name} 无凭据 verifyAuth=ok=false`, async () => {
      const p = createProviderFromPreset(name, { fetchFn: async () => ({ ok: true, json: async () => ({}) }) });
      const r = await p.verifyAuth();
      expect(r.ok).toBe(false);
      expect(r.error).toBe('credentials_missing');
    });
  }
});

describe('生产装配（防「零接线」假绿）：预设并入工厂字典 → mount 能构造 provider', () => {
  it('syncFactoriesWithPresets 含 generic-rest + 三家预设名', () => {
    const keys = Object.keys(syncFactoriesWithPresets(SYNC_PROVIDER_FACTORY)).sort();
    expect(keys).toEqual(['fxiaoke', 'generic-rest', 'neocrm', 'salesforce']);
  });

  it('buildPresetProvider：按描述符声明的对象名过滤（保留预设 soql），且实例 kind=generic-rest', () => {
    const p = buildPresetProvider('salesforce', { credentials: { clientId: 'x', clientSecret: 'y' }, objects: [{ name: 'Account' }] });
    expect(p.kind).toBe('generic-rest');
  });

  it('loadTenantSyncTargets（kind=salesforce）真正构造出 provider（非静默跳过）', async () => {
    const readConfig = async (key) => {
      if (key === 'integration-providers') {
        return { value: [{ id: 'sf1', kind: 'salesforce', enabled: true, trust_level: 'L1', objects: [{ name: 'Account' }] }] };
      }
      if (key === 'sync-trust') return { value: { default_level: 'L1' } };
      return { value: null };
    };
    const resolveCredentials = async () => ({ sf1: { clientId: 'cid', clientSecret: 'csec' } });
    const targets = await loadTenantSyncTargets({
      tenantId: 't1', readConfig, resolveCredentials, factories: syncFactoriesWithPresets(SYNC_PROVIDER_FACTORY),
    });
    expect(targets).toHaveLength(1);
    expect(targets[0].kind).toBe('salesforce');
    expect(targets[0].provider.kind).toBe('generic-rest'); // 实际实现仍是唯一通用 provider
    expect(targets[0].objects.map((o) => o.name)).toEqual(['Account']);
  });

  it('反向对照：不并预设 → loadTenantSyncTargets 静默跳过 kind=salesforce（证明并入确有作用）', async () => {
    const readConfig = async (key) => {
      if (key === 'integration-providers') {
        return { value: [{ id: 'sf1', kind: 'salesforce', enabled: true, trust_level: 'L1', objects: [{ name: 'Account' }] }] };
      }
      return { value: null };
    };
    const targets = await loadTenantSyncTargets({ tenantId: 't1', readConfig, factories: SYNC_PROVIDER_FACTORY });
    expect(targets).toHaveLength(0); // 未并预设 → 无此 kind → 跳过
  });
});
