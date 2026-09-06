// test/llm/client.test.js — src/llm/client.js 消费方契约（mock readConfig + fetch，不触真实网络）
// 覆盖：未配置→null / 已配置→think 函数 / fetch 失败→降级 / getLlmJson 解析 / 缓存 TTL / 多配置 name·strategy
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 表源（llm_config）在本文件内一律置空 → 所有用例确定性走注入的 readConfig 回退源，避免依赖 DB 实况
vi.mock('../../src/llm/llmConfigStore.js', () => ({
  getDefault: vi.fn(async () => null),
  getByName: vi.fn(async () => null),
  getAllActive: vi.fn(async () => []),
  hydrate: (c) => c,
}));

import { getLlmThink, getLlmJson, resetLlmCache } from '../../src/llm/client.js';
import { encryptSecret } from '../../src/llm/secret.js';

beforeEach(() => {
  resetLlmCache(); // 清 TTL 缓存（每例独立）
  vi.restoreAllMocks();
});

// 便捷夹具：合法的 LLM 配置（api_key 走真实 encryptSecret 加密，验证解密链路）
function cfg({ base_url, api_key = 'sk-test-123' } = {}) {
  return {
    provider: 'siliconflow',
    model: 'deepseek-v4',
    temp: 0.3,
    base_url,
    api_key: encryptSecret(api_key),
  };
}
function readConfigOf(value) {
  return async () => value;
}

describe('getLlmThink', () => {
  it('未配置 → null（agentLoop 回退 defaultThink）', async () => {
    const think = await getLlmThink({ readConfig: readConfigOf(null) });
    expect(think).toBeNull();
  });

  it('配置缺 model → null（视为不可用）', async () => {
    const think = await getLlmThink({ readConfig: readConfigOf({ provider: 'siliconflow' }) });
    expect(think).toBeNull();
  });

  it('已配置 → 返回 think 函数；调用命中真实 fetch', async () => {
    const called = vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"action":"crm-opp-create","params":{"name":"x"},"reasoning":"r"}' } }] }),
    }));
    vi.stubGlobal('fetch', called);
    const think = await getLlmThink({ readConfig: readConfigOf(cfg()) });
    expect(think).toBeTypeOf('function');

    const r = await think({ payload: { query: '跟进线索 A' } }, { step: { id: 's1' }, prior: [] });
    expect(called).toHaveBeenCalledTimes(1);
    expect(r.action).toBe('crm-opp-create');
    expect(r.params).toEqual({ name: 'x' });
    expect(r.degraded).toBe(false);
  });

  it('fetch 失败 → 降级（degraded=true, action=null, 不抛）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('net down'); }));
    const think = await getLlmThink({ readConfig: readConfigOf(cfg()) });
    const r = await think({ payload: {} });
    expect(r.degraded).toBe(true);
    expect(r.action).toBeNull();
    expect(r.reasoning).toContain('LLM 调用失败');
  });

  it('HTTP 非 2xx → 降级', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })));
    const think = await getLlmThink({ readConfig: readConfigOf(cfg()) });
    const r = await think({ payload: {} });
    expect(r.degraded).toBe(true);
    expect(r.degradeReason).toBe('llm_error');
  });

  it('输出不可解析 → 降级 llm_parse', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '抱歉，无法回答' } }] }) })));
    const think = await getLlmThink({ readConfig: readConfigOf(cfg()) });
    const r = await think({ payload: {} });
    expect(r.degraded).toBe(true);
    expect(r.degradeReason).toBe('llm_parse');
  });

  it('base_url 仅给基址 → 自动补 /chat/completions', async () => {
    let captured = null;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      captured = { url, auth: opts.headers.Authorization };
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{}' } }] }) };
    }));
    const think = await getLlmThink({ readConfig: readConfigOf(cfg({ base_url: 'https://api.siliconflow.cn/v1' })) });
    await think({ payload: {} });
    expect(captured.url).toBe('https://api.siliconflow.cn/v1/chat/completions');
    expect(captured.auth).toBe('Bearer sk-test-123'); // 解密后明文只进请求头
  });
});

describe('getLlmJson（非 agentLoop 推理消费方）', () => {
  it('已配置 → 返回 JSON 对象；不可解析 → null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"score":0.8,"note":"达标"}' } }] }),
    })));
    const llmJson = await getLlmJson({ readConfig: readConfigOf(cfg()) });
    const obj = await llmJson('系统提示', '用户提示');
    expect(obj).toEqual({ score: 0.8, note: '达标' });

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'no json' } }] }) })));
    const obj2 = await llmJson('系统', '用户');
    expect(obj2).toBeNull();
  });

  it('未配置 → null', async () => {
    const llmJson = await getLlmJson({ readConfig: readConfigOf(null) });
    expect(llmJson).toBeNull();
  });
});

describe('缓存 TTL（PUT 后经 resetLlmCache 强制失效）', () => {
  it('同配置 15s 内只读库一次；resetLlmCache 后重新读', async () => {
    const reads = [];
    const readConfig = async () => { reads.push(1); return cfg(); };
    const think1 = await getLlmThink({ readConfig });
    const think2 = await getLlmThink({ readConfig }); // 命中缓存
    expect(think1).toBeTruthy();
    expect(think2).toBeTruthy();
    expect(reads.length).toBe(1);

    resetLlmCache();
    await getLlmThink({ readConfig });
    expect(reads.length).toBe(2);
  });
});