// test/connectors/discovery/lookupRouter.test.js
import { describe, it, expect } from 'vitest';
import { routeExternalLookup } from '../../../src/connectors/discovery/lookupRouter.js';

const fakeAdapter = (over) => ({
  id: 'anysite',
  search: async (q, ctx) => (over?.search ? over.search(q, ctx) : [{ name: 'Acme', provider: 'anysite' }]),
  enrich: async (e, f, ctx) => (over?.enrich ? over.enrich(e, f, ctx) : { industry: { value: 'chem', confidence: 0.8, provider: 'anysite' } }),
});

describe('routeExternalLookup', () => {
  it('未知/未启用 provider → 返回 error 且零写', async () => {
    const r = await routeExternalLookup({ provider: 'nope', kind: 'prospect', tenantId: 't1', deps: {
      loadAdapters: async () => [], resolveCredentials: async () => ({}),
    } });
    expect(r.items).toEqual([]);
    expect(r.error).toBe('provider_not_enabled_or_unknown');
  });

  it('prospect kind → 调 adapter.search 透传 credentials', async () => {
    let seenCtx = null;
    const r = await routeExternalLookup({ provider: 'anysite', kind: 'prospect',
      payload: { icp: { industries: ['chem'] } }, tenantId: 't1', deps: {
        loadAdapters: async () => [fakeAdapter({ search: async (q, ctx) => { seenCtx = ctx; return [{ name: 'Acme' }]; } })],
        resolveCredentials: async () => ({ anysite: 'JWT123' }),
      } });
    expect(r.items).toEqual([{ name: 'Acme' }]);
    expect(seenCtx.credentials.anysite).toBe('JWT123');
  });

  it('enrich kind → 调 adapter.enrich 并扁平化 fieldHit', async () => {
    const r = await routeExternalLookup({ provider: 'anysite', kind: 'enrich',
      payload: { entity: { name: 'Acme' }, fields: ['industry'] }, tenantId: 't1', deps: {
        loadAdapters: async () => [fakeAdapter()], resolveCredentials: async () => ({}),
      } });
    expect(r.items[0]).toMatchObject({ field: 'industry', value: 'chem' });
  });

  it('adapter 抛错 fail-open → 返回空 items', async () => {
    const r = await routeExternalLookup({ provider: 'anysite', kind: 'prospect', tenantId: 't1', deps: {
      loadAdapters: async () => [fakeAdapter({ search: async () => { throw new Error('boom'); } })],
      resolveCredentials: async () => ({}),
    } });
    expect(r.items).toEqual([]);
  });
});
