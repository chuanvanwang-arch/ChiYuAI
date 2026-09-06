// src/kanban/scheduler.js — 调度器：扫描 ready 任务 → claim → 派发 agentLoop → complete/fail
// 设计输入：docs/2026-08-24-ai-native-sales-crm-design.md §03 编排设计
// 单例锁防双实例；agentLoop 在 Task 8 落地，故 lazy-import 以避免模块加载期硬依赖
import { query, queryWrite } from '../db.js';
import { claimTask, completeTask, failTask, gateBlockTask, listTasks } from './kanban.js';
import { createDispatchQueue } from './dispatch.js';
import { agentSpecs } from '../agent/agentSpec.js';
import { contractIdForAgent } from '../agent/contractIds.js';
import { recordEpisode } from '../agent/agentEpisodes.js';

const queue = createDispatchQueue({ maxInflight: 3 });

// 抢占单例锁：scheduler_lock 仅一行 (id=1)；多实例重复 INSERT/UPDATE 同一行即互斥
export async function acquireLock() {
  await queryWrite(
    `INSERT INTO scheduler_lock (id, pid) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET pid=EXCLUDED.pid, host=EXCLUDED.host, acquired_at=now()`,
    [process.pid]
  );
}

// 主 SKILL 前缀：方法论 SKILL（method-*）与智能体专属 SKILL（decision-*）。
// 排除 data-particle-* / crm-asset-attach 等基础步骤——它们是 SKILL 内部的动作，不是派发粒度的方法论。
const PRIMARY_SKILL_RE = /^(method-|decision-)/;

// 由 agentSpec.skillCalls 派生主 SKILL slug（首个方法论/专属 SKILL；无则回落 fallback）
// D4 修复配套：tasks 表无 skill_slug 列，派发时经 payload 注入，由 agentLoop 读取执行。
export function primarySkillFor(agent) {
  const calls = agentSpecs[agent]?.capabilities?.skillCalls || [];
  return calls.find((s) => PRIMARY_SKILL_RE.test(s)) || 'crm-skill-fallback';
}

// —— A 接诊分流唯一入口路由（5 agent 名册：A→B/C/D + E 复盘）——
// 纯函数：输入 kanban task（含 payload.intent / payload.level），输出路由决策：
//   targetAgent：派发目标（quote-engine / followup-agent / decision-retro）
//   gateAgents：重大商机额外把关（review-gate）
//   payload：注入 level + contract_task_id + skill_slug + dispatchedFrom，供 agentLoop 写契约 episode
export function routeThroughIntake(task = {}) {
  const p = task.payload || {};
  // D5 修复（2026-09-01）：classifyRequirement 返回的 level 是 'L3'/'L2'/'L1'（见 classify.js RULES），
  // 而此处旧判定只认 'major' → 重大商机永远走 normal 分支，review-gate 把关闸门形同虚设。
  // 现同时兼容两种量级表示（语义 'major' 与分级 'L3'）。
  const level = (p.level === 'major' || p.level === 'L3') ? 'major' : 'normal';
  const intent = p.intent || 'quote';
  // A 意图路由（方案C 决策前后双 Agent）：decision-enrich 决策前富集 / decision-execute 决策后治理
  //   → decision-agent，注入专属 skill_slug 与契约键（ct-decision-enrich / ct-decision-execute），
  //   不挂 review-gate：决策闸确定性引擎独立把关，agent 仅做富集/写回，绝不回灌 disposition。
  if (intent === 'decision-enrich' || intent === 'decision-execute') {
    const skillSlug = intent === 'decision-enrich' ? 'method-decision-enrich' : 'method-decision-execute';
    const contractTaskId = intent === 'decision-enrich' ? 'ct-decision-enrich' : 'ct-decision-execute';
    return {
      targetAgent: 'decision-agent',
      gateAgents: [],
      payload: {
        ...p,
        level,
        contract_task_id: contractTaskId,
        skill_slug: skillSlug,
        dispatchedFrom: 'intake-router',
      },
    };
  }
  // A 意图路由：复盘 → E 复盘智能体；跟进 → C 跟进催办；报价/售前 → B 报价测算；重大商机全程 D 把关
  // T2（2026-09-03）：优先采用事件矩阵已算好的 payload.targetAgent（合法 agent 时才用），
  //   否则按 intent 推导。这样 CRM_ACCOUNT(funnel-classification)→followup-agent 等矩阵路由不被错派给 quote-engine。
  const targetAgent = (p.targetAgent && agentSpecs[p.targetAgent])
    ? p.targetAgent
    : intent === 'retro' ? 'decision-retro'
    : intent === 'followup' ? 'followup-agent'
    : 'quote-engine';
  const gateAgents = level === 'major' ? ['review-gate'] : [];
  // D2 修复：契约键改为稳定短键（与契约文档 §A 的 contract_task_id 一一对应），
  // 旧格式 `intake:<uuid>:<level>:<agent>` 永远无法与契约块 JOIN，导致矩阵只反映手工演示数据。
  const contractTaskId = contractIdForAgent(targetAgent)
    || `intake:${task.id || 'anon'}:${level}:${targetAgent}`;
  // T2（2026-09-03）：显式 skill_slug 授权覆盖——仅当命中 targetAgent.skillCalls 闭包才保留，
  //   否则回落 primarySkillFor（防越权 SKILL 经事件通道被派发）。
  const calls = agentSpecs[targetAgent]?.capabilities?.skillCalls || [];
  const skillSlug = (p.skill_slug && calls.includes(p.skill_slug)) ? p.skill_slug : primarySkillFor(targetAgent);
  return {
    targetAgent,
    gateAgents,
    payload: {
      ...p,
      level,
      contract_task_id: contractTaskId,
      skill_slug: skillSlug,
      dispatchedFrom: 'intake-router',
    },
  };
}

// 扫描 ready 任务并全部入队派发；返回本次扫描到的 ready 数量
// 多租户修复（2026-09-01）：此前未透传 tenantId → listTasks 落回默认 'system'，
// 非 system 租户的 ready 任务永不被泵起（事件触发式复盘按决策租户建单，会直接踩到该缺口）。
export async function pumpReadyTasks({ chainId = null, tenantId = 'system' } = {}) {
  const ready = await listTasks({ status: 'ready', chainId, tenantId });
  for (const t of ready) {
    await queue.push(t.id, () => dispatchOne(t));
  }
  return ready.length;
}

// 派发单任务核心（可注入 runWithSkillFn，便于集成测试）；claim → A 路由 → runWithSkill → complete；异常 → fail
// 契约接线：contract_task_id 经 ctx 注入 agentLoop（修复原 runWithSkill(task, ctx) 位置参数错位——runWithSkill 期望 opts.ctx，
// 旧写法令 ctx 整体成为 opts 导致 contractTask/actor 在 agentLoop 内读取不到，契约闭环键丢失）
export async function dispatchOneCore(task, { runWithSkillFn = null } = {}) {
  const claimed = await claimTask(task.id).catch(() => null);
  if (!claimed) return;
  try {
    const runWithSkill = runWithSkillFn || (await import('../agent/agentLoop.js')).runWithSkill;
    // A 唯一入口路由：先经 routeThroughIntake 分级派发，再注入 contract_task_id
    // （契约接线：agentLoop 写入 episode.context_facts.contract_task_id ← 闭环关联键）
    const routed = routeThroughIntake(task);
    const ctx = { contractTask: task?.payload?.contract_task_id || routed.payload.contract_task_id, actor: routed.targetAgent, decision_id: task?.payload?.decision_id || null };
    // D7 修复（2026-09-01）：intake-router 是内嵌路由逻辑、无独立 dispatch 路径，此前零运行痕迹，
    // 契约矩阵该行恒红。路由决策每次派发都真实执行，故如实落一条 episode，并标 route_only=true
    // （未跑完整 SKILL 循环），保证"有痕迹"与"未伪造"并存。
    await recordIntakeRouteEpisode(task, routed).catch(() => {});
    // D4 修复：把路由产物（含 skill_slug / 契约键）合并进 task 再交给 agentLoop——
    // 旧写法直接传原始 task，agentLoop 读到的 payload 不含 skill_slug，恒回落 crm-skill-fallback。
    const outcome = await runWithSkill({ ...task, payload: routed.payload }, { ctx });
    // D6 修复（2026-09-01）：重大商机的 gateAgents 此前只被算出、从未派发 ⇒ review-gate
    // 永远不产生 episode，评审把关闸门形同虚设。此处在主执行后串行跑 gate 复核。
    // ② gate 阻断式（2026-09-01）：gate 返回 verdict，任一 reject → 主任务 blocked(gate_reject)
    // 挂起等人工裁决（未定稿）；全 pass → completeTask（定稿）。仅影响 gateAgents>0 任务。
    const gate = await runGateAgents(routed, task, runWithSkill);
    const rejected = Object.values(gate).some((g) => g && g.ok === false);
    if (rejected) {
      await gateBlockTask(task.id, { gate });
    } else {
      await completeTask(task.id, { result: { ...(outcome || {}), gate } });
    }
  } catch (e) {
    await failTask(task.id, { error: e?.message || String(e) });
  }
}

// 接诊分流（intake-router）运行痕迹：路由决策已真实执行，落 loop-started/loop-done 两条 episode。
// route_only=true 明示"仅路由、未执行完整 SKILL 循环"，供审计区分真执行与路由痕迹。
export async function recordIntakeRouteEpisode(task, routed) {
  const ctId = contractIdForAgent('intake-router');
  if (!ctId) return;
  const facts = {
    skill: 'method-intake-routing',
    contract_task_id: ctId,
    route_only: true,
    degraded: true,
    target_agent: routed.targetAgent,
    level: routed.payload.level,
  };
  const payload = { taskId: task.id, targetAgent: routed.targetAgent, gateAgents: routed.gateAgents };
  await recordEpisode({ agent_id: 'intake-router', phase: 'loop-started', context_facts: facts, payload });
  await recordEpisode({ agent_id: 'intake-router', phase: 'loop-done', context_facts: { ...facts, ms: 0 }, payload });
}

// gate agent 串行把关：每个 gate 用自身身份执行，读结构化 verdict，失败隔离不抛
export async function runGateAgents(routed, task, runWithSkill) {
  const out = {};
  for (const g of routed.gateAgents || []) {
    const contractTask = contractIdForAgent(g) || `gate:${g}`;
    const gCtx = { contractTask, actor: g };
    const gTask = {
      ...task,
      payload: { ...routed.payload, skill_slug: primarySkillFor(g), contract_task_id: contractTask },
    };
    try {
      const o = await runWithSkill(gTask, { ctx: gCtx });
      const verdict = o?.verdict || o?.outcome?.verdict; // 兼容 outcome 包裹
      // fail-safe：verdict 缺失或非 'pass' → 保守 reject（避免静默通过）
      const ok = verdict === 'pass';
      out[g] = {
        ok,
        verdict: ok ? 'pass' : 'reject',
        outcome: o,
        defects: ok ? [] : (o?.defects || ['verdict 非 pass 或缺失']),
      };
    } catch (e) {
      // 异常 → 保守 reject（fail-safe），避免"抛异常被当成通过"
      out[g] = { ok: false, verdict: 'reject', error: e?.message || String(e), defects: ['gate 执行异常'] };
    }
  }
  return out;
}

// 运行期派发：使用真实 agentLoop.runWithSkill（dispatchOneCore 默认路径）
async function dispatchOne(task) {
  return dispatchOneCore(task, {});
}
