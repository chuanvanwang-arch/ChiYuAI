// src/approval/engine.js — 审批引擎（起单/条件路由/三种模式/兜底）
// 实证（§5bis G21/G22）：审批流 = 可配置一等公民，条件分支路由 + 会签/或签/顺序 + 自动通过兜底
// 综合详设 §7 G 组主章；对齐文件结构契约
// 契约修正（执行期与真实代码库对齐）：
//   F1: queryParticles 返回数组（particleRepo.js:42-49 return r.rows）
//   F2: updateParticle 签名 { patch, state, event }（particleRepo.js:51）
//   F4: 条件路由先扫全部条件边，最后回退无条件默认边（否则条件链路永不命中）
import { createParticle, getParticle, queryParticles, updateParticle } from '../particles/particleRepo.js';
import { nextState, canTransition } from './stateMachine.js';
import { getDefaultEmptyApproverAction } from './approvalConfig.js';
import { emit } from '../events/bus.js';

// 状态比较归一为大写：种子/展示约定用小写 todo/approved，引擎运行态写大写 TODO/APPROVED；
// 统一归一避免大小写不一致导致待签任务查不到（典型症状：列表可见但点批准报「任务不存在或已处理」）
const statusIs = (s, target) => (s || '').toString().toUpperCase() === target;

// 顺序闸纯函数（SEQUENTIAL 实证）：只允许最小 seq 的 TODO 任务被签，越序拒绝
// 抽出为纯函数便于本地单测（无 PG 依赖）；advanceTask 调用
export function seqCheck(pendingTasks, taskId) {
  const target = pendingTasks.find(t => t.id === taskId);
  if (!target) throw new Error(`顺序闸: 任务不存在或已处理: ${taskId}`);
  const minSeq = Math.min(...pendingTasks.map(t => t.payload?.seq ?? Number.MAX_SAFE_INTEGER));
  if ((target.payload?.seq ?? Number.MAX_SAFE_INTEGER) !== minSeq) {
    throw new Error(`顺序闸: 当前应签第 ${minSeq} 位（${target.payload?.approver ?? '?'} 越序被拒）`);
  }
  return true;
}

// 条件求值：GT/LT/EQ/IN
function evalCondition(cond, ctx) {
  const v = ctx[cond.payload.field];
  switch (cond.payload.operator) {
    case 'GT': return v > cond.payload.value;
    case 'LT': return v < cond.payload.value;
    case 'EQ': return v === cond.payload.value;
    case 'IN': return (cond.payload.value || []).includes(v);
    default: return false;
  }
}

// 路由（F4）：先扫全部条件边命中；无命中回退无条件默认边；无出边 → 流程结束
function route(startNode, flowData, ctx) {
  const outLinks = flowData.links.filter(l => l.payload.from_node === startNode.id);
  const fallback = outLinks.find(l => !l.payload.condition_ref);
  for (const link of outLinks) {
    if (link.payload.condition_ref) {
      const cond = flowData.conditions.find(c => c.id === link.payload.condition_ref);
      if (cond && evalCondition(cond, ctx)) {
        return flowData.nodes.find(n => n.id === link.payload.to_node);
      }
    }
  }
  return fallback ? flowData.nodes.find(n => n.id === fallback.payload.to_node) : null;
}

// 节点物化（C1 修复）：CONDITION(AI) 节点透明跳过，落到首个可签 APPROVER 节点
// 设计 §5：CONDITION 无审批人，原 startInstance 直接 auto_pass 放行 → 条件分支永不生效；
//   现改为递归 materialize：CONDITION 按 route() 求值选分支后进入目标节点，带 visited 环保护。
// START/DEFAULT 作「继续向下」兜底；END/null → 返回 null（流程终态/通过）。
function materializeNode(node, flowData, ctx, visited = new Set()) {
  if (!node || node.payload.node_type === 'END') return null;
  if (visited.has(node.id)) return null;            // 环保护：已访问 → 截断，避免死循环
  visited.add(node.id);
  if (node.payload.node_type === 'APPROVER') return node;
  // CONDITION / START / DEFAULT：沿 route() 取下一节点继续物化
  const target = route(node, flowData, ctx);
  return materializeNode(target, flowData, ctx, visited);
}

// 审批人解析：实例传入 approvers 优先；否则走审批规则兜底（C9 emptyApproverAction）
// 语义修正（计划内部矛盾，同 F4 类）：AUTO_PASS 是显式配置的兜底，非默认值——
// 默认 empty_approver_action='ASSIGN_ADMIN'（转交管理员），否则无审批人=自动放行（审批流形同虚设，危险默认）
function resolveApprovers(approverRule, { submitter, approvers = [] }) {
  if (approvers.length) return approvers;
  // 显式兜底优先：empty_approver_action='AUTO_PASS' 是「审批人为空即自动通过」的显式声明，
  // 高于节点规则——节点规则是默认审批人指派；AUTO_PASS 声明空则直接放行，防止规则兜底掩盖显式配置
  const action = approverRule.payload.empty_approver_action || getDefaultEmptyApproverAction();
  if (action === 'AUTO_PASS') return { auto_pass: true };
  // 节点规则（默认指派）：ROLE/SPECIFIC_PERSON 优先于 ASSIGN_ADMIN 兜底（08-26 根因修复：退回重审/未传 approvers 场景审批人错误为 role:admin）
  if (approverRule.payload.approver_type === 'ROLE' && approverRule.payload.role) {
    return [`role:${approverRule.payload.role}`];   // 前缀规范化：role:<role> 与兜底/测试契约一致
  }
  if (approverRule.payload.approver_type === 'SPECIFIC_PERSON' && approverRule.payload.assigned_to) {
    return [approverRule.payload.assigned_to];
  }
  if (action === 'ASSIGN_ADMIN') return ['role:admin'];
  if (action === 'ASSIGN_SPECIFIC') {
    return approverRule.payload.assigned_to ? [approverRule.payload.assigned_to] : ['role:admin'];
  }
  return [];
}

// 无审批规则节点时的兜底（取代硬编码 {auto_pass:true}）：读运行态默认兜底动作，
//   'AUTO_PASS' → 自动通过；否则转 admin 人工（安全默认）。避免「无规则=静默自动放行」的危险默认。
function fallbackNoApprover() {
  return getDefaultEmptyApproverAction() === 'AUTO_PASS' ? { auto_pass: true } : ['role:admin'];
}

// 分级审批节点审批人解析（T7：§3.3 金额档位 → 节点数）。
// 设计：T5 物化每条规则「满档位（T3）」拓扑（APPROVER 节点按序 manager/director/president…），
//   起单时由 handler 经 resolveApprovalChain(ruleId,{amount}) 算出当笔档位链并作为 tierApprovers 传入。
// 两种拓扑需区分（否则破坏「单节点多审批人」SEQUENTIAL/ALL 同节点顺序签）：
//   (A) 多 APPROVER 节点流（分级审批，一节点一审批人）→ 按序位 ordinal 取链中第 ordinal 位：
//         - 链内有值 → 仅该审批人签此节点（实现 T1/T2/T3 节点数差异）；
//         - 链已尽（ordinal>=len）→ 该节点 AUTO_PASS 跳过（不回退 seeded role，避免越级）。
//   (B) 单 APPROVER 节点流（同节点多审批人，SEQUENTIAL/ALL 顺序签）→ 全链落在当前节点（全部 TODO，按 seq 顺序签）。
//   - 未传 tierApprovers（向后兼容旧调用 / 演示流）→ 回退 seeded role（等同 T3 满链）。
// ordinal 由调用方按「链路中位于本节点之前的 APPROVER 节点数」计算，与节点 pos 绝对编号无关。
function resolveNodeApprover(tierApprovers, approverOrdinal, approverRule, { submitter }, totalApprovers = 0) {
  // 仅当调用方显式传入非空档位链（tier_approvers）才启用跨节点分发；
  // 空数组（向后兼容旧调用 / 演示流未传档位）视为「未分级」→ 回退 seeded role（等同 T3 满链）。
  if (Array.isArray(tierApprovers) && tierApprovers.length > 0 && approverOrdinal >= 0) {
    const norm = (r) => (r.startsWith('role:') ? r : `role:${r}`); // 规范化：与 resolveApprovers 一致（role:<role>）
    if (totalApprovers > 1) {
      // (A) 多节点流：一节点一审批人，按序位分发
      if (approverOrdinal < tierApprovers.length && tierApprovers[approverOrdinal]) {
        return [norm(tierApprovers[approverOrdinal])];
      }
      if (approverOrdinal >= tierApprovers.length) return { auto_pass: true }; // 链已尽：跳过剩余高级节点
    } else {
      // (B) 单节点流：同节点多审批人，全链落当前节点（SEQUENTIAL/ALL 顺序签）
      return tierApprovers.map(norm);
    }
  }
  return approverRule ? resolveApprovers(approverRule, { submitter, approvers: [] }) : fallbackNoApprover();
}

// 计算某 APPROVER 节点在链路中的序位（0 起）：位于其 pos 之前的 APPROVER 节点数
function approverOrdinalOf(fd, node) {
  return fd.nodes.filter(n => n.payload.node_type === 'APPROVER' && (n.payload.pos ?? 0) < (node.payload.pos ?? 0)).length;
}

// 取流程拓扑：nodes + links + approvers + conditions（按 flow_id 过滤；数组 API）
async function loadFlow(flow_id, tenantId = 'system') {
  const flow = await getParticle(flow_id);
  if (!flow) throw new Error(`审批流不存在: ${flow_id}`);
  const nodes = (await queryParticles({ type: 'CRM_APPROVAL_NODE', tenantId: tenantId }))
    .filter(r => r.payload.flow_id === flow_id).sort((a, b) => (a.payload.pos || 0) - (b.payload.pos || 0));
  const links = (await queryParticles({ type: 'CRM_APPROVAL_LINK', tenantId: tenantId }))
    .filter(r => r.payload.from_node && nodes.some(n => n.id === r.payload.from_node));
  const approvers = (await queryParticles({ type: 'CRM_APPROVAL_APPROVER', tenantId: tenantId }))
    .filter(r => nodes.some(n => n.id === r.payload.node_id));
  const conditions = (await queryParticles({ type: 'CRM_APPROVAL_CONDITION', tenantId: tenantId }))
    .filter(r => nodes.some(n => n.id === r.payload.node_id));
  return { flow, nodes, links, approvers, conditions };
}

// 起单：startInstance(flow_id, business_type, business_id, ctx, { submitter, approvers })
// 路由到首个审批节点；无审批规则/空审批人 → AUTO_PASS 直接 APPROVED
export async function startInstance(flow_id, business_type, business_id, ctx, { submitter, approvers = [], tenantId = 'system' }) {
  const fd = await loadFlow(flow_id, tenantId);
  const start = fd.nodes.find(n => n.payload.node_type === 'START');
  if (!start) throw new Error(`审批流缺少 START 节点: ${flow_id}`);

  const node = materializeNode(start, fd, ctx);
  if (!node) {
    // 无可达审批节点（空流/全 END/环）→ 直接通过（AUTO_PASS 语义）
    return createParticle('CRM_APPROVAL_INSTANCE', {
      flow_id, business_type, business_id, submitter,
      status: 'APPROVED', current_node: null, current_node_name: null, ctx,
    }, { tenantId: tenantId });
  }

  const approverRule = fd.approvers.find(a => a.payload.node_id === node.id);
  const totalApprovers = fd.nodes.filter(n => n.payload.node_type === 'APPROVER').length;
  const resolved = approverRule ? resolveNodeApprover(approvers, approverOrdinalOf(fd, node), approverRule, { submitter }, totalApprovers) : fallbackNoApprover();

  if (resolved.auto_pass) {
    return createParticle('CRM_APPROVAL_INSTANCE', {
      flow_id, business_type, business_id, submitter,
      status: 'APPROVED', current_node: null, current_node_name: null, ctx,
      tier_approvers: approvers.length ? approvers : undefined,
      auto_pass_reason: 'empty_approver AUTO_PASS',
    }, { tenantId: tenantId });
  }

  const inst = await createParticle('CRM_APPROVAL_INSTANCE', {
    flow_id, business_type, business_id, submitter,
    status: 'APPROVING', current_node: node.id, current_node_name: node.payload.name,
    node_mode: approverRule ? (approverRule.payload.multi_approver_mode || 'ANY') : 'ANY',
    approvers: resolved, ctx,
    tier_approvers: approvers.length ? approvers : undefined, // T7 分级：全链存实例，供 advanceToNextNode 跨节点分发
  }, { tenantId: tenantId });

  for (const [i, approver] of resolved.entries()) {
    await createParticle('CRM_APPROVAL_TASK', {
      instance_id: inst.id, node_id: node.id, approver,
      status: 'TODO', opinion: null,
      // 顺序闸（SEQUENTIAL）：approvers 数组序即签批序（G23 实证：可配置顺序签）
      // ALL/ANY 也写 seq 供审计/展示，但只有 SEQUENTIAL 模式强制顺序
      seq: i + 1,
    }, { tenantId: tenantId });
  }
  return inst;
}

// 推进审批：advanceTask(instance_id, task_id, { approver, decision, opinion })
// decision: 'approve' | 'reject'；按节点模式（ANY/ALL/SEQUENTIAL）判定实例终态
export async function advanceTask(instance_id, task_id, { approver, decision, opinion = '', tenantId = 'system' }) {
  const inst = await getParticle(instance_id);
  if (!inst) throw new Error(`审批实例不存在: ${instance_id}`);
  const pendingTasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: tenantId }))
    .filter(t => t.payload.instance_id === instance_id && statusIs(t.payload.status, 'TODO'));
  const task = pendingTasks.find(t => t.id === task_id);
  if (!task) throw new Error(`审批任务不存在或已处理: ${task_id}`);

  const mode = inst.payload.node_mode || 'ANY';
  // 顺序闸（SEQUENTIAL 实证）：只允许最小 seq 的 TODO 任务被签，越序拒绝（否则顺序签形同虚设）
  if (mode === 'SEQUENTIAL') seqCheck(pendingTasks, task_id);
  if (decision === 'reject') {
    await updateParticle(task_id, { patch: { ...task.payload, status: 'REJECTED', opinion, decided_by: approver } });
    await updateInstanceStatus(inst, 'REJECTED');
    emit('approval', 'task-rejected', { instance_id, task_id, approver, decision, opinion });
    return { status: 'REJECTED' };
  }
  if (decision === 'approve') {
    await updateParticle(task_id, { patch: { ...task.payload, status: 'APPROVED', opinion, decided_by: approver } });
    emit('approval', 'task-approved', { instance_id, task_id, approver, decision: 'approve', opinion });
    if (mode === 'ANY') {
      // 或签：任一审批人通过即本节点通过，立即推进（同节点多审批人时不再等待其余人）
      return advanceToNextNode(inst, await loadFlow(inst.payload.flow_id, tenantId), inst.payload.ctx || {}, tenantId);
    }
    // 会签/顺序签：须当前节点全部签完（按节点，而非全实例 —— B1 修复核心）
    const nodeTasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: tenantId }))
      .filter(t => t.payload.instance_id === instance_id && t.payload.node_id === inst.payload.current_node && statusIs(t.payload.status, 'TODO'));
    if (nodeTasks.length) {
      // 同节点仍有待签（ALL/SEQUENTIAL 多审批人同节点）→ 留在 APPROVING
      return { status: 'APPROVING' };
    }
    // 当前节点签完 → 推进到下一节点（B1：节点间推进状态机；多签链 经理→总监→总裁 依赖此）
    return advanceToNextNode(inst, await loadFlow(inst.payload.flow_id, tenantId), inst.payload.ctx || {}, tenantId);
  }
  throw new Error(`未知审批决策: ${decision}（approve/reject）`);
}

// 提交人撤回：withdrawInstance(instance_id, { by })
// 语义对齐 stateMachine.js OPERATIONS_BY_STATE（PENDING_SUBMIT/APPROVING 均允许 withdraw → CANCELED）
export async function withdrawInstance(instance_id, { by, tenantId = 'system' }) {
  const inst = await getParticle(instance_id);
  if (!inst) throw new Error(`审批实例不存在: ${instance_id}`);
  if (!canTransition(inst.payload.status, 'withdraw')) {
    throw new Error(`状态机拒绝: ${inst.payload.status} 不允许撤回（仅 PENDING_SUBMIT/APPROVING）`);
  }
  // 终态保护 + 审计留痕：待办任务同撤（TRANSFERRED/APPROVED/REJECTED 历史任务不碰）
  const tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: tenantId }))
    .filter(t => t.payload.instance_id === instance_id && statusIs(t.payload.status, 'TODO'));
  for (const t of tasks) {
    await updateParticle(t.id, { patch: { ...t.payload, status: 'CANCELED', cancel_note: `withdrawn by ${by}` } });
  }
  await updateInstanceStatus(inst, 'CANCELED');
  emit('approval', 'instance-withdrawn', { instance_id, by, status: 'CANCELED', canceled_tasks: tasks.length });
  return { status: 'CANCELED', canceled_tasks: tasks.length };
}

// 加签：addSignTask(instance_id, { approver, by })
// 语义对齐 stateMachine.js（APPROVING 允许 add_sign，不改实例状态）
// SEQUENTIAL 尾部追加 seq（续最大 seq）；ALL/ANY 追加尾部（seq 仅审计展示）
export async function addSignTask(instance_id, { approver, by, tenantId = 'system' }) {
  const inst = await getParticle(instance_id);
  if (!inst) throw new Error(`审批实例不存在: ${instance_id}`);
  if (!canTransition(inst.payload.status, 'add_sign')) {
    throw new Error(`状态机拒绝: ${inst.payload.status} 不允许加签（仅 APPROVING）`);
  }
  const tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: tenantId }))
    .filter(t => t.payload.instance_id === instance_id);
  const maxSeq = tasks.length ? Math.max(...tasks.map(t => t.payload.seq ?? 0)) : 0;
  const task = await createParticle('CRM_APPROVAL_TASK', {
    instance_id, node_id: inst.payload.current_node, approver,
    status: 'TODO', opinion: null,
    seq: maxSeq + 1,        // 尾续（SEQUENTIAL 顺序闸自然生效：新签必须在前序签完后）
    added_by: by,           // 审计留痕：加签人
  }, { tenantId: tenantId });
  emit('approval', 'task-added-sign', { instance_id, task_id: task.id, approver, by, seq: maxSeq + 1 });
  return { task_id: task.id, seq: maxSeq + 1 };
}

// 转交：transferTask(instance_id, task_id, { to, by })
// 语义对齐计划类型契约（任务状态 TODO→APPROVED|REJECTED|TRANSFERRED）
// 原任务留痕 TRANSFERRED（from/to/by），新建同 seq 任务给 to（order 不变，SEQUENTIAL 闸不破序）
export async function transferTask(instance_id, task_id, { to, by, tenantId = 'system' }) {
  const inst = await getParticle(instance_id);
  if (!inst) throw new Error(`审批实例不存在: ${instance_id}`);
  if (!canTransition(inst.payload.status, 'transfer')) {
    throw new Error(`状态机拒绝: ${inst.payload.status} 不允许转交（仅 APPROVING）`);
  }
  const task = await getParticle(task_id);
  if (!task || task.payload.instance_id !== instance_id || !statusIs(task.payload.status, 'TODO')) {
    throw new Error(`审批任务不存在或已处理: ${task_id}`);
  }
  await updateParticle(task_id, {
    patch: { ...task.payload, status: 'TRANSFERRED', transfer_from: task.payload.approver, transfer_to: to, transfer_by: by },
  });
  const nt = await createParticle('CRM_APPROVAL_TASK', {
    instance_id, node_id: task.payload.node_id, approver: to,
    status: 'TODO', opinion: null,
    seq: task.payload.seq,   // 同 seq：原位的转交承接（顺序闸下不跳序）
    transferred_from: task.payload.approver, transferred_by: by,
  }, { tenantId: tenantId });
  emit('approval', 'task-transferred', { instance_id, task_id, to, by, seq: task.payload.seq });
  return { transferred: task_id, new_task_id: nt.id, seq: task.payload.seq };
}

// 退回：returnTask(instance_id, task_id, { approver, back_node_id, opinion, by })
// 契约实证（CordysCRM /approval-action/back）：退回 = 打回指定节点重新审批（backNodeId），流程主干不迁移
//   1) 当前节点 TODO 任务 → RETURNED 留痕（被打回，不可再签）
//   2) 实例 current_node 切到 back 节点（缺省 = 流程首个 APPROVER = 重新从头审）
//   3) 按 back 节点的审批人规则重新生成 1..n TODO 任务（seq 重排，顺序闸重新生效）
// 与 reject 区别：reject 实例→REJECTED 终态；back 实例仍 APPROVING 主干（天然闭环，无需 submit 生命周期）
export async function returnTask(instance_id, task_id, { approver, back_node_id = null, opinion = '', by, tenantId = 'system' }) {
  const inst = await getParticle(instance_id);
  if (!inst) throw new Error(`审批实例不存在: ${instance_id}`);
  if (!canTransition(inst.payload.status, 'return')) {
    throw new Error(`状态机拒绝: ${inst.payload.status} 不允许退回（仅 APPROVING）`);
  }
  const task = await getParticle(task_id);
  if (!task || task.payload.instance_id !== instance_id || !statusIs(task.payload.status, 'TODO')) {
    throw new Error(`审批任务不存在或已处理: ${task_id}`);
  }
  // 当前节点 TODO 任务全部作废（同一节点的其他待签一并 RETURNED——整节点打回）
  const nodeTasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: tenantId }))
    .filter(t => t.payload.instance_id === instance_id && t.payload.node_id === inst.payload.current_node && statusIs(t.payload.status, 'TODO'));
  for (const t of nodeTasks) {
    await updateParticle(t.id, {
      patch: { ...t.payload, status: 'RETURNED', opinion, decided_by: approver, return_note: `backed to ${back_node_id || 'start'} by ${by}: ${opinion || '退回原因'}`, returned_by: by },
    });
  }
  // 目标 back 节点（缺省 = 流程首个 APPROVER 节点，即重新从头审）
  const fd = await loadFlow(inst.payload.flow_id, tenantId);
  const backNode = back_node_id
    ? fd.nodes.find(n => n.id === back_node_id)
    : fd.nodes.find(n => n.payload.node_type === 'APPROVER');
  if (!backNode || !['APPROVER', 'START', 'DEFAULT'].includes(backNode.payload.node_type)) {
    throw new Error(`退回目标节点无效: ${back_node_id || '(首个 APPROVER)'}`);
  }
  const approverRule = fd.approvers.find(a => a.payload.node_id === backNode.id);
  const resolved = approverRule ? resolveApprovers(approverRule, { submitter: inst.payload.submitter, approvers: [] }) : { auto_pass: true };
  if (resolved.auto_pass) {
    throw new Error(`退回目标节点 ${backNode.payload.name} 无审批人（AUTO_PASS 不可作退回目标）`);
  }
  // 实例 current_node 切到 back 节点（主干保持 APPROVING）
  await updateParticle(inst.id, {
    patch: { ...inst.payload, current_node: backNode.id, current_node_name: backNode.payload.name, node_mode: approverRule ? (approverRule.payload.multi_approver_mode || 'ANY') : 'ANY' },
  });
  for (const [i, a] of resolved.entries()) {
    await createParticle('CRM_APPROVAL_TASK', {
      instance_id, node_id: backNode.id, approver: a,
      status: 'TODO', opinion: null,
      seq: i + 1,             // 重排（被打回节点重新签批，顺序闸重新生效）
      backed_by: by,          // 审计留痕：退回触发人
    }, { tenantId: tenantId });
  }
  emit('approval', 'task-returned', { instance_id, task_id, approver, back_node_id: backNode.id, opinion, by, returned_tasks: nodeTasks.length, reissued_tasks: resolved.length });
  return { status: 'APPROVING', current_node: backNode.id, current_node_name: backNode.payload.name, returned_tasks: nodeTasks.length, reissued_tasks: resolved.length };
}

// 节点推进（B1 修复）：当前节点全部签完后，route() 取下一节点并物化
//   - 下一节点为 END/null（或环）→ 实例终态 APPROVED
//   - 下一节点无审批人（auto_pass）→ 继续推进（递归直到首个有审批人节点或终态）
//   - 否则切 current_node + 生成新 TODO 任务，留在 APPROVING
// 依赖 materializeNode（C1）跳过 CONDITION(AI) 节点，使 AI 闸透明生效。
async function advanceToNextNode(inst, fd, ctx, tenantId = 'system') {
  const current = fd.nodes.find(n => n.id === inst.payload.current_node);
  // 取当前节点的「后继」节点（route 沿出边求值），再物化（C1 跳过 CONDITION）；
  // 注意：materializeNode(current) 会原样返回 APPROVER 自身，必须先用 route(current) 取其后继。
  const nextRaw = current ? route(current, fd, ctx) : null;
  if (!nextRaw) {
    // 无后继出边（空流/末节点无 END）→ 直接终态通过
    await updateInstanceStatus(inst, 'APPROVED');
    return { status: 'APPROVED' };
  }
  const next = materializeNode(nextRaw, fd, ctx);
  if (!next) {
    // 后继是 END 节点（物化返回 null）→ 终态，current 落到 END，便于看板呈现「已到终点」
    await updateParticle(inst.id, {
      patch: { ...inst.payload, current_node: nextRaw.id, current_node_name: nextRaw.payload.name },
    });
    // 用刷新后的实例做状态机终态迁移（避免覆盖刚写的 current_node）
    await updateInstanceStatus(await getParticle(inst.id), 'APPROVED');
    return { status: 'APPROVED' };
  }
  const approverRule = fd.approvers.find(a => a.payload.node_id === next.id);
  const totalApprovers = fd.nodes.filter(n => n.payload.node_type === 'APPROVER').length;
  const resolved = approverRule ? resolveNodeApprover(inst.payload.tier_approvers || [], approverOrdinalOf(fd, next), approverRule, { submitter: inst.payload.submitter }, totalApprovers) : fallbackNoApprover();
  if (resolved.auto_pass) {
    // 下一节点无审批人 → 直接通过并继续推进（递归到终态或首个有审批人节点）
    await updateParticle(inst.id, {
      patch: { ...inst.payload, current_node: next.id, current_node_name: next.payload.name },
    });
    return advanceToNextNode(await getParticle(inst.id), fd, ctx, tenantId);
  }
  await updateParticle(inst.id, {
    patch: { ...inst.payload, current_node: next.id, current_node_name: next.payload.name, node_mode: approverRule ? (approverRule.payload.multi_approver_mode || 'ANY') : 'ANY' },
  });
  for (const [i, approver] of resolved.entries()) {
    await createParticle('CRM_APPROVAL_TASK', {
      instance_id: inst.id, node_id: next.id, approver,
      status: 'TODO', opinion: null, seq: i + 1,
    }, { tenantId: tenantId });
  }
  return { status: 'APPROVING' };
}

// 终态更新：按目标态映射合法状态机操作（APPROVED→approve_all / REJECTED→reject / CANCELED→cancel）
// 语义修正：撤回应经「cancel」判定而非「reject」（withdrawInstance 走 CANCELED 路径）
const OP_BY_STATUS = { APPROVED: 'approve_all', REJECTED: 'reject', CANCELED: 'cancel' };
async function updateInstanceStatus(inst, status) {
  const op = OP_BY_STATUS[status];
  if (!op || !canTransition(inst.payload.status, op)) {
    throw new Error(`状态机拒绝: ${inst.payload.status} → ${status}`);
  }
  return updateParticle(inst.id, { patch: { ...inst.payload, status } });
}