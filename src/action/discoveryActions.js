// src/action/discoveryActions.js — 线索自主发现 Action 族
// 铁律（逐条继承 connectors/connectorActions.js:1-7）：
//   ① 写通道第 0 闸（autoDecision=true + decisionScenario → executor.js:64-70 统一 mint，无决策不写）
//   ② 外部数据只落 payload 事实字段 + sourcedFrom 弱边（auto_weak；relation_confidence 落边 meta）
//   ③ 低置信 → confirm 信号（stage2 review），绝不冒充人工确认
//   ④ 禁删：只增改，不删除粒子/边
import { registerAction } from './registry.js';
import { createEdge } from '../particles/particleRepo.js';

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
      const entity = (ctx.getParticle ? await ctx.getParticle(account_id) : null) || { id: account_id };
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
      // Task 8 落地（模块 = connectors/discovery/claygent.js，签名 (entity, brief, {getLlmJson})）
      const { claygentResearch } = await import('../connectors/discovery/claygent.js');
      const { getLlmJson } = await import('../llm/client.js');
      const entity = (ctx.getParticle ? await ctx.getParticle(account_id) : null) || { id: account_id };
      return claygentResearch(entity, brief, { getLlmJson: ctx.getLlmJson || getLlmJson });
    },
  });
}
