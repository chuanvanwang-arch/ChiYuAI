// src/approval/compensation.js — 写前快照 + 回滚补偿（H28 实证）
// 实证（§5bis H28 数据回滚机制）：审批结果触发的数据变更可回滚
// 与 upsert 幂等共同构成写操作完整性双保障（ai-native-action-design 事务完整性）
// F5 修正：快照落既有 crm.memory_snapshot 不可变表（schema.sql:239，禁 update/delete）
//          createSnapshot 签名 { topic, refId, snapshot }（src/memory/snapshot.js:4-9）
import { createSnapshot } from '../memory/snapshot.js';
import { recordAudit } from '../action/auditHook.js';

// 写前快照：审批后动作执行前，把将被修改的粒子属性快照为不可变快照（禁 update/delete）
// 返回 { id, topic, ref_id, snapshot: { kind:'pre_write_snapshot', business_id, before, taken_at } }
export async function snapshotFor(business_id, beforePayload, { topic = 'approval:pre_write' } = {}) {
  return createSnapshot({
    topic,
    refId: business_id,
    snapshot: {
      kind: 'pre_write_snapshot',
      business_id,
      before: beforePayload,
      taken_at: new Date().toISOString(),
    },
  });
}

// 回滚判定：ok=true → 不回滚；ok=false → 返回快照 before（由调用方 executor 应用恢复）
export async function rollbackIfNeeded(business_id, { ok }, snapshot) {
  if (ok) return { rolled_back: false };
  const before = snapshot?.snapshot?.before || {};
  return { rolled_back: true, restored: before, business_id };
}

// 审批补偿审计（V3：审批记录=审计事件流；调用方：approval/engine 驳回/失败路径）
export async function recordAuditCompensation({ business_id, action = 'rollback', reason = null, actor = 'system', decision_id = null }) {
  return recordAudit({
    target_particle_type: 'CRM_APPROVAL_INSTANCE',
    source: 'approval',
    action,
    actor,
    decision_id,
    payload: { business_id, reason, approval_instance_id: business_id },
  });
}