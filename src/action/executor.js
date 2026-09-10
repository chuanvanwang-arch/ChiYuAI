// src/action/executor.js — Action 执行器（写通道第 0 闸：无 decision_id 不写；HITL 阶段 2 接入点）
// 设计输入：docs/2026-08-24-ai-native-sales-crm-design.md §6.4 / 03 编排设计 / 决策事件主轴 §6（写通道强制 decision_id）
// 第 3.5 闸：docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md §7（阶段推进前置，消费 method-stage-progression）
import { getAction, listActions } from './registry.js';
import { getParticle } from '../particles/particleRepo.js';
import { emit } from '../events/bus.js';
import { loadProfile } from '../context/roleProfiles.js';
import { actorRole, enforceScope, isParticleScoped } from '../context/scope.js';
import { isWriteWhitelisted } from './whitelist.js';
import { query } from '../db.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { checkPatchPermissions } from '../metaAttr/fieldPermission.js';
import { recordAudit } from './auditHook.js'; // 10-能力审计单点（V5：写 Action 三段必经）
import { recordTokens } from '../alerts/tokenAccounting.js'; // 09-V6 token 计量（写 Action 执行处；fail-open 不阻断）
import { deterministicEval } from '../aiAttributes/evaluator.js'; // 门控现场复算 BANTCC 六维明细
import { readThreshold, DEFAULT_THRESHOLDS } from '../sales/salesThresholds.js'; // 门控阈值（走配置，禁硬编码）
import { toStageCode, S_ATTACHMENT_GATES } from '../sales/stageTaxonomy.js'; // 阶段码归一（lead→S1 等）+ 第3.5闸强制附件门禁定义
import { advise } from '../decision/adviseService.js'; // 对话驱动建议（2026-09-08 T7）：仅阻断路径附加，合规写零侵入

export const registry = { list: listActions, get: getAction };

// T1：autoDecision 统一 mint 辅助（查 scenario 注册 + 从 params 解析实体）
// getScenario：tenant 专属缺失回退 system（对齐 requireDecision 回退语义）；返回行或 null
async function getScenario(scenario_id, tenantId = 'system') {
  const r = await query(
    `SELECT * FROM decision_scenario WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`,
    [scenario_id, tenantId]
  );
  return r.rows[0] || null;
}
// inferEntities：从 action params 解析 involved_entities（对齐已合规 action 传 [{type,id}] 形态）
function inferEntities(actionName, params = {}) {
  if (params.deal_id) return [{ type: 'CRM_DEAL', id: params.deal_id }];
  if (params.contract_id) return [{ type: 'CRM_CONTRACT', id: params.contract_id }];
  if (params.invoice_id) return [{ type: 'CRM_INVOICE', id: params.invoice_id }];
  if (params.order_id) return [{ type: 'CRM_ORDER', id: params.order_id }];
  if (params.payment_plan_id) return [{ type: 'CRM_PAYMENT_PLAN', id: params.payment_plan_id }];
  if (params.account_id) return [{ type: 'CRM_ACCOUNT', id: params.account_id }];
  return [];
}

export const actionExecutor = {
  async dispatch(actionName, params, ctx = { tenantId: 'system', actor: 'system' }) {
    const def = getAction(actionName);
    if (!def) return { ok: false, error: `未知 Action: ${actionName}` };
    // 写通道第 0 闸（决策事件主轴）：一切写操作强制携带 decision_id（无决策不写）
    // 豁免：ctx.bootstrap（系统引导/种子）或 def.autoDecision（Action 自身经自主引擎 mint decision）
    // decision_id 取数：ctx 优先、params 兜底（Action 参数显式携带决策 id 亦合规）
    const decisionId = ctx.decision_id || params?.decision_id;
    if (def.kind === 'write' && !decisionId && !ctx.bootstrap && !def.autoDecision) {
      emit('trace', 'action-write-blocked', { action: actionName, actor: ctx.actor, reason: 'no_decision_id' });
      // 对话驱动建议（2026-09-08 T7）：阻断时顺带给出决策建议卡，帮助销售补齐 decision_id 所需的决策。
      // 只在阻断路径附加，不改变第 0 闸任何判定语义；fail-open（advise 异常不影响阻断返回）。
      let advice = null;
      try {
        const a = await advise({ utterance: params?.utterance || '', ctx: { tenantId: ctx.tenantId }, deal: null, stage: params?.stage || null });
        advice = a.advice;
      } catch { advice = null; }
      return { ok: false, gate: 'decision_required', error: '第0闸: 写操作必须携带 decision_id（无决策不写）', advice };
    }
    // T1：autoDecision 统一 mint——仅声明 decisionScenario 且已注册才代 handler mint（防硬抛 + 防双 mint）
    // 未声明 decisionScenario（含已合规 7 个 handler 内 mint 的 action）→ 跳过，不双 mint
    // 已声明但 scenario 未注册 → trace 告警不抛错（保持原行为，假绿风险可巡检）
    if (def.autoDecision && !decisionId && def.decisionScenario) {
      const sc = await getScenario(def.decisionScenario, ctx.tenantId);
      if (sc) {
        // C5（2026-09-10）：补 tenantId（与 gateway.js:167 同源修复）。缺租户 → 决策恒落 system。
        const d = await requireDecision(def.decisionScenario, { action: actionName, ...params, actor: ctx.actor }, inferEntities(actionName, params), { actor_id: ctx.actor, tenantId: ctx.tenantId || null });
        ctx.decision_id = d.decision.decision_id;
        emit('decision', `${actionName}-auto`, { decision_id: d.decision.decision_id, scenario: def.decisionScenario });
      } else {
        emit('trace', 'auto-decision-no-scenario', { action: actionName, scenario: def.decisionScenario });
      }
    }
    // 写通道第 1 闸（上下文分层）：数据范围越界不写/读
    // 豁免：ctx.bootstrap（系统引导/种子）；demo/未命中角色回退无限制
    if (!ctx.bootstrap && isParticleScoped(def)) {
      const role = await actorRole(ctx);
      if (role) {
        const profile = await loadProfile(role.role_tag);
        if (profile) {
          const verdict = await enforceScope(def, ctx, params, profile);
          if (!verdict.ok) {
            emit('trace', 'action-scope-blocked', { action: actionName, actor: ctx.actor, reason: verdict.reason });
            return { ok: false, gate: 'scope_violation', error: `第1闸: 数据范围越界（${verdict.reason || ''}）` };
          }
        }
      }
    }
    // 写通道第 1.5 闸（角色 RBAC 硬闸，§6.6 skill_registry.rbac_roles）：默认开放
    // 仅当 Action 显式声明 rbac_roles 且已识别角色不在白名单时拦截；
    // 未声明 rbac_roles / 角色未识别（含 bootstrap 旁路）→ 放行（向后兼容阶段1）
    if (!ctx.bootstrap && Array.isArray(def.rbac_roles) && def.rbac_roles.length) {
      const role = await actorRole(ctx);
      if (!role || !def.rbac_roles.includes(role.role_tag)) {
        emit('trace', 'action-permission-denied', { action: actionName, actor: ctx.actor, role: role?.role_tag });
        return { ok: false, gate: 'permission_denied', error: `第1.5闸: 角色 ${role?.role_tag || 'unidentified'} 无权执行 ${actionName}` };
      }
    }
    // 写通道第 1.7 闸（套餐功能门槛 plan_entitlement，计费域设计 §6）：
    //   仅当 Action 显式声明 requiresEntitlement 时校验当前租户档位是否解锁对应权益；
    //   缺权益 → fail-closed 拦截（提示升级套餐）；解析异常 → fail-open（不误杀主链路）。
    //   豁免：ctx.bootstrap（系统种子）；**显式** system 租户恒全权益（resolveEntitlements 内已豁免）。
    //   P1-1（2026-09-06）：原 `ctx.tenantId || 'system'` 兜底使「缺租户」静默获得全权益，闸门可被绕过
    //     → 改为缺 tenantId 即 fail-closed 拒绝（不阻断=不设防），并 emit trace 便于补齐调用点。
    if (!ctx.bootstrap && Array.isArray(def.requiresEntitlement) && def.requiresEntitlement.length) {
      const gateTenantId = ctx.tenantId;
      if (!gateTenantId) {
        emit('trace', 'action-plan-missing-tenant', { action: actionName, requires: def.requiresEntitlement });
        return {
          ok: false,
          gate: 'plan_entitlement_missing_tenant',
          error: `第1.7闸: 执行上下文缺 tenantId，无法确定套餐权益（需 ${def.requiresEntitlement.join(',')}）`,
        };
      }
      try {
        const { resolveEntitlements } = await import('../billing/entitlements.js');
        const ents = await resolveEntitlements(gateTenantId);
        const missing = def.requiresEntitlement.filter((k) => !ents.has(k));
        if (missing.length) {
          emit('trace', 'action-plan-blocked', { action: actionName, tenant: gateTenantId, missing });
          return { ok: false, gate: 'plan_entitlement', error: `第1.7闸: 当前套餐未解锁权益 ${missing.join(',')}，请升级套餐` };
        }
      } catch {
        /* fail-open：权益解析失败不阻断主写 */
      }
    }
    // 写通道第 2.5 闸（字段级 RBAC，设计 §6.3）：data-particle-update 逐字段核 meta_attr.permission
    if (!ctx.bootstrap && def.name === 'data-particle-update' && params?.patch) {
      const role = await actorRole(ctx);
      if (role?.role_tag) {
        const ptype = params.type || await inferParticleType(params.id);
        const verdict = await checkPatchPermissions(ptype, params.patch, role.role_tag);
        if (!verdict.ok) {
          emit('trace', 'action-field-permission-blocked', { action: actionName, actor: ctx.actor, field: verdict.field, mode: verdict.mode });
          return { ok: false, gate: 'field_permission', error: `第2.5闸: ${verdict.reason || ''}` };
        }
      }
    }
    // 写通道第 2 闸（force 双闸 + 对话式写白名单，R6/C2）：在第 1.5 闸之后、实际写 emit 之前
    // 1) force 双闸：R6 高危写操作必须显式 params.force===true（403 语义，不执行、不改状态）
    if (def.force && !(params && params.force === true)) {
      emit('trace', 'action-force-blocked', { action: actionName, actor: ctx.actor });
      return { ok: false, gate: 'needs_force', error: '第2闸: 高危写操作需 force=true' };
    }
    // 2) 写白名单闸：对话入口（channel==='conversational'）的非白名单写操作默认拒绝
    //    豁免：bootstrap（系统种子）/ authorizedWrite（HITL/系统显式授权）/ autoDecision（自身 mint decision）
    if (def.kind === 'write' && !ctx.bootstrap && ctx.channel === 'conversational'
        && !isWriteWhitelisted(actionName) && !ctx.authorizedWrite) {
      emit('trace', 'action-write-whitelist-blocked', { action: actionName, actor: ctx.actor });
      return { ok: false, gate: 'write_whitelist', error: '第2闸: 写操作不在对话式白名单内' };
    }
    // 写通道第 3 闸（HITL 审批流，总体设计 §8.3-③ / 12 文档 §7-5 / borrowings §T-2.5）：
    // needsApproval:true 的高危写必须经审批流通过后的显式放行（ctx.approvalPassed）才执行
    // 豁免：bootstrap（系统引导）/ approvalPassed（审批流通过后的执行路径：submit→approve→exec 链）
    if (def.kind === 'write' && def.needsApproval && !ctx.bootstrap && !ctx.approvalPassed) {
      emit('trace', 'action-approval-blocked', { action: actionName, actor: ctx.actor, reason: 'needs_approval' });
      return { ok: false, gate: 'approval_required', error: '第3闸: 该写操作需经 HITL 审批流通过后才能执行（approvalPassed=true）' };
    }
    // 写通道第 3.5 闸（阶段推进前置，设计 §7）：仅 crm-deal-advance 生效
    // 语义：soft gate——输出 gap 提示不硬拦；硬拦仅当缺口为「硬缺口」（无需求事实/BANTCC 硬维缺失）
    // 消费方：skills/method-stage-progression/rules/gates.md（P1-P6 advance_gate）
    // 实现要点：crm-deal-advance 为 autoDecision（ctx.decision_id 为空）且参数无 from_stage
    //   → 现查 DEAL 粒子 payload.stage 作为当前阶段（P1-P6 为方法论文档阶段，落 payload.stage）
    if (def.name === 'crm-deal-advance' && !ctx.bootstrap && params?.deal_id && params?.to_stage) {
      try {
        const deal = await getParticle(params.deal_id);
        // 阶段码归一：DB/入参可能是英文别名或遗留 P 码，统一成 S 码再匹配第3.5闸
        const curStage = toStageCode(deal?.payload?.stage) || deal?.payload?.stage || null;
        const toStage = toStageCode(params.to_stage) || params.to_stage || null;
        const dealPayload = deal?.payload || {};
        const v = salesStageGate({ curStage, toStage, dealPayload });
        if (!v.ok) {
          emit('trace', 'sales-stage-gate-blocked', { action: actionName, actor: ctx.actor, curStage, toStage, gaps: v.gaps });
          return { ok: false, gate: 'sales_prereq', error: `第3.5闸: ${v.gaps.join(';')}` };
        }
        if (v.warnings?.length) {
          ctx.salesWarnings = v.warnings;
          emit('trace', 'sales-stage-gate-soft', { action: actionName, actor: ctx.actor, curStage, toStage, warnings: v.warnings });
        }
      } catch { /* 查粒子失败 fail-open（不误杀）；后续写审计正常走 */ }
    }
    // 写通道第 3.6 闸（2026-08-30 三分类 C 类 C6）：商机三要素闸
    // 触发：data-particle-create + CRM_DEAL + 非 lead 阶段
    // 校验 bantcc.* 三维（budget/authority/timetable，与 P3→P4 闸同源字段）；兼容 ai.bantcc_completeness 已评估
    // 语义（用户确认 B 方案）：三要素 = BANTCC 的 B(预算)/A(责任人)/T(时间表)，与 P3→P4 同源
    // 判据抽为导出纯函数 salesDealPrereq（零 DB、可单测）；dispatch 内联调用
    if (def.name === 'data-particle-create' && !ctx.bootstrap
        && (params?.type === 'CRM_DEAL' || params?.particle_type === 'CRM_DEAL')) {
      const v = salesDealPrereq(params?.payload || {});
      if (!v.ok) {
        emit('trace', 'sales-deal-prereq-blocked', { action: actionName, actor: ctx.actor, missing: v.missing });
        return { ok: false, gate: 'sales_deal_prereq', error: `商机三要素缺失（${v.missing.join('/')}）` };
      }
    }
    if (def.kind === 'write') {
      emit('trace', 'action-write-requested', {
        action: actionName, actor: ctx.actor, decision_id: ctx.decision_id || null, params,
      });
      // 10-能力审计单点（V5 写通道必经）：写 Action 请求落审计（fail-open 不阻断）
      await recordAudit({
        target_particle_type: def.particleType || inferParticleTypeFromParams(params),
        source: 'action', action: `${actionName}:requested`, actor: ctx.actor || 'system',
        decision_id: decisionId, payload: { params },
      });
    }
    try {
      const data = await def.handler(params, ctx);
      if (def.kind === 'write') {
        emit('trace', 'action-write-executed', {
          action: actionName, actor: ctx.actor, ok: true, decision_id: ctx.decision_id || null,
        });
        // 10-能力审计单点（V5 写通道必经）：写 Action 执行成功落审计（fail-open 不阻断）
        await recordAudit({
          target_particle_type: def.particleType || inferParticleTypeFromParams(params),
          source: 'action', action: `${actionName}:executed`, actor: ctx.actor || 'system',
          decision_id: decisionId, payload: { result_summary: (data && data.id) ? { id: data.id } : {} },
        });
        // 09-V6 token-业务对账：写 Action 执行成功计量 token（ctx.tokensIn/Out，未提供则 0；
        // fail-open：计量失败不阻断主写——与审计同纪律）
        await recordTokens({
          actor: ctx.actor || 'system', action: actionName,
          // P0-2（2026-09-06）：优先显式 ctx.tokensIn/Out，回退本次运行的 LLM 真实累加值（ctx.tokenMeter，
        //   由 agentLoop 经 metering.onUsage 累积）。原实现两者皆无 → 计量恒 0。
        tokensIn: ctx.tokensIn ?? ctx.tokenMeter?.in ?? 0,
        tokensOut: ctx.tokensOut ?? ctx.tokenMeter?.out ?? 0,
          source: 'llm', decision_id: decisionId,
          tenantId: ctx.tenantId || 'system',
          module: ctx.module || 'core',
        });
      }
      return { ok: true, data, action: actionName, confirm: def.confirm || null };
    } catch (e) {
      if (def.kind === 'write') {
        emit('trace', 'action-write-failed', { action: actionName, error: e.message });
        // 10-能力审计单点（V5 写通道必经）：写 Action 失败落审计（fail-open 不阻断）
        await recordAudit({
          target_particle_type: def.particleType || inferParticleTypeFromParams(params),
          source: 'action', action: `${actionName}:failed`, actor: ctx.actor || 'system',
          decision_id: decisionId, payload: { error: e.message },
        });
      }
      return { ok: false, error: e.message, action: actionName };
    }
  },
};

// 第 3.5 闸纯函数（直接测试入口）：阶段推进前置检查（soft/hard 语义）
// 消费 side：dispatch crm-deal-advance 内联调用；hard 缺口（无需求事实/BANTCC<0.6/无方案验证）→ 拦截
// soft 缺口（如 P4→P5 无合同签署事实）→ 仅 warnings 提示不拦截
// 事实源：skills/method-stage-progression/methodology.json（stages[].advance_gate）
// 阶段命名（用户规格）：S1 线索发掘→S2 需求确认→S3 方案匹配→S4 报价谈判→S5 合同确认→S6 赢单移交（S7 输单/S8 丢单 退出态）
//   门控逻辑对齐 v0.3「两关 + BANTCC」：S2→S3 复用两关闸、S3→S4 复用 BANTCC 资质闸
//   第 3.5 闸单一事实源：src/sales/stageTaxonomy.js（S_GATE_DEFS / S_ATTACHMENT_GATES）；本处为其机器可读 check 实现

// S1-S6 advance_gate 机器可读实现（与 SKILL methodology.json / stageTaxonomy.S_GATE_DEFS 逐条对齐）
const STAGE_GATES = [
  {
    from: 'S1', to: 'S2', hard: true,
    check: (p, th) => {
      const needs = p.needs || {};
      const min = readThreshold(th, 'gate.s1_s2_min_need_facts');
      const filled = ['product', 'qty', 'spec'].filter((k) => needs[k]).length;
      return filled >= min ? null : `缺客户需求事实（needs product/qty/spec 至少${min}项）`;
    },
  },
  {
    from: 'S2', to: 'S3', hard: true,
    check: (p) => {
      const ai = p.ai || {};
      const v = ai.sales_visit_value;
      const ok = (typeof v === 'object') ? Boolean(v.value) : Boolean(v);
      return ok ? null : '方案验证拜访未被判有价值（sales_visit_value=false）';
    },
  },
  {
    // SWAS soft 闸——不硬拦，仅提示（避免卡死推进）
    // swas_completeness < swas.soft_warn_below 时提示「未做商机回顾」
    from: 'S2', to: 'S3', hard: false,
    check: (p, th) => {
      const ai = p.ai || {};
      const comp = ai.swas_completeness;
      const completeness = typeof comp === 'object' ? Number(comp.value ?? 1) : Number(comp ?? 1);
      const softBelow = readThreshold(th, 'swas.soft_warn_below');
      if (completeness < softBelow) {
        return `未做商机回顾（SWAS 齐全度 ${completeness} < ${softBelow}），建议先补 SWAS——soft 提示`;
      }
      return null;
    },
  },
  {
    from: 'S3', to: 'S4', hard: true,
    check: (p, th) => {
      const ai = p.ai || {};
      // BANTCC 阈值走配置（与 21 条 03-01 同源，杜绝三处各写一遍）
      const pass = readThreshold(th, 'bantcc.pass');
      const unknown = readThreshold(th, 'bantcc.unknown');
      const bantccVal = ai.bantcc_completeness;
      const bantcc = typeof bantccVal === 'object' ? Number(bantccVal.value ?? unknown) : Number(bantccVal ?? unknown);
      if (bantcc < pass) {
        // 定位缺哪一维：优先读已落库的 ai.bantcc_detail，缺失时现算（确定性兜底，零 DB）
        let detail = (ai.bantcc_detail && typeof ai.bantcc_detail === 'object') ? ai.bantcc_detail.value : null;
        if (!detail || typeof detail !== 'object') {
          try { detail = deterministicEval('CRM_DEAL', p, { key: 'bantcc_detail' })?.value; } catch { detail = null; }
        }
        const missing = detail
          ? Object.entries(detail).filter(([, v]) => Number(v) < pass).map(([k]) => k)
          : [];
        return missing.length
          ? `BANTCC 硬维缺口（<${pass} 禁止推 S4）：缺 ${missing.join('、')}`
          : `BANTCC 硬维缺口（<${pass} 禁止推 S4）`;
      }
      const hasQuote = Boolean(p.quotation_refs?.length || p.has_quotation || p.quotation_id);
      return hasQuote ? null : '缺报价事实（quotation_refs/has_quotation）';
    },
  },
  {
    from: 'S4', to: 'S5', hard: true, // 2026-08-30 三分类 C 类：证据缺口硬拦（review-gate/合同事实任一存在即放行）
    check: (p) => {
      const approved = Boolean(
        p.review_gate_decision === 'approved' ||
        (p.decisions || []).some(d => d.scene === 'REVIEW_GATE' && d.disposition === 'approved')
      );
      // 证据兜底（软事实硬闸）：任一证据存在即放行——review-gate 通过 / 合同事实 / 预计下单时间
      // 设计文档 §3.1 明确「contract_facts/signed_at/contract_no/order_date ... 任一存在即过关」（或关系，非叠加）
      if (approved) return null;
      const hasContractFacts = Boolean(p.contract_facts || p.signed_at || p.contract_no);
      const orderDate = p.swas?.schedule?.order_date;
      if (hasContractFacts || orderDate) return null;
      const parts = [];
      parts.push('缺 review-gate 通过记录与合同签署事实');
      parts.push('缺预计下单时间（swas.schedule.order_date）');
      return parts.join('；') + '——hard 拦截（软事实硬闸：任一证据存在即放行）';
    },
  },
  {
    from: 'S5', to: 'S6', hard: true, // 2026-08-30 三分类 C 类：合同+全款未落事实硬拦
    check: (p) => {
      const signed = Boolean((p.contract_no && p.signed_at) || p.delivery_accepted_at);
      const paid = Boolean(p.paid_at || p.payment_received);
      if (signed && paid) return null;
      const parts = [];
      if (!signed) parts.push('合同未签署/未验收');
      if (!paid) parts.push('未收到全款');
      return `${parts.join('、')}——hard 拦截（合同+全款事实缺一不可）；S3→S4 BANTCC 兜底`;
    },
  },
];

// 阶段门禁（强制附件）：S_ATTACHMENT_GATES 定义某推进边必须存在的 tagged attachment，缺则 hard 阻断
function hasTaggedAttachment(p, tag) {
  return Array.isArray(p.attachments) && p.attachments.some((a) => a && a.tag === tag);
}

export function salesStageGate({ curStage, toStage, dealPayload = {}, thresholds = DEFAULT_THRESHOLDS } = {}) {
  const gaps = [];
  const warnings = [];
  for (const g of STAGE_GATES) {
    if (g.from !== curStage || g.to !== toStage) continue;
    const msg = g.check(dealPayload, thresholds);
    if (!msg) continue;
    if (g.hard) gaps.push(msg);
    else warnings.push(msg);
  }
  // 阶段门禁（强制附件）：缺 tagged attachment → hard 阻断（即便其它闸放行，缺附件也拦截）
  const attachDef = S_ATTACHMENT_GATES[`${curStage}->${toStage}`];
  if (attachDef && !hasTaggedAttachment(dealPayload, attachDef.tag)) {
    gaps.push(`缺阶段门禁附件「${attachDef.label}」（tag=${attachDef.tag}）——hard 拦截`);
  }
  const hard = gaps.length > 0;
  return hard ? { ok: false, gate: 'sales_prereq', gaps, warnings: [] } : { ok: true, gaps: [], warnings };
}

// C6 商机三要素闸判据（2026-08-30 三分类 C 类）：零 DB 纯函数
// 语义：B(预算)/A(责任人)/T(时间表) 三维任一非空即达标；兼容 ai.bantcc_completeness 已评估兜底
// lead/线索阶段豁免（线索不进要素闸）；阈值走 readThreshold('bantcc.pass')，出厂默认 0.6
export function salesDealPrereq(payload = {}) {
  const raw = payload.stage || payload.state || 'S1';
  const stage = toStageCode(raw) || raw; // lead/线索别名→S1；S1 保持；未知值原样（走后续要素闸）
  if (stage === 'S1' || raw === '线索') return { ok: true, missing: [] };
  const b = payload.bantcc || {};
  const aiComp = Number(payload.ai?.bantcc_completeness?.value ?? 0);
  const pass = readThreshold(DEFAULT_THRESHOLDS, 'bantcc.pass', 0.6);
  const bOk = b.budget_ok === true || (b.budget != null && String(b.budget) !== '');
  const aOk = b.authority_ok === true || (b.authority != null && String(b.authority) !== '');
  const tOk = b.timetable_ok === true || b.schedule != null || b.timeline != null;
  if ((bOk && aOk && tOk) || aiComp >= pass) return { ok: true, missing: [] };
  const missing = [];
  if (!bOk) missing.push('预算');
  if (!aOk) missing.push('责任人');
  if (!tOk) missing.push('时间表');
  return { ok: false, missing };
}

// 由 id/type 反查粒子类型（字段闸需 particle_type；查询失败放行，数据闸兜底）
async function inferParticleType(idOrType) {
  if (!idOrType) return null;
  const r = await query(`SELECT type FROM crm.particles WHERE (id::text=$1 OR slug=$1) LIMIT 1`, [idOrType]);
  return r.rows[0]?.type || null;
}

// 由写 Action 参数推断目标粒子类型（审计挂点用；无推断返回 null 不阻断）
function inferParticleTypeFromParams(params = {}) {
  if (params?.type) return params.type;
  if (params?.particle_type) return params.particle_type;
  if (params?.deal_id) return 'CRM_DEAL';
  if (params?.account_id) return 'CRM_ACCOUNT';
  if (params?.contact_id) return 'CRM_CONTACT';
  if (params?.quote_id) return 'CRM_QUOTATION';
  if (params?.contract_id) return 'CRM_CONTRACT';
  if (params?.invoice_id) return 'CRM_INVOICE';
  if (params?.order_id) return 'CRM_ORDER';
  return null;
}
