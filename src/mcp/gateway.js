// src/mcp/gateway.js — MCP 请求闸（读直连 / 敏感读 confirm / 写两阶段 + action-confirm + 决策第0闸 + 降级显式弹窗）
// 设计输入：总体设计 §6.13 + docs/2026-08-26-crm-role-confirm-permission-design.md
import { actionExecutor } from '../action/executor.js';
import { getAction } from '../action/registry.js';
import { emit } from '../events/bus.js';
import { extractToken, buildMcpCtx } from './auth.js';
import { resolveEffectiveRole } from './intent.js';
import { MCP_CONFIG } from './config.js';
import { requireDecision } from '../decision/autonomyEngine.js';
import { resolveEntitlements } from '../billing/entitlements.js';
import { advise } from '../decision/adviseService.js';

const SWITCH_OPTIONS = ['sales', 'manager', 'presales', 'exec', 'finance', 'contract_admin'];
const CONFIRM_TTL_MS = 10 * 60 * 1000;

const confirmSessions = new Map(); // confirm_token → { action, kind, params, actor, role, expiresAt }

function hashParams(params = {}) { try { return JSON.stringify(params); } catch { return String(params); } }

// 协议位（不参与业务参数合并/冲突判定）：这些键由 MCP 传输层或本模块自身消费
// force 不在此列（2026-09-09 修复）：executor 第 2 闸（R6 高危写 force 双闸）读 params.force，
//   若把 force 列为协议位，mergePhase2Params 遍历时 continue 跳过 → force 永不进 execParams →
//   data-particle-update（force:true）经 MCP 通道恒被 needs_force 拒绝（回归根因，17c8faf 引入）。
//   故 force 作为业务执行参数随 phase2 增补合并，参与第 2 闸判定。
const PROTOCOL_KEYS = new Set(['confirm_token', 'api_token', 'choice', 'switched_role', 'utterance', 'decision_id']);

// phase2 参数合并：**只增补、禁止覆盖**（confirm 语义保护，2026-09-09）
// 背景：原实现（:253）执行时一律用 session.params（phase1 冻结值），phase2 传入的 params 仅用于
//   extractToken → 用户在 phase2 补的扩展明细（如基础/标准档定价明细）被**静默丢弃**。
// 语义取舍：
//   ① 全量合并 → 用户确认 A、实际执行 B，confirm 闸门形同虚设（否决）；
//   ② 严格拒绝一切额外参数 → 安全但体验差，补明细必须重走 phase1；
//   ③ 只增补、禁覆盖（采用）：已展示给用户的键不可改写（hashParams 比对，不一致即拒绝并要求重发确认），
//      phase1 未出现的键允许补入 —— 兼顾 confirm 语义完整性与分段提交的可用性。
export function mergePhase2Params(session, phase2 = {}) {
  const p1 = session.params || {};
  const added = {};
  let conflict = null;
  for (const [k, v] of Object.entries(phase2 || {})) {
    if (PROTOCOL_KEYS.has(k)) continue;                       // 协议位不参与业务参数合并
    if (!Object.prototype.hasOwnProperty.call(p1, k)) { added[k] = v; continue; }  // 新键 → 允许增补
    if (hashParams(p1[k]) !== hashParams(v)) { conflict = k; break; }              // 覆盖已展示字段 → 冲突
  }
  return { params: { ...p1, ...added }, conflict, added: Object.keys(added) };
}

// ─── 套餐权益闸：MCP 通道整体（2026-09-06 交付补齐）─────────────────────────────────────────
// 设计依据：docs/2026-09-06-billing-gate-repair-design.md §7 映射表
//   「mcp_access | MCP 通道整体（在 gateway 层校验，不逐 Action 声明）」
// 口径与 Action 第 1.7 闸（src/action/executor.js:91-113）保持一致：
//   - system 平台身份恒豁免（resolveEntitlements 同口径）
//   - 缺 tenantId → fail-closed（拒绝，不静默按 system 放行）
//   - 未解锁 mcp_access → 拒绝并给出可行动的升级提示
export async function assertMcpAccess(ctx) {
  const tid = ctx?.tenantId ?? null;
  if (!tid) {
    emit('trace', 'mcp-entitlement-missing-tenant', { channel: 'mcp', actor: ctx?.actor ?? null });
    return { ok: false, gate: 'mcp_entitlement_missing_tenant', error: 'MCP 通道缺少租户上下文，无法校验 mcp_access 权益' };
  }
  if (tid === 'system') return { ok: true, exempt: true };
  try {
    const ents = await resolveEntitlements(tid);
    if (!ents.has('mcp_access')) {
      emit('trace', 'mcp-entitlement-denied', { tenant_id: tid, channel: 'mcp' });
      return { ok: false, gate: 'mcp_entitlement', error: '当前套餐未解锁 MCP 接入权益（mcp_access），请升级套餐后重试' };
    }
    return { ok: true };
  } catch (e) {
    // 权益解析异常 fail-open（与 executor 第 1.7 闸同范式：不误杀通道，留痕由闸二次判定）
    emit('trace', 'mcp-entitlement-error', { tenant_id: tid, error: String(e?.message || e) });
    return { ok: true, degraded: true };
  }
}

// 降级显式弹窗（对齐 CordysCRM 截图；AI 绝不接收/显示明文）
export function buildDegradedPrompt() {
  return [
    '⚠️ 角色/凭证信息不全，已自动降级为 sales 只读模式',
    '',
    '为安全起见，请选择以下任一方式补全凭证（AI 永远不在对话中接收或显示密钥明文）：',
    '  1 我创建 .env 框架（推荐）→ AI 给模板，你填好后放 ~/.crm-native/.env，重启 MCP server',
    '  2 我已设置环境变量 → 执行 echo $env:CRM_API_TOKEN.Substring(0,4)，把前 4 位回复给我（仅前 4 位）',
    '  3 给我 PowerShell 命令 → AI 给 Set-Item Env:\\CRM_API_TOKEN 命令，你复制执行（AI 看不到明文）',
    '  4 其他补充...',
    '',
    '任务流已标"待确认"（橙色 badge）。',
  ].join('\n');
}

// 商机推进第0闸业务提问：真实阶段跃迁动态化（2026-09-02）
// 设计意图：crm-deal-advance 为通用推进 Action（autoDecision），S2→S3 等非 P1→P2 边同样适用；
//   文案不可写死「P1→P2」（P1-P6 仅是方法论显示别名，阶段跃迁是 S1-S8 真实码）。
// 语义闸：to_stage 须为合法 S 码（S_STAGES），否则回退通用文案（不误报具体阶段）。
import { S_STAGES, S_LABEL } from '../sales/stageTaxonomy.js';
function buildAdvanceQuestion(toStage) {
  if (!toStage || !S_STAGES.includes(toStage)) {
    return `推进商机为自动决策，将由您确认后由系统生成决策凭证并完成写入。`;
  }
  return `是否将商机推进到 ${toStage}（${S_LABEL[toStage] || ''}）阶段？推进商机为自动决策，将由您确认后由系统生成决策凭证并完成写入。`;
}

// MCP 写入参反查 involved_entities（对齐 executor.js:31 inferEntities 的 [{type,id}] 形态）
// gateway 侧零 DB 轻量版：创建类写入（含 data-particle-create）无既有实体 → 空数组（与既有
//   autoDecision 路径同属性；决策仍 mint，实体锚定由后续事件/边补齐）
function inferMcpEntities(params = {}) {
  if (params.deal_id) return [{ type: 'CRM_DEAL', id: params.deal_id }];
  if (params.contract_id) return [{ type: 'CRM_CONTRACT', id: params.contract_id }];
  if (params.account_id) return [{ type: 'CRM_ACCOUNT', id: params.account_id }];
  if (params.contact_id) return [{ type: 'CRM_CONTACT', id: params.contact_id }];
  if (params.invoice_id) return [{ type: 'CRM_INVOICE', id: params.invoice_id }];
  if (params.order_id) return [{ type: 'CRM_ORDER', id: params.order_id }];
  return [];
}

function issueSession(action, kind, params, ctx) {
  const tokenValue = `ct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  confirmSessions.set(tokenValue, {
    action, kind, params,
    actor: ctx.actor, role: ctx.role,
    expiresAt: Date.now() + CONFIRM_TTL_MS,
  });
  return tokenValue;
}

// 拼装 confirm 表单（写 + 敏感读共用）；focus_domain 由意图校正引擎注入（透明展示本次操作视角，不升权）
function buildConfirmForm(actionName, def, ctx, params, focusDomain = null) {
  return {
    code: 'CONFIRM_REQUIRED',
    action: actionName,
    kind: def.kind,
    actor: ctx.actor,
    role: ctx.role,
    focus_domain: focusDomain,
    switch_options: SWITCH_OPTIONS,
    decision_id: ctx.decision_id || params?.decision_id || null,
    task_id: params?.task_id || null,
    impact_scope: def.data_scope_domains || null,
  };
}

// 写 phase1：决策第 0 闸 → 降级软提示（仍发 confirm_token，符合 §6「写仍走 action-confirm」）→ 不执行
export async function mcpWritePhase1(actionName, params = {}, headers = {}) {
  // 对话诉求原文：MCP 协议级透传（tools.js protocolShape 已声明，否则被 zod strip）。
  // 取出后立即从 params 删除——D2 铁律：对话原文零落库，不得随写参数进入粒子 payload。
  const utteranceText = typeof params?.utterance === 'string' ? params.utterance : '';
  if (params && Object.prototype.hasOwnProperty.call(params, 'utterance')) delete params.utterance;
  const token = extractToken(params, headers);
  const ctx = await buildMcpCtx({ token, channel: 'mcp', decisionId: params?.decision_id || null });
  if (MCP_CONFIG.security.requireAuth && ctx.degraded) {
    return { ok: false, gate: 'auth_required',
      error: '首次接入请先调用 crm_login(username,password) 完成用户名密码验证',
      hint: 'crm_login 返回的 token 于后续工具调用携带：api_token=<token> 或 Authorization: Bearer <token>' };
  }
  // 套餐权益闸（2026-09-06 交付补齐）：MCP 通道整体受 mcp_access 控制，在 gateway 层统一校验
  {
    const ent = await assertMcpAccess(ctx);
    if (!ent.ok) return { ok: false, gate: ent.gate, error: ent.error };
  }
  // 2026-09-04 MCP 建档通道（用户拍板）：Action 声明 decisionScenario → gateway 代为 mint 决策。
  //   设计取舍：mint 放在 gateway（仅 MCP 通道）而非 executor——executor 第 0 闸维持
  //   「无 decision_id 且非 bootstrap → 拒绝」原语义不变（test/action.test.js:125、
  //   decision-gate.test.js:11 锚定），避免通用 substrate 写入口被放宽后波及 REST/UI/seed 全链路。
  //   未声明 decisionScenario 的写 Action（如 crm-deal-advance / crm-asset-attach）行为完全不变。
  const def = getAction(actionName);
  if (!params?.decision_id && def?.decisionScenario) {
    try {
      const d = await requireDecision(
        def.decisionScenario,
        { action: actionName, ...params, actor: ctx.actor },
        inferMcpEntities(params),
        { actor_id: ctx.actor },
      );
      const did = d?.decision?.decision_id;
      if (did) {
        params = { ...params, decision_id: did };
        ctx.decision_id = did;
        emit('decision', `${actionName}-mcp-mint`, { decision_id: did, scenario: def.decisionScenario });
      } else {
        emit('trace', 'mcp-write-decision-mint-empty', { action: actionName, scenario: def.decisionScenario });
      }
    } catch (e) {
      // mint 失败 fail-safe：留痕后退回原 DECISION_NEEDED 语义，绝不「无决策放行」
      emit('trace', 'mcp-write-decision-mint-failed', {
        action: actionName, scenario: def.decisionScenario, error: e.message,
      });
    }
  }
  if (!params?.decision_id) {
    emit('trace', 'mcp-write-blocked-no-decision', { action: actionName });
    // 2026-09-02 用户指示：第0闸提示从「技术语言（携带 decision_id）」改为「业务提问（推进决策）」
    // 设计落点：推进商机（crm-deal-advance）为 autoDecision Action——引擎（或升级人工）自动 mint 决策，
    //   无需外部 decision_id（对齐 test/decision-gate.test.js:33-51）。因此提示面向用户问「是否推进」，
    //   由用户拍板后引擎产生决策 → 写放行；而非要求用户去页面手动创建决策（那是误导）。
    // 对话驱动建议（2026-09-08 T6）：第 0 闸阻断时同样产出建议——「缺决策依据」正是销售最需要建议的时刻。
    // fail-open：异常或无诉求文本时保持 null，绝不改变既有闸语义。
    let blockedAdvice = null;
    try {
      if (utteranceText) {
        // 阶段优先取显式 stage，其次推进类动作的 to_stage（如 crm-deal-advance 推进到 S4）
        const a = await advise({ utterance: utteranceText, ctx: { tenantId: ctx.tenantId }, deal: null, stage: params?.stage || params?.to_stage || null });
        blockedAdvice = a.advice;
      }
    } catch { blockedAdvice = null; }
    return {
      ok: false,
      advice: blockedAdvice,
      gate: 'decision_required',
      code: 'DECISION_NEEDED',
      // action 为商机推进类（autoDecision）→ 直接问推进；其余写 → 问是否发起对应决策
      question: actionName === 'crm-deal-advance'
        ? buildAdvanceQuestion(params?.to_stage)
        : `该写入需要决策依据。是否确认发起该业务动作并由您拍板？确认后将生成决策凭证（decision_id）并完成写入。`,
      error: '第0闸: 该写操作缺少决策依据（decision_id），需用户决策后放行。',
    };
  }
  if (!def || def.kind !== 'write') return { ok: false, error: `未知写 Action: ${actionName}` };
  const intent = await resolveEffectiveRole(ctx.role, actionName, ctx.scopes || {});
  ctx.focus_domain = intent.focus_domain;
  ctx.over_scope = intent.over_scope;
  const confirm_token = issueSession(actionName, 'write', params, ctx);
  emit('trace', 'mcp-write-phase1-confirm-issued', { action: actionName, actor: ctx.actor, focus_domain: intent.focus_domain });
  // 降级软提示：仍发 confirm_token，但附带 prompt 让客户端显式提示补完凭证（不硬阻断写）
  const extra = (ctx.degraded && ctx.prompt_needed) ? { degraded: true, prompt: buildDegradedPrompt() } : {};
  // 对话驱动建议（2026-09-08 T6）：仅附加字段，不改变 confirm_token 与闸语义；fail-open（异常不阻断）
  let advice = null;
  try {
    const a = await advise({ utterance: utteranceText, ctx: { tenantId: ctx.tenantId }, deal: null, stage: params?.stage || params?.to_stage || null });
    advice = a.advice;
  } catch { advice = null; }
  return { ok: true, confirm_token, ...extra, advice, form: { ...buildConfirmForm(actionName, def, ctx, params, intent.focus_domain), degraded: ctx.degraded } };
}

// 敏感读 phase1：无决策闸，仅 confirm（读不写）；降级同样软提示
export async function mcpReadSensitivePhase1(actionName, params = {}, headers = {}) {
  const token = extractToken(params, headers);
  const ctx = await buildMcpCtx({ token, channel: 'mcp', decisionId: null });
  if (MCP_CONFIG.security.requireAuth && ctx.degraded) {
    return { ok: false, gate: 'auth_required',
      error: '首次接入请先调用 crm_login(username,password) 完成用户名密码验证',
      hint: 'crm_login 返回的 token 于后续工具调用携带：api_token=<token> 或 Authorization: Bearer <token>' };
  }
  // 套餐权益闸（2026-09-06 交付补齐）：MCP 通道整体受 mcp_access 控制，在 gateway 层统一校验
  {
    const ent = await assertMcpAccess(ctx);
    if (!ent.ok) return { ok: false, gate: ent.gate, error: ent.error };
  }
  const def = getAction(actionName);
  if (!def || def.kind !== 'read_sensitive') return { ok: false, error: `未知敏感读 Action: ${actionName}` };
  const intent = await resolveEffectiveRole(ctx.role, actionName, ctx.scopes || {});
  ctx.focus_domain = intent.focus_domain;
  ctx.over_scope = intent.over_scope;
  const confirm_token = issueSession(actionName, 'read_sensitive', params, ctx);
  const extra = (ctx.degraded && ctx.prompt_needed) ? { degraded: true, prompt: buildDegradedPrompt() } : {};
  return { ok: false, code: 'CONFIRM_REQUIRED', confirm_token, ...extra, form: { ...buildConfirmForm(actionName, def, ctx, params, intent.focus_domain), degraded: ctx.degraded } };
}

// 统一 phase2：choice 1 执行 / 2 切换角色 / 3 取消
export async function mcpConfirmPhase2(confirmToken, choice = '1', switchedRole = null, params = {}, headers = {}) {
  const session = confirmSessions.get(confirmToken);
  if (!session || session.expiresAt < Date.now()) {
    confirmSessions.delete(confirmToken);
    return { ok: false, gate: 'confirm_expired', error: 'confirm_token 无效或已过期' };
  }
  if (choice === '3') {
    confirmSessions.delete(confirmToken);
    return { ok: true, code: 'CANCELLED', message: '已取消，任务回到待确认前状态' };
  }
  let role = session.role;
  if (choice === '2' && switchedRole) {
    const def = getAction(session.action);
    if (Array.isArray(def?.rbac_roles) && def.rbac_roles.length && !def.rbac_roles.includes(switchedRole)) {
      confirmSessions.delete(confirmToken);
      return { ok: false, gate: 'permission_denied', error: `第1.5闸: 角色 ${switchedRole} 无权执行 ${session.action}` };
    }
    role = switchedRole;
  }
  confirmSessions.delete(confirmToken); // 一次性消费
  // phase2 参数合并（只增补、禁覆盖）：执行前先合并，冲突则不执行（confirm 语义保护）
  const { params: execParams, conflict, added } = mergePhase2Params(session, params);
  if (conflict) {
    emit('trace', 'mcp-confirm-params-conflict', { action: session.action, field: conflict, actor: session.actor });
    return {
      ok: false, gate: 'confirm_params_conflict',
      error: `字段 ${conflict} 与确认时展示的值不一致，已拒绝执行（confirm 语义保护）`,
      hint: '如需修改已确认的字段，请重新发起一次工具调用走完整确认流程',
    };
  }
  const ctx = await buildMcpCtx({ token: extractToken(params, headers), channel: 'mcp', decisionId: session.params?.decision_id });
  ctx.role = role; // 应用切换后的角色
  if (added.length) emit('trace', 'mcp-confirm-params-augmented', { action: session.action, added, actor: session.actor });
  const r = await actionExecutor.dispatch(session.action, execParams, ctx);
  emit('trace', 'mcp-confirm-executed', { action: session.action, ok: r.ok, role });
  return r;
}

export async function mcpConfirmCancel(confirmToken) {
  if (confirmSessions.delete(confirmToken)) return { ok: true, code: 'CANCELLED' };
  return { ok: false, gate: 'confirm_expired', error: 'confirm_token 无效或已过期' };
}

// 读直连：仅 kind==='read' 直接 dispatch（降级 sales 仍允许只读直连，符合 §6「读直连，写仍走 action-confirm」）
// read_sensitive 不应经此入口（由 mcpReadSensitivePhase1 接管，需 confirm）
export async function mcpReadDirect(actionName, params = {}, headers = {}) {
  const token = extractToken(params, headers);
  const ctx = await buildMcpCtx({ token, channel: 'mcp', decisionId: null });
  if (MCP_CONFIG.security.requireAuth && ctx.degraded) {
    return { ok: false, gate: 'auth_required',
      error: '首次接入请先调用 crm_login(username,password) 完成用户名密码验证',
      hint: 'crm_login 返回的 token 于后续工具调用携带：api_token=<token> 或 Authorization: Bearer <token>' };
  }
  // 套餐权益闸（2026-09-06 交付补齐）：MCP 通道整体受 mcp_access 控制，在 gateway 层统一校验
  {
    const ent = await assertMcpAccess(ctx);
    if (!ent.ok) return { ok: false, gate: ent.gate, error: ent.error };
  }
  const def = getAction(actionName);
  if (def && def.kind === 'read') {
    const intent = await resolveEffectiveRole(ctx.role, actionName, ctx.scopes || {});
    ctx.focus_domain = intent.focus_domain;
    ctx.over_scope = intent.over_scope;
    const res = await actionExecutor.dispatch(actionName, params, ctx);
    // 对话驱动建议（2026-09-08 T6）：读结果附加建议卡；fail-open（异常原样返回，绝不阻断读）
    // 关键修正：若 handler 已在 data.advice 返回建议卡（如 crm-decision-advise 已结合 deal 算出红线/B档），
    // 必须沿用 handler 的结果提到顶层，绝不用 deal:null 重算覆盖（否则红线/approval_prefill 被丢弃，且 tier 被错误降级）。
    if (res?.data?.advice) return { ...res, advice: res.data.advice };
    try {
      const a = await advise({ utterance: params?.utterance || '', ctx: { tenantId: ctx.tenantId }, deal: null, stage: params?.stage || null });
      return { ...res, advice: a.advice };
    } catch { return res; }
  }
  return { ok: false, error: `未知读 Action: ${actionName}` };
}

// 兼容薄包装（保留旧 API，避免撕裂 server.js 与既有测试；新调用方请用 mcpConfirmPhase2）
export async function mcpWritePhase2(confirmToken, params = {}, headers = {}) {
  return mcpConfirmPhase2(confirmToken, '1', null, params, headers);
}

// hashParams 已接线（2026-09-09）：mergePhase2Params 用它做「已确认字段是否被改写」的冲突校验，不再是死代码。
