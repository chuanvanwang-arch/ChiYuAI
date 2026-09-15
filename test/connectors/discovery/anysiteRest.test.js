// test/connectors/discovery/anysiteRest.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock fetch 全局
const fetches = [];
global.fetch = vi.fn(async (url, opts) => {
  fetches.push({ url, opts });
  if (url.includes('/linkedin/email/user')) {
    return { ok: true, json: async () => ([{ name: 'Jane Doe', headline: 'CEO @ Acme', email: 'jane@acme.com' }]) };
  }
  if (url.includes('search/companies') || url.includes('company/search')) {
    return { ok: true, json: async () => ({ items: [{ name: 'Acme Co', industry: 'chemical', url: 'https://li.com/acme' }] }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
});

const { anysiteAdapter } = await import('../../../src/connectors/discovery/adapters/anysite.js');

beforeEach(() => { fetches.length = 0; });

describe('anysite REST adapter', () => {
  it('enrich by email → access-token header + 字段映射', async () => {
    const a = anysiteAdapter();
    const out = await a.enrich({ email: 'jane@acme.com' }, ['industry', 'registered_address'], { credentials: { anysite: 'JWT-XYZ' } });
    expect(fetches[0].url).toContain('/api/linkedin/email/user');
    expect(fetches[0].opts.headers['access-token']).toBe('JWT-XYZ');
    expect(out.industry).toBeDefined();
  });

  it('search by icp → 尝试候选路径，命中即映射 candidate', async () => {
    const a = anysiteAdapter();
    const list = await a.search({ industries: ['chemical'], limit: 5 }, { credentials: { anysite: 'JWT-XYZ' } });
    expect(list.length).toBeGreaterThan(0);
    expect(list[0].provider).toBe('anysite');
  });

  it('无凭据 → fail-open 返回空，不抛', async () => {
    const a = anysiteAdapter();
    expect(await a.search({ industries: ['x'] }, {})).toEqual([]);
    expect(await a.enrich({ name: 'X' }, ['industry'], {})).toEqual({});
  });

  it('health() 探活用已验证端点，返回 {ok,valid}', async () => {
    const a = anysiteAdapter();
    const h = await a.health({ credentials: { anysite: 'JWT-XYZ' } });
    expect(h).toHaveProperty('ok');
    expect(h).toHaveProperty('valid');
  });

  it('__mock 透传（单测兼容旧用例）', async () => {
    const a = anysiteAdapter({ __mock: { companies: [{ name: 'MockCo', domain: 'mock.com' }] } });
    const list = await a.search({ industries: ['x'] }, {});
    expect(list[0].name).toBe('MockCo');
  });
});
