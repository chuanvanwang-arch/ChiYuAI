// test/llm/clientMultiConfig.test.js — 多 LLM 配置选取与调用策略（T2）
// 契约：name 精确选取 / round-robin 跨调用轮换（规避单 key 限流，根治 DRAFTS=0）/
//       轮换下首次超时自动换下一条重试一次 / 表源为空回退注入 readConfig 单条源
// 隔离：表源 llm_config 一律 mock，不触真实 DB；fetch 一律 stub，不触真实网络
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getDefault: vi.fn(),
  getByName: vi.fn(),
  getAllActive: vi.fn(),
  // 模拟真实 hydrate：明文 api_key + 补 /chat/completions
  hydrate: (c) => (c
    ? { ...c, apiKey: c.api_key, base: String(c.base_url || 'https://x/v1').replace(/\/+$/, '') + '/chat/completions' }
    : null),
}));
vi.mock('../../src/llm/llmConfigStore.js', () => mocks);

import { getLlmJson, resetLlmCache } from '../../src/llm/client.js';

const CFG_A = {
  id: 'c1', name: 'sf-main', provider: 'siliconflow', model: 'mA',
  base_url: 'https://api.siliconflow.cn/v1', api_key: 'sk-a', is_default: true, temp: 0.7, max_tokens: 1024,
};
const CFG_B = {
  id: 'c2', name: 'ds-backup', provider: 'deepseek', model: 'mB',
  base_url: 'https://api.deepseek.com/v1', api_key: 'sk-b', is_default: false, temp: 0.7, max_tokens: 1024,
};

// 捕获每次请求命中的 base URL（即实际选用的配置）
function stubFetchCapture(impl) {
  const urls = [];
  const fn = vi.fn(async (url, opts) => {
    urls.push({ url, auth: opts?.headers?.Authorization });
    return impl ? impl(url, urls.length) : { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
  });
  vi.stubGlobal('fetch', fn);
  return { fn, urls };
}

beforeEach(() => {
  resetLlmCache();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  mocks.getDefault.mockResolvedValue(CFG_A);
  mocks.getByName.mockImplementation(async (n) => (n === CFG_B.name ? CFG_B : (n === CFG_A.name ? CFG_A : null)));
  mocks.getAllActive.mockResolvedValue([CFG_A, CFG_B]);
});

describe('name 精确选取', () => {
  it('getLlmJson({name}) → 命中指定配置（非 default）', async () => {
    const { urls } = stubFetchCapture();
    const llm = await getLlmJson({ name: 'ds-backup' });
    expect(llm).toBeTypeOf('function');
    await llm('sys', 'user');
    expect(urls).toHaveLength(1);
    expect(urls[0].url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(urls[0].auth).toBe('Bearer sk-b');
  });

  it('name 不存在 → 返回 null（不静默取 default）', async () => {
    stubFetchCapture();
    expect(await getLlmJson({ name: 'nope' })).toBeNull();
  });
});

describe('默认策略', () => {
  it('无 name/strategy → 取 is_default 那条', async () => {
    const { urls } = stubFetchCapture();
    const llm = await getLlmJson();
    await llm('sys', 'user');
    expect(urls[0].url).toBe('https://api.siliconflow.cn/v1/chat/completions');
    expect(urls[0].auth).toBe('Bearer sk-a');
  });
});

describe('round-robin 轮换（根治限流连续超时）', () => {
  it('连续多次取用 → 在多条配置间轮换，不恒定命中同一条', async () => {
    const { urls } = stubFetchCapture();
    for (let i = 0; i < 4; i++) {
      const llm = await getLlmJson({ strategy: 'round-robin', refresh: true });
      await llm('sys', 'user');
    }
    expect(urls.map((u) => u.auth)).toEqual([
      'Bearer sk-a', 'Bearer sk-b', 'Bearer sk-a', 'Bearer sk-b',
    ]);
  });

  it('首次调用超时 → 自动换下一条配置重试一次并成功返回 JSON', async () => {
    const { urls } = stubFetchCapture((_url, nth) => {
      if (nth === 1) throw new Error('timeout'); // 首条超时
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"draft_patches":[{"knob":"threshold"}]}' } }] }) };
    });
    const llm = await getLlmJson({ strategy: 'round-robin', refresh: true });
    const out = await llm('sys', 'user');
    expect(out).toEqual({ draft_patches: [{ knob: 'threshold' }] });
    expect(urls).toHaveLength(2); // 1 次失败 + 1 次换配置重试
    expect(urls[1].auth).not.toBe(urls[0].auth); // 重试换了另一条配置
  });

  it('两条全失败 → 返回 null（不抛，交调用方降级）', async () => {
    stubFetchCapture(() => { throw new Error('all down'); });
    const llm = await getLlmJson({ strategy: 'round-robin', refresh: true });
    expect(await llm('sys', 'user')).toBeNull();
  });
});

describe('双源回退（表源为空 → config_store 单条）', () => {
  it('表源全部为空 → 回退注入 readConfig 的单条配置，既有能力不倒退', async () => {
    mocks.getDefault.mockResolvedValue(null);
    mocks.getByName.mockResolvedValue(null);
    mocks.getAllActive.mockResolvedValue([]);
    const { urls } = stubFetchCapture();
    const readConfig = async () => ({
      provider: 'siliconflow', model: 'legacy', base_url: 'https://legacy.example/v1', api_key: 'sk-legacy',
    });
    const llm = await getLlmJson({ readConfig, refresh: true });
    expect(llm).toBeTypeOf('function'); // 表空但单条源可用 → 不降级
    await llm('sys', 'user');
    expect(urls[0].url).toBe('https://legacy.example/v1/chat/completions');
    expect(urls[0].auth).toBe('Bearer sk-legacy');
  });

  it('表源空 + 单条源空 → null（保持原有降级语义）', async () => {
    mocks.getDefault.mockResolvedValue(null);
    mocks.getByName.mockResolvedValue(null);
    mocks.getAllActive.mockResolvedValue([]);
    stubFetchCapture();
    expect(await getLlmJson({ readConfig: async () => null, refresh: true })).toBeNull();
  });
});
