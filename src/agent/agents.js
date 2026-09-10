// src/agent/agents.js — 六条装配校验断言（03 编排设计 第 6 轮）
// 1 derivedFrom 存在 2 SKILL validated 3 权限闭包 4 Action 在 Registry 5 KG 就绪(降级) 6 evaluator(阶段2)
import { agentSpecs } from './agentSpec.js';
import { getAction } from '../action/registry.js';
import { seedActions } from '../action/seed-actions.js';
import { seedDiscoveryActions } from '../action/discoveryActions.js';

// KG 当前全局降级态（阶段1/2 无 KG，统一 degraded）；接 KG 后改为读取真实就绪态。
// 该标志用于「降级一致性守护」：声明 L3 上下文但 KG 降级属装配失败（契约层只看声明集合、不感知降级，会静默误判）。
const KG_DEGRADED = true;

// 降级一致性守护：声明含 L3 且 KG 降级 → ok:false。可被单测直接调用。
export function l3DegradedGuard(spec) {
  const layers = spec?.capabilities?.knowledgeScope?.layers || [];
  const l3Stated = layers.includes('L3');
  return { ok: !(l3Stated && KG_DEGRADED), detail: l3Stated ? '声明L3但KG降级' : 'ok' };
}

// KG 层级全序（用于 kg_target 天花板与收敛判定）
const KG_LAYER_ORDER = ['L1', 'L2', 'L3', 'L4'];

// kg_target 天花板：返回 KG 层级数组索引（含）。无 kg_target 则开放到最高层。
function kgTargetCeiling(spec) {
  const t = spec?.capabilities?.kgTarget;
  if (!t) return KG_LAYER_ORDER.length - 1; // 无目标 → 允许到最高层
  const top = Array.isArray(t) ? t[t.length - 1] : t;
  const idx = KG_LAYER_ORDER.indexOf(top);
  return idx === -1 ? KG_LAYER_ORDER.length - 1 : idx;
}

// KG 当前可服务层级：降级态（kg_coverage_stage2）仅 L1/L2；就绪后开放全层。
function kgServedLayers() {
  return KG_DEGRADED ? ['L1', 'L2'] : ['L1', 'L2', 'L3', 'L4'];
}

// L3 收敛闸门（G3 守护核心）：运行时把 knowledge_scope.layers 收敛到
// 「KG 当前可服务范围 ∩ kg_target 天花板」，越界层（如降级下的 L3）被收敛掉。
// 返回 effective 供 Agent 运行时强制使用；triggered 表示发生收敛（降级不一致，需修复）。
export function kgConvergenceGate(spec) {
  const declared = spec?.capabilities?.knowledgeScope?.layers || [];
  const ceiling = kgTargetCeiling(spec);
  const served = kgServedLayers().filter((l) => KG_LAYER_ORDER.indexOf(l) <= ceiling);
  const effective = declared.filter((l) => served.includes(l));
  const dropped = declared.filter((l) => !effective.includes(l));
  const triggered = dropped.length > 0;
  return {
    ok: !triggered,
    declared,
    target: spec?.capabilities?.kgTarget ?? null,
    effective,
    dropped,
    triggered,
    detail: triggered
      ? `L3收敛闸门收敛 ${dropped.join('/')}（KG降级,kg_target=${spec?.capabilities?.kgTarget ?? '无'}）`
      : 'ok',
  };
}

// Agent 运行时强制收敛入口：返回应注入的 knowledge_scope.layers（已收敛到 KG 可服务范围），
// 保证降级态下不会请求 KG 实际缺失的 L3 上下文（契约层静默误判的根因）。
export function resolveRuntimeKgLayers(spec) {
  return kgConvergenceGate(spec).effective;
}

export async function assertAgentAssembly() {
  // 确保 Action Registry 已注入（Agent 装配断言 4 依赖；幂等）
  seedActions();
  // 线索发现 Action 族（Task 5 三处硬闭包 1/3）：decision-agent capabilities 依赖其在 Registry 存在（断言 4）
  seedDiscoveryActions();
  const results = [];

  // 断言 3：权限闭包 ⋃(SKILL.calls) ⊆ capabilities.actions
  for (const [id, spec] of Object.entries(agentSpecs)) {
    const calls = spec.capabilities.skillCalls || [];
    for (const c of calls) {
      const ok = spec.capabilities.actions.includes(c);
      results.push({ agent: id, assertion: 'permission_closure', ok, detail: `${c} ⊆ actions` });
    }
  }

  // 断言 4：所有 Action 在 Registry 存在
  for (const [id, spec] of Object.entries(agentSpecs)) {
    for (const a of spec.capabilities.actions) {
      const ok = getAction(a) !== null;
      results.push({ agent: id, assertion: 'action_in_registry', ok, detail: a });
    }
  }

  // 断言 1：derivedFrom 存在（taskFlow 表阶段 1 用常量校验）
  for (const [id, spec] of Object.entries(agentSpecs)) {
    results.push({ agent: id, assertion: 'derived_from', ok: Boolean(spec.identity.derivedFrom), detail: spec.identity.derivedFrom });
  }

  // 断言 5：KG 就绪 → 降级语义（阶段 1 无 KG，降级启动并标注，非拒绝）
  for (const [id] of Object.entries(agentSpecs)) {
    results.push({ agent: id, assertion: 'kg_ready', ok: true, detail: 'degraded: kg_coverage_stage2' });
  }

  // 断言 5b：降级一致性守护 — 声明 L3 但 KG 降级（kg_coverage_stage2）视为装配失败
  // （契约校验层 contractService.js:36 / contractParser.js:117 仅比对声明集合、不感知降级态，L3 检索缺失会静默误判）
  for (const [id, spec] of Object.entries(agentSpecs)) {
    const g = l3DegradedGuard(spec);
    results.push({ agent: id, assertion: 'l3_stated_but_kg_degraded', ok: g.ok, detail: g.detail });
  }

  // 断言 5c：L3 收敛闸门（G3 守护）— 运行时 knowledge_scope.layers 必须收敛到 KG 可服务范围；
  // 越界层（降级态下的 L3）被收敛掉，触发即装配失败（与 l3_stated_but_kg_degraded 双保险，且产出 effective 供运行时强制注入）。
  for (const [id, spec] of Object.entries(agentSpecs)) {
    const g = kgConvergenceGate(spec);
    results.push({ agent: id, assertion: 'kg_target_convergence', ok: g.ok, detail: g.detail });
  }

  // 断言 2/6：SKILL validated + evaluator 阶段 2 落地 → 降级语义
  for (const [id] of Object.entries(agentSpecs)) {
    results.push({ agent: id, assertion: 'skill_validated', ok: true, detail: 'degraded: skill_registry_stage2' });
    results.push({ agent: id, assertion: 'evaluator_ready', ok: true, detail: 'degraded: evaluator_stage2' });
  }

  const failed = results.filter(r => !r.ok);
  return { ok: failed.length === 0, results, failed };
}
