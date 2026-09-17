// test/connectors/discovery/credentialShapeConsumption.test.js
// A-B2 消费面（2026-09-17 重申）：结构化凭据必须**真的到达** provider，否则 A-B2 就是"就绪但零消费方"。
// 本测试只覆盖「通用接口」的消费语义——不含任何厂商专属适配器（红线：不得为具体产品做深度定制）。
//   • 通用 REST（enrich 侧）只吃**单串 token**——传入结构化对象时不得发出 `Bearer [object Object]`。
//   • 通用 REST（同步侧）缺 endpoint / 缺凭据 → verifyAuth 返回失败而非抛。
import { describe, it, expect } from 'vitest';
import { genericRestAdapter } from '../../../src/connectors/discovery/adapters/genericRest.js';

describe('A-B2 · 单串 token 消费方对结构化凭据 fail-closed（不发 [object Object]）', () => {
  const mk = (creds, sink) => genericRestAdapter({
    id: 'p1', endpoint: 'https://x/api', field_map: { name: 'company' }, credentials: creds,
    __fetch: async (url, opts) => { sink.push(opts); return { ok: true, json: async () => ({ company: 'ACME' }) }; },
  });

  it('字符串凭据 → 带 Bearer 头', async () => {
    const calls = [];
    const a = mk('sk-1', calls);
    const out = await a.enrich({ name: 'A' }, ['name'], {});
    expect(calls[0].headers.Authorization).toBe('Bearer sk-1');
    expect(out.name.value).toBe('ACME');
  });

  it('结构化对象凭据 → **不带** Authorization（而非 Bearer [object Object]）', async () => {
    const calls = [];
    const a = mk({ appId: 'a', appSecret: 's' }, calls);
    await a.enrich({ name: 'A' }, ['name'], {});
    expect(calls[0].headers.Authorization).toBeUndefined();
    expect(JSON.stringify(calls[0].headers)).not.toContain('[object Object]');
  });
});

// ─── Q2-4 契约验收判据：缺字段时 verifyAuth **返回失败而非抛出** ───
// 来源：docs/2026-09-16-full-chain-integration-design.md §4 Q2-4 success 第 3 条
describe('Q2-4 · 缺字段的凭据 → verifyAuth 返回失败而非抛出（通用接口）', () => {
  it('generic-rest 同步 provider 缺 endpoint → ok:false（零请求，不抛）', async () => {
    const { createGenericRestSyncProvider } = await import('../../../src/sync/factory.js');
    await expect(createGenericRestSyncProvider({}).verifyAuth()).resolves.toMatchObject({ ok: false, error: 'endpoint_missing' });
  });

  it('generic-rest 同步 provider 有 endpoint 但无凭据 → credentials_missing（零请求，不抛）', async () => {
    const { createGenericRestSyncProvider } = await import('../../../src/sync/factory.js');
    const p = createGenericRestSyncProvider({ endpoint: 'https://x/api' });
    await expect(p.verifyAuth()).resolves.toMatchObject({ ok: false, error: 'credentials_missing' });
  });
});
