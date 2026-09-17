// src/action/seed-actions.js — 种子 Action（平台 substrate + 跨粒子能力 Action）
// 设计输入：01 粒子设计 §8（R2/R5：资源走 substrate，能力 Action 非粒子 CRUD）
import { registerAction, listActions } from './registry.js';
import { query, pool } from '../db.js';
import { createParticle, updateParticle, queryParticles, getParticle, createEdge, queryNeighbors } from '../particles/particleRepo.js';
import { advanceStage } from '../particles/lifecycle.js';
import { ruleEngine } from '../ruleEngine.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { emit } from '../events/bus.js';
import { listMetaAttr, setMetaAttr } from '../metaAttr/metaAttrRepo.js';
import { readConfig } from '../config/configStore.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { advise } from '../decision/adviseService.js';
import { collectFollowupRequirement } from '../decision/requirementConditions.js';
import {
  S_ALL_STAGES, S_LABEL, S_TRANSITIONS, S_GATE_DEFS, S_ATTACHMENT_GATES, toStageCode,
  STAGE_DEFAULT_SCENARIO as STAGE_SCENARIO, // 2026-09-08：上移至 stageTaxonomy.js 为单一事实源（注释随之上移）
} from '../sales/stageTaxonomy.js';
import { scoreBantcc6 } from '../sales/gateThresholdDelta.js';
import { mantOk, funnelZone, forecastClass, weightedAmount } from '../sales/funnelQuality.js';
import { evaluateBehaviorChecklist } from '../sales/behaviorChecklist.js';
import { mergedThresholds, readThreshold, deriveRhythmDays } from '../sales/salesThresholds.js';
import { leadQualifyGap } from '../sales/leadQualify.js'; // S0P→S1 升级判据（与 executor STAGE_GATES 同源）
import { reopenDeal } from '../sales/reopenDeal.js';
import { mergedTargets } from '../sales/namedAccountTargets.js';
import {
  detectAccountDuplicate, mergeIntoExisting,
} from '../particles/dedup.js'; // 2026-09-08 客户去重创建闸（docs/plans/2026-09-07-crm-dedup.md 任务2）
import { seedProspectingActions } from './prospectingActions.js'; // 2026-09-14 拓客三 Action（T5，装配汇聚 3/3）
import { seedPreheatActions } from './preheatActions.js'; // 2026-09-15 P1-3 触达前预热（T11，装配汇聚 3/3）
// 2026-09-17 信号读 Action（P1-4）：MCP 暴露面源头。signalOwnerScope 是**唯一收窄点**（http/tenantScope.js，
//   纯函数零依赖）——此处复用而非另写谓词，防止「同一隔离语义两处实现」的漂移（HTTP 侧已由静态守卫锚定）。
import { createSignalStore } from '../signal/store.js';
import { buildIcs } from '../signal/ics.js';
import { signalOwnerScope } from '../http/tenantScope.js';

// 商机推进决策沉淀铁律（2026-09-02）：crm-deal-advance 的 last_decision_id 必须 updateParticle 写回，
//   单纯改内存对象不落库 = 决策断链（审计/决策网络无法从商机追溯决策）。同型缺陷排查：任何
//   handler 中「updated.payload = {...}` 之后都应检查是否有对应落库写（advanceStage 只写 stage）。
// 规则门禁（S1→S2）实证：need_facts 3 项齐备（product/qty/spec）→ 通过（decision-gate.test.js:37-41）。

// 数据访问留痕铁律（2026-09-02）：agent 执行体 action 的 SQL 失败禁止静默吞错。
// 历史缺陷：三处查商机的表名误写成单数形式（生产库只有复数表名）→ 恒抛 relation does not exist，
// 且被「空 catch 返回空行集」吞掉 → 表现为「无可用商机」，SKILL 执行必失败且无人知晓。
// 统一形态：catch 内先 recordFailure(kind, e) 留痕再返回空行集 —— fail-safe 不中断编排，但失败可观测。
// 注：test/method-skill-real-execution.test.js 有两条反假绿护栏锁死本约定（源码文本断言），
//     故本注释刻意不原样书写缺陷代码片段，避免自命中。

// 阶段 → 决策场景映射（写通道第 0 闸：每次商机推进都是一个决策事件）
// 2026-08-31 统一术语：键改用 S1-S8 单一事实源
// 方案 A 接线（2026-08-31）：submit 不传 flow_id 时按 business_type → domain 解析粒子 id
// 配置页 flow_id 即业务域字符串；运行态引擎按粒子 id 查，需经 getFlowByDomain 桥接
const BIZ_DOMAIN = {
  CRM_QUOTATION: 'quote', CRM_CONTRACT: 'contract', CRM_INVOICE: 'invoice',
  CRM_ORDER: 'order', CRM_DEAL: 'deal',
};

// T7 分级审批接线（设计 §3.3）：按业务实体金额解析档位（T1/T2/T3）→ 档位链审批人 →
//   传入 engine.startInstance（tier_approvers 经 resolveNodeApprover 按节点序位分发，实现「按金额生成节点数」）。
// 依赖 R1-R4 已物化（scripts/seed-approval-rules.mjs）；未物化返回 null（由调用方决定抛错或静默跳过）。
async function startGradedApproval({ entityType, entityId, ruleId, submitter, extraCtx = {}, tenantId = 'system' }) {
  const { startInstance } = await import('../approval/engine.js');
  const { getFlowByDomainWithFallback } = await import('../approval/flow.js');
  const { resolveApprovalChain } = await import('../approval/ruleResolver.js');
  const { readApprovalConfig } = await import('../approval/approvalConfig.js');
  const domain = BIZ_DOMAIN[entityType];
  const fid = (await getFlowByDomainWithFallback(domain, tenantId))?.id;
  if (!fid) return null; // 未配置审批流：调用方决定（submit 抛错 / deal-advance 静默跳过）
  // 审批业务参数一律后台配置（config_store['approval-config']），运行态实时读取（铁律 2026-08-31）
  // 2026-09-05 G2：按租户读（tenantId 透传；审批参数租户隔离）
  const cfg = await readApprovalConfig(tenantId);
  const entity = await getParticle(entityId);
  const amount = Number(entity?.payload?.amount) || 0;
  const chain = resolveApprovalChain(ruleId, { amount, config: cfg }).approverChain; // T1/T2/T3 档位链（如 ['manager'] / ['manager','director'] / ...）
  return startInstance(fid, entityType, entityId, { amount, ...extraCtx }, { submitter, approvers: chain, tenantId });
}

export function seedActions() {
  // 平台 substrate（R2/R5：粒子 CRUD 走 substrate，非领域 Action）
  registerAction({
    name: 'data-particle-create', kind: 'write', permission: 'auth',
    namespace: 'data', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    // 2026-09-04 MCP 建档通道（用户拍板）：substrate 写族默认不上 MCP（tools.js data-* 排除），
    //   本 Action 以 mcpExpose 单点 opt-in 放开——销售/AI 可经 MCP 建客户/商机/合同等主数据。
    //   刻意不加 autoDecision：mint 决策放在 gateway（仅 MCP 通道），executor 第 0 闸语义保持
    //   「无 decision_id 且非 bootstrap → 拒绝」不变（test/action.test.js:125、decision-gate.test.js:11 锚定）。
    //   decisionScenario 为 gateway 侧 mint 的落点场景（db/seed.sql PARTICLE_CREATE）。
    mcpExpose: true,
    decisionScenario: 'PARTICLE_CREATE',
    schema: { type: 'string', payload: 'object' },
    parameters: {
      required: ['type', 'payload'],
      properties: { type: { type: 'string', candidateSource: 'particle_type_enum' } },
    },
    handler: async ({ type, payload }, ctx) => {
      // 【去重创建闸】CRM_ACCOUNT 前置查重（2026-09-08，bootstrap/seed 豁免，等同 accountGuard 范式）
      // 设计：docs/plans/2026-09-07-crm-dedup.md 任务2
      if (type === 'CRM_ACCOUNT' && ctx.bootstrap !== true) {
        const dup = await detectAccountDuplicate(payload?.name, payload?.industry, ctx.tenantId)
          .catch(() => ({ decision: 'CREATE' }));
        if (dup?.decision === 'MERGE' && dup.candidateId) {
          // 静默归并：字段级并入已有账户，不新建（根绝重复）
          const merged = await mergeIntoExisting(dup.candidateId, payload, ctx.tenantId, ctx.actor);
          return { ok: true, merged: true, particle: merged, decision_basis: 'AUTO_MERGE_DUPLICATE' };
        }
        if (dup?.decision === 'PROMPT' && dup.candidateId) {
          // 低置信：仍创建，标 possible_duplicate_of 供前端提示（不静默归并）
          payload = { ...payload, possible_duplicate_of: dup.candidateId };
        }
      }
      return createParticle(type, payload, {
        tenantId: ctx.tenantId,
        // 2026-08-31 根因修复：CRM_ACCOUNT 写路径强约束 named_owner（AI 写账户无主→看板不可见修复）
        // actor 兜底：ctx.actor 非空且非 'system' 时自动补 named_owner/owner_id/owner
        actor: ctx.actor,
        // enforceNamedOwner 由 routes.js POST /api/particles 的第 0 闸语义决定：
        //  对话式入口 + 非 bootstrap → true（强制要求 AI 提供 named_owner）；其余放行
        enforceNamedOwner: ctx.enforceNamedOwner === true,
        // 待办②(2026-09-03) 深度防御：业务写透传第0闸 mint 的 decision_id（undefined→软强制不触发，向后兼容）
        requireDecisionId: ctx.decision_id,
        // §5 防复发（account-misbind）：CRM_DEAL 走账户归属守护；bootstrap/seed 通道豁免
        // （演示账户绑印通等历史数据经 bootstrap 写入，不强制名称一致校验）
        accountGuard: type === 'CRM_DEAL' && ctx.bootstrap !== true,
      });
    },
  });
  registerAction({
    name: 'data-particle-read', kind: 'read', permission: 'auth',
    namespace: 'data', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { type: 'string', id: 'string' },
    handler: async ({ type, id }, ctx) =>
      id ? getParticle(id)
         : queryParticles({ type, tenantId: ctx.tenantId }),
  });
  // 决策复盘（decision-retro agent 的 skillCall，2026-08-31 补齐）：
  //   agentSpec 声明了 decision-retrospective 但 Registry 从未注册 → 装配断言 4（action_in_registry）失败，
  //   即「agent 被授权调用一个不存在的 action」。此处按 read 语义落地——
  //   汇总决策质量：根因分布 + 应连边缺失率 + 结果校验态，供复盘结论与校准处方使用。
  registerAction({
    name: 'decision-retrospective', kind: 'read', permission: 'auth', requiresEntitlement: ['audit_provenance'],
    namespace: 'decision', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { windowDays: 'number', limit: 'number' },
    handler: async ({ windowDays = 30, limit = 10 }, ctx) => {
      const since = new Date(Date.now() - Number(windowDays) * 864e5).toISOString();
      const rows = await query(
        `SELECT decision_id, scenario_id, state, outcome, outcome_verified, root_cause, attribution, created_at
           FROM crm.decision
          WHERE created_at >= $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [since, Number(limit)]
      ).catch((e) => { recordFailure('decision-retro-lookup-failed', e); return { rows: [] }; });
      const byCode = {};
      let missingEdge = 0;
      for (const r of rows.rows || []) {
        const code = r.root_cause?.code || 'UNKNOWN';
        byCode[code] = (byCode[code] || 0) + 1;
        // E 边缺失：仅当具备应连边依据（known=true）且确有未连边时计入（防误判护栏）
        const ec = r.attribution?.edge_compliance || {};
        if (ec.known === true && Array.isArray(ec.required_missing) && ec.required_missing.length > 0) missingEdge += 1;
      }
      const total = (rows.rows || []).length;
      return {
        windowDays: Number(windowDays),
        total,
        byCode,
        edgeMissingCount: missingEdge,
        edgeMissingRate: total ? missingEdge / total : null,
        verified: (rows.rows || []).filter((r) => r.outcome_verified).length,
        samples: (rows.rows || []).slice(0, 10).map((r) => ({
          decisionId: r.decision_id, scenario: r.scenario_id, state: r.state,
          outcome: r.outcome, rootCause: r.root_cause?.code || null,
        })),
      };
    },
  });
  // —— 智能体执行体真执行动作（method-* 步骤落点，2026-09-01）——
  // 全部 kind:'read'：agent 上下文执行零落库、零 HITL、零 decision_id（executor.js 写闸仅对 write 生效）。
  // deal_id 取自 ctx.taskPayload?.deal_id；缺失时回退租户最新商机（保证真执行不落空）。

  // crm-memory-upsert：决策前后双 Agent 的 write-through 落点（方案C，2026-09-02）
  //   富集阶段把先例/线索写回记忆，执行阶段把结论/故事线挂决策网络。解码「记忆真空」根因——
  //   agent 此前无任何写回通道，auditability 恒 21%。此处补齐唯一硬缺口（Grep crm-memory-upsert 0 命中）。
  //   kind:'write' 但走 memory_log 专用落库（非业务主表），不触发 executor 业务写闸，需 agent 上下文。
  registerAction({
    name: 'crm-memory-upsert', kind: 'write', permission: 'auth', requiresEntitlement: ['memory'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: {
      topic: 'string', kind: 'string', payload: 'object',
      layer: 'string', entityId: 'string', entityType: 'string', ttlDays: 'number',
    },
    parameters: {
      required: ['topic', 'payload'],
      properties: {
        topic: { type: 'string' },
        kind: { type: 'string', default: 'event' },
        layer: { type: 'string', default: 'L-Workspace' },
        entityId: { type: 'string', description: '客户/商机锚点 id；不传则按 payload.account_id → deal_id 自动解析' },
        entityType: { type: 'string', description: '锚点类型：ACCOUNT/DEAL/CONTACT/LEAD；不传按 payload.type 推导' },
        ttlDays: { type: 'number', default: 30 },
      },
    },
    handler: async ({ topic, kind = 'event', payload, layer = 'L-Workspace', entityId = null, entityType = null, ttlDays = 30 }, ctx) => {
      // 决策写回通道：topic/payload 缺省时从 ctx 推导（agent 经 decision_id 自然锚定，
      // 避免 SKILL 步骤硬编码 topic；SKILL 的 crm-memory-upsert 步骤 params 为空时仍能写回）。
      const decisionId = ctx?.decision_id || null;
      const derTopic = topic || (decisionId ? `decision:${decisionId}` : 'decision:enrich');
      // payload 显式 null = 调用方错误，拒绝；undefined = 由 ctx 推导（决策写回以 decision_id 锚定）
      const derPayload = payload === undefined ? { decision_id: decisionId, intent: ctx?.taskPayload?.intent || null } : payload;
      if (derPayload == null) return { ok: false, error: 'payload 缺失且无法推导（需 topic/payload 或 ctx.decision_id）' };
      const { appendMemory } = await import('../memory/memoryLog.js');
      // C1/C2（2026-09-10）：租户与锚点贯通。此前不传 tenantId → 记忆恒落 system，
      //   agent 写了但业务租户永远读不到（「记忆真空」根因之一）。
      const res = await appendMemory({
        topic: derTopic, kind, payload: derPayload, layer, entityId, entityType,
        ttlDays: Number(ttlDays) || 30,
        actor: ctx?.actor || 'decision-agent',
        tenantId: ctx?.tenantId || null,
        type: derPayload?.type || null,
        id: derPayload?.id || null,
      }).catch((e) => { recordFailure('crm-memory-upsert-failed', e); return null; });
      if (!res || res.ok === false) return { ok: false, error: res?.reason || 'memory 落库失败' };
      return {
        ok: true, memoryId: res.row?.id, topic: derTopic, layer,
        tenant_id: res.tenant_id, entity_id: res.entity_id, entity_type: res.entity_type,
      };
    },
  });

  // P0-② 租户级 Knowledge 写入通道（docs/2026-09-03-tenant-knowledge-design.md §5）
  // 零信任不旁路：第0闸（decision_id）+ confirm:'critical' 双段（全仓无 needsApproval:true 先例，
  //   对齐 crm-deal-advance 范式；crm-write skill write_two_phase 同型）；rbac_roles 白名单（第1.5闸）。
  // kind ∈ {icp, competitors, objections, buyer_language}（类目配置化，禁硬编码于逻辑散点）
  registerAction({
    name: 'crm-knowledge-upsert', kind: 'write', permission: 'auth', requiresEntitlement: ['ai_agents'],
    namespace: 'crm', agentTool: true, needsApproval: false, confirm: 'critical',
    rbac_roles: ['manager', 'presales', 'exec', 'sysadmin'],
    version: '1.0.0', owner: 'crm-native',
    schema: {
      id: 'string', term: 'string', kind: 'string', content: 'string',
      source: 'string', confidence: 'number', tags: 'array',
    },
    parameters: {
      required: ['term', 'kind', 'content'],
      properties: {
        id: { type: 'string', description: '存在则更新，缺则新建' },
        term: { type: 'string' },
        kind: { type: 'string', enum: ['icp','competitors','objections','buyer_language'] },
        content: { type: 'string' },
        source: { type: 'string', default: 'manual' },
        confidence: { type: 'number', default: 1 },
        tags: { type: 'array', items: { type: 'string' } },
      },
    },
    handler: async (p, ctx) => {
      const tid = ctx.tenantId || 'system';
      const payload = {
        term: p.term, kind: p.kind, content: p.content,
        source: p.source || 'manual',
        confidence: Number(p.confidence ?? 1),
        tags: Array.isArray(p.tags) ? p.tags : [],
      };
      const decisionId = ctx.decision_id || null;
      if (p.id) {
        const r = await updateParticle(p.id, {
          patch: payload, requireDecisionId: decisionId,
        }).catch((e) => { recordFailure('crm-knowledge-update-failed', e); return null; });
        if (!r) return { ok: false, error: 'knowledge 更新失败（见 trace）' };
        return { ok: true, id: r.id, updated: true };
      }
      const r = await createParticle('CRM_KNOWLEDGE', payload, {
        tenantId: tid, actor: ctx.actor, requireDecisionId: decisionId,
      }).catch((e) => { recordFailure('crm-knowledge-create-failed', e); return null; });
      if (!r) return { ok: false, error: 'knowledge 创建失败（见 trace）' };
      return { ok: true, id: r.id, created: true };
    },
  });

  // crm-quote-estimate：报价测算（A/B 两方案 + 毛利预估），不落库
  registerAction({
    name: 'crm-quote-estimate', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      let deal = deal_id ? await getParticle(deal_id) : null;
      if (!deal) {
        const rows = await query(
          `SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1
           ORDER BY created_at DESC LIMIT 1`, [tid])
           .catch((e) => { recordFailure('crm-deal-lookup-failed', e); return { rows: [] }; });
        deal = rows.rows?.[0] ? { id: rows.rows[0].id, payload: rows.rows[0].payload } : null;
      }
      if (!deal) return { ok: false, reason: '无可用商机' };
      const p = deal.payload || {};
      // 修复（2026-09-09）：读取租户配置的产品单价 + 价目表，使测算基于系统真实价格而非 deal.amount 拍脑袋
      const { loadTenantPriceData } = await import('../sales/quoteService.js');
      const { products } = await loadTenantPriceData(tid);
      const productMap = new Map();
      for (const pr of (products || [])) {
        const key = pr.id || pr.product_id || pr.name;
        if (key != null) { productMap.set(key, pr); if (pr.name != null) productMap.set(pr.name, pr); }
      }
      // 商机挂了产品明细 → 基于真实 list_price 测算；否则回退 deal.amount 并标记
      let listPrice = 0, resolvedCount = 0;
      const dealProducts = Array.isArray(p.products) ? p.products : [];
      for (const dp of dealProducts) {
        const ref = dp.product_id || dp.name || dp.product;
        const prod = productMap.get(ref);
        const lp = prod != null ? (prod.list_price != null ? prod.list_price : prod.price) : null;
        if (lp != null) { listPrice += lp * (Number(dp.qty) || 1); resolvedCount += 1; }
      }
      const priceSource = resolvedCount > 0 ? 'price_list' : 'deal_amount_fallback';
      if (resolvedCount === 0) listPrice = Number(p.amount) || 0;
      const cost = Number(p.cost) || listPrice * 0.6; // 无成本字段时按出厂默认 60%
      const planA = { name: '方案A·标准报价', price: listPrice, margin: listPrice - cost, marginPct: listPrice ? ((listPrice - cost) / listPrice * 100).toFixed(1) : '0' };
      const planB = { name: '方案B·折扣报价', price: +(listPrice * 0.92).toFixed(2), margin: +(listPrice * 0.92 - cost).toFixed(2), marginPct: listPrice ? (((listPrice * 0.92 - cost) / (listPrice * 0.92)) * 100).toFixed(1) : '0' };
      return { ok: true, deal_id: deal.id, priceSource, productsResolved: resolvedCount, productCatalogSize: (products || []).length, listPrice, cost, plans: [planA, planB], recommended: planB.margin >= planA.margin ? 'B' : 'A' };
    },
  });
  // crm-review-gate-evaluate：评审把关四维审查（功能/架构/安全/合规），不落库、不批准
  registerAction({
    name: 'crm-review-gate-evaluate', kind: 'read', permission: 'auth', requiresEntitlement: ['decision_autonomy'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      let deal = deal_id ? await getParticle(deal_id) : null;
      if (!deal) {
        const rows = await query(
          `SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1
           ORDER BY created_at DESC LIMIT 1`, [tid])
           .catch((e) => { recordFailure('crm-deal-lookup-failed', e); return { rows: [] }; });
        deal = rows.rows?.[0] ? { id: rows.rows[0].id, payload: rows.rows[0].payload } : null;
      }
      if (!deal) return { ok: false, reason: '无可用商机' };
      const p = deal.payload || {};
      const dims = {
        functional: !!p.solution_fit || !!p.requirements,        // 功能：方案契合/需求明确
        architectural: !!p.tech_feasible,                         // 架构：技术可行
        security: !!p.security_review || p.stage !== 'S1',        // 安全：已做安全评审（非线索期）
        compliance: !!p.contract_no || !!p.compliance_ok,         // 合规：合同/合规已确认
      };
      const passed = Object.values(dims).filter(Boolean).length;
      const verdict = passed >= 3 ? 'pass' : passed === 2 ? 'conditional' : 'fail';
      return { ok: true, deal_id: deal.id, dims, passedCount: passed, total: 4, verdict,
               findings: Object.entries(dims).filter(([, v]) => !v).map(([k]) => `缺失:${k}`) };
    },
  });
  // crm-followup-schedule：跟进催办（按 behavior-standard 节奏派生跟进计划 + 超时转人工），不落库
  registerAction({
    name: 'crm-followup-schedule', kind: 'read', permission: 'auth', requiresEntitlement: ['event_automation'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      // 行为合格线节奏走配置（阈值配置化铁律）；缺失用出厂默认 7 天
      const cfg = (await readConfig('behavior-standard', { tenantId: tid }).catch(() => null))?.value || {};
      const cadenceDays = Number(cfg?.followup_cadence_days ?? 7);
      const rows = await query(
        `SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1
         ${deal_id ? 'AND id=$2' : ''} ORDER BY created_at DESC LIMIT 5`,
        deal_id ? [tid, deal_id] : [tid]
      ).catch((e) => { recordFailure('crm-deal-lookup-failed', e); return { rows: [] }; });
      const now = Date.now();
      const schedule = (rows.rows || []).map((r) => {
        const p = r.payload || {};
        const last = p.last_activity_at ? new Date(p.last_activity_at).getTime() : (p.created_at ? new Date(p.created_at).getTime() : now);
        const idleDays = Math.floor((now - last) / 864e5);
        const overdue = idleDays > cadenceDays;
        return { deal_id: r.id, idleDays, cadenceDays, overdue,
                 action: overdue ? 'escalate_to_human' : 'auto_followup', nextAt: new Date(last + cadenceDays * 864e5).toISOString().slice(0, 10) };
      });
      return { ok: true, cadenceDays, schedule, overdueCount: schedule.filter((s) => s.overdue).length };
    },
  });

  // crm-followup-requirement-collect：跟进采集 SHOULD/NICE 需求维度证据（T9，REQUIREMENT 方法论）
  // 写经 autoDecision 第0闸；将 followup 判定（预算/时间表/试用 等非 MUST 维度）沉淀为可回溯证据，供复盘。
  // 铁律：auto 来源须带 evidence_ref（methodologyEvidence.js:88）→ 未提供时以 followup://<deal_id> 派生源标记
  //   （采集动作本身即出处），避免无出处断言被拒；来源仍记为 'auto'，人工断言优先级更高（铁律②）。
  registerAction({
    name: 'crm-followup-requirement-collect', kind: 'write', permission: 'auth', requiresEntitlement: ['event_automation'],
    confirm: 'normal', autoDecision: true, decisionScenario: 'REQUIREMENT_COLLECT',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', dims: 'array' },
    parameters: { required: ['deal_id', 'dims'], properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id, dims }, ctx) => {
      const tid = ctx.tenantId || 'system';
      // dims 未显式传 → 从 requirement-dimensions 配置自动取 SHOULD/NICE 维度，默认 met=false（已评估未满足，供复盘）
      let effective = dims;
      if (!Array.isArray(effective) || !effective.length) {
        const cfg = (await readConfig('requirement-dimensions', { tenantId: tid }).catch(() => null))?.value || {};
        effective = (cfg.dimensions || [])
          .filter((d) => d.level && d.level !== 'MUST')
          .map((d) => ({ dim_key: d.dim_key, met: false, value: null }));
      }
      if (!effective.length) throw new Error('无可采集的需求维度（dims 为空且配置无 SHOULD/NICE 维度）');
      const out = await collectFollowupRequirement(
        deal_id,
        effective.map((d) => ({ ...d, evidence_ref: d.evidence_ref || `followup://${deal_id}` })),
        { tenantId: tid, assertedBy: ctx.actor || 'followup-agent', decisionId: ctx.decision_id }
      );
      return { ok: true, collected: out.length, results: out };
    },
  });

  // —— CRM 三大业务方法步骤落点（2026-09-02 补：method-* 由「仅元数据」升级为真执行）——
  // 背景：method-stage-progression / method-funnel-classification / method-behavior-standard
  //   此前在 seed.js 只登记元数据、无 steps[]，executeSkill 恒降级 stepsMissing=true（契约矩阵假绿）。
  // 原则（沿用上方同款）：① kind:'read' 零落库零 HITL；② 判定内核一律复用 src/sales/* 既有纯函数，
  //   不在此重写业务规则（单一事实源）；③ 阈值一律经 readConfig（阈值配置化铁律）；④ SQL 失败留痕不静默。

  // crm-stage-progression-evaluate：阶段推进判定（当前 S 码 → 下一阶段 + 闸门缺失项 + BANTCC）
  registerAction({
    name: 'crm-stage-progression-evaluate', kind: 'read', permission: 'auth', requiresEntitlement: ['decision_autonomy'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } } },
    handler: async ({ deal_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      let deal = deal_id ? await getParticle(deal_id) : null;
      if (!deal) {
        const rows = await query(
          `SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1
           ORDER BY created_at DESC LIMIT 1`, [tid]
        ).catch((e) => { recordFailure('crm-deal-lookup-failed', e); return { rows: [] }; });
        deal = rows.rows?.[0] ? { id: rows.rows[0].id, payload: rows.rows[0].payload } : null;
      }
      if (!deal) return { ok: false, reason: '无可用商机' };
      const p = deal.payload || {};
      const thresholds = mergedThresholds(
        (await readConfig('sales-thresholds', { tenantId: tid }).catch(() => null))?.value || {});
      const bantccPass = readThreshold(thresholds, 'bantcc.pass');
      const bantcc = scoreBantcc6(p);

      let stage = toStageCode(p.stage);
      // 兼容历史脏值（如 'leads'）：S 码映射未命中时，先做单复数归一再试（不改动公共 taxonomy 模块）
      if (!S_ALL_STAGES.includes(stage) && typeof p.stage === 'string') {
        stage = toStageCode(p.stage.replace(/s$/, '')) || stage;
      }
      // 下一阶段取合法推进边，排除退出边（S7 输单 / S8 丢单）
      const next = S_TRANSITIONS.find((t) => t.from === stage && t.to !== 'S7' && t.to !== 'S8') || null;
      const gateDef = next ? (S_GATE_DEFS.find((g) => g.from === next.from && g.to === next.to) || null) : null;
      const attachGate = next ? (S_ATTACHMENT_GATES[`${next.from}->${next.to}`] || null) : null;

      // 闸门证据判定：只认可观察字段，不做 AI 推断（缺证据即判未满足，保证不假绿）
      const hasAttach = (tag) => {
        const atts = Array.isArray(p.attachments) ? p.attachments : [];
        return atts.some((a) => (typeof a === 'string' ? a === tag : a?.tag === tag)) || Boolean(p[tag]);
      };
      const GATE_EVIDENCE = {
        need_facts: () => Boolean(p.needs?.product || p.needs?.qty
          || (Array.isArray(p.pain_points) ? p.pain_points.length : p.pain_points)),
        visit_value: () => Boolean(typeof p.ai?.sales_visit_value === 'object'
          ? p.ai.sales_visit_value.value : p.ai?.sales_visit_value),
        bantcc_quote: () => bantcc >= bantccPass
          && Boolean(p.quotation_id || p.quote_amount || p.expected_amount),
        review_contract: () => Boolean(p.contract_no || p.contract_id),
        contract_paid: () => Boolean(Number(p.paid_amount) > 0 || p.paid === true),
        // S0P→S1 升级正式线索：与 executor STAGE_GATES 同判据（共享 leadQualifyGap，单一事实源）
        bantcc_lead: () => leadQualifyGap(p, {
          pass: bantccPass,
          unknown: readThreshold(thresholds, 'bantcc.unknown'),
        }) === null,
      };
      const missing = [];
      if (gateDef) {
        const fn = GATE_EVIDENCE[gateDef.key];
        if (!fn || !fn()) missing.push({ key: gateDef.key, hard: gateDef.hard, reason: '闸门条件未满足（缺可观察证据）' });
      }
      if (attachGate && !hasAttach(attachGate.tag)) {
        missing.push({ key: attachGate.tag, hard: true, reason: `缺强制附件：${attachGate.label}` });
      }

      return {
        ok: true, deal_id: deal.id, stage, stageLabel: S_LABEL[stage] || stage,
        rawStage: p.stage ?? null,
        nextStage: next?.to ?? null, nextStageLabel: next ? (S_LABEL[next.to] || next.to) : null,
        canAdvance: Boolean(next) && missing.length === 0,
        gate: gateDef?.key ?? null, missing,
        bantcc: Number(bantcc.toFixed(3)), bantccPass,
      };
    },
  });

  // crm-funnel-classify：大漏斗分类（MANT 四要素 → 四象限分区 + 预测分类 + 加权金额）
  registerAction({
    name: 'crm-funnel-classify', kind: 'read', permission: 'auth', requiresEntitlement: ['advanced_reporting'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', limit: 'number' },
    parameters: { properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' }, limit: { type: 'number' } } },
    handler: async ({ deal_id, limit = 20 }, ctx) => {
      const tid = ctx.tenantId || 'system';
      const thresholds = mergedThresholds(
        (await readConfig('sales-thresholds', { tenantId: tid }).catch(() => null))?.value || {});
      const cap = Math.max(1, Math.min(100, Number(limit) || 20));
      const rows = await query(
        `SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1
         ${deal_id ? 'AND id=$2' : ''} ORDER BY created_at DESC LIMIT ${cap}`,
        deal_id ? [tid, deal_id] : [tid]
      ).catch((e) => { recordFailure('crm-deal-lookup-failed', e); return { rows: [] }; });
      const deals = (rows.rows || []).map((r) => ({ id: r.id, payload: r.payload || {} }));
      if (!deals.length) return { ok: false, reason: '无可用商机' };

      const items = deals.map((d) => {
        const mant = mantOk(d.payload?.funnel || {});
        return {
          deal_id: d.id, name: d.payload?.name || null,
          zone: funnelZone(d), forecastClass: forecastClass(d),
          mantOk: mant.ok, mantMissing: mant.missing,
          amount: Number(d.payload?.expected_amount || d.payload?.amount || 0),
          weightedAmount: weightedAmount(d, thresholds),
        };
      });
      const byZone = items.reduce((acc, it) => { acc[it.zone] = (acc[it.zone] || 0) + 1; return acc; }, {});
      return {
        ok: true, count: items.length, byZone, items,
        weightedTotal: items.reduce((s, it) => s + it.weightedAmount, 0),
        cadenceHint: deriveRhythmDays({}, thresholds), // 拜访节奏建议（配置驱动，非 AI 推断）
      };
    },
  });

  // crm-behavior-check：销售行为合格线（21 条 BH-01~07 有/无判定 + 缺口清单）
  registerAction({
    name: 'crm-behavior-check', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { account_id: 'string' },
    parameters: { properties: { account_id: { type: 'string', candidateSource: 'CRM_ACCOUNT' } } },
    handler: async ({ account_id }, ctx) => {
      const tid = ctx.tenantId || 'system';
      let account = account_id ? await getParticle(account_id) : null;
      if (!account) {
        const rows = await query(
          `SELECT id, payload FROM crm.particles WHERE type='CRM_ACCOUNT' AND tenant_id=$1
           ORDER BY created_at DESC LIMIT 1`, [tid]
        ).catch((e) => { recordFailure('crm-account-lookup-failed', e); return { rows: [] }; });
        account = rows.rows?.[0] ? { id: rows.rows[0].id, payload: rows.rows[0].payload } : null;
      }
      if (!account) return { ok: false, reason: '无可用客户' };
      // 商机/联系人按 payload.account_id 关联（与 /api/board/named-accounts 同源口径）
      const [dealRows, contactRows] = await Promise.all([
        query(
          `SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1
             AND payload->>'account_id'=$2 ORDER BY created_at DESC LIMIT 50`, [tid, account.id])
          .catch((e) => { recordFailure('crm-deal-lookup-failed', e); return { rows: [] }; }),
        query(
          `SELECT id, payload FROM crm.particles WHERE type='CRM_CONTACT' AND tenant_id=$1
             AND payload->>'account_id'=$2 ORDER BY created_at DESC LIMIT 50`, [tid, account.id])
          .catch((e) => { recordFailure('crm-contact-lookup-failed', e); return { rows: [] }; }),
      ]);
      const deals = (dealRows.rows || []).map((r) => ({ id: r.id, payload: r.payload || {} }));
      const contacts = (contactRows.rows || []).map((r) => ({ id: r.id, payload: r.payload || {} }));
      const thresholds = mergedThresholds(
        (await readConfig('sales-thresholds', { tenantId: tid }).catch(() => null))?.value || {});
      const targetsCfg = mergedTargets(
        (await readConfig('named-account-targets', { tenantId: tid }).catch(() => null))?.value || {});
      const r = evaluateBehaviorChecklist(account.payload || {}, deals, contacts, thresholds, targetsCfg);
      return {
        ok: true, account_id: account.id, pass: r.pass, total: r.total,
        gaps: r.gaps, items: r.items, dealCount: deals.length, contactCount: contacts.length,
      };
    },
  });

  // 决策图查询（P8 · REST + MCP 只读查询面 /api/graph/* 的 MCP 形态）
  // 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P8
  // 安全纪律（沿用 crm-native 总则）：① 只读，绝不写图；② 绝对禁删；③ RBAC 数据范围过滤（rbac_roles 不含 sales → 第1.5闸拒绝越权）；
  //   ④ 返回受限范围（节点仅含 decision_id/state/disposition，不暴露内部 Action/agent 名）。
  // 注：graph_query 走 crm_graph_query（REST /api/graph/* 同源，单一事实源）；sales 角色默认无权读决策网（仅看商机/账户级数据）。
  registerAction({
    name: 'crm_graph_query', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'decision', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    rbac_roles: ['manager', 'presales', 'exec', 'finance'],
    schema: { query_type: 'string', decision_id: 'string', entity_id: 'string', max_depth: 'number' },
    handler: async ({ query_type = 'trace', decision_id, entity_id, max_depth = 4 }, ctx) => {
      const depth = Math.max(1, Math.min(6, Number(max_depth) || 4));
      const { query } = await import('../db.js');
      if (query_type === 'neighbors') {
        if (!entity_id) return { ok: false, error: 'neighbors 需要 entity_id' };
        const [{ rows: edges }] = await Promise.all([
          query(
            `SELECT edge_type, source_id, source_type, target_id, target_type, meta
             FROM crm.edges WHERE tenant_id=$1 AND (source_id=$2 OR target_id=$2) LIMIT 100`,
            ['system', entity_id]),
        ]);
        const otherIds = [...new Set(edges.map((e) => (e.source_id === entity_id ? e.target_id : e.source_id)))];
        const neighbors = otherIds.length
          ? (await query(
              `SELECT id, type, title, state, payload FROM crm.particles WHERE tenant_id=$1 AND id = ANY($2::uuid[]) LIMIT 100`,
              ['system', otherIds])).rows
          : [];
        return { ok: true, query_type, entity_id, edges, neighbors };
      }
      if (!decision_id) return { ok: false, error: 'decision_id required' };
      if (query_type === 'trace') {
        const { traceUpstream, traceDownstream } = await import('../decision/ageGraph.js');
        const { listTypedEdges } = await import('../decision/relation.js');
        const upstream = await traceUpstream(decision_id, { maxDepth: depth });
        const downstream = await traceDownstream(decision_id, { maxDepth: depth });
        const typedEdges = await listTypedEdges(decision_id, { direction: 'both' }).catch(() => []);
        return { ok: true, query_type, decision_id, upstream, downstream, typedEdges };
      }
      if (query_type === 'impact') {
        const { impactMap } = await import('../decision/ageGraph.js');
        return { ok: true, query_type, ...(await impactMap(decision_id, { maxDepth: depth })) };
      }
      if (query_type === 'provenance') {
        const { exportAudit } = await import('../decision/provenance.js');
        return { ok: true, query_type, decision_id, ...(await exportAudit({ decision_id })) };
      }
      return { ok: false, error: `未知 query_type: ${query_type}` };
    },
  });
  registerAction({
    name: 'data-particle-update', kind: 'write', permission: 'auth',
    namespace: 'data', agentTool: true, force: true, needsApproval: false,
    version: '1.1.0', owner: 'crm-native',
    schema: { type: 'string', id: 'string', patch: 'object' },
    parameters: { required: ['id', 'patch'] },
    // 2026-09-09 MCP 事实变更通道（用户拍板方案 A，与 data-particle-create 同构 opt-in）：
    //   · mcpExpose：解除 tools.js:89 对 data-* 写族的默认屏蔽（此前对外智能体无粒子更新通道，
    //     事实变更只能绕本地脚本）。
    //   · decisionScenario：gateway 代为 mint 第 0 闸决策（gateway.js:138）；requireDecision
    //     强校验场景存在（autonomyEngine.js:124），故 db/seed.sql 必须同步播种 PARTICLE_UPDATE。
    //   · tenantId 透传：修复前未传 → particleRepo.js:190 的 F1 跨租户防御「不传即不校验」，
    //     MCP 开放后凭任意 id 可跨租户写。此处显式传 ctx.tenantId 关闭该洞。
    //   设计：docs/2026-09-09-mcp-particle-update-expose-design.md
    mcpExpose: true,
    decisionScenario: 'PARTICLE_UPDATE',
    // state 透传（2026-08-28 业务主数据）：软停用 = state 流转（禁删铁律），非 payload 字段变更；
    // 不传 state 时行为与原先完全一致（updateParticle 默认 state: undefined 不改状态列）
    handler: async ({ type, id, patch, state }, ctx) =>
      updateParticle(id, { patch, state, requireDecisionId: ctx.decision_id, tenantId: ctx.tenantId }),
  });
  registerAction({
    name: 'data-particle-edge-create', kind: 'write', permission: 'auth',
    namespace: 'data', agentTool: false, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { source_type: 'string', source_id: 'string', edge_type: 'string', target_type: 'string', target_id: 'string' },
    handler: async (p, ctx) => createEdge(p.source_type, p.source_id, p.edge_type, p.target_type, p.target_id, p.meta || {}, ctx.tenantId),
  });

  // —— 非结构化证据挂接（2026-08-31 上传/挂接两步管道）——
  // 设计：docs/2026-08-31-unstructured-asset-attach-design.md §4.2
  // 语义：业务写（第0闸 decision_id + 1.5闸 RBAC + 两阶段 confirm 由 gateway 负责）；
  //       本 handler 只做业务校验（目标白名单 / 资产存在性 / 状态）与 evidenced_by 边落库。
  // 注意：namespace=crm 且非 data- 前缀 → tools.js:65 写循环自动纳入 MCP 暴露，无需改 tools.js。
  registerAction({
    name: 'crm-asset-attach', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, confirm: 'normal', autoDecision: false,
    version: '1.0.0', owner: 'crm-native',
    description: '非结构化证据挂接：把已上传的资产粒子经 evidenced_by 边挂到业务粒子（合同/商机/客户等）',
    schema: { asset_id: 'string', target_type: 'string', target_id: 'string', evidence_ref: 'string' },
    parameters: { required: ['asset_id', 'target_type', 'target_id'] },
    handler: async ({ asset_id, target_type, target_id, evidence_ref }, ctx) => {
      // 受控谓词语义域（对齐设计 §4 evidenced_by）：只允许业务主实体挂证据
      // 业务拒绝一律 throw（crm-* 惯例）：dispatch 捕获为 {ok:false,error}，
      // 避免被包成 {ok:true,data:{ok:false}} 让调用方误判成功（executor.js:156 恒包 ok:true）
      const ASSET_TARGETS = ['CRM_DEAL', 'CRM_ACCOUNT', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_INVOICE'];
      if (!ASSET_TARGETS.includes(target_type)) {
        throw new Error(`白名单外目标类型: ${target_type}（允许 ${ASSET_TARGETS.join('/')}）`);
      }
      const asset = await getParticle(asset_id);
      if (!asset || asset.type !== 'CRM_UNSTRUCTURED_ASSET') throw new Error(`资产不存在或非证据粒子: ${asset_id}`);
      if (asset.state !== 'uploaded') throw new Error(`资产状态非 uploaded: ${asset.state}`);
      const target = await getParticle(target_id);
      if (!target || target.type !== target_type) throw new Error(`目标粒子不存在或类型不符: ${target_id}`);

      const meta = {
        edge_source: 'manual',
        evidence_ref: evidence_ref || null,
        sha256: asset.payload?.sha256 || null,
        decision_id: ctx.decision_id || null, // 第0闸留痕（可溯源：这条边由哪个决策授权）
        attached_by: ctx.actor || null,
        attached_at: new Date().toISOString(),
      };
      try {
        // createEdge 对未受控谓词抛错（受控表见 particleModel.js CONTROLLED_PREDICATES）
        await createEdge(target_type, target_id, 'evidenced_by', 'CRM_UNSTRUCTURED_ASSET', asset_id, meta, ctx.tenantId || 'system');
      } catch (e) {
        throw new Error(`挂接失败: ${e.message}`);
      }
      emit('particle', 'asset-attached', { asset_id, target_type, target_id, by: ctx.actor, decision_id: ctx.decision_id });
      const targetName = target.payload?.name || target.title || target_type;
      return {
        ok: true,
        // 输出纪律：业务语言摘要（不含内部 id 堆砌；sha256 仅回显前 8 位供人工核对）
        summary: `已将「${asset.payload?.file_name || asset_id}」挂接到${targetName}`,
        asset_id, target_type, target_id,
        file_name: asset.payload?.file_name || null,
        sha256: meta.sha256 ? meta.sha256.slice(0, 8) : null,
        decision_id: ctx.decision_id || null,
      };
    },
  });

  // —— 粒子属性元模型（设计 2026-08-26 §5.2）——
  registerAction({
    name: 'data-particle-attr-read', kind: 'read', permission: 'auth',
    namespace: 'data', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { particle_type: 'string', enabled: 'boolean', semantic_tag: 'string' },
    handler: async ({ particle_type, enabled, semantic_tag }, ctx) =>
      listMetaAttr({ particleType: particle_type || null, enabled: enabled === undefined ? undefined : enabled, semanticTag: semantic_tag || null }),
  });
  registerAction({
    name: 'data-particle-attr-update', kind: 'write', permission: 'auth',
    namespace: 'data', agentTool: true, confirm: 'critical', needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { particle_type: 'string', attr_slug: 'string', patch: 'object' },
    parameters: { required: ['particle_type', 'attr_slug', 'patch'] },
    handler: async ({ particle_type, attr_slug, patch }, ctx) =>
      setMetaAttr(particle_type, attr_slug, patch, { actor: ctx.actor }),
  });
  registerAction({
    name: 'crm-field-permission', kind: 'read', permission: 'auth', requiresEntitlement: ['rbac_advanced'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { particle_type: 'string', role_tag: 'string' },
    handler: async ({ particle_type, role_tag }, ctx) => {
      // 字段级 RBAC 读侧：返回该角色对每个 enabled 属性的 mode
      const rows = await listMetaAttr({ particleType: particle_type, enabled: true });
      return rows.map((r) => ({ attr_slug: r.attr_slug, mode: (r.permission?.roles || {})[role_tag] || 'editable' }));
    },
  });

  // 跨粒子能力 Action（领域级，非粒子 CRUD）；autoDecision：自身经自主引擎 mint decision 满足第 0 闸
  registerAction({
    name: 'crm-deal-advance', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, deferDecisionMint: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', to_stage: 'string', transitionedBecause: 'string' },
    parameters: {
      required: ['deal_id', 'to_stage', 'transitionedBecause'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, to_stage, transitionedBecause }, ctx) => {
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const gate = await ruleEngine.check('CRM_DEAL', 'advance',
        { from: deal.payload.stage, to: to_stage }, { closed_reason: deal.payload.closed_reason });
      if (!gate.ok) throw new Error(`规则闸拒绝: ${gate.reasons.join(', ')}`);

      // 写通道第 0 闸：携带 decision_id 或经自主引擎 mint（无决策不写）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const scenario_id = STAGE_SCENARIO[to_stage] || 'OPP_QUALIFY';
        const res = await requireDecision(
          scenario_id,
          { customer: deal.payload.customer_tier, project: deal.payload.project_tier, stage: to_stage, deal_id },
          [{ type: 'DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: to_stage === 'lost' ? 'REJECT' : 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'deal-advance', { deal_id, to_stage, decision_id, mode: res.mode });
      }
      const updated = await advanceStage(deal_id, to_stage, { transitionedBecause, owner: ctx.actor });
      // S0P→S1 升级为「正式线索」：落状态载体 qualified_at / qualified_by（设计 §3.5.2 / §2.3）
      // advanceStage 只写 stage（lifecycle.js:6 契约），状态字段须在 handler 内手工补写并随 updateParticle 落库。
      if (toStageCode(deal.payload.stage) === 'S0P' && toStageCode(to_stage) === 'S1') {
        updated.payload = {
          ...updated.payload,
          qualified_at: new Date().toISOString(),
          qualified_by: ctx.actor,
        };
      }
      // 决策沉淀到商机（decided_on 边：DEAL → DECISION 由 decision.involved_entities 承载）
      // 2026-09-02 修复：last_decision_id 必须真正写回粒子 payload（此前只改内存对象，
      //   推进后 DB 中 last_decision_id 恒为 null → 决策与商机断链，审计无法从商机追溯决策）。
      updated.payload = { ...updated.payload, last_decision_id: decision_id };
      await updateParticle(deal_id, { patch: { ...updated.payload }, requireDecisionId: decision_id, tenantId: ctx.tenantId });
      // T7 R1 商机推进审批（S2→S3）：非阻断——G-S3 阶段门禁已在 salesStageGate 硬拦，
      //   此处并行起 R1 审批实例（销售经理签核留痕，档位链恒为 ['manager']），不阻塞阶段推进。
      if (deal.payload.stage === 'S2' && to_stage === 'S3') {
        try {
          const inst = await startGradedApproval({ entityType: 'CRM_DEAL', entityId: deal_id, ruleId: 'R1', submitter: ctx.actor, tenantId: ctx.tenantId });
          if (inst) emit('approval', 'deal-advance-submitted', { instance_id: inst.id, deal_id, status: inst.payload.status, tier: inst.payload.tier_approvers });
        } catch { /* 审批接线失败不阻断阶段推进 */ }
      }
      return { ...updated, decision_id };
    },
  });

  // 商机重开（输入态 S7/S8→S2，保留粒子身份，决策锚定 DEAL_REOPEN）
  // 设计：docs/specs/2026-09-03-deal-reopen-stop-loss-mirror-design.md Task 1
  // 范式同 crm-deal-advance：action 自身 mint 决策满足写通道第 0 闸；不动 advanceStage 只进不退。
  // 不加入 WRITE_WHITELIST（whitelist.js 维持原样）→ 默认 human_gate，重开需显式 HITL 确认（零信任）。
  registerAction({
    name: 'crm-deal-reopen', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, deferDecisionMint: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', reason: 'string' },
    parameters: {
      required: ['deal_id', 'reason'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, reason }, ctx) => {
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 写通道第 0 闸：经自主引擎 mint DEAL_REOPEN 决策（自带 re-armed stop_loss）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const res = await requireDecision(
          'DEAL_REOPEN',
          // stage = 重开目标阶段（T7 改：S2 → S0P，重开须重走 BANT；随 reopenDeal 目标同步）
          { stage: 'S0P', deal_id, reopen_from: deal.payload.stage },
          [{ type: 'DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'deal-reopen', { deal_id, decision_id, mode: res.mode });
      }
      const updated = await reopenDeal(deal_id, { reason, owner: ctx.actor, decision_id, tenantId: ctx.tenantId });
      return { ...updated, decision_id };
    },
  });
  // —— SWAS 商机回顾（P1-A：设计 §4）：写 CRM_DEAL.payload.swas（JSONB，不新增表，避免 CRUD 爆炸）——
  // 写经决策第 0 闸：def 不声明 autoDecision → 必须显式携带 decision_id（无决策不写）；
  //   confirm:'normal'（常规写确认）；非 scoped / 非 needsApproval / 非 rbac_roles → 仅过第0闸与范围闸。
  registerAction({
    name: 'crm-deal-swas-update', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', swas: 'object', reviewed_at: 'string', reviewed_by: 'string' },
    parameters: { required: ['deal_id', 'swas'] },
    handler: async ({ deal_id, swas, reviewed_at, reviewed_by }, ctx) => {
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const prev = deal.payload.swas || {};
      const nextSwas = {
        ...prev,
        ...swas,
        reviewed_at: reviewed_at || new Date().toISOString(),
        reviewed_by: reviewed_by || ctx.actor,
      };
      const updated = await updateParticle(deal_id, {
        patch: { ...deal.payload, swas: nextSwas },
        requireDecisionId: ctx.decision_id, tenantId: ctx.tenantId,
      });
      emit('crm', 'swas-updated', { deal_id, reviewed_by: nextSwas.reviewed_by, decision_id: ctx.decision_id });
      return { ...updated, deal_id, swas: nextSwas };
    },
  });
  // —— 线索池（B6：池 = 粒子集合视图 + 组织治理配置；线索 = DEAL lead 阶段）——
  // crm-lead-pick：领取（校验池规则：每日限额/间隔/新数据/前归属；受控 Action，写通道第 0 闸 autoDecision）
  registerAction({
    name: 'crm-lead-pick', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', owner_id: 'string', pool_id: 'string' },
    parameters: {
      required: ['deal_id', 'owner_id'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' }, pool_id: { type: 'string', candidateSource: 'pool' } },
    },
    handler: async ({ deal_id, owner_id, pool_id }, ctx) => {
      const { query } = await import('../db.js');
      const { readPoolConfig, poolOf, resolvePoolId, checkPickRule } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 仅公海(S0)可领；已认领(S0P/S1+)拒领（杜绝重复归属）
      if (toStageCode(deal.payload.stage) !== 'S0') {
        throw new Error(`非公海阶段: ${deal.payload.stage}（仅 S0 公海可领取）`);
      }
      if (deal.payload.owner_id) throw new Error('该线索已有归属，不可重复领取');
      // 池配置（三类池 per-tenant；禁 'org-hq' 硬编码）
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const pool = poolOf(cfg, resolvePoolId(cfg, { pool_id }));
      const prev_owner = deal.payload.prev_owner_id || null;
      // 当日领取计数 + 最近一次领取时间
      //   P1：补 tenant 谓词（禁跨租户计数串扰）
      //   D1（2026-09-11 派发前复查）：原 `count(*)` 无日期条件 → today_picked_count 实为
      //     「该 owner 在库 S0P 总量」，daily_limit 退化为总量上限（累计持有 N 条即锁死当日份额；
      //     线索被回收后计数腾空 → 可无限刷单绕过日限）。且 max(updated_at) 会被任意跟进刷新
      //     → pick_interval_hours 间隔判定失真。改为「当日 FILTER + picked_at」条件聚合。
      const agg = await query(
        `SELECT
           count(*) FILTER (WHERE NULLIF(payload->>'picked_at','')::timestamptz >= date_trunc('day', now()))::int AS n,
           max(NULLIF(payload->>'picked_at','')::timestamptz) AS last_pick
         FROM crm.particles
         WHERE type='CRM_DEAL' AND tenant_id=$2 AND payload->>'stage'='S0P' AND payload->>'owner_id'=$1`,
        [owner_id, tenantId]
      ).catch((e) => { recordFailure('crm-lead-pick-agg-failed', e); return { rows: [{ n: 0, last_pick: null }] }; });
      const check = checkPickRule(pool.pick_rule, {
        owner: owner_id, prev_owner,
        today_picked_count: agg.rows[0].n,
        last_picked_at: agg.rows[0].last_pick,
        follow_up_at: deal.payload.last_follow_up_at,
        is_new: !!deal.payload.is_new,
      });
      if (!check.ok) throw new Error(`池领取规则拒绝: ${check.errors.join('; ')}`);
      // 写通道第 0 闸（autoDecision：自身经自主引擎 mint decision）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LEAD_FOLLOW_UP',
          { action: 'lead-pick', deal_id, owner_id, pool: pool.id },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'lead-pick', { deal_id, owner_id, decision_id, mode: res.mode });
      }
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0P',                       // 认领 = 进入私海待校验，不等于正式线索
          owner_id, prev_owner_id: prev_owner,
          picked_at: new Date().toISOString(),
          pool_id: pool.id, pool_type: pool.type || 'new',
        },
        requireDecisionId: decision_id, tenantId,
        // T3 CAS：仅当仍处 S0 且无人认领时方可认领，消除并发竞态（已被领/已升阶则拒绝）
        casExpectStage: 'S0', casExpectOwnerEmpty: true,
      });
      emit('crm', 'lead-picked', { deal_id, owner_id, pool_id: pool.id, tenant_id: tenantId });
      return { ...updated, decision_id };
    },
  });
  // crm-lead-recycle：回收（超期未跟进自动触发；事件驱动——scheduler 扫描 → 预警事件 → 回收）
  registerAction({
    name: 'crm-lead-recycle', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', reason: 'string' },
    parameters: {
      required: ['deal_id'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, reason }, ctx) => {
      const { readPoolConfig, poolOf, resolvePoolId, checkRecycleRule } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 回收对象 = 已认领的私海待校验线索（S0P）；公海 S0 无人跟进，不参与超期回收
      if (toStageCode(deal.payload.stage) !== 'S0P') {
        throw new Error(`非私海待校验阶段: ${deal.payload.stage}（仅 S0P 可回收）`);
      }
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const curPool = poolOf(cfg, resolvePoolId(cfg, { pool_id: deal.payload.pool_id, pool_type: deal.payload.pool_type }));
      const check = checkRecycleRule(curPool.recycle_rule, { last_follow_up_at: deal.payload.last_follow_up_at });
      if (!check.ok) throw new Error(`未达回收条件: ${check.reason}`);
      // 写通道第 0 闸（autoDecision）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LEAD_FOLLOW_UP',
          { action: 'lead-recycle', deal_id, reason: reason || check.reason },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'lead-recycle', { deal_id, decision_id, mode: res.mode });
      }
      // 回收：解除归属（owner 置空 = 回公海）+ 事件总线可审计
      const targetId = (!curPool.recycle_rule.recycle_target || curPool.recycle_rule.recycle_target === 'self')
        ? curPool.id : curPool.recycle_rule.recycle_target;
      const tgtPool = poolOf(cfg, targetId);
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0',                        // 回到公海
          owner_id: null, prev_owner_id: deal.payload.owner_id || null,
          pool_id: tgtPool.id, pool_type: tgtPool.type || curPool.type,
          recycled_at: new Date().toISOString(),
          recycle_reason: reason || check.reason,
          pooled_at: new Date().toISOString(),   // T4：回公海重置入池时间（in_pool_days 改用 pooled_at）
        },
        requireDecisionId: decision_id,
        tenantId,                             // P0 修复：此前未传 → 回收写操作无租户谓词
      });
      emit('crm', 'lead-recycled', { deal_id, reason: reason || check.reason, decision_id, tenant_id: tenantId });
      return { ...updated, decision_id };
    },
  });
  // crm-lead-return：销售手动退回公海（场景②：核实无立项/无预算，不能转正式商机）
  // 关键：不调用 checkRecycleRule —— 退回是「质量」判据（客户没立项），不是「时间」判据。
  //   原 crm-lead-recycle 硬校验超期 → 未超期即 throw，销售退回被引擎拒（本 Action 存在的根因）。
  registerAction({
    name: 'crm-lead-return', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true, deferDecisionMint: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', reason_code: 'string', note: 'string' },
    parameters: {
      required: ['deal_id', 'reason_code'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, reason_code, note }, ctx) => {
      const RETURN_REASONS = new Set(['no_project', 'no_budget', 'no_decision_maker', 'no_timeline', 'other']);
      if (!RETURN_REASONS.has(reason_code)) {
        throw new Error(`非法 reason_code: ${reason_code}（须为 ${[...RETURN_REASONS].join('/')}）`);
      }
      const { readPoolConfig, poolOf, resolvePoolId } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const stage = toStageCode(deal.payload.stage);
      if (stage !== 'S0P' && stage !== 'S1') throw new Error(`非可退回阶段: ${deal.payload.stage}（仅 S0P/S1）`);
      if (!deal.payload.owner_id) throw new Error('无归属线索无需退回（已在公海）');
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const curPool = poolOf(cfg, resolvePoolId(cfg, { pool_id: deal.payload.pool_id, pool_type: deal.payload.pool_type }));
      const targetId = curPool?.return_target || 'pool-nurture';   // 默认进培育池，不回新线索池
      const tgtPool = poolOf(cfg, targetId);

      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LEAD_FOLLOW_UP',
          { action: 'lead-return', deal_id, reason_code, from_stage: stage },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'lead-return', { deal_id, decision_id, mode: res.mode });
      }
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0', owner_id: null,
          prev_owner_id: deal.payload.owner_id,
          pool_id: tgtPool?.id || targetId,
          pool_type: tgtPool?.type || 'nurture',
          returned_at: new Date().toISOString(),
          return_reason: reason_code,
          return_note: note || null,
          pooled_at: new Date().toISOString(),   // T4：退回公海重置入池时间
          qualified_at: null, qualified_by: null,   // 退回即取消「正式线索」资格
          mant_ok_at_return: mantOk(deal.payload.funnel || {}).ok,  // 审计留痕，不作拒绝判据
        },
        requireDecisionId: decision_id, tenantId,
      });
      emit('crm', 'lead-returned', { deal_id, reason_code, decision_id, tenant_id: tenantId });
      return { ...updated, decision_id };
    },
  });
  // crm-deal-archive-to-pool：战败归档进战败公海（场景③）
  // 语义：归档后 stage=S0（统一公海语义）+ pool_type=lost，同时写 last_terminal_stage 保留输单/丢单事实，
  //       避免「归档即丢失战败信息」；再激活由 crm-deal-reopen 从 S0(lost) → S0P 重走 BANT。
  registerAction({
    name: 'crm-deal-archive-to-pool', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, deferDecisionMint: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', reason: 'string' },
    parameters: {
      required: ['deal_id'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, reason }, ctx) => {
      const { readPoolConfig } = await import('../sales/pool.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const cur = toStageCode(deal.payload.stage);
      if (cur !== 'S7' && cur !== 'S8') throw new Error(`仅终态(S7/S8)可归档，当前=${deal.payload.stage}`);
      const tenantId = ctx.tenantId || 'system';
      const cfg = await readPoolConfig({ tenantId });
      const lost = cfg.pools.find((p) => p.type === 'lost') || { id: 'pool-lost', type: 'lost' };

      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LOSS_REVIEW',
          { action: 'deal-archive-to-pool', deal_id, from_stage: cur },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'REJECT' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'deal-archive', { deal_id, decision_id, mode: res.mode });
      }
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload,
          stage: 'S0', pool_id: lost.id, pool_type: 'lost',
          owner_id: null, prev_owner_id: deal.payload.owner_id || null,
          prev_pool_id: deal.payload.pool_id || null,       // 供重开时恢复
          prev_pool_type: deal.payload.pool_type || null,
          last_terminal_stage: cur,                          // 保留 S7/S8 事实，不因归档丢失
          archived_at: new Date().toISOString(),
          archive_reason: reason || null,
          pooled_at: new Date().toISOString(),   // T4：归档进战败公海亦重置入池时间
        },
        requireDecisionId: decision_id, tenantId,
      });
      emit('crm', 'deal-archived-to-pool', { deal_id, last_terminal_stage: cur, decision_id, tenant_id: tenantId });
      return { ...updated, decision_id };
    },
  });
  // crm-lead-reclaim-bulk：离职批量回收（场景④）
  // 语义：限定真实租户（禁 system 通配，避免一次误操作扫全库）；
  //   非终态(S0P/S1-S6) 归还原 pool_type 对应池并置 S0 公海；
  //   终态(S7/S8) 只解除归属并归 lost，不动阶段（避免把已关闭商机重新推回公海污染漏斗）。
  registerAction({
    name: 'crm-lead-reclaim-bulk', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, deferDecisionMint: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { user_id: 'string', reason: 'string' },
    parameters: { required: ['user_id'], properties: {} },
    handler: async ({ user_id, reason }, ctx) => {
      const { query } = await import('../db.js');
      const tenantId = ctx.tenantId || 'system';
      if (!tenantId || tenantId === 'system') throw new Error('离职回收必须限定真实租户（禁 system 通配）');
      const { readPoolConfig, resolvePoolId } = await import('../sales/pool.js');
      const cfg = await readPoolConfig({ tenantId });
      const lost = cfg.pools.find((p) => p.type === 'lost') || { id: 'pool-lost', type: 'lost' };
      const rows = await query(
        `SELECT id, payload FROM crm.particles
         WHERE type='CRM_DEAL' AND tenant_id=$1 AND payload->>'owner_id'=$2`,
        [tenantId, user_id]
      ).catch((e) => { recordFailure('crm-lead-reclaim-query-failed', e); return { rows: [] }; });

      const targets = (rows.rows || []).filter((r) => {
        const s = toStageCode(r.payload?.stage);
        return ['S0P', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8'].includes(s);
      });

      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LEAD_FOLLOW_UP',
          { action: 'lead-reclaim-bulk', user_id, tenantId, count: targets.length },
          [{ type: 'CRM_PERSON', id: user_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'lead-reclaim-bulk', { user_id, tenantId, decision_id, mode: res.mode });
      }

      let count = 0;
      const failed = [];
      for (const r of targets) {
        const cur = toStageCode(r.payload.stage);
        const terminal = cur === 'S7' || cur === 'S8';
        const poolType = terminal ? 'lost' : (r.payload.pool_type || 'new');
        const pid = terminal ? lost.id : resolvePoolId(cfg, { pool_type: poolType });
        try {
          await updateParticle(r.id, {
            patch: {
              ...r.payload,
              ...(terminal ? {} : { stage: 'S0' }),
              owner_id: null, prev_owner_id: user_id,
              pool_id: pid, pool_type: poolType,
              reclaimed_at: new Date().toISOString(),
              reclaim_reason: reason || 'offboard',
              pooled_at: new Date().toISOString(),   // T4：离职回收重置入池时间
            },
            requireDecisionId: decision_id, tenantId,
          });
          count += 1;
        } catch (e) {
          failed.push({ id: r.id, error: String(e?.message || e) });
        }
      }
      emit('crm', 'lead-reclaimed-bulk', { user_id, tenant_id: tenantId, count, failed: failed.length, decision_id }); // T8 复查：事件键统一 tenant_id（同族 lead-returned / deal-archived-to-pool）
      return { ok: true, count, failed, decision_id };
    },
  });
  registerAction({
    name: 'crm-account-360', kind: 'read', permission: 'auth', requiresEntitlement: ['customer_360'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { account_id: 'string' },
    handler: async ({ account_id }, ctx) => {
      const acct = await getParticle(account_id);
      if (!acct) throw new Error(`ACCOUNT 不存在: ${account_id}`);
      const edges = await queryNeighbors('CRM_ACCOUNT', account_id, ctx.tenantId);
      return { account: acct, related: edges };
    },
  });

  // 售前：生成技术方案（CRM_TECHNICAL_PROPOSAL 粒子），挂到所属 DEAL（has_technical_proposal），写通道第 0 闸（autoDecision）
  // 命名对齐反 CRUD 爆炸铁律（§06 R2/R5）：能力 Action 用业务动词，非粒子 CRUD（create/read/update/delete 走 substrate）
  registerAction({
    name: 'crm-proposal-write', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', title: 'string', content: 'string', solution_type: 'string' },
    parameters: {
      required: ['deal_id', 'title', 'content'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, title, content, solution_type }, ctx) => {
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 写通道第 0 闸：携带 decision_id 或经自主引擎 mint（无决策不写）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const res = await requireDecision(
          'OPP_QUALIFY',
          { customer: deal.payload.customer_tier, project: deal.payload.project_tier, artifact: 'TECH_PROPOSAL', deal_id },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'tech-proposal-create', { deal_id, decision_id, mode: res.mode });
      }
      const proposal = await createParticle('CRM_TECHNICAL_PROPOSAL',
        { title, content, solution_type: solution_type || 'solution', owner_id: ctx.actor, deal_id },
        { tenantId: ctx.tenantId, requireDecisionId: decision_id });
      await createEdge('CRM_DEAL', deal_id, 'has_technical_proposal', 'CRM_TECHNICAL_PROPOSAL', proposal.id, {}, ctx.tenantId);
      return { ...proposal, decision_id };
    },
  });

  // —— 报价域（T3-5：写时金额计算 + 审批接线；QUOTATION 粒子 + crm-quote-create/submit）——
  // crm-quote-create：创建报价（自动取价 + 自动算金额 + 写后验证 sum=明细；第 0 闸 autoDecision）
  registerAction({
    name: 'crm-quote-create', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true,
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { name: 'string', deal_id: 'string', valid_until: 'string', items: 'object' },
    parameters: {
      required: ['name', 'deal_id', 'items'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ name, deal_id, valid_until, items }, ctx) => {
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // 写通道第 0 闸（autoDecision：自身经自主引擎 mint decision，无决策不写）
      //   —— 修复此前「声明 autoDecision 但 handler 未 mint」的假绿：报价写无 decision 锚定。
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const res = await requireDecision(
          'QUOTE_PRICING',
          { customer: deal.payload.customer_tier, project: deal.payload.project_tier, deal_id },
          [{ type: 'DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'quote-create', { deal_id, decision_id, mode: res.mode });
      }
      const { createQuote, loadTenantPriceData } = await import('../sales/quoteService.js');
      // 修复（2026-09-09）：按租户读取配置的产品单价 + 价目表，使报价真正取价（此前从不加载 → 单价缺失）
      const { priceLists, products } = await loadTenantPriceData(ctx.tenantId);
      const quote = await createQuote({ name, deal_id, valid_until, items, products, priceLists, tenantId: ctx.tenantId, decisionId: decision_id });
      emit('crm', 'quote-created', { quote_id: quote.id, deal_id, amount: quote.amount, decision_id });
      return { ...quote, decision_id };
    },
  });
  // crm-quote-submit：提交报价（写 → HITL 审批流；confirm:'critical' 对齐 G21 四大审批域之一）
  registerAction({
    name: 'crm-quote-submit', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'QUOTE_PRICING',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { quote_id: 'string', flow_id: 'string', ctx: 'object' },
    parameters: { required: ['quote_id'] },
    handler: async ({ quote_id, flow_id, ctx }, actionCtx) => {
      // T7 分级审批：按报价金额解析 T1/T2/T3 档位链 → 引擎按节点序位分发（实现「按金额生成节点数」）
      const inst = await startGradedApproval({ entityType: 'CRM_QUOTATION', entityId: quote_id, ruleId: 'R2', submitter: actionCtx.actor, extraCtx: ctx || {}, tenantId: actionCtx.tenantId })
        || (() => { throw new Error('未配置审批流（域 quote，须先 seed-approval-rules）'); })();
      emit('approval', 'quote-submitted', { instance_id: inst.id, quote_id, status: inst.payload.status, tier: inst.payload.tier_approvers });
      return inst;
    },
  });
  // crm-quote-activate：报价审批通过后生效（第三闸消费端，borrowings §T-2.3 审批后动作）
  // needsApproval:true → 无 ctx.approvalPassed 时 executor 第3闸拦截（approval_required）；
  // 审批流 approve 通过后的执行路径带 approvalPassed=true → 放行 activateQuote（draft→approved 单向，终态保护）
  registerAction({
    name: 'crm-quote-activate', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'QUOTE_PRICING',
    namespace: 'crm', agentTool: true, force: false, needsApproval: true,
    version: '1.0.0', owner: 'crm-native',
    schema: { quote_id: 'string' },
    parameters: { required: ['quote_id'], properties: { quote_id: { type: 'string', candidateSource: 'CRM_QUOTATION' } } },
    handler: async ({ quote_id }, ctx) => {
      const { activateQuote } = await import('../sales/quoteService.js');
      const q = await activateQuote(quote_id, { by: ctx.actor, tenantId: ctx.tenantId, decisionId: ctx.decision_id });
      emit('crm', 'quote-activated', { quote_id, approval_status: q.approval_status, activated_by: ctx.actor });
      return q;
    },
  });
  // crm-contract-create：创建合同（T3-6；01 文档 line13 铁律：合同属交易实体生命周期 → 挂 DEAL 的 has_contract 边）
  // 写时管线：contractService.validateContract（编号/周期/金额/写后验证 sum=明细）→ createParticle（hooks 自动建边/向量）
  registerAction({
    name: 'crm-contract-create', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true, decisionScenario: 'POST_CONTRACT',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { contract_no: 'string', deal_id: 'string', quotation_id: 'string', start_date: 'string', end_date: 'string', amount: 'number', line_items: 'array' },
    parameters: {
      required: ['contract_no', 'deal_id', 'amount'],
      properties: {
        contract_no: { type: 'string' },
        deal_id: { type: 'string', candidateSource: 'CRM_DEAL' },
        quotation_id: { type: 'string', candidateSource: 'CRM_QUOTATION' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        amount: { type: 'number' },
        line_items: { type: 'array' },
      },
    },
    handler: async ({ contract_no, deal_id, quotation_id, start_date, end_date, amount, line_items }, ctx) => {
      const { createContract } = await import('../sales/contractService.js');
      const contract = await createContract({ contract_no, deal_id, quotation_id, start_date, end_date, amount, line_items, tenantId: ctx.tenantId, decisionId: ctx.decision_id });
      // 闭合 S5→S6 第3.5闸证据桥：合同签署事实回写 DEAL（gate 读 contract_no+signed_at；
      // 方法论要求「contract_sign 事件 + CRM_CONTRACT 粒子」——粒子由 createContract 建，事件/事实在此补）
      const signedAt = (start_date && String(start_date).slice(0, 10)) || new Date().toISOString().slice(0, 10);
      await updateParticle(deal_id, {
        patch: { contract_no, signed_at: signedAt, has_contract: true },
        event: { type: 'contract_sign', contract_id: contract.id, contract_no, signed_at: signedAt },
        requireDecisionId: ctx.decision_id,
      }).catch(() => {});
      emit('decision', 'contract_sign', { contract_id: contract.id, deal_id, contract_no, signed_at: signedAt });
      emit('crm', 'contract-created', { contract_id: contract.id, deal_id, amount });
      return contract;
    },
  });
  // crm-review-gate-approve：评审把关（双闸门：报价复核+合同确认）通过后落库（闭合 S4→S5 第3.5闸证据桥）
  // 写经 autoDecision 第0闸；将结果写入 DEAL.payload.review_gate_decision='approved'（gate 主读路径）
  // 并追加 review_gate 事件 + emit decision 事件（方法论要求 REVIEW_GATE 留痕）
  registerAction({
    name: 'crm-review-gate-approve', kind: 'write', permission: 'auth', requiresEntitlement: ['approval_flow'], confirm: 'normal', autoDecision: true, decisionScenario: 'REVIEW_GATE',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { deal_id: 'string', findings: 'object', redline_basis: 'array' },
    parameters: {
      required: ['deal_id'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' } },
    },
    handler: async ({ deal_id, findings, redline_basis }, ctx) => {
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      // T8 红线溯源：若本次终审携带红线依据（来自 crm-decision-advise 的 approval_prefill），
      // 必须非空且与审批商机一致，否则拒绝终审——确保「红线决策的审批结论可溯源」。
      if (redline_basis != null) {
        if (!Array.isArray(redline_basis) || redline_basis.length === 0) {
          throw new Error('红线终审须携带非空红线依据摘要（红线决策的审批结论须可溯源）');
        }
        const mismatch = redline_basis.find((r) => r && r.deal_id && r.deal_id !== deal_id);
        if (mismatch) throw new Error(`红线依据与审批商机不一致（依据 deal_id=${mismatch.deal_id} ≠ 审批 ${deal_id}）`);
      }
      const updated = await updateParticle(deal_id, {
        patch: { review_gate_decision: 'approved', review_gate_findings: findings || null },
        event: { type: 'review_gate', disposition: 'approved', findings: findings || null },
        requireDecisionId: ctx.decision_id,
      });
      emit('decision', 'review_gate_passed', { deal_id, findings: findings || null });
      return { ...updated, review_gate_decision: 'approved' };
    },
  });
  // crm-contract-submit：提交合同（写 → HITL 审批流；confirm:'critical' —— 合同属 G21 四大审批域）
  registerAction({
    name: 'crm-contract-submit', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'POST_CONTRACT',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { contract_id: 'string', flow_id: 'string', ctx: 'object' },
    parameters: { required: ['contract_id'] },
    handler: async ({ contract_id, flow_id, ctx }, actionCtx) => {
      // T7 分级审批：按合同金额解析 T1/T2/T3 档位链 → 引擎按节点序位分发
      const inst = await startGradedApproval({ entityType: 'CRM_CONTRACT', entityId: contract_id, ruleId: 'R3', submitter: actionCtx.actor, extraCtx: ctx || {}, tenantId: actionCtx.tenantId })
        || (() => { throw new Error('未配置审批流（域 contract，须先 seed-approval-rules）'); })();
      emit('approval', 'contract-submitted', { instance_id: inst.id, contract_id, status: inst.payload.status, tier: inst.payload.tier_approvers });
      return inst;
    },
  });
  // crm-invoice-submit：提交发票（写 → HITL 审批流；G21 四大审批域收口 T3-8）
  // 语义对齐 quote/contract：发票开票 → 审批（大额开票需核准）→ 通过后才可核销（invoice-reconcile）
  registerAction({
    name: 'crm-invoice-submit', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'INVOICE_APPROVE',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { invoice_id: 'string', flow_id: 'string', ctx: 'object' },
    parameters: { required: ['invoice_id'] },
    handler: async ({ invoice_id, flow_id, ctx }, actionCtx) => {
      // T7 分级审批：按发票金额解析 T1/T2/T3 档位链 → 引擎按节点序位分发
      const inst = await startGradedApproval({ entityType: 'CRM_INVOICE', entityId: invoice_id, ruleId: 'R4', submitter: actionCtx.actor, extraCtx: ctx || {}, tenantId: actionCtx.tenantId })
        || (() => { throw new Error('未配置审批流（域 invoice，须先 seed-approval-rules）'); })();
      emit('approval', 'invoice-submitted', { instance_id: inst.id, invoice_id, status: inst.payload.status, tier: inst.payload.tier_approvers });
      return inst;
    },
  });
  // crm-order-submit：提交订单（写 → HITL 审批流；G21 四大审批域收口 T3-9）
  // 语义对齐 quote/contract：订单 draft → 审批（金额/条款核准）→ 通过后才可 advance（confirmed→shipped→completed）
  registerAction({
    name: 'crm-order-submit', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'ORDER_APPROVE',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { order_id: 'string', flow_id: 'string', ctx: 'object' },
    parameters: { required: ['order_id'] },
    handler: async ({ order_id, flow_id, ctx }, actionCtx) => {
      const { startInstance } = await import('../approval/engine.js');
      const { getFlowByDomainWithFallback } = await import('../approval/flow.js');
      const domain = BIZ_DOMAIN.CRM_ORDER;
      const fid = flow_id || (await getFlowByDomainWithFallback(domain, actionCtx.tenantId))?.id;
      if (!fid) throw new Error(`未配置审批流（域 ${domain}）`);
      const inst = await startInstance(fid, 'CRM_ORDER', order_id, ctx || {}, { submitter: actionCtx.actor, tenantId: actionCtx.tenantId });
      emit('approval', 'order-submitted', { instance_id: inst.id, order_id, status: inst.payload.status });
      return inst;
    },
  });
  // crm-payment-plan-create：创建回款计划（应回侧，T3-7；挂 contract_id → hooks 自动建 has_contract 边）
  registerAction({
    name: 'crm-payment-plan-create', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true, decisionScenario: 'POST_CONTRACT',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { contract_id: 'string', plan_seq: 'number', plan_amount: 'number', plan_end: 'string' },
    parameters: { required: ['contract_id', 'plan_seq', 'plan_amount', 'plan_end'] },
    handler: async ({ contract_id, plan_seq, plan_amount, plan_end }, ctx) => {
      const { createPaymentPlan } = await import('../sales/paymentService.js');
      const plan = await createPaymentPlan({ contract_id, plan_seq, plan_amount, plan_end, tenantId: ctx.tenantId, decisionId: ctx.decision_id });
      emit('crm', 'payment-plan-created', { plan_id: plan.id, contract_id, plan_amount });
      return plan;
    },
  });
  // crm-payment-record-create：登记回款（实回侧，T3-7；对账差额实时可算）
  registerAction({
    name: 'crm-payment-record-create', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true, decisionScenario: 'POST_CONTRACT',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { contract_id: 'string', paid_seq: 'number', paid_amount: 'number', paid_at: 'string', voucher: 'string' },
    parameters: { required: ['contract_id', 'paid_seq', 'paid_amount'] },
    handler: async ({ contract_id, paid_seq, paid_amount, paid_at, voucher }, ctx) => {
      const { createPaymentRecord } = await import('../sales/paymentService.js');
      const record = await createPaymentRecord({ contract_id, paid_seq, paid_amount, paid_at, voucher, tenantId: ctx.tenantId, decisionId: ctx.decision_id });
      emit('crm', 'payment-record-created', { record_id: record.id, contract_id, paid_amount });
      return record;
    },
  });
  // crm-invoice-create：创建发票（T3-8；挂 contract_id → hooks 自动建 has_contract 边；初始 reconcile_status=open）
  registerAction({
    name: 'crm-invoice-create', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true, decisionScenario: 'INVOICE_APPROVE',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { invoice_no: 'string', invoice_type: 'string', invoice_amount: 'number', invoice_date: 'string', contract_id: 'string', customer_id: 'string' },
    parameters: { required: ['invoice_no', 'invoice_type', 'invoice_amount', 'invoice_date', 'contract_id'] },
    handler: async ({ invoice_no, invoice_type, invoice_amount, invoice_date, contract_id, customer_id }, ctx) => {
      const { createInvoice } = await import('../sales/invoiceService.js');
      const invoice = await createInvoice({ invoice_no, invoice_type, invoice_amount, invoice_date, contract_id, customer_id, tenantId: ctx.tenantId, decisionId: ctx.decision_id });
      return invoice;
    },
  });
  // crm-invoice-reconcile：发票核销（T3-8；开票→回款→对账核销闭环，条件=累计实回≥发票金额）
  registerAction({
    name: 'crm-invoice-reconcile', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'INVOICE_APPROVE',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { invoice_id: 'string', invoice_amount: 'number', records: 'array' },
    parameters: { required: ['invoice_id', 'invoice_amount'] },
    handler: async ({ invoice_id, invoice_amount, records }, ctx) => {
      const { reconcileInvoice } = await import('../sales/invoiceService.js');
      const r = await reconcileInvoice(invoice_id, invoice_amount, records, { decisionId: ctx.decision_id });
      return r;
    },
  });
  // crm-order-create：创建订单（T3-9；挂 deal_id/contract_id → hooks 自动建边；初始 status=draft）
  registerAction({
    name: 'crm-order-create', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'normal', autoDecision: true, decisionScenario: 'ORDER_APPROVE',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { order_no: 'string', deal_id: 'string', contract_id: 'string', amount: 'number' },
    parameters: { required: ['order_no', 'deal_id', 'amount'] },
    handler: async ({ order_no, deal_id, contract_id, amount }, ctx) => {
      const { createParticle } = await import('../particles/particleRepo.js');
      const order = await createParticle('CRM_ORDER', {
        order_no, deal_id, contract_id, amount, status: 'draft', invalid: false,
      }, { tenantId: ctx.tenantId, requireDecisionId: ctx.decision_id });
      emit('crm', 'order-created', { order_id: order.id, deal_id, amount });
      return order;
    },
  });
  // crm-order-advance：订单推进（T3-9；单向状态机 draft→confirmed→shipped→completed，跨步/回退拒绝）
  registerAction({
    name: 'crm-order-advance', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'ORDER_APPROVE',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { order_id: 'string', to_status: 'string', transitionedBecause: 'string' },
    parameters: { required: ['order_id', 'to_status', 'transitionedBecause'] },
    handler: async ({ order_id, to_status, transitionedBecause }, ctx) => {
      const { advanceOrder } = await import('../sales/orderService.js');
      const updated = await advanceOrder({ order_id, to_status, transitionedBecause, tenantId: ctx.tenantId, decisionId: ctx.decision_id });
      return updated;
    },
  });
  // crm-import-batch：导入 upsert 批量写（T3-10；H27：导入新建/更新双模式，幂等）
  // 批量写过闸：confirm:'critical'（批量写必须确认，防误伤）；行级校验失败跳过不中断整批
  registerAction({
    name: 'crm-import-batch', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true, decisionScenario: 'IMPORT_BATCH',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { particle_type: 'string', rows: 'array', mode: 'string', required: 'array' },
    parameters: {
      required: ['particle_type', 'rows', 'mode'],
      properties: {
        particle_type: { type: 'string', candidateSource: 'particle_type_enum' },
        rows: { type: 'array' },
        mode: { type: 'string', enum: ['insert', 'upsert'] },
      },
    },
    handler: async ({ particle_type, rows, mode, required }, ctx) => {
      const { importBatch } = await import('../sales/importService.js');
      // §5 防复发（account-misbind）：CRM_DEAL 批量写启用账户归属守护
      const stats = await importBatch({ particle_type, rows, mode, required, tenantId: ctx.tenantId, accountGuard: particle_type === 'CRM_DEAL', decisionId: ctx.decision_id });
      return stats;
    },
  });

  // —— 商机回退特权（B5：商机只能向前推进，除非管理员——crm-deal-rollback 仅 admin 可调）——
  // 回退 = 特权写（confirm:'critical' + rbac_roles:['admin'] + 必带 reason）；过规则闸 + 阶段配置 allow_back 闸
  registerAction({
    name: 'crm-deal-rollback', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'], confirm: 'critical', autoDecision: true,
    namespace: 'crm', agentTool: false, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native', rbac_roles: ['admin'],
    schema: { deal_id: 'string', to_stage: 'string', reason: 'string' },
    parameters: {
      required: ['deal_id', 'to_stage', 'reason'],
      properties: { deal_id: { type: 'string', candidateSource: 'CRM_DEAL' }, to_stage: { type: 'string', candidateSource: 'deal_stage_enum' } },
    },
    handler: async ({ deal_id, to_stage, reason }, ctx) => {
      const { getParticle, updateParticle } = await import('../particles/particleRepo.js');
      const { checkRollback } = await import('../sales/stageConfig.js');
      const deal = await getParticle(deal_id);
      if (!deal) throw new Error(`DEAL 不存在: ${deal_id}`);
      const cur = deal.payload.stage || deal.payload.state;
      const rb = checkRollback(cur, to_stage, {
        stageConfig: deal.payload.stage_config,
        allowBack: !!deal.payload.afoot_rollback || !!deal.payload.end_rollback,
      });
      if (!rb.ok) throw new Error(`回退规则闸拒绝: ${rb.reason}`);
      if (!reason || !String(reason).trim()) throw new Error(`回退必填原因（reason）`);
      // 写通道第 0 闸（autoDecision：自身 mint decision）
      let decision_id = ctx.decision_id;
      if (!decision_id) {
        const { requireDecision } = await import('../decision/autonomyEngine.js');
        const res = await requireDecision(
          'LOSS_REVIEW',
          { action: 'deal-rollback', deal_id, from: cur, to: to_stage, reason },
          [{ type: 'CRM_DEAL', id: deal_id }],
          { actor_id: ctx.actor, disposition: 'APPROVE' }
        );
        decision_id = res.decision.decision_id;
        emit('decision', 'deal-rollback', { deal_id, to_stage, decision_id, mode: res.mode });
      }
      const updated = await updateParticle(deal_id, {
        patch: {
          ...deal.payload, stage: to_stage, stage_changed_at: new Date().toISOString(),
          rollback_reason: reason, rollbacked_by: ctx.actor, last_decision_id: decision_id,
        },
        state: to_stage, tenantId: ctx.tenantId,
        requireDecisionId: decision_id,
      });
      emit('crm', 'deal-rollback', { deal_id, from: cur, to: to_stage, reason, decision_id });
      return { ...updated, decision_id };
    },
  });

  // —— 审批域 Action（写操作过三闸：规则层→action-confirm→HITL 审批流；本组 Action 即审批流入口）——
  // 设计约束：审批动作强制 confirm:'critical'（G21 实证：审批即决策，必须人类确认）
  registerAction({
    name: 'crm-approval-flow-define', kind: 'write', permission: 'auth', requiresEntitlement: ['approval_flow'], confirm: 'critical',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { name: 'string', enabled: 'boolean' },
    parameters: { required: ['name'], properties: { name: { type: 'string' } } },
    handler: async ({ name, enabled }) => {
      const { createFlow } = await import('../approval/flow.js');
      const flow = await createFlow({ name, enabled });
      emit('approval', 'flow-defined', { flow_id: flow.id, name });
      return flow;
    },
  });
  registerAction({
    name: 'crm-approval-start', kind: 'write', permission: 'auth', requiresEntitlement: ['approval_flow'], confirm: 'critical',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.1.0', owner: 'crm-native',
    schema: { flow_id: 'string', business_type: 'string', business_id: 'string', ctx: 'object', approvers: 'array' },
    parameters: {
      required: ['flow_id', 'business_type', 'business_id'],
      properties: {
        approvers: {
          type: 'array', items: { type: 'string' },
          description: '显式审批人/审批链（如 ["role:presales","role:manager"]）；省略则按流配置的节点规则解析。显式指定时必须覆盖全部审批节点，否则拒绝起单（fail-closed）',
        },
      },
    },
    handler: async ({ flow_id, business_type, business_id, ctx, approvers }, actionCtx) => {
      const { startInstance } = await import('../approval/engine.js');
      const explicit = Array.isArray(approvers) ? approvers.filter((a) => typeof a === 'string' && a) : [];
      // approvers 透传（2026-09-09 审批失效根治）：此前恒传空数组，调用方只能落进「空审批人」分支，
      //   叠加 engine 的 AUTO_PASS 前置判定 → 起单即通过。现支持显式指定审批链；
      //   requireFullChain 防止「链长 < 节点数」时剩余节点被静默跳过（新的跳审通道）。
      const inst = await startInstance(flow_id, business_type, business_id, ctx || {}, {
        submitter: actionCtx.actor, tenantId: actionCtx.tenantId,
        approvers: explicit,
        requireFullChain: explicit.length > 0,
      });
      emit('approval', 'instance-started', { instance_id: inst.id, business_type, business_id, status: inst.payload.status });
      return inst;
    },
  });
  registerAction({
    name: 'crm-approval-approve', kind: 'write', permission: 'auth', requiresEntitlement: ['approval_flow'], confirm: 'critical',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { instance_id: 'string', task_id: 'string', decision: 'string', opinion: 'string', back_node_id: 'string' },
    parameters: { required: ['instance_id', 'task_id', 'decision'] },
    handler: async ({ instance_id, task_id, decision, opinion, back_node_id }, actionCtx) => {
      // decision: approve / reject（advanceTask）/ return（退回 = 打回节点重审，back 语义：back_node_id 可显式指定目标节点）
      // 退回复用同一个审批裁决 Action（与 approve/reject 同属「审批人对当前任务的裁决」）；
      // back 语义实证（CordysCRM /approval-action/back）：打回指定节点重新审批，流程主干不迁移（天然闭环）
      const { advanceTask, returnTask } = await import('../approval/engine.js');
      const r = decision === 'return'
        ? await returnTask(instance_id, task_id, { approver: actionCtx.actor, back_node_id, opinion, by: actionCtx.actor })
        : await advanceTask(instance_id, task_id, { approver: actionCtx.actor, decision, opinion });
      emit('approval', decision === 'approve' ? 'task-approved' : decision === 'return' ? 'task-returned' : 'task-rejected', { instance_id, task_id, decision, opinion });
      return r;
    },
  });
  // 任务级操作（引擎补强同源契约：stateMachine OPERATIONS_BY_STATE withdraw/add_sign/transfer 均 APPROVING 内合法）
  // 撤回：提交人撤单（APPROVING → CANCELED，待办任务同撤）
  registerAction({
    name: 'crm-approval-withdraw', kind: 'write', permission: 'auth', requiresEntitlement: ['approval_flow'], confirm: 'critical',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { instance_id: 'string' },
    parameters: { required: ['instance_id'] },
    handler: async ({ instance_id }, actionCtx) => {
      const { withdrawInstance } = await import('../approval/engine.js');
      const r = await withdrawInstance(instance_id, { by: actionCtx.actor });
      emit('approval', 'instance-withdrawn', { instance_id, status: r.status, canceled_tasks: r.canceled_tasks });
      return r;
    },
  });
  // 转交：审批人 TODO 任务原位转给他人（留痕 TRANSFERRED + 同 seq 承接）
  registerAction({
    name: 'crm-approval-transfer', kind: 'write', permission: 'auth', requiresEntitlement: ['approval_flow'], confirm: 'critical',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { instance_id: 'string', task_id: 'string', to: 'string' },
    parameters: { required: ['instance_id', 'task_id', 'to'] },
    handler: async ({ instance_id, task_id, to }, actionCtx) => {
      const { transferTask } = await import('../approval/engine.js');
      const r = await transferTask(instance_id, task_id, { to, by: actionCtx.actor });
      emit('approval', 'task-transferred', { instance_id, task_id, to, seq: r.seq });
      return r;
    },
  });
  // 加签：审批中追加审批人（SEQUENTIAL 尾续 seq，顺序闸自然生效）
  registerAction({
    name: 'crm-approval-add-sign', kind: 'write', permission: 'auth', requiresEntitlement: ['approval_flow'], confirm: 'critical',
    namespace: 'crm', agentTool: true, force: false, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { instance_id: 'string', approver: 'string' },
    parameters: { required: ['instance_id', 'approver'] },
    handler: async ({ instance_id, approver }, actionCtx) => {
      const { addSignTask } = await import('../approval/engine.js');
      const r = await addSignTask(instance_id, { approver, by: actionCtx.actor });
      emit('approval', 'task-added-sign', { instance_id, approver, seq: r.seq });
      return r;
    },
  });

  // —— 敏感读 Action（kind:'read_sensitive'；经 gateway confirm 闸，不直连；§6.13 角色确认）——
  // 客户 360：跨 ≥3 实体（CUSTOMER+DEAL+CONTRACT）聚合视图
  registerAction({
    name: 'crm-customer-360', kind: 'read_sensitive', permission: 'auth', requiresEntitlement: ['customer_360'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native', data_scope_domains: ['CRM_CUSTOMER', 'CRM_DEAL', 'CRM_CONTRACT'],
    schema: { customer_id: 'string' },
    parameters: { required: ['customer_id'] },
    handler: async ({ customer_id }, ctx) => {
      const { query } = await import('../db.js');
      const cust = await query(`SELECT * FROM crm.particles WHERE type='CRM_CUSTOMER' AND id=$1`, [customer_id]);
      const deals = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'customer_id'=$1 LIMIT 50`, [customer_id]);
      const contracts = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_CONTRACT' AND payload->>'customer_id'=$1 LIMIT 50`, [customer_id]);
      return { customer: cust.rows[0] || null, deal_count: deals.rows.length, contract_count: contracts.rows.length, deals: deals.rows, contracts: contracts.rows };
    },
  });
  // 跨实体查询：单查询跨 ≥2 实体类型
  registerAction({
    name: 'crm-cross-entity-query', kind: 'read_sensitive', permission: 'auth', requiresEntitlement: ['advanced_reporting'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native', data_scope_domains: ['CRM_DEAL', 'CRM_CONTRACT', 'CRM_INVOICE', 'CRM_CUSTOMER'],
    schema: { entity_types: 'array', customer_id: 'string', limit: 'number' },
    parameters: { required: ['entity_types'] },
    handler: async ({ entity_types, customer_id, limit = 20 }, ctx) => {
      const { query } = await import('../db.js');
      const types = (entity_types || []).map(String);
      if (types.length < 2) throw new Error('跨实体查询需 ≥2 个 entity_types');
      const rows = await query(
        `SELECT type, id, payload FROM crm.particles
         WHERE type = ANY($1) ${customer_id ? "AND payload->>'customer_id'=$2" : ''} LIMIT ${Number(limit)}`,
        customer_id ? [types, customer_id] : [types]
      );
      return { entity_types: types, count: rows.rows.length, rows: rows.rows };
    },
  });
  // 财务应收：INVOICE + PAYMENT 域聚合
  registerAction({
    name: 'crm-finance-receivables', kind: 'read_sensitive', permission: 'auth', requiresEntitlement: ['advanced_reporting'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native', data_scope_domains: ['CRM_INVOICE', 'CRM_PAYMENT_RECORD'],
    schema: { contract_id: 'string', limit: 'number' },
    handler: async ({ contract_id, limit = 50 }, ctx) => {
      const { query } = await import('../db.js');
      const inv = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_INVOICE' ${contract_id ? 'AND payload->>\'contract_id\'=$1' : ''} LIMIT ${Number(limit)}`, contract_id ? [contract_id] : []);
      const pay = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_PAYMENT_RECORD' ${contract_id ? 'AND payload->>\'contract_id\'=$1' : ''} LIMIT ${Number(limit)}`, contract_id ? [contract_id] : []);
      return { invoice_count: inv.rows.length, payment_count: pay.rows.length, invoices: inv.rows, payments: pay.rows };
    },
  });
  // 决策人工处置（校准 P0：HITL 闭环消费端）——升级决策落地待办的 action；人工经
  //  POST /api/decisions/:id/disposition 处置（recordHumanDisposition 唯一出口），本 action 仅
  //  作为待办语义锚（confirm:'critical' 对齐 crm-quote-submit 审批域；不自动派发执行）
  registerAction({
    name: 'decision-disposition', kind: 'write', permission: 'auth', requiresEntitlement: ['decision_autonomy'], confirm: 'critical',
    namespace: 'crm', agentTool: false, force: false, needsApproval: true,
    version: '1.0.0', owner: 'crm-native',
    schema: { decision_id: 'string', disposition: 'string', note: 'string' },
    parameters: {
      required: ['decision_id', 'disposition'],
      properties: { decision_id: { type: 'string', candidateSource: 'DECISION' }, disposition: { type: 'string' } },
    },
    handler: async ({ decision_id, disposition, note }, ctx) => {
      const { recordHumanDisposition } = await import('../decision/disposition.js');
      const r = await recordHumanDisposition(decision_id, {
        disposition, by_id: ctx.actor, by_role: ctx.role, note,
      });
      if (!r.ok) throw new Error(r.error || '处置失败');
      emit('decision', 'human-disposition', { decision_id, disposition, overridden: r.overridden, state: r.next_state });
      return { decision_id, overridden: r.overridden, state: r.next_state };
    },
  });
  // 合同到期：CONTRACT + end_date 过滤
  registerAction({
    name: 'crm-contract-expiring', kind: 'read_sensitive', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native', data_scope_domains: ['CRM_CONTRACT'],
    schema: { within_days: 'number', limit: 'number' },
    handler: async ({ within_days = 30, limit = 50 }, ctx) => {
      const { query } = await import('../db.js');
      const rows = await query(
        `SELECT id, payload FROM crm.particles WHERE type='CRM_CONTRACT'
         AND (payload->>'end_date')::date <= now()::date + $1::int LIMIT ${Number(limit)}`,
        [Number(within_days)]
      );
      return { within_days, count: rows.rows.length, contracts: rows.rows };
    },
  });

  // —— 业务角色方法论 SKILL 作为只读知识 Action（断言 3：skillCalls ⊆ actions 三链闭合）——
  // 语义：method-* 是方法论 SKILL（seed.js 登记 registry 元数据），此处再注册为 action，
  // 使 agent 的 skillCalls 可合法包含 method-*，且 executeSkill 的 rule 步骤可 dispatch。
  // handler 只读 SKILL 目录知识返回结构化决策（读知识，零写），与旧 8 个 method-* 不冲突。
  // 注：壳为 read 不代表绕过第 0 闸——SKILL 内每一步仍各自 dispatch 真实 action，
  //     写操作由其自身（如 crm-memory-upsert，kind:'write'）过闸。
  [
    ['intake-routing', '接诊分流：意图识别×商机分级×派发路由'],
    ['quote-engine', '报价测算：配置×成本×毛利实时测算，输出 A/B 方案'],
    ['followup-engine', '跟进催办：自动跟进×节点催办×超时转人工'],
    ['review-gate', '评审把关：双闸门×专家介入×内置四维审查（功能/架构/安全/合规）'],
    ['stage-progression', '商机阶段推进：S1-S6 大漏斗/推进前置/止损阈值（）'],
    ['funnel-classification', '大漏斗客户分类：商机/目标/潜力四象限与接触节奏（）'],
    ['behavior-standard', '销售行为合格线：21 条 BH-01~07 有/无检查项 + TAORAN 六要素（）'],
    // 2026-09-02 方案C：决策前后双 Agent 的承载 SKILL（decision-agent 的 skillCalls 需闭合）。
    //   enrich = 决策前只读富集（装配上下文×记忆线索×风险注解，零写，无 decision_id 故不能过写闸）；
    //   execute = 决策后治理写回（记忆沉淀×决策复盘，写步骤由 crm-memory-upsert 自身过第 0 闸）。
    ['decision-enrich', '决策前富集：装配上下文×记忆线索×风险注解（只读，零写）'],
    ['decision-execute', '决策后执行：记忆沉淀×决策复盘×治理写回（写步骤各自过第 0 闸）'],
    // 2026-09-08 对话驱动决策建议（docs/plans/2026-09-08-dialog-driven-decision-advice.md T0）：
    //   方法论壳（本项，读 SKILL.md）+ 执行体 crm-decision-advise（T6 注册，产出建议卡，零写）。
    ['dialog-router', '对话坐标路由：诉求关键词×商机阶段→8 大决策场景 × S1-S8 阶段建议'],
    // 2026-09-15 P1-1（Anysite 借鉴）：触达钩子方法论——锚点选取×24-30 词开口×来源可溯源（对齐 CitationGuard），
    //   只读知识壳（读 skills/method-outreach-hook/SKILL.md），钩子写回由调用方经第 0 闸完成。
    ['outreach-hook', '触达钩子：锚点选取×24-30 词开口钩子×来源可溯源（对齐 CitationGuard，fail-closed 拒出）'],
  ].forEach(([id, desc]) => registerAction({
    name: `method-${id}`, kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'method', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { query: 'string' },
    handler: async ({ query }, ctx) => {
      // 读对应 SKILL 目录方法论，返回结构化决策（读知识，零写）
      const base = `skills/method-${id}/SKILL.md`;
      return { skill: `method-${id}`, description: desc, readFrom: base, query: query || null };
    },
  }));

  // ─── T18 J2 反馈回路 MCP 工具（经 buildMcpTools 自动暴露；写经 autoDecision 第0闸）───
  registerAction({
    name: 'crm_decision_outcome_query', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { decision_id: 'string', scenario_id: 'string', outcome_type: 'string' },
    handler: async ({ decision_id, scenario_id, outcome_type } = {}) => {
      const { getGateOutcome } = await import('../monitor/monitorStore.js');
      const { listOutcomes } = await import('../decision/outcome.js');
      if (scenario_id) return getGateOutcome(scenario_id);
      if (decision_id) return { decision_id, outcomes: await listOutcomes(decision_id) };
      throw new Error('decision_id 或 scenario_id 必填其一');
    },
  });
  registerAction({
    name: 'crm_gate_outcome', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { scenario_id: 'string', window_days: 'number' },
    handler: async ({ scenario_id, window_days } = {}) => {
      const { getGateOutcome } = await import('../monitor/monitorStore.js');
      if (!scenario_id) throw new Error('scenario_id required');
      return getGateOutcome(scenario_id, { window_days: window_days || 30 });
    },
  });
  registerAction({
    name: 'crm_decision_outcome_write', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    // 非 autoDecision：写「既有决策」的结果，decision_id 为必需入参（消费方提供，不 mint 新决策）；
    // autoDecision:false 使第0闸在缺 decision_id 时硬拦（避免写入 decision_id=null 的结果假绿）。
    confirm: 'normal', autoDecision: false, namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { decision_id: 'string', outcome_type: 'string', source: 'string', payload: 'object' },
    parameters: { required: ['decision_id'] },
    handler: async ({ decision_id, outcome_type, source = 'mcp', payload = {} } = {}) => {
      const { writeOutcome } = await import('../decision/outcome.js');
      const row = await writeOutcome(decision_id, { outcome_type, source, payload });
      return { ok: true, outcome: row };
    },
  });

  // ─── T25 全链路溯源（J→M→K→粒子库 四层链 + ④ 跳三检）───
  registerAction({
    name: 'crm_decision_trace', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { decision_id: 'string' },
    parameters: { required: ['decision_id'] },
    handler: async ({ decision_id } = {}) => {
      if (!decision_id) throw new Error('decision_id required');
      const { traceRootCause } = await import('../decision/traceRootCause.js');
      const t = await traceRootCause(decision_id);
      if (!t) throw new Error(`decision 不存在: ${decision_id}`);
      return t;
    },
  });

  // ─── T27 七类根因归因（trace → classify；返回 code/layer/severity/evidence + 建议 patch knob）───
  registerAction({
    name: 'crm_decision_root_cause', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { decision_id: 'string' },
    parameters: { required: ['decision_id'] },
    handler: async ({ decision_id } = {}) => {
      if (!decision_id) throw new Error('decision_id required');
      const { traceRootCause } = await import('../decision/traceRootCause.js');
      const { classifyRootCause } = await import('../decision/rootCauseClassifier.js');
      const t = await traceRootCause(decision_id);
      if (!t) throw new Error(`decision 不存在: ${decision_id}`);
      const attr = (t.layer_j.attribution) || {};
      const rootCause = classifyRootCause({
        feedback: attr.feedback || {},
        attribution: { required_fill: attr.required_fill, edge_compliance: t.edge_compliance },
        particleChecks: t.particle_checks,
      });
      return { decision_id, trace: t, root_cause: rootCause };
    },
  });

  // ─── T26 结构化业务反馈回写（可用性 + 偏差严重度；经第0闸）───
  registerAction({
    name: 'crm_decision_outcome_set', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    // 非 autoDecision：写「既有决策」的结构化反馈，decision_id 为 required 入参（消费方提供，不 mint）；
    // autoDecision:false 使第0闸在缺 decision_id 时硬拦（杜绝 decision_id=null 假绿）。
    confirm: 'normal', autoDecision: false, namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { decision_id: 'string', feedback: 'object' },
    parameters: { required: ['decision_id', 'feedback'] },
    handler: async ({ decision_id, feedback = {} } = {}) => {
      const { setDecisionFeedback } = await import('../decision/feedback.js');
      return setDecisionFeedback(decision_id, feedback);
    },
  });

  // ─── T23 J3 校准 MCP：6 工具全链路可读可写（读直出；写经第0闸 confirm/autoDecision）───
  // 契约：docs/2026-08-30-j2-j3-comprehensive-design.md L185-L190
  registerAction({
    name: 'crm_calibration_patches', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { status: 'string', scenario_id: 'string', limit: 'number' },
    handler: async ({ status = null, scenario_id = null, limit = 50 } = {}) => {
      const { listPatches } = await import('../calibration/store.js');
      const patches = await listPatches({ status, limit });
      if (scenario_id) {
        return { ok: true, patches: patches.filter((p) => p.scenario_id === scenario_id) };
      }
      return { ok: true, patches };
    },
  });

  registerAction({
    name: 'crm_calibration_metrics', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { scenario_id: 'string', window_days: 'number', limit: 'number' },
    handler: async ({ scenario_id = null, window_days = 30, limit = 500 } = {}) => {
      // 与 HTTP GET /api/calibration/metrics 同链路（共享 loadDecisions，杜绝双口径漂移）
      const { loadDecisions } = await import('../calibration/sampleLoader.js');
      const { computeMetrics } = await import('../calibration/metrics.js');
      const { attribute } = await import('../calibration/rules.js');
      const rows = await loadDecisions({ scenario_id, window_days, limit });
      const metrics = computeMetrics(rows);
      return { ok: true, sample_size: rows.length, metrics, attribution: attribute(metrics) };
    },
  });

  registerAction({
    name: 'crm_calibration_patch_generate', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    confirm: 'normal', autoDecision: true, decisionScenario: 'CALIBRATION_CHANGE', namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { scenario_id: 'string', window_days: 'number' },
    parameters: { required: ['scenario_id'] },
    handler: async ({ scenario_id, window_days = 30 } = {}) => {
      if (!scenario_id) throw new Error('scenario_id required');
      // 与 HTTP POST /api/calibration/patches/generate 同链路（共享 loadDecisions/enrichPatchesAndSave，
      //   store.produceDecision 第0闸），杜绝双口径漂移——见 docs/2026-08-30-j2-j3-comprehensive-design.md L185-L190
      const { loadDecisions } = await import('../calibration/sampleLoader.js');
      const { computeMetrics } = await import('../calibration/metrics.js');
      const { readConf, produceDecision } = await import('../calibration/store.js');
      const { attribute } = await import('../calibration/rules.js');
      const { enrichPatchesAndSave } = await import('../calibration/patchAssembler.js');
      const decisions = await loadDecisions({ scenario_id, window_days, limit: 500 });
      const metrics = computeMetrics(decisions);
      const conf = await readConf();
      const att = attribute(metrics);
      const r = await enrichPatchesAndSave({
        decisions, metrics, att, conf, scenario_id,
        savePatches: (await import('../calibration/store.js')).savePatches,
        produceDecision,
      });
      return { ok: true, created: r.created, skipped_duplicates: r.skipped_duplicates, blocked_by: r.blocked_by, decision_id: r.decision_id, patches: r.patches.filter((p) => p.to_value), guards: att.guards, reason: att.reason };
    },
  });

  registerAction({
    name: 'crm_calibration_patch_approve', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    confirm: 'normal', autoDecision: true, decisionScenario: 'CALIBRATION_CHANGE', namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { patch_id: 'string' },
    parameters: { required: ['patch_id'] },
    handler: async ({ patch_id } = {}) => {
      if (!patch_id) throw new Error('patch_id required');
      const { approvePatch } = await import('../calibration/store.js');
      const r = await approvePatch(patch_id);
      if (r.patch && r.patch.status === 'REJECTED') throw new Error('处方已被拒绝，无法批准');
      return { ok: true, ...r };
    },
  });

  registerAction({
    name: 'crm_calibration_patch_reject', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    confirm: 'normal', autoDecision: true, decisionScenario: 'CALIBRATION_CHANGE', namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { patch_id: 'string' },
    parameters: { required: ['patch_id'] },
    handler: async ({ patch_id } = {}) => {
      if (!patch_id) throw new Error('patch_id required');
      const { rejectPatch } = await import('../calibration/store.js');
      const patch = await rejectPatch(patch_id);
      return { ok: true, patch };
    },
  });

  registerAction({
    name: 'crm_calibration_patch_rollback', kind: 'write', permission: 'auth', requiresEntitlement: ['core_crm'],
    confirm: 'normal', autoDecision: true, decisionScenario: 'CALIBRATION_CHANGE', namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { patch_id: 'string' },
    parameters: { required: ['patch_id'] },
    handler: async ({ patch_id } = {}) => {
      if (!patch_id) throw new Error('patch_id required');
      const { rollbackPatch } = await import('../calibration/store.js');
      const r = await rollbackPatch(patch_id);
      return { ok: true, ...r };
    },
  });

  // ─── §7 crm_root_cause_list：按根因类别/层/严重度聚合（供 A9 共性问题发现）───
  // 契约：docs/2026-08-30-full-traceability-root-cause-design.md §7（缺失工具，本批补齐）
  //   读侧只查 decision.root_cause JSONB（分类器落库结果），不做任何写。
  registerAction({
    name: 'crm_root_cause_list', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { window_days: 'number', limit: 'number', code: 'string' },
    handler: async ({ window_days = 30, limit = 500, code = null } = {}) => {
      const { query } = await import('../db.js');
      const r = await query(
        `SELECT decision_id, scenario_id, root_cause, created_at
         FROM crm.decision
         WHERE root_cause IS NOT NULL AND created_at >= now() - ($1::int || ' days')::interval
         ORDER BY created_at DESC LIMIT $2`,
        [window_days, limit]
      );
      const rows = r.rows || [];
      const by_code = {};
      const by_layer = {};
      const by_severity = {};
      for (const row of rows) {
        const rc = row.root_cause || {};
        const code = rc.code || 'UNKNOWN';
        const layer = rc.layer || '?';
        const severity = rc.severity || 'unknown';
        by_code[code] = (by_code[code] || 0) + 1;
        by_layer[layer] = (by_layer[layer] || 0) + 1;
        by_severity[severity] = (by_severity[severity] || 0) + 1;
      }
      const samples = rows
        .filter((row) => !code || (row.root_cause?.code || 'UNKNOWN') === code)
        .slice(0, 10)
        .map((row) => ({
          decision_id: row.decision_id,
          scenario_id: row.scenario_id,
          code: row.root_cause?.code || 'UNKNOWN',
          severity: row.root_cause?.severity || 'unknown',
          knob: row.root_cause?.knob || null,
          created_at: row.created_at,
        }));
      return { ok: true, total: rows.length, by_code, by_layer, by_severity, samples };
    },
  });

  // —— 智能体任务调度（2026-08-30 决策 1A：MCP 暴露「需求→调度」）——
  // 背景：POST /api/agent/dispatch（src/http/routes.js:455）今日随 S03 工作台新增，
  //   但为独立 HTTP 路由、未注册 Action → buildMcpTools 未生成 MCP 工具（办公智能体无法经 MCP 发起调度）。
  // 本 Action 复用 HTTP 同链路（classifyRequirement → createTask → pumpReadyTasks），杜绝双口径漂移。
  // 第 0 闸：同 HTTP 路由注释——创建的是编排任务（crm.kanban.tasks），非业务粒子写，
  //   不触发 requireDecision 硬闸；仅经 recordDecisionEvent 落决策审计链（降级不硬抛）。
  // MCP 暴露后写仍走 gateway 两阶段 confirm（第0闸 decision_id 若缺由调用方补；无决策不写硬闸语义保留）。
  registerAction({
    name: 'agent-dispatch', kind: 'write', permission: 'auth', requiresEntitlement: ['ai_agents'],
    confirm: 'normal', namespace: 'agent', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    schema: { requirement: 'string' },
    parameters: { required: ['requirement'] },
    handler: async ({ requirement } = {}, ctx = {}) => {
      const nl = String(requirement || '').trim();
      if (!nl) throw new Error('requirement required');
      const { classifyRequirement } = await import('../agent/classify.js');
      const { createTask } = await import('../kanban/kanban.js');
      const { pumpReadyTasks } = await import('../kanban/scheduler.js');
      const { recordDecisionEvent } = await import('../decision/decisionRepo.js');
      const cls = classifyRequirement(nl);
      if (cls.needsClarification) {
        return { ok: false, gate: 'needs_clarification', needsClarification: true, notes: cls.notes };
      }
      await recordDecisionEvent('agent_dispatch', {
        scenario_id: 'agent-dispatch', intent: cls.intent, level: cls.level, actor: ctx.actor || 'mcp', requirement: nl,
      }).catch(() => {});
      const task = await createTask({
        step: 'agent-dispatch',
        title: nl.slice(0, 80),
        actionName: 'agent-dispatch',
        payload: { requirement: nl, intent: cls.intent, level: cls.level, owner: ctx.actor || 'mcp' },
        decisionId: ctx.decision_id || null,
      });
      const dispatched = await pumpReadyTasks({}).catch(() => 0);
      return { ok: true, taskId: task.id, intent: cls.intent, level: cls.level, status: task.status, dispatched };
    },
  });

  // ─── 平台运营洞察 / 待办 / 记忆读（2026-09-05 设计 §3）───
  // my-todo-query：六视角待办（复用 workbenchRouter.buildViewRows + defaultDeps）
  registerAction({
    name: 'my-todo-query', kind: 'read', permission: 'auth', namespace: 'crm', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { view: 'string', limit: 'number' },
    handler: async ({ view = 'approval', limit = 50 } = {}, ctx = {}) => {
      const { buildViewRows, defaultDeps } = await import('../http/workbenchRouter.js');
      const actor = { username: ctx?.actor || 'system', roles: [ctx?.role || 'system'], tenantId: ctx?.tenantId || 'system' };
      const rows = await buildViewRows(view, actor, defaultDeps).catch((e) => { recordFailure('my-todo-query-failed', e); return []; });
      return { view, rows: rows.slice(0, Number(limit) || 50) };
    },
  });

  // my-todo-approve / reject：审批任务签批（复用 advanceTask；approver 匹配在 engine 内校验，越权拒）
  const todoSign = (decision) => ({
    name: decision === 'approve' ? 'my-todo-approve' : 'my-todo-reject',
    kind: 'write', permission: 'auth', namespace: 'crm', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { task_id: 'string', instance_id: 'string', opinion: 'string' },
    handler: async ({ task_id, instance_id, opinion = '' } = {}, ctx = {}) => {
      const { advanceTask } = await import('../approval/engine.js');
      const r = await advanceTask(instance_id, task_id, {
        approver: ctx?.actor || 'system', decision, opinion, tenantId: ctx?.tenantId || 'system',
      });
      return { ok: true, ...r };
    },
  });
  registerAction(todoSign('approve'));
  registerAction(todoSign('reject'));

  // tune-approve / tune-reject：参数调优处方签批（复用 approvePatch/rejectPatch；仅 sysadmin）
  const tuneSign = (approve) => ({
    name: approve ? 'tune-approve' : 'tune-reject',
    kind: 'write', permission: 'auth', namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    rbac_roles: ['sysadmin'],
    schema: { patch_id: 'string', opinion: 'string' },
    handler: async ({ patch_id, opinion = '' } = {}, ctx = {}) => {
      const { approvePatch, rejectPatch } = await import('../calibration/store.js');
      const fn = approve ? approvePatch : rejectPatch;
      const r = await fn(patch_id, { resolved_by: ctx?.actor || 'sysadmin' }).catch((e) => { recordFailure('tune-sign-failed', e); throw e; });
      return { ok: true, ...r };
    },
  });
  registerAction(tuneSign(true));
  registerAction(tuneSign(false));

  // admin-tenant-usage：租户套餐/用量/到期/缴费（只读聚合现有表；仅 sysadmin）
  registerAction({
    name: 'admin-tenant-usage', kind: 'read', permission: 'auth', requiresEntitlement: ['advanced_reporting'], namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    rbac_roles: ['sysadmin'],
    schema: { tenantId: 'string' },
    handler: async ({ tenantId = null } = {}, ctx = {}) => {
      const { query } = await import('../db.js');
      const rows = (await query(
        `SELECT ts.tenant_id, ts.plan_id, ts.status, ts.expires_at, ts.grace_until, ts.payment_ref,
                mu.calls, mu.tokens_in, mu.tokens_out, mu.period
           FROM crm.tenant_subscription ts
           LEFT JOIN crm.module_usage mu ON mu.tenant_id = ts.tenant_id AND mu.period = to_char(now(),'YYYY-MM')
          WHERE ($1::text IS NULL OR ts.tenant_id=$1)
          ORDER BY ts.expires_at`,
        [tenantId]
      )).rows;
      return { rows };
    },
  });

  // admin-agent-summary / admin-decision-health / admin-param-diagnosis：聚合报告转 MCP（仅 sysadmin）
  registerAction({
    name: 'admin-agent-summary', kind: 'read', permission: 'auth', namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    rbac_roles: ['sysadmin'],
    schema: { days: 'number', tenantId: 'string' },
    handler: async ({ days = 7, tenantId = 'system' } = {}, ctx = {}) => {
      const { getAgentSummary } = await import('../monitor/monitorStore.js');
      return getAgentSummary({ days: Number(days) || 7, tenantId });
    },
  });
  registerAction({
    name: 'admin-decision-health', kind: 'read', permission: 'auth', requiresEntitlement: ['audit_provenance'], namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    rbac_roles: ['sysadmin'],
    schema: { days: 'number', tenantId: 'string' },
    handler: async ({ days = 30, tenantId = 'system' } = {}, ctx = {}) => {
      const { getDecisionHealth } = await import('../monitor/monitorStore.js');
      return getDecisionHealth({ days: Number(days) || 30, tenantId });
    },
  });
  registerAction({
    name: 'admin-param-diagnosis', kind: 'read', permission: 'auth', requiresEntitlement: ['industry_config'], namespace: 'admin', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    rbac_roles: ['sysadmin'],
    schema: { days: 'number' },
    handler: async ({ days = 7 } = {}, ctx = {}) => {
      const { getParamDiagnosis } = await import('../monitor/diagnosis.js');
      return getParamDiagnosis({ days: Number(days) || 7 });
    },
  });

  // crm-memory-read：客户记忆查询（memory_log by entity；per-tenant 收敛，sysadmin 通配）
  registerAction({
    name: 'crm-memory-read', kind: 'read', permission: 'auth', requiresEntitlement: ['memory'], namespace: 'crm', agentTool: true,
    needsApproval: false, version: '1.0.0', owner: 'crm-native',
    schema: { entityId: 'string', topic: 'string', layer: 'string', limit: 'number', windowDays: 'number' },
    handler: async ({ entityId, topic = null, layer = null, limit = 20, windowDays = 30 } = {}, ctx = {}) => {
      const { query } = await import('../db.js');
      const tenantId = ctx?.tenantId || 'system';
      const where = ['archived=false'];
      const params = [];
      if (tenantId && tenantId !== 'system' && tenantId !== '*') { params.push(tenantId); where.push(`tenant_id=$${params.length}`); }
      if (entityId) { params.push(entityId); where.push(`entity_id=$${params.length}`); }
      if (topic) { params.push(`%${topic}%`); where.push(`topic LIKE $${params.length}`); }
      if (layer) { params.push(layer); where.push(`layer=$${params.length}`); }
      params.push(new Date(Date.now() - Number(windowDays) * 864e5).toISOString());
      where.push(`created_at >= $${params.length}`);
      params.push(Number(limit) || 20);
      const rows = (await query(
        `SELECT id, topic, kind, layer, entity_id, payload, created_at FROM crm.memory_log
           WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
        params
      )).rows;
      return { rows, count: rows.length };
    },
  });

  // 2026-09-03 C 方案 T2/T4：lifecycle 元数据集中标注（不破坏上方 66 个业务块）
  // engine = 审批流/校准/决策/agent 引擎类 + method 命名空间（由引擎内部触发，MCP 暴露但标注 [引擎]）
  // crm-decision-advise：对话决策建议（T6）——把销售诉求定位到 8 大决策坐标并给出建议卡。
  // kind=read：不落库、不过第 0 闸（建议本身不是写）。
  // 注：`persist` 参数为 T8 落锚点预留，当前**未接线**（返回体不含 decision_id），T8 完成后生效。
  registerAction({
    name: 'crm-decision-advise', kind: 'read', permission: 'auth', requiresEntitlement: ['core_crm'],
    namespace: 'crm', agentTool: true, needsApproval: false, mcpExpose: true,
    version: '1.0.0', owner: 'crm-native',
    description: '把销售诉求定位到 8 大决策场景 × S1-S8 阶段并给出决策建议卡（A 明确处置/B 风险提示/C 只补信息）',
    schema: { utterance: 'string', deal_id: 'string', stage: 'string', persist: 'boolean' },
    parameters: { properties: { utterance: { type: 'string' }, deal_id: { type: 'string', candidateSource: 'CRM_DEAL' }, stage: { type: 'string' }, persist: { type: 'boolean' } } },
    handler: async ({ utterance = '', deal_id, stage = null, persist = false }, ctx) => {
      const tid = ctx.tenantId || 'system';
      const deal = deal_id ? await getParticle(deal_id).catch(() => null) : null;
      // 关键修正：MCP 通道已解析出登录者角色（buildMcpCtx→ctx.role），务必透传给 advise，
      // 否则 actorRole 回退 default 上限（D6 降级）丢失真实角色 → 红线 detail 显示「默认 权限」
      // 而非真实角色上限。scopes 一并透传供 over_scope 判定。
      const r = await advise({ utterance, ctx: { tenantId: tid, role: ctx.role, scopes: ctx.scopes }, deal, stage });
      return { ok: r.ok, advice: r.advice, degraded: r.degraded || null };
    },
  });

  // reserved = 注册暴露但确无运行调用点的业务 action（死表面降级，遵守禁 DELETE 铁律不物理删；
  //   审计修正：用户原选"物理删除重复项"，但 52 死表面中无真正重复项——
  //   crm-customer-360 实为 read_sensitive 通道 action（SKILL×12 + 2 专项测试消费），其余为商机生命周期
  //   写操作与引擎型，删之会破坏 SKILL 引用与测试 → 降级 reserved 而非删，后续可逐个评估接线/删除）
  const ENGINE_NAMES = new Set([
    'crm-approval-flow-define', 'crm-approval-start', 'crm-approval-approve', 'crm-approval-withdraw',
    'crm-approval-transfer', 'crm-approval-add-sign',
    'crm_calibration_patches', 'crm_calibration_metrics', 'crm_calibration_patch_generate',
    'crm_calibration_patch_approve', 'crm_calibration_patch_reject', 'crm_calibration_patch_rollback',
    'crm_decision_outcome_query', 'crm_gate_outcome', 'crm_decision_outcome_write', 'crm_decision_trace',
    'crm_decision_root_cause', 'crm_decision_outcome_set', 'crm_graph_query', 'crm_root_cause_list',
    'decision-disposition', 'agent-dispatch',
  ]);
  // 2026-09-14 拓客三 Action（T5 装配汇聚 3/3）：prospecting-* 与 discovery-* 并列注册
  seedProspectingActions();
  // 2026-09-15 P1-3 触达前预热（T11 装配汇聚 3/3）：preheat-schedule/mark/status 三 Action
  seedPreheatActions();

  // ── 信号读 Action（2026-09-17 前台可见性审计 P1-4）──
  // 「MCP 工具面由 Action Registry 生成」（src/mcp/tools.js buildMcpTools）——registry 里此前**零 signal action**
  //   ⇒ 两个专家包（crm-native / sales-decision-admin）经 crm-native-mcp 连上后，工具清单里根本没有信号能力；
  //   「更新插件」自然无用（暴露面源头未开）。此二 Action 是暴露的前提。
  // 口径：
  //   · kind='read' → 走读直连（executor 不触写闸/第0闸）；
  //   · 身份 fail-closed：MCP 读通道必须带 ctx.actor，缺身份一律拒绝——**不返回全量**
  //     （不收窄 = 全租户泄漏，是最危险的假绿方向）；
  //   · 隔离复用唯一收窄点 signalOwnerScope（不另造谓词）；零 DELETE、零写入。
  registerAction({
    name: 'crm-signal-list', kind: 'read', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    description: '列出当前租户的主动运行时信号（销售自动化）：支持按状态/类型/严重度过滤；普通角色自动收窄为「我负责的 + 我的同角色广播」',
    schema: { status: 'string', kind: 'string', severity: 'string', mine: 'boolean', limit: 'number' },
    handler: async ({ status = null, kind = null, severity = null, mine = false, limit = 100 } = {}, ctx = {}) => {
      // 身份闸优先于一切（先闸后读，避免"先查库再判"）
      if (!ctx.actor) return { ok: false, error: 'auth_required', hint: 'MCP 读通道需要已登录身份（先 crm_login）' };
      const tenantId = ctx.tenantId || 'system';
      const ownerScope = signalOwnerScope({ username: ctx.actor, role: ctx.role }, { mine });
      const store = createSignalStore(pool);
      const rows = await store.list({ tenant_id: tenantId, status, kind, severity, ownerScope });
      const items = rows.slice(0, Math.max(1, Number(limit) || 100)).map((r) => ({
        signal_id: r.signal_id,
        kind: r.kind,
        severity: r.severity,
        status: r.status,
        target_role: r.target_role,
        owner_id: r.owner_id,
        created_at: r.created_at,
        subject: r.payload?.subject || null,
        // 有日历时间才可导出（与前端「加入日历」同判据，避免前端有按钮而 MCP 导出失败）
        has_calendar: typeof r.payload?.event_at === 'string' && !!r.payload.event_at,
      }));
      return { ok: true, tenant_id: tenantId, total: rows.length, items };
    },
  });

  registerAction({
    name: 'crm-signal-ics', kind: 'read', permission: 'auth',
    namespace: 'crm', agentTool: true, needsApproval: false,
    version: '1.0.0', owner: 'crm-native',
    description: '把一条带日期语义的信号导出为标准 iCalendar（.ics）文本，供写入外部日历；无日期/非法日期明确失败（不造幽灵日程）',
    schema: { signal_id: 'string' },
    parameters: { required: ['signal_id'], properties: { signal_id: { type: 'string' } } },
    handler: async ({ signal_id: signalId } = {}, ctx = {}) => {
      if (!ctx.actor) return { ok: false, error: 'auth_required', hint: 'MCP 读通道需要已登录身份（先 crm_login）' };
      if (!signalId) return { ok: false, error: 'signal_id_required' };
      const tenantId = ctx.tenantId || 'system';
      const { rows } = await query(
        `SELECT * FROM crm.signal WHERE signal_id=$1 AND tenant_id=$2`,
        [signalId, tenantId],
      ).catch(() => ({ rows: [] }));
      if (!rows[0]) return { ok: false, error: 'signal_not_found' };
      const ics = buildIcs(rows[0]);
      if (!ics) {
        return {
          ok: false, error: 'not_a_calendar_signal',
          hint: '该信号无 payload.event_at 或日期非法，按设计不生成日程（不造幽灵日程）',
        };
      }
      return { ok: true, signal_id: signalId, filename: `signal-${signalId}.ics`, content_type: 'text/calendar', ics };
    },
  });

  const RESERVED_NAMES = new Set([
    'crm-quote-estimate', 'crm-review-gate-evaluate', 'crm-followup-schedule', 'crm-stage-progression-evaluate',
    'crm-funnel-classify', 'crm-behavior-check', 'crm-field-permission', 'crm-deal-swas-update',
    'crm-lead-pick', 'crm-lead-recycle', 'crm-proposal-write', 'crm-quote-create', 'crm-quote-submit',
    'crm-quote-activate', 'crm-contract-create', 'crm-contract-submit', 'crm-invoice-submit', 'crm-order-submit',
    'crm-payment-plan-create', 'crm-payment-record-create', 'crm-invoice-create', 'crm-invoice-reconcile',
    'crm-order-create', 'crm-order-advance', 'crm-import-batch', 'crm-deal-rollback',
    'crm-customer-360', 'crm-cross-entity-query', 'crm-finance-receivables', 'crm-contract-expiring',
  ]);
  for (const a of listActions()) {
    if (ENGINE_NAMES.has(a.name) || a.namespace === 'method') {
      registerAction({ ...a, lifecycle: 'engine' });
    } else if (RESERVED_NAMES.has(a.name)) {
      registerAction({ ...a, lifecycle: 'reserved' });
    }
  }
}
