// test/connectors/prospectingSearchAdapters.test.js — 拓客适配器 search()（T4）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §2 + 实施计划 T4
// 铁律：search() 可选能力（基类不强制）；无凭据/异常 → 返回 []（fail-open）；
//   不得返回 fit_score（修订 2：fit_score 仅服务端 computeFitScore 计算）
import { describe, it, expect } from 'vitest';
import { qixinAdapter, mapSearchResult } from '../../src/connectors/discovery/adapters/qixin.js';
import { xinbangAdapter } from '../../src/connectors/discovery/adapters/xinbang.js';
import { ProviderAdapter } from '../../src/connectors/discovery/providerAdapter.js';

describe('prospecting 适配器 search()（T4）', () => {
  it('① qixin.search 返回候选数组（强信号字段）', async () => {
    const a = qixinAdapter({ __mock: { companies: [{ name: '示例科技', domain: 'ex.com', industry: 'healthcare', revenue: 5e8, funding_round: true, hiring_icp_role: true, tender_match: true }] } });
    const r = await a.search({ industries: ['healthcare'], limit: 5 }, {});
    expect(Array.isArray(r)).toBe(true);
    expect(r[0].name).toBe('示例科技');
    expect(r[0].provider).toBe('qixin');
    expect('fit_score' in r[0]).toBe(false);       // 修订 2：适配器不得返回 fit_score
  });
  it('② qixin.search 无凭据返回 [] 不抛错（fail-open）', async () => {
    const a = qixinAdapter({});   // 无 __mock、无 key
    const r = await a.search({}, {}).catch((e) => {
      throw new Error('不应抛错: ' + e.message);
    });
    expect(Array.isArray(r)).toBe(true);
  });
  it('③ xinbang.search 返回辅助信号候选', async () => {
    const a = xinbangAdapter({ __mock: { accounts: [{ name: '某公众号', platform: 'wechat', posts: 12, interactions: 345 }] } });
    const r = await a.search({}, {});
    expect(Array.isArray(r)).toBe(true);
    expect(r[0].provider).toBe('xinbang');
    expect('fit_score' in r[0]).toBe(false);
  });
  it('④ xinbang.search 无凭据返回 []（fail-open）', async () => {
    const a = xinbangAdapter({});
    const r = await a.search({}, {});
    expect(Array.isArray(r)).toBe(true);
    expect(r.length).toBe(0);
  });
  describe('mapSearchResult 职位层级下钻（P1-2）', () => {
    it('① 源返回招聘岗位字符串 → 附 hiring_role', () => {
      const r = mapSearchResult({ name: 'X', latest_hiring: true, hiring_icp_role: '招聘VP' });
      expect(r.hiring_role).toBe('招聘VP');
      expect(r.hiring_icp_role).toBe(true);   // 布尔信号契约不变
    });
    it('② 源返回 d.hiring_role → 优先取', () => {
      const r = mapSearchResult({ name: 'X', hiring_role: '销售总监' });
      expect(r.hiring_role).toBe('销售总监');
    });
    it('③ 源无招聘岗位信息 → 不附 hiring_role（fail-open，评分按默认 1.0）', () => {
      const r = mapSearchResult({ name: 'X' });
      expect('hiring_role' in r).toBe(false);
      expect('fit_score' in r).toBe(false);   // 修订 2：适配器不得返回 fit_score
    });
  });
  it('⑤ 基类不变：enrich 仍为缺省抛错接口占位', () => {
    // 不破坏既有 enrich 能力——基类方法仍是 enrich（构造时覆盖不加 search 的适配器仍可 enrich）
    expect(typeof ProviderAdapter.prototype.enrich).toBe('function');
  });
});
