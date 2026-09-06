// src/agent/agentLoop.js — 执行循环：SKILL 驱动（只读 SKILL 步骤序列）+ LLM 降级（默认 think 规则回退）
// 设计输入：03 编排设计；复用 P2P agentLoop 模式（forceRule 主路 / LLM 路 / 降级回退）
import { getSkill, executeSkill } from '../skills/registry.js';
import { emit } from '../events/bus.js';
import { assembleContext } from '../context/assembler.js';
import { formatForPrompt } from '../context/injector.js';
import { recordEpisode } from './agentEpisodes.js';
import { getLlmThink } from '../llm/client.js';
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';

// 降级 think：LLM 不可用时的规则回退（P2P 已验证模式）
async function defaultThink(task, opts = {}) {
  return {
    action: task.payload?.paramAction || null,
    params: task.payload?.staticParams || {},
    reasoning: '[规则回退] LLM 未启用，走规则默认值',
    degraded: true,
    degradeReason: 'llm_disabled',
  };
}

// 上下文分层注入：组装 L1-L4 bundle 并格式化为 prompt 上下文块（降级不抛）
export async function buildContextBlock(task, ctx) {
  const bundle = await assembleContext(
    { actor: ctx?.actor, intent: task?.payload?.intent || {}, query: task?.payload?.query || task?.payload?.staticParams?.query || '', tenantId: ctx?.tenantId || 'system' }
  ).catch(() => ({ layers: {}, degraded: true, missing: {}, scopeModel: 'all' }));
  return { block: formatForPrompt(bundle), bundle };
}

// ─── A9 可审计性趋势闭环（只读监测，2026-08-31 物化设计 §9）───
// 读 crm.agent_sla 近 14 天物化快照，比较最新 vs 最早 auditability_pct：
// 恶化 ≥ dropThreshold（默认 15pt）→ emit('alert','auditability-regression')（事件域 alert，不写粒子）；
// 阈值与开关均走 config_store['auditability-sla-monitor']（阈值配置化铁律），缺失时用出厂默认。
// 处置动作由显式写 Action 触发（07 文档 §5-2），本函数只读 + 发射预警。
export async function auditabilityTrendMonitor() {
  const cfg = (await readConfig('auditability-sla-monitor', { tenantId: 'system' }).catch(() => null))?.value || {};
  if (cfg.enabled === false) return { skipped: true };
  const dropThreshold = Number(cfg.drop_threshold ?? 15);
  const days = Number(cfg.days ?? 14);
  const rows = (await query(
    `SELECT auditability_pct FROM crm.agent_sla
     WHERE measured_at >= now() - make_interval(days=>$1)
     ORDER BY measured_at ASC`,
    [days]
  )).rows.map((r) => Number(r.auditability_pct));
  if (rows.length < 2) return { scanned: rows.length, verdict: 'insufficient_history' };
  const newest = rows[rows.length - 1];          // 最新（ASC → 末尾）
  const oldest = rows[0];                        // 最早（窗口内）
  const drop = oldest - newest;                  // 负 = 恶化
  if (drop <= -dropThreshold) {
    emit('alert', 'auditability-regression', {
      from: oldest, to: newest, drop, threshold: dropThreshold,
      suggestion: '复盘未裁决冲突(Q3)与孤立决策(Q4),对齐 4 问审计闭环',
    });
    return { scanned: rows.length, verdict: 'regression', from: oldest, to: newest, drop };
  }
  return { scanned: rows.length, verdict: 'ok', from: oldest, to: newest };
}

export async function runWithSkill(task, opts = {}) {
  const { llmThink = null, onStep = null, ctx = { tenantId: 'system', actor: 'agent' } } = opts;
  // SKILL 派发接线（D4 修复 2026-09-01）：tasks 表无 skill_slug 列，旧逻辑恒回落 'crm-skill-fallback'，
  // 导致 5 个 agent 声明的 method-*/decision-retrospective 从未被真正调用（运行期 episode.skill 全为 fallback）。
  // 取值链：task.skill_slug（未来加列后生效）→ task.payload.skill_slug（调度器路由注入）→ fallback。
  const skillSlug = task.skill_slug || task.payload?.skill_slug || 'crm-skill-fallback';
  const skill = getSkill(skillSlug);
  if (!skill) throw new Error(`SKILL 不存在: ${skillSlug}`);

  // 未显式注入 llmThink → 自动取用 config_store('llm') 配置（首次 PUT 后生效）；
  // 未配置/失败 → null → 回退 defaultThink（llm_disabled 降级，行为不变）
  // P0-2（2026-09-06）：本次 agent 运行的真实 token 累加器，挂 ctx 供 Action 执行处回填
  //   （原 executor.js:201 的 ctx.tokensIn/Out 无人提供 → 恒 0，Action 级计量形同虚设）
  ctx.tokenMeter = ctx.tokenMeter || { in: 0, out: 0 };
  const metering = {
    tenantId: ctx?.tenantId || 'system',
    actor: ctx?.actor || 'agent',
    action: 'agent-think',
    onUsage: (u) => { ctx.tokenMeter.in += Number(u?.tokensIn) || 0; ctx.tokenMeter.out += Number(u?.tokensOut) || 0; },
  };
  const think = llmThink || (await getLlmThink({ metering }).catch(() => null)) || defaultThink;
  const startedAt = Date.now();
  const ctId = ctx?.contractTask || null;
  // ① 意图解析：skill 路由决策即“意图”，emit 供工作台 reasoning-trace 三段①驱动（B-γ 详情 TAB）
  emit('trace', 'agent-intent-parsed', { taskId: task.id, intent: skillSlug, action: task.action_name });
  recordEpisode({
    agent_id: ctx?.actor || 'agent', phase: 'intent-parsed',
    context_facts: { intent: skillSlug, contract_task_id: ctId },
    payload: { taskId: task.id, intent: skillSlug },
  }).catch(() => {});
  // 上下文分层：组装 L1-L4 块并注入（降级不抛，result 由 executeSkill 消费）
  const { block: contextBlock, bundle } = await buildContextBlock(task, ctx).catch(() => ({ block: '', bundle: { layers: {}, missing: {} } }));
  const knowledgeLayersRead = Object.keys(bundle?.layers || {}).filter((l) => !bundle?.missing?.[l]);
  emit('trace', 'agent-context-injected', { taskId: task.id, len: contextBlock.length });
  recordEpisode({
    agent_id: ctx?.actor || 'agent', phase: 'context-injected',
    context_facts: {
      context_len: contextBlock.length,
      preview: String(contextBlock).slice(0, 800),
      knowledge_layers_read: knowledgeLayersRead,
      contract_task_id: ctId,
    },
    payload: { taskId: task.id, len: contextBlock.length },
  }).catch(() => {});
  emit('trace', 'agent-loop-started', { taskId: task.id, skill: skillSlug });
  recordEpisode({
    agent_id: ctx?.actor || 'agent', phase: 'loop-started',
    context_facts: { skill: skillSlug, contract_task_id: ctId }, payload: { taskId: task.id, skill: skillSlug },
  }).catch(() => {});

  try {
    // 透传 taskPayload 进 ctx（method-* 真执行 2026-09-01）：
    // step.params 是静态的，新 read action 经 ctx.taskPayload.deal_id 定向真实商机。
    const execCtx = { ...ctx, taskPayload: task.payload };
    const outcome = await executeSkill(skill, task, { llmThink: think, ctx: execCtx });
    // LLM 不可用（使用默认 think）→ 整体标记降级，即便全为 rule 步骤（保证可观测降级语义）
    if (think === defaultThink) outcome.degraded = true;
    emit('trace', 'agent-loop-done', { taskId: task.id, skill: skillSlug, ms: Date.now() - startedAt, degraded: outcome.degraded });
    recordEpisode({
      agent_id: ctx?.actor || 'agent', phase: 'loop-done',
      context_facts: { skill: skillSlug, degraded: outcome.degraded, ms: Date.now() - startedAt, contract_task_id: ctId },
      payload: { taskId: task.id, degraded: outcome.degraded },
    }).catch(() => {});
    onStep?.({ type: 'done', outcome });
    return outcome;
  } catch (e) {
    emit('trace', 'agent-loop-failed', { taskId: task.id, skill: skillSlug, error: e.message });
    recordEpisode({
      agent_id: ctx?.actor || 'agent', phase: 'loop-failed',
      context_facts: { skill: skillSlug, error: e.message, contract_task_id: ctId }, payload: { taskId: task.id, error: e.message },
    }).catch(() => {});
    throw e;
  }
}
