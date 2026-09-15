// src/action/discoveryActions.js — 线索自主发现 Action 族
// 铁律（逐条继承 connectors/connectorActions.js:1-7）：
//   ① 写通道第 0 闸（autoDecision=true + decisionScenario → executor.js:64-70 统一 mint，无决策不写）
//   ② 外部数据只落 payload 事实字段 + sourcedFrom 弱边（auto_weak；relation_confidence 落边 meta）
//   ③ 低置信 → confirm 信号（stage2 review），绝不冒充人工确认
//   ④ 禁删：只增改，不删除粒子/边
import { registerAction } from './registry.js';
import { createEdge, getParticle, updateParticle } from '../particles/particleRepo.js';

// 决策场景 id（UPPER_SNAKE，与 db/seed.sql 的 crm.decision_scenario 键同源；Task 6 落 'LEAD_FIT' 行）。
const DISCOVERY_SCENARIO = 'LEAD_FIT';

// 写通道 fail-closed 守卫：executor 已 mint 时 ctx.decision_id 必有值（executor.js:68-70）。
//   为 undefined 说明场景行缺失 → executor.js:71 只会 emit trace 'auto-decision-no-scenario'
//   然后**照常执行 handler**（静默无决策写）。此处把静默失败顶成硬错，不留假绿。
function requireMintedDecision(ctx, actionName) {
  if (!ctx?.decision_id) {
    throw new Error(
      `decision_required: ${actionName} 无 decision_id（检查 crm.decision_scenario 是否已 seed '${DISCOVERY_SCENARIO}'）`
    );
  }
}

function registerDiscovery(def) {
  registerAction({
    kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'discovery', agentTool: true, force: false, needsApproval: true,
    autoDecision: true, confirm: 'stage2', owner: 'crm-native', version: '1.0.0',
    autoWeakEdge: true, weakPredicate: 'sourcedFrom',
    decisionScenario: DISCOVERY_SCENARIO,
    schema: {}, parameters: { required: [] },
    ...def,
  });
}

export function seedDiscoveryActions() {
  // discovery-run：一次自主发现（本体优先富集 + 缺口瀑布 + 评分入 payload）
  registerDiscovery({
    name: 'discovery-run',
    schema: { tenant_id: 'string', seed: 'object', limit: 'number' },
    parameters: { required: ['seed'] },
    handler: async (input, ctx) => {
      requireMintedDecision(ctx, 'discovery-run');
      // Task 7 落地；动态 import → 注册期零模块依赖（Task 5 可独立绿）
      const { runDiscovery } = await import('../agent/discoveryOrchestrator.js');
      return runDiscovery(ctx, input);
    },
  });

  // discovery-enrich：对指定 account 执行一次瀑布富集（写 payload + sourcedFrom 弱边）
  registerDiscovery({
    name: 'discovery-enrich',
    schema: { account_id: 'string', fields: 'array' },
    parameters: { required: ['account_id'] },
    handler: async ({ account_id, fields }, ctx) => {
      requireMintedDecision(ctx, 'discovery-enrich');
      const { loadAdapters } = await import('../connectors/discovery/providerRegistry.js');
      const { runWaterfall } = await import('../connectors/discovery/waterfall.js');
      const { buildEnrichmentPayload } = await import('../agent/discoverySchema.js');
      const adapters = await loadAdapters({ tenantId: ctx.tenantId });
      // ctx 上没有 getParticle（executor.js 只传 params+ctx）→ 直调 repo；旧写法是恒假守卫，
      // entity 会退化为 { id } 致适配器拿不到 name/domain/email（静默退化、测试仍绿）。
      const p = await getParticle(account_id).catch(() => null);
      const entity = p ? { id: p.id, name: p.payload?.name, domain: p.payload?.domain } : { id: account_id };
      const { values, cost } = await runWaterfall(adapters, entity, fields || ['email', 'firmographics'], ctx);
      const enrichment = buildEnrichmentPayload(values);
      // 来源语义落边：ACCOUNT --sourcedFrom--> KNOWLEDGE（auto_weak，relation_confidence 落 meta）
      const k = values?.source_knowledge_id;
      if (k?.value) {
        await createEdge('CRM_ACCOUNT', account_id, 'sourcedFrom', 'CRM_KNOWLEDGE', k.value, {
          edge_source: 'auto_weak', relation_confidence: k.confidence ?? 0.5,
          provenance: 'discovery-enrich', decision_id: ctx.decision_id,
        }, ctx.tenantId).catch(() => {});
      }
      return { account_id, enrichment, cost, decision_id: ctx.decision_id };
    },
  });

  // discovery-research：Claygent 式自主研究（区块二分抓取 + getLlmJson 抽取，见 Task 8）
  registerDiscovery({
    name: 'discovery-research',
    schema: { account_id: 'string', brief: 'string' },
    parameters: { required: ['account_id', 'brief'] },
    handler: async ({ account_id, brief }, ctx) => {
      requireMintedDecision(ctx, 'discovery-research');
      return runDiscoveryResearch({ account_id, brief }, ctx);
    },
  });
}

// 编排（可独立单测：deps 注入替身 → 零 DB）。handler 仅做「决策守卫 + 转发」。
// fail-open：无产出绝不写库（T8 断言②）。写 payload.research 用浅合并 patch（particleRepo.js:210
//   { ...cur.payload, ...patch }）→ 不冲掉既有 discovery/enrichment 段。
export async function runDiscoveryResearch(input = {}, ctx = {}, deps = {}) {
  const { account_id, brief } = input || {};
  const getP = deps.getParticle || getParticle;               // 顶部已静态 import
  const updP = deps.updateParticle || updateParticle;
  const claygentResearch = deps.claygentResearch
    || (await import('../connectors/discovery/claygent.js')).claygentResearch;
  let getLlmJson = deps.getLlmJson;
  if (getLlmJson === undefined) {
    const { getLlmJson: factory } = await import('../llm/client.js');
    // 真实形状：工厂 → 调用器；无 LLM 配置返回 null（fail-open）
    getLlmJson = await factory({ tenantId: ctx && ctx.tenantId }).catch(() => null);
  }
  const p = account_id ? await getP(account_id).catch(() => null) : null;
  const entity = p ? { id: p.id, name: p.payload && p.payload.name, domain: p.payload && p.payload.domain } : { id: account_id };
  const research = await claygentResearch(entity, brief, { getLlmJson, fetchText: deps.fetchText });
  const hasContent = !!(research.summary || (research.signals || []).length
    || (research.competitors || []).length || (research.risks || []).length);
  if (!hasContent) return { account_id, research, written: false, decision_id: (ctx && ctx.decision_id) || null };
  await updP(account_id, { patch: { research }, tenantId: ctx && ctx.tenantId, requireDecisionId: (ctx && ctx.decision_id) || null });
  return { account_id, research, written: true, decision_id: (ctx && ctx.decision_id) || null };
}
