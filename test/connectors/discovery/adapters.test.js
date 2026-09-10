// test/connectors/discovery/adapters.test.js — 单元（桩 HTTP / 注入研究通道，绝不触真实网络）
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { emailVerify } from '../../../src/connectors/discovery/adapters/emailVerify.js';
import { webResearch } from '../../../src/connectors/discovery/adapters/webResearch.js';
import { tenderAdapter } from '../../../src/connectors/discovery/adapters/tender.js';
import { gaodeAdapter } from '../../../src/connectors/discovery/adapters/gaode.js';
import { listProviderIds } from '../../../src/connectors/discovery/providerRegistry.js';

beforeEach(() => { delete process.env.GAODE_KEY; vi.restoreAllMocks(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('适配器统一契约（设计 v8.1 §3）', () => {
  it('4 适配器同契约：id / costTier / coverageFields / enrich', () => {
    const list = [
      emailVerify({ id: 'email-verify', costTier: 1, enabled: true }),
      webResearch({ id: 'web-research', costTier: 0, enabled: true }),
      tenderAdapter({ id: 'tender', costTier: 0, enabled: true }),
      gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true, credentialsRef: 'env:GAODE_KEY' }),
    ];
    for (const a of list) {
      expect(typeof a.enrich).toBe('function');
      expect(Number.isFinite(a.costTier)).toBe(true);
      expect(Array.isArray(a.coverageFields) && a.coverageFields.length).toBeTruthy();
    }
  });

  it('模块加载即自注册：4 个 id 均在 Provider Registry', () => {
    const ids = listProviderIds();
    for (const id of ['email-verify', 'web-research', 'tender', 'gaode']) expect(ids).toContain(id);
  });
});

describe('email-verify（本地语法判定，不联网）', () => {
  it('命中：合法邮箱 → 六元齐全，confidence < 0.9（不伪称「已验证」）', async () => {
    const a = emailVerify({ id: 'email-verify', costTier: 1, enabled: true });
    const r = await a.enrich({ email: 'a@b.com' }, ['email'], {});
    expect(r.email.provider).toBe('email-verify');
    expect(r.email.value).toBe('a@b.com');
    expect(r.email.ts).toBeTruthy();
    expect(r.email.confidence).toBeLessThan(0.9);
  });

  it('无邮箱 / 语法非法 / 一次性域名 → 返 {}（不是 null）', async () => {
    const a = emailVerify({ id: 'email-verify', costTier: 1, enabled: true });
    expect(await a.enrich({}, ['email'], {})).toEqual({});
    expect(await a.enrich({ email: 'not-an-email' }, ['email'], {})).toEqual({});
    expect(await a.enrich({ email: 'x@mailinator.com' }, ['email'], {})).toEqual({});
  });

  it('未请求 email 字段 → 不做事，返 {}', async () => {
    const a = emailVerify({ id: 'email-verify', costTier: 1, enabled: true });
    expect(await a.enrich({ email: 'a@b.com' }, ['phone'], {})).toEqual({});
  });
});

describe('web-research（Claygent 委托，无通道不伪造）', () => {
  it('委托 ctx.research 并归一化为六元', async () => {
    const research = vi.fn(async () => ({ tech_stack: { value: 'k8s', confidence: 0.8, cost: 0 } }));
    const a = webResearch({ id: 'web-research', costTier: 0, enabled: true });
    const r = await a.enrich({ name: 'X' }, ['tech_stack'], { research });
    expect(research).toHaveBeenCalledTimes(1);
    expect(r.tech_stack.provider).toBe('web-research');
    expect(r.tech_stack.value).toBe('k8s');
    expect(r.tech_stack.ts).toBeTruthy();
  });

  it('无研究通道 → fail-open 返 {}（绝不伪造字段）', async () => {
    const a = webResearch({ id: 'web-research', costTier: 0, enabled: true });
    expect(await a.enrich({ name: 'X' }, ['tech_stack'], {})).toEqual({});
  });

  it('研究通道抛错 → 返 {}，不向上抛', async () => {
    const a = webResearch({ id: 'web-research', costTier: 0, enabled: true });
    const research = vi.fn(async () => { throw new Error('llm down'); });
    expect(await a.enrich({ name: 'X' }, ['tech_stack'], { research })).toEqual({});
  });
});

describe('tender（复用既有 tenderConnector 管道）', () => {
  it('委托 filterTenders：标题关键词 + 区域真过滤，命中取首条', async () => {
    const a = tenderAdapter({ id: 'tender', costTier: 0, enabled: true });
    const ctx = {
      tenderSubscription: { keywords: ['涂料'], region: '北京' },
      tenders: [
        { id: 'T1', title: '某涂料厂招标', region: '北京市', amount: 100 },
        { id: 'T2', title: '无关钢材采购', region: '上海市' },
      ],
    };
    const r = await a.enrich({ name: 'X' }, ['tender_match'], ctx);
    expect(r.tender_match.provider).toBe('tender');
    expect(r.tender_match.value).toBe('某涂料厂招标');
    expect(r.tender_match.ts).toBeTruthy();
  });

  it('无命中 → {}', async () => {
    const a = tenderAdapter({ id: 'tender', costTier: 0, enabled: true });
    expect(await a.enrich({ name: 'X' }, ['tender_match'], { tenders: [] })).toEqual({});
  });

  it('tender_signals：返回命中聚合（tender_id / keyword / amount）', async () => {
    const a = tenderAdapter({ id: 'tender', costTier: 0, enabled: true });
    const ctx = { tenderSubscription: { keywords: [] }, tenders: [{ id: 'T9', title: '任意标讯', region: '北京', amount: 5 }] };
    const r = await a.enrich({ name: 'X' }, ['tender_signals'], ctx);
    expect(Array.isArray(r.tender_signals.value)).toBe(true);
    expect(r.tender_signals.value[0].tender_id).toBe('T9');
  });
});

describe('gaode（桩 HTTP，不触真实网络）', () => {
  it('地址 → geo_coord + registered_address（第二字段 cost=0，同次调用不重复计费）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ status: '1', geocodes: [{ location: '116.48,39.99', formatted_address: '北京市朝阳区' }] }),
    })));
    process.env.GAODE_KEY = 'test-key';
    const a = gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true, credentialsRef: 'env:GAODE_KEY' });
    const r = await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord', 'registered_address'], {});
    expect(r.geo_coord.provider).toBe('gaode');
    expect(r.geo_coord.value).toBe('116.48,39.99');
    expect(r.geo_coord.cost).toBe(1);
    expect(r.registered_address.cost).toBe(0);
  });

  it('无 key → 不发起任何网络请求，返 {}', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const a = gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true });
    expect(await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord'], {})).toEqual({});
    expect(spy).not.toHaveBeenCalled();
  });

  it('HTTP 抛错 / 状态非 1 → fail-open 返 {}，不抛', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down'); }));
    process.env.GAODE_KEY = 'test-key';
    const a = gaodeAdapter({ id: 'gaode', costTier: 1, enabled: true });
    expect(await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord'], {})).toEqual({});

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ status: '0', info: 'INVALID_USER_KEY' }) })));
    expect(await a.enrich({ registered_address: '北京市朝阳区' }, ['geo_coord'], {})).toEqual({});
  });
});
