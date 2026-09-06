// test/llm/embeddingClient.test.js — 真语义向量客户端单测（mock llmConfigStore + fetch）
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// mock 配置源：hydrate 解密后给 apiKey + base（…/chat/completions）→ 客户端切成 /embeddings
vi.mock('../../src/llm/llmConfigStore.js', () => ({
  getDefault: async () => ({ provider: 'siliconflow', model: 'BAAI/bge-large-zh-v1.5', base_url: 'https://api.siliconflow.cn/v1', api_key: 'enc' }),
  hydrate: (c) => ({ ...c, apiKey: 'sk-test', base: 'https://api.siliconflow.cn/v1/chat/completions' }),
}));

const { embed } = await import('../../src/llm/embeddingClient.js');

let realFetch;
beforeAll(() => { realFetch = global.fetch; });
afterAll(() => { global.fetch = realFetch; });

describe('embeddingClient.embed', () => {
  it('POST /v1/embeddings 并返回 number[]（维度=模型原生）', async () => {
    global.fetch = async (url, opts) => {
      expect(String(url)).toContain('/embeddings'); // 端点同域、非 chat
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('BAAI/bge-large-zh-v1.5');
      expect(body.input).toBe('hello');
      expect(opts.headers.Authorization).toBe('Bearer sk-test');
      return { ok: true, status: 200, async json() { return { data: [{ embedding: [0.1, 0.2, 0.3] }] }; } };
    };
    const v = await embed('hello');
    expect(Array.isArray(v)).toBe(true);
    expect(v.every((x) => typeof x === 'number')).toBe(true);
    expect(v).toEqual([0.1, 0.2, 0.3]);
  });

  it('env EMBEDDING_MODEL 可覆盖模型', async () => {
    global.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      expect(body.model).toBe('custom-model');
      return { ok: true, status: 200, async json() { return { data: [{ embedding: [1] }] }; } };
    };
    await embed('x', { model: 'custom-model' });
  });

  it('HTTP 非 2xx → 抛（由 embedText 捕获降级为哈希）', async () => {
    global.fetch = async () => ({ ok: false, status: 500, async json() { return {}; } });
    await expect(embed('x')).rejects.toThrow();
  });

  it('空向量 → 抛', async () => {
    global.fetch = async () => ({ ok: true, status: 200, async json() { return { data: [{ embedding: [] }] }; } });
    await expect(embed('x')).rejects.toThrow('空向量');
  });
});
