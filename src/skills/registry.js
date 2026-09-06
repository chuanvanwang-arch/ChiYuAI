// src/skills/registry.js — SKILL 表 + SKILL 驱动执行
// 设计输入：03 编排设计（反模式 9：只读 SKILL 步骤序列，不自由探索）
// steps[] 含 decision 标记（rule/j_judge/o_optimize/f_forecast）；rule 步骤零 LLM 调用
// §6.6 skill_registry：enabled(后台开关) + rbac_roles(角色白名单) 硬闸（默认开放）
import { actionExecutor } from '../action/executor.js';
import { actorRole } from '../context/scope.js';
import { agentSpecs } from '../agent/agentSpec.js';

const skills = new Map();

// 系统级智能体执行体的 SKILL 授权（2026-09-01）：
//   rbac_roles 是「人类角色白名单」，判据是 CRM_PERSON.payload.role_tags；
//   而 agent actor（quote-engine / decision-retro …）没有 CRM_PERSON 粒子，role_tag 恒为 null，
//   在真 SKILL 接线前因恒走 crm-skill-fallback（无 rbac_roles）而从未暴露；接线后会被角色闸拦死。
//   正确语义：agent 的授权判据是 agentSpec.capabilities.skillCalls 闭包（声明了才能调），
//   fallback 为降级兜底路径，任何已登记 agent 均可执行。
export function agentSkillAllowed(actor, slug) {
  if (!agentSpecs[actor]) return false;
  if (slug === 'crm-skill-fallback') return true;
  const calls = agentSpecs[actor].capabilities?.skillCalls || [];
  return calls.includes(slug);
}

export function registerSkill(def) {
  // def: { slug, version, steps: [...], enabled?, rbac_roles? }
  // enabled?: boolean — 后台停用开关（false=引擎不装载、市场不暴露，§6.6 skill_registry.enabled）
  // rbac_roles?: string[] — 允许执行此 SKILL 的 role_tag 白名单；缺省=默认开放
  skills.set(`${def.slug}@${def.version}`, def);
  if (!skills.has(def.slug)) skills.set(def.slug, def); // 默认最新版（无版本号索引）
}

export function getSkill(slug) {
  return skills.get(slug) || null;
}

// 引擎接线（§6.6 后台启停立即生效）：DB 侧改 enabled 后调用，同步内存注册表（无需重启）
export function setSkillEnabled(slug, enabled) {
  const def = skills.get(slug) || skills.get(`${slug}@1`); // slug 或 slug@version 两种索引
  if (!def) return false;
  def.enabled = !!enabled;
  return true;
}

// SKILL 级硬闸（§6.6）：disabled / 角色越权 → 拒绝；默认开放
export async function canExecuteSkill(def, ctx = {}) {
  if (def.enabled === false) return { ok: false, reason: `SKILL ${def.slug} 已停用（skill_registry.enabled=false）` };
  if (Array.isArray(def.rbac_roles) && def.rbac_roles.length) {
    // 系统级智能体走 skillCalls 闭包闸，不参与人类角色判定
    if (ctx.actor && agentSpecs[ctx.actor]) {
      if (!agentSkillAllowed(ctx.actor, def.slug)) {
        return { ok: false, reason: `agent ${ctx.actor} 未声明 SKILL ${def.slug}（skillCalls 闭包不含）` };
      }
      return { ok: true };
    }
    const role = ctx.role || (ctx.actor ? (await actorRole({ actor: ctx.actor }))?.role_tag : null);
    if (!role || !def.rbac_roles.includes(role)) {
      return { ok: false, reason: `角色 ${role || 'unidentified'} 无权执行 SKILL ${def.slug}` };
    }
  }
  return { ok: true };
}

// SKILL 驱动执行：只读 SKILL 步骤序列，不自由探索（反模式 9）
export async function executeSkill(skill, task, opts = {}) {
  const { llmThink = null, ctx = { tenantId: 'system', actor: 'agent' } } = opts;
  const gate = await canExecuteSkill(skill, ctx);
  if (!gate.ok) throw new Error(gate.reason);
  // 步骤未落地的降级护栏（2026-09-01 建立 / 2026-09-02 收窄范围）：
  //   建立时 method-* 类 SKILL 多数仅登记元数据、无 steps[]，真接线后直接执行会崩（steps undefined）。
  //   2026-09-02 已为 6 个 method-* 补齐 steps[]（quote-engine / followup-engine / review-gate /
  //   stage-progression / funnel-classification / behavior-standard）；剩余 8 个仍只有元数据
  //   （方法论内容在 skills/method-* 目录，供外部智能体经 MCP 消费）。
  //   护栏保留：无 steps 时降级为单步粒子读取并标记 degraded + stepsMissing，
  //   保证编排不中断、降级可观测（不伪造合规：调用方据此可区分"已调用"与"已落地"）。
  const hasSteps = Array.isArray(skill.steps) && skill.steps.length > 0;
  const steps = hasSteps ? skill.steps : [{ step: 1, action: 'data-particle-read', decision: 'rule', params: {} }];
  const stepsRun = [];
  for (const step of steps) {
    if (step.decision === 'rule') {
      // rule 步骤：直接 dispatch + 规则后处理，零 LLM
      const r = await actionExecutor.dispatch(step.action, step.params || {}, ctx);
      stepsRun.push({ step: step.step, decision: 'rule', result: r, ok: r.ok });
      if (!r.ok) throw new Error(`rule 步骤失败: ${r.error}`);
    } else {
      // 推理步骤：LLM 产出分析（action:null 或具体 action），不直接调 Action
      const analysis = llmThink
        ? await llmThink(task, { step, prior: stepsRun })
        : { action: null, params: {}, reasoning: '[降级推理] LLM 不可用', degraded: true };
      stepsRun.push({ step: step.step, decision: step.decision, analysis, ok: true, degraded: !!analysis.degraded });
      if (analysis.action) {
        const r = await actionExecutor.dispatch(analysis.action, analysis.params, ctx);
        stepsRun[stepsRun.length - 1].result = r;
      }
    }
  }
  return { steps: stepsRun, done: true,
           degraded: !hasSteps || stepsRun.some(s => s.degraded),
           stepsMissing: !hasSteps,
           reasoning: stepsRun.filter(s => s.analysis).map(s => s.analysis.reasoning).filter(Boolean) };
}
