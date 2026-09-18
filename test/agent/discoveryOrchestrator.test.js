// test/agent/discoveryOrchestrator.test.js
// 全部注入替身（deps），零 IO / 零 DB；生产默认真实现由 Step 5 保证（不留「打桩绿、生产崩」缝隙）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runDiscovery, repoWriteOpts } from '../../src/agent/discoveryOrchestrator.js';
import { registerBuiltinAdapters } from '../../src/connectors/discovery/builtinAdapters.js';
import { resolveAdapters, _resetRegistry } from '../../src/connectors/discovery/providerRegistry.js';
import { DEFAULT_DISCOVERY_RULES } from '../../src/config/discoveryRules.js';

const ctx = { tenantId: 't1', actor: 'alice', decision_id: 'dec-1' };
const mkDeps = (over = {}) => {
  const calls = { create: [], update: [], edge: [] };
  const deps = {
    rules: DEFAULT_DISCOVERY_RULES,
    adapters: [],
    find: vi.fn(async () => null),
    create: vi.fn(async (type, attrs) => { calls.create.push({ type, attrs }); return { id: `new-${type}` }; }),
    update: vi.fn(async (id, attrs) => { calls.update.push({ id, attrs }); return { id }; }),
    createEdge: vi.fn(async (...a) => { calls.edge.push(a); return { ok: true }; }),
    ...over,
  };
  return { deps, calls };
};

describe('runDiscovery（自主发现编排）', () => {
  it('新建链路：ACCOUNT(potential) + DEAL(lead，含 name) + 评分入 payload', async () => {
    const { deps, calls } = mkDeps();
    const out = await runDiscovery(ctx, { seed: { name: '测试公司', domain: 'x.com' } }, deps);
    expect(calls.create.map((c) => c.type)).toEqual(['CRM_ACCOUNT', 'CRM_DEAL']);
    expect(calls.create[0].attrs.state).toBe('potential');          // ACCOUNT 生命周期态（非业务阶段）
    expect(calls.create[0].attrs.name).toBe('测试公司');
    expect(calls.create[1].attrs.name).toBeTruthy();                // identity=name 必填，缺则生产必抛
    expect(calls.create[1].attrs.account_id).toBe('new-CRM_ACCOUNT');
    expect(out.payload.discovery.icp_fit_score).toBeDefined();
    expect(out.payload.discovery.why_narrative).toContain('decision_id=dec-1'); // 真实溯源，非 'pending'
    expect(out.accountId).toBe('new-CRM_ACCOUNT');
  });

  it('查重命中：复用既有客户，不重复建号', async () => {
    const { deps, calls } = mkDeps({ find: vi.fn(async () => ({ id: 'acc-existing' })) });
    const out = await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, deps);
    expect(calls.create.map((c) => c.type)).toEqual(['CRM_DEAL']); // 只建 DEAL，不再建 ACCOUNT
    expect(out.accountId).toBe('acc-existing');
  });

  it('瀑布命中 → enrichment 落 payload 且六元齐（layer/source 由 buildEnrichmentPayload 补齐）', async () => {
    const stub = {
      id: 'stub', costTier: 1, coverageFields: ['email'],
      async enrich() { return { email: { value: 'a@b.com', confidence: 0.6, cost: 1, provider: 'stub' } }; },
    };
    const { deps, calls } = mkDeps({ adapters: [stub] });
    const out = await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, deps);
    const patch = calls.update[0].attrs;
    expect(patch.enrichment.email.value).toBe('a@b.com');
    expect(patch.enrichment.email.layer).toBe('L2');
    expect(patch.enrichment.email.source).toBe('provider_adapter');
    expect(out.cost).toBe(1);
    expect(out.enriched).toEqual(['email']);
  });

  it('溯源弱边：有知识 id 才落边，且为 7 参真实形状', async () => {
    const stub = {
      id: 'stub', costTier: 1, coverageFields: ['source_knowledge_id'],
      async enrich() {
        return { source_knowledge_id: { value: 'k-9', confidence: 0.7, cost: 0, provider: 'stub' } };
      },
    };
    const a = mkDeps({ adapters: [stub] });
    await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, a.deps);
    expect(a.calls.edge[0]).toEqual([
      'CRM_ACCOUNT', 'new-CRM_ACCOUNT', 'sourcedFrom', 'CRM_KNOWLEDGE', 'k-9',
      expect.objectContaining({ edge_source: 'auto_weak', provenance: 'discovery-run', decision_id: 'dec-1' }),
      't1',
    ]);
    const b = mkDeps();
    await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, b.deps);
    expect(b.calls.edge.length).toBe(0); // 无知识 id → 不落边，不伪造来源
  });

  it('生产写助手 opts 真实透传租户 + decision_id（防伪隔离，零 DB 可断言）', async () => {
    expect(repoWriteOpts({ tenantId: 't9', actor: 'bob', decision_id: 'dec-9' }))
      .toEqual({ tenantId: 't9', actor: 'bob', requireDecisionId: 'dec-9' });
    expect(repoWriteOpts({}).tenantId).toBe('system'); // 缺租户兜底 system（与 particleRepo 默认一致）
    const { deps } = mkDeps();
    const out = await runDiscovery(ctx, { seed: { name: 'X', domain: 'x.com' } }, deps);
    expect(out.tenantId).toBe('t1');
  });

  it('缺 seed.name → fail-closed 抛错（不让 identity 校验在生产才炸）', async () => {
    const { deps } = mkDeps();
    await expect(runDiscovery(ctx, { seed: { domain: 'x.com' } }, deps)).rejects.toThrow(/seed\.name/);
  });
});

describe('内置适配器启动接线（死接线回归护栏）', () => {
  beforeEach(() => _resetRegistry());
  it('registerBuiltinAdapters 后 已启用源按 costTier 升序可解析（含 anysite，2026-09-18 收口开启）', () => {
    registerBuiltinAdapters();
    const ids = resolveAdapters(DEFAULT_DISCOVERY_RULES).map((a) => a.id);
    expect(ids).toEqual(['web-research', 'tender', 'email-verify', 'gaode', 'anysite']);
  });
});

describe('⑦ 真实评分（LF-2，2026-09-16）：占位 0.5 已被真实评分取代', () => {
  it('零信号 → intent_score.value 为 0（而非占位 0.5）', async () => {
    const { deps } = mkDeps({ rules: { signals: { funding_round: { weight: 0.9 } }, icp: { industries: ['chemical'] } }, adapters: [] });
    const out = await runDiscovery(ctx, { seed: { name: 'XX 化工' } }, deps);
    expect(out.payload.discovery.intent_score.value).toBe(0); // 关键：不是 0.5
  });

  it('命中信号 → intent_score.value > 0 且带设计 §5 的 rule_ref', async () => {
    const stub = {
      id: 'stub', costTier: 1, coverageFields: ['funding_round'],
      async enrich() { return { funding_round: { value: true, provider: 'stub', ts: new Date().toISOString() } }; },
    };
    const { deps } = mkDeps({ rules: { signals: { funding_round: { weight: 0.9 } } }, adapters: [stub] });
    const out = await runDiscovery(ctx, { seed: { name: 'XX 化工' } }, deps);
    expect(out.payload.discovery.intent_score.value).toBeGreaterThan(0);
    expect(out.payload.discovery.intent_score.judge.rule_ref).toBe('scenario:lead-fit#ruler:hiring_icp_role');
  });
});
