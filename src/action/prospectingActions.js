// src/action/prospectingActions.js — 拓客三个 MCP Action（search/select/confirm）
// 设计输入：docs/2026-09-14-prospecting-module-design.md §4/§5
// 铁律（继承 connectorActions + discoveryActions）：
//   ① search/select 只读；confirm 写，走第 0 闸（decisionScenario=PROSPECTING_CONFIRM → executor mint）
//   ② 适配器不注入 fit_score；服务端 computeFitScore 统一计算（修订 2）
//   ③ 入池复用 createLeadFromTender 范式：CRM_DEAL S0 + pool_type:'new' + source:'prospecting'
//      + DEAL --sourcedFrom--> KNOWLEDGE 弱边（修订 1，主语统一）
//   ④ 查重：已有企业（name/domain 命中原 CRM_ACCOUNT）标 existing:true 不入池（禁删，复用赢家）
//   ⑤ 不新增粒子类型（红线 §10）；候选 id 由本模块按 name 派生（稳定 hash，与 provider 无关）
import { registerAction } from './registry.js';
import { createProspectingSession, getSession, updateSession } from './prospectingSession.js';
import { mergedProspectingRules, computeFitScore } from '../config/prospectingRules.js';
import { resolveAdapters } from '../connectors/discovery/providerRegistry.js';
import { routeExternalLookup } from '../connectors/discovery/lookupRouter.js'; // T2 入站意图路由（零 CRM 写）
import { getDraft, softExpireDraft } from '../connectors/discovery/draftRepo.js'; // T4 草稿暂存（discovery_draft）
import { emit } from '../events/bus.js';

const SCENARIO = 'PROSPECTING_CONFIRM';

// 候选 id 派生：稳定短 id（name+domain hash），供会话内圈选/确认引用
function candidateIdOf(name, domain) {
  const s = `${name}|${domain || ''}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `c${h.toString(36)}`;
}

// 写通道 fail-closed 守卫（对齐 discoveryActions.js:16-22）：executor 已 mint 时 ctx.decision_id 必有值
function requireMintedDecision(ctx, actionName) {
  if (!ctx?.decision_id) {
    throw new Error(`decision_required: ${actionName} 无 decision_id（检查 crm.decision_scenario 是否已 seed '${SCENARIO}'）`);
  }
}

export function seedProspectingActions() {
  // —— prospecting-lookup（入站意图路由工具，只读，零 CRM 写）：
  //     路由到指定 provider 适配器取数 → 暂存 discovery_draft（staging）→ 返回草稿预览。
  //     满足「禁自动落 CRM 粒子」红线：confirm 阶段（prospecting-confirm draft_id 分支）才落 CRM。
  //     insertDraft 走惰性 import（draftRepo 在 T4 落地），避免本模块在 T4 之前因缺文件加载失败。
  registerAction({
    name: 'prospecting-lookup', kind: 'read', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { provider: 'string', kind: 'string', payload: 'object' },
    parameters: { required: ['provider', 'kind'] },
    handler: async ({ provider, kind, payload = {} }, ctx, deps = {}) => {
      const route = deps.routeExternalLookup || routeExternalLookup;
      const draftInsert = deps.insertDraft
        || (await import('../connectors/discovery/draftRepo.js')).insertDraft;
      const res = await route({ provider, kind, payload, tenantId: ctx.tenantId, deps });
      if (res.error) return { provider, kind, count: 0, items: [], error: res.error };
      // 仅暂存到 discovery_draft（staging，非 CRM 粒子）—— confirm 阶段才落 CRM
      const d = await draftInsert({ tenantId: ctx.tenantId, provider, kind, items: res.items || [] }).catch(() => null);
      return {
        draft_id: d?.draft_id || null,
        provider, kind,
        count: (res.items || []).length,
        items: (res.items || []).slice(0, 20), // 仅预览
        preview: true,
      };
    },
  });

  // —— prospecting-search（只读）：候选清单 + fit_score ——
  registerAction({
    name: 'prospecting-search', kind: 'read', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { query: 'object', pool: 'string' },
    parameters: { required: ['query'] },
    handler: async ({ query = {}, pool }, ctx, deps = {}) => {
      const rules = await (deps.mergedRules
        ? deps.mergedRules({ tenantId: ctx.tenantId })
        : mergedProspectingRules({ tenantId: ctx.tenantId }));
      const enabled = Object.entries(rules.sources || {})
        .filter(([, s]) => s && s.enabled)
        .map(([id, s]) => ({ id, enabled: true, costTier: 0 }));
      const adapters = resolveAdapters({ providers: enabled });
      // qixin 强信号 + xinbang 辅助信号（join 增强）
      let candidates = [];
      for (const a of adapters) {
        if (typeof a.search !== 'function') continue;   // 无 search 跳过
        const list = await a.search(query, ctx).catch(() => []);
        for (const c of list) {
          candidates.push({
            ...c,
            id: candidateIdOf(c.name, c.domain),
            signals: {
              hiring: !!c.hiring_icp_role,
              funding: !!c.funding_round,
              tender: !!c.tender_match,
              social: !!(c.social_content && (c.social_content.posts || c.social_content.interactions)),
            },
          });
        }
      }
      // fit_score 服务端统一计算（适配器注入的 fit_score 忽略——修订 2），阈值过滤 + 限量
      const scored = candidates
        .map((c) => ({ ...c, fit_score: computeFitScore(c, rules) }))
        .filter((c) => c.fit_score >= (rules.fit_threshold ?? 0))
        .slice(0, rules.candidate_limit ?? 50);
      // 会话：幂等重建（同 actor 旧会话覆盖）
      const sessionId = createProspectingSession({ tenantId: ctx.tenantId, actor: ctx.actor });
      updateSession(sessionId, { candidates: scored, state: 'listing' });
      return { session_id: sessionId, total: scored.length, candidates: scored };
    },
  });

  // —— prospecting-select（只读）：圈选（校验 ∈ 候选） ——
  registerAction({
    name: 'prospecting-select', kind: 'read', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: false,
    autoDecision: false, confirm: 'stage0', owner: 'prospecting', version: '1.0.0',
    schema: { session_id: 'string', selected_ids: 'array' },
    parameters: { required: ['session_id', 'selected_ids'] },
    handler: async ({ session_id, selected_ids }, ctx) => {
      const s = getSession(session_id);
      if (!s) throw new Error(`prospecting session 不存在或已超时: ${session_id}`);
      if (s.tenantId !== ctx.tenantId) throw new Error('跨租户访问拒绝');
      const valid = new Set((s.candidates || []).map((c) => c.id));
      const bad = (selected_ids || []).filter((id) => !valid.has(id));
      if (bad.length) throw new Error(`圈选含非候选 id: ${bad.join(', ')}（防注入）`);
      return updateSession(session_id, { selected_ids, state: 'selecting' });
    },
  });

  // —— prospecting-confirm（唯一写）：批量入池 S0 + sourcedFrom 弱边 ——
  registerAction({
    name: 'prospecting-confirm', kind: 'write', permission: 'auth',
    namespace: 'prospecting', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'prospecting', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',
    decisionScenario: SCENARIO,
    schema: { session_id: 'string', confirmed_ids: 'array' },
    parameters: { required: ['session_id', 'confirmed_ids'] },
    // deps 注入（对齐 runDiscoveryResearch）：单测可注入替身；生产走真实 particleRepo/bus
    handler: async ({ session_id, confirmed_ids, draft_id }, ctx, deps = {}) => {
      const createParticle = deps.createParticle || (await import('../particles/particleRepo.js')).createParticle;
      const createEdge = deps.createEdge || (await import('../particles/particleRepo.js')).createEdge;
      const findAccount = deps.findAccount || (async (name, domain) => {
        const { queryParticles } = await import('../particles/particleRepo.js');
        // 按 name/domain 查重（对齐 dedupResolver 默认 criteria）
        const rows = await queryParticles({ type: 'CRM_ACCOUNT', tenantId: ctx?.tenantId }).catch(() => null);
        if (rows && rows.length) {
          const hit = rows.find((r) => r.payload?.name === name || r.payload?.domain === domain);
          if (hit) return hit;
        }
        return null;
      });
      const busEmit = deps.emit || emit;

      // —— 草稿路径（设计 T4）：从 discovery_draft 取待确认候选，落 CRM_DEAL S0 ——
      // 复用网关两阶段 confirm_token（本 Action 已声明 autoDecision:true + decisionScenario=PROSPECTING_CONFIRM，
      //   phase1 已 mint decision_id；phase2 执行时 ctx.decision_id 已具备，满足第 0 闸）。
      // 双闸：无 token → 网关拒写；无草稿/非 pending/已过期 → 此处拒写。软状态翻转，禁物理 DELETE。
      if (draft_id) {
        const getDraftFn = deps.getDraft || getDraft;
        const softExpire = deps.softExpireDraft || softExpireDraft;
        const d = await getDraftFn(draft_id, { tenantId: ctx.tenantId });
        if (!d) throw new Error(`discovery_draft 不存在: ${draft_id}`);
        if (d.status !== 'pending') throw new Error(`discovery_draft 状态非 pending（${d.status}）: ${draft_id}`);
        if (d.expires_at && new Date(d.expires_at) < new Date()) throw new Error(`discovery_draft 已过期: ${draft_id}`);
        const candidates = (d.items || []).map((it) => ({ ...it, id: candidateIdOf(it.name || '', it.domain || '') }));
        const results = [];
        for (const cand of candidates) {
          const hit = await findAccount(cand.name, cand.domain).catch(() => null);
          if (hit) { results.push({ account_id: hit.id || null, deal_id: null, decision_id: ctx.decision_id, existing: true }); continue; }
          const deal = await createParticle('CRM_DEAL', {
            name: cand.name, stage: 'S0', pool_type: 'new', source: 'prospecting',
            expected_amount: cand.revenue || 0, industry: cand.industry, pooled_at: new Date().toISOString(),
          }, { tenantId: ctx.tenantId, requireDecisionId: ctx.decision_id });
          await createEdge('CRM_DEAL', deal.id, 'sourcedFrom', 'CRM_KNOWLEDGE', `prospecting:${cand.id}`, {
            edge_source: 'auto_weak', relation_confidence: cand.fit_score ?? 0.5, provenance: 'prospecting-lookup', decision_id: ctx.decision_id,
          }, ctx.tenantId).catch(() => {});
          results.push({ account_id: null, deal_id: deal.id, decision_id: ctx.decision_id, existing: false });
        }
        await softExpire(draft_id);
        busEmit('prospecting', 'batch-pooled', { tenant_id: ctx.tenantId, total: results.length, decision_id: ctx.decision_id, via: 'discovery_draft' });
        return { results, via: 'discovery_draft' };
      }

      requireMintedDecision(ctx, 'prospecting-confirm');
      const s = getSession(session_id);
      if (!s) throw new Error(`prospecting session 不存在或已超时: ${session_id}`);
      if (s.tenantId !== ctx.tenantId) throw new Error('跨租户访问拒绝');
      const valid = new Set((s.candidates || []).map((c) => c.id));
      const bad = (confirmed_ids || []).filter((id) => !valid.has(id));
      if (bad.length) throw new Error(`确认含非候选 id: ${bad.join(', ')}`);
      const results = [];
      for (const id of confirmed_ids) {
        const cand = (s.candidates || []).find((c) => c.id === id);
        if (!cand) continue;
        const hit = await findAccount(cand.name, cand.domain).catch(() => null);
        if (hit) { results.push({ account_id: hit.id || null, deal_id: null, decision_id: ctx.decision_id, existing: true }); continue; }
        const deal = await createParticle('CRM_DEAL', {
          name: cand.name, stage: 'S0', pool_type: 'new', source: 'prospecting',
          expected_amount: cand.revenue || 0, industry: cand.industry,
          pooled_at: new Date().toISOString(),
        }, { tenantId: ctx.tenantId, requireDecisionId: ctx.decision_id });
        // 溯源弱边：CRM_DEAL --sourcedFrom--> CRM_KNOWLEDGE（修订 1，主语统一对齐 createLeadFromTender）
        await createEdge('CRM_DEAL', deal.id, 'sourcedFrom', 'CRM_KNOWLEDGE', `prospecting:${cand.id}`, {
          edge_source: 'auto_weak', relation_confidence: cand.fit_score ?? 0.5,
          provenance: 'prospecting-search', decision_id: ctx.decision_id,
        }, ctx.tenantId).catch(() => {});
        results.push({ account_id: null, deal_id: deal.id, decision_id: ctx.decision_id, existing: false });
      }
      busEmit('prospecting', 'batch-pooled', { tenant_id: ctx.tenantId, total: results.length, decision_id: ctx.decision_id });
      updateSession(session_id, { state: 'pooled', confirmed_ids });
      return { results };
    },
  });
}
