// test/integration/externalProviderFusion.test.js
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// 用注入凭据 + mock fetch 跑全链，避免依赖真实 JWT/外网。
// 注意：anysite 解析 res.items；qixin/xinbang 解析 res.data.list —— mock 同时返回两种形态以兼容三者。
const fakeData = {
  anysite: [{ name: 'AnysiteCo', domain: 'anysite.com', industry: 'chemical' }],
  qixin:   [{ name: 'QixinCo',   domain: 'qixin.com',   industry: 'chemical' }],
  xinbang: [{ name: 'XinbangCo', domain: 'xinbang.com', industry: 'media' }],
};
global.fetch = vi.fn(async (url) => {
  const prov = url.includes('qixin.com') ? 'qixin' : url.includes('newrank.cn') ? 'xinbang' : url.includes('anysite.io') ? 'anysite' : 'anysite';
  const list = fakeData[prov] || [];
  return { ok: true, json: async () => ({ items: list, data: { list } }) };
});

const { seedActions } = await import('../../src/action/seed-actions.js');
const { getAction } = await import('../../src/action/registry.js');
const { insertDraft, getDraft, softExpireDraft } = await import('../../src/connectors/discovery/draftRepo.js');
const { registerBuiltinAdapters } = await import('../../src/connectors/discovery/builtinAdapters.js');
const { queryWrite, pool } = await import('../../src/db.js');

const TID = 'test-e2e-fusion';

beforeAll(() => { seedActions(); registerBuiltinAdapters(); });
afterAll(async () => { await queryWrite(`DELETE FROM crm.discovery_draft WHERE tenant_id=$1`, [TID]).catch(() => {}); await pool.end(); });

describe('multi-provider fusion E2E', () => {
  for (const prov of ['anysite', 'qixin', 'xinbang']) {
    it(`${prov}: lookup → draft → confirm 全链`, async () => {
      const lookup = getAction('prospecting-lookup');
      const r1 = await lookup.handler({ provider: prov, kind: 'prospect', payload: { icp: { industries: ['chemical'] } } },
        { tenantId: TID },
        { resolveCredentials: async () => ({ [prov]: 'JWT' }), // 经 routeExternalLookup 注入
          // 显式授权通道（D1）：config_store override 启用付费源，验证经 mergedDiscoveryRules 合并生效
          readConfig: async (key) => (key === 'discovery-rules'
            ? { value: { providers: [{ id: 'qixin', enabled: true }, { id: 'anysite', enabled: true }, { id: 'xinbang', enabled: true }] } }
            : null),
          insertDraft: (d) => insertDraft(d) });
      expect(r1.draft_id).toBeTruthy();
      expect(r1.count).toBeGreaterThan(0);

      const confirm = getAction('prospecting-confirm');
      const created = [];
      const res = await confirm.handler({ draft_id: r1.draft_id }, { tenantId: TID, decision_id: `dec-${prov}`, actor: 'alice' },
        { createParticle: async (type, payload) => { created.push(payload); return { id: 'id' }; },
          createEdge: async () => ({}),
          getDraft: (id, o) => getDraft(id, o),
          softExpireDraft: (id) => softExpireDraft(id),
          findAccount: async () => null });
      expect(created.length).toBe(1);
      expect(created[0].stage).toBe('S0');
      expect(res.via).toBe('discovery_draft');
    });
  }

  it('无 credentials（provider 已授权启用）→ lookup fail-open 返回 count:0（不报错、不抛）', async () => {
    const lookup = getAction('prospecting-lookup');
    const r = await lookup.handler({ provider: 'anysite', kind: 'prospect', payload: {} }, { tenantId: TID },
      { resolveCredentials: async () => ({}), insertDraft: async () => ({ draft_id: 'x' }),
        readConfig: async (key) => (key === 'discovery-rules'
          ? { value: { providers: [{ id: 'anysite', enabled: true }] } }
          : null) });
    expect(r.count).toBe(0);
    expect(r.preview).toBe(true);
  });
});
