// src/kanban/kanban.js — 极简四态状态机 + 熔断 + 审计
// 设计输入：docs/2026-08-24-ai-native-sales-crm-design.md §03 编排设计
// 复用 P2P kanban.js 接口，保持与 Agent2b 编排同构
import { query, queryWrite } from '../db.js';
import { FAILURE_LIMIT } from './types.js';
import { emit } from '../events/bus.js';

// 每次状态转换持久化审计（task_audit），供 A9 知识闭环与能力审计消费
export async function auditTransition(taskId, fromState, toState, byActor = 'system', reason = null) {
  await queryWrite(
    `INSERT INTO task_audit (task_id, from_state, to_state, by_actor, reason)
     VALUES ($1,$2,$3,$4,$5)`,
    [taskId, fromState, toState, byActor, reason]
  );
}

export async function getTask(id) {
  const r = await query('SELECT * FROM tasks WHERE id=$1', [id]);
  return r.rows[0] || null;
}

export async function listTasks({ status, chainId, tenantId = 'system' } = {}) {
  const where = ['tenant_id=$1'];
  const params = [tenantId];
  let i = 2;
  if (status) { where.push(`status=$${i++}`); params.push(status); }
  if (chainId) { where.push(`chain_id=$${i++}`); params.push(chainId); }
  const r = await query(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at`, params);
  return r.rows;
}

// 创建任务：默认 ready 态；depends_on 为 UUID[]（缺省空）
// decisionId：校准 P0 —— 升级决策落地待办时携带，打通「决策 → 待办 → 人工处置」链路
export async function createTask({ tenantId = 'system', chainId = null, step, title, actionName, payload = {}, dependsOn = [], decisionId = null }) {
  const r = await queryWrite(
    `INSERT INTO tasks (tenant_id, chain_id, step, title, action_name, payload, depends_on, status, decision_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'ready',$8) RETURNING *`,
    [tenantId, chainId, step, title, actionName, JSON.stringify(payload), dependsOn, decisionId]
  );
  return r.rows[0];
}

// 认领：ready / failed → running（failed 认领即 retry）
export async function claimTask(id, { byActor = 'scheduler' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (!['ready', 'failed'].includes(t.status)) {
    throw new Error(`任务 ${id} 状态 ${t.status} 不可认领（需 ready 或 failed）`);
  }
  const reason = t.status === 'failed' ? 'retry' : 'claim';
  const r = await queryWrite(
    `UPDATE tasks SET status='running', updated_at=now() WHERE id=$1 RETURNING *`,
    [id]
  );
  await auditTransition(id, t.status, 'running', byActor, reason);
  emit('task', 'running', { id });
  return r.rows[0];
}

// 完成：running → done，清连续失败计数
export async function completeTask(id, { result = null, resultPath = null, byActor = 'worker' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'running') throw new Error(`任务 ${id} 状态 ${t.status} 不可完成（需 running）`);
  const r = await queryWrite(
    `UPDATE tasks SET status='done', consecutive_failures=0, result=$1, result_path=$2, updated_at=now() WHERE id=$3 RETURNING *`,
    [result ? JSON.stringify(result) : null, resultPath ?? null, id]
  );
  await auditTransition(id, 'running', 'done', byActor, 'complete');
  emit('task', 'done', { id });
  return r.rows[0];
}

// 失败：running → failed；连续失败 >= FAILURE_LIMIT → blocked(circuit_break)
export async function failTask(id, { error = null, byActor = 'worker' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'running') throw new Error(`任务 ${id} 状态 ${t.status} 不可失败（需 running）`);
  const nf = t.consecutive_failures + 1;
  let toState = 'failed';
  let blockKind = null;
  if (nf >= FAILURE_LIMIT) { toState = 'blocked'; blockKind = 'circuit_break'; }
  const r = await queryWrite(
    `UPDATE tasks SET status=$1, consecutive_failures=$2, block_kind=$3, error=$4, updated_at=now() WHERE id=$5 RETURNING *`,
    [toState, nf, blockKind, error, id]
  );
  await auditTransition(id, 'running', toState, byActor, blockKind ? `circuit_break: ${error}` : `failed: ${error}`);
  emit('task', toState, { id });
  return r.rows[0];
}

// gate 阻断：running → blocked(gate_reject)；主任务未定稿，等人工裁决（② gate 阻断式）
export async function gateBlockTask(id, { gate = null, byActor = 'scheduler' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'running') throw new Error(`任务 ${id} 状态 ${t.status} 不可 gate 阻断（需 running）`);
  const summary = gate ? JSON.stringify(gate) : null;
  const r = await queryWrite(
    `UPDATE tasks SET status='blocked', block_kind='gate_reject', error=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [summary, id]
  );
  await auditTransition(id, 'running', 'blocked', byActor, `gate_reject: ${(summary || '').slice(0, 200)}`);
  emit('task', 'blocked', { id, block_kind: 'gate_reject' });
  return r.rows[0];
}

// 人工放行：blocked(gate_reject) → done（定稿）
export async function approveGateBlock(id, { byActor = 'user' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (t.status !== 'blocked' || t.block_kind !== 'gate_reject') throw new Error(`任务 ${id} 不在 blocked(gate_reject)`);
  const r = await queryWrite(
    `UPDATE tasks SET status='done', block_kind=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
    [id]
  );
  await auditTransition(id, 'blocked', 'done', byActor, 'gate_approve');
  emit('task', 'done', { id });
  return r.rows[0];
}

// reset 幂等：任意状态 → ready，清失败计数 / block / error / worker 标记
export async function resetTask(id, { byActor = 'system', reason = 'reset' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  const r = await queryWrite(
    `UPDATE tasks SET status='ready', consecutive_failures=0, block_kind=NULL, error=NULL, worker_pid=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
    [id]
  );
  await auditTransition(id, t.status, 'ready', byActor, reason);
  emit('task', 'reset', { id });
  return r.rows[0];
}

// —— awaiting_confirm 挂点（角色确认 / 敏感读 / 降级弹窗；§6.13 范式）——
// ready / failed → awaiting_confirm
export async function requestConfirm(id, { reason = 'write', byActor = 'system' } = {}) {
  const t = await getTask(id);
  if (!t) throw new Error(`任务不存在: ${id}`);
  if (!['ready', 'failed'].includes(t.status)) throw new Error(`任务 ${id} 状态 ${t.status} 不可请求确认`);
  const r = await queryWrite(
    `UPDATE tasks SET status='awaiting_confirm', awaiting_confirm_at=now(), awaiting_confirm_reason=$1, updated_at=now() WHERE id=$2 RETURNING *`,
    [reason, id]
  );
  await auditTransition(id, t.status, 'awaiting_confirm', byActor, `confirm:${reason}`);
  emit('task', 'awaiting_confirm', { id, reason });
  return r.rows[0];
}

// awaiting_confirm → running（确认执行）
export async function confirmTask(id, { role, switchedFrom = null, byActor = 'user' } = {}) {
  const t = await getTask(id);
  if (!t || t.status !== 'awaiting_confirm') throw new Error(`任务 ${id} 不在 awaiting_confirm`);
  const r = await queryWrite(
    `UPDATE tasks SET status='running', confirmed_at=now(), confirmed_role=$1, switched_from_role=$2, updated_at=now() WHERE id=$3 RETURNING *`,
    [role || t.confirmed_role, switchedFrom, id]
  );
  await auditTransition(id, 'awaiting_confirm', 'running', byActor, `confirmed:${role}`);
  emit('task', 'running', { id, role });
  return r.rows[0];
}

// awaiting_confirm → ready（取消，回到待触发）
export async function cancelConfirm(id, { byActor = 'user' } = {}) {
  const t = await getTask(id);
  if (!t || t.status !== 'awaiting_confirm') throw new Error(`任务 ${id} 不在 awaiting_confirm`);
  const r = await queryWrite(`UPDATE tasks SET status='ready', updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  await auditTransition(id, 'awaiting_confirm', 'ready', byActor, 'confirm-cancelled');
  emit('task', 'reset', { id });
  return r.rows[0];
}

// awaiting_confirm → failed（超时未响应）
export async function timeoutConfirm(id, { byActor = 'scheduler' } = {}) {
  const t = await getTask(id);
  if (!t || t.status !== 'awaiting_confirm') throw new Error(`任务 ${id} 不在 awaiting_confirm`);
  const r = await queryWrite(`UPDATE tasks SET status='failed', consecutive_failures=consecutive_failures+1, updated_at=now() WHERE id=$1 RETURNING *`, [id]);
  await auditTransition(id, 'awaiting_confirm', 'failed', byActor, 'confirm-timeout');
  emit('task', 'failed', { id, reason: 'confirm-timeout' });
  return r.rows[0];
}
