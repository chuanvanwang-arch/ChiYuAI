// src/connectors/discovery/adapters/xinbang.js — 新榜：公众号 / 小红书 / 抖音 内容信号
import { ProviderAdapter, fieldHit } from '../providerAdapter.js';
import { registerProvider } from '../providerRegistry.js';

const XINBANG_API = process.env.XINBANG_API || 'https://api.newrank.cn/openapi';

export function xinbangAdapter(cfg = {}) {
  return new (class extends ProviderAdapter {
    constructor() {
      super({ id: 'xinbang', kind: 'social', scope: 'paid', costTier: 2,
        coverageFields: ['social_content'], ...cfg });
    }
    async enrich(entity, fields = [], ctx = {}) {
      if (cfg.__mock) {
        const out = {};
        if (fields.includes('social_content')) {
          Object.assign(out, fieldHit('social_content', {
            value: { platform: 'wechat,xhs,douyin', posts: cfg.__mock.posts, interactions: cfg.__mock.interactions },
            confidence: 0.6, cost: this.costTier, provider: this.id,
          }));
        }
        return out;
      }
      const key = ctx.credentials?.xinbang || process.env.XINBANG_KEY;
      if (!key) return {};
      const q = entity?.name;
      if (!q) return {};
      let res;
      try {
        const r = await fetch(`${XINBANG_API}/account/content?name=${encodeURIComponent(q)}`, { headers: { Authorization: `Bearer ${key}` } });
        if (!r.ok) return {};
        res = await r.json();
      } catch { return {}; }
      const d = res?.data || {};
      const out = {};
      if (fields.includes('social_content')) {
        Object.assign(out, fieldHit('social_content', {
          value: { platform: d.platform, posts: d.posts, interactions: d.interactions },
          confidence: 0.6, cost: this.costTier, provider: this.id,
        }));
      }
      return out;
    }
    // search()：拓客辅助信号（内容/社媒）——不单独产生候选；按 name 与 qixin join 增强 fit_score
    async search(query = {}, ctx = {}) {
      if (cfg.__mock) {
        const out = Array.isArray(cfg.__mock.accounts) ? cfg.__mock.accounts : [];
        return out.map((c) => ({ ...c, provider: 'xinbang' }));
      }
      const key = ctx.credentials?.xinbang || process.env.XINBANG_KEY;
      if (!key) return [];
      try {
        const r = await fetch(`${XINBANG_API}/account/search`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify({ name: query.name, limit: query.limit || 20 }) });
        if (!r.ok) return [];
        const res = await r.json();
        const list = Array.isArray(res?.data?.list) ? res.data.list : [];
        return list.map((d) => ({ name: d.name, platform: d.platform, social_content: { posts: d.posts, interactions: d.interactions }, confidence: 0.6, provider: 'xinbang' }));
      } catch { return []; }
    }
  })();
}

registerProvider('xinbang', xinbangAdapter);
