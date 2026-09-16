// src/signal/followupEngine.js — followup 重评执行（T06）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T06
// 职责：读对象（resolver.findRef）→ 重算信号（store.create 幂等）→ appendMemory 合并不覆盖子键
import { createSignalStore } from './store.js';
import { createEntityResolver } from '../sync/resolver.js';

export function createFollowupEngine({ pool, signalStore, resolver, memory } = {}) {
  async function reevaluate({ object, externalId, tenantId = 'system' }) {
    const s = signalStore || createSignalStore(pool);
    const r = resolver || createEntityResolver({ pool });
    const ref = await r.findRef({ tenantId, provider: 'mock', object, externalId }).catch(() => null);
    if (!ref) return { ok: false, error: 'ref_not_found' };
    // T21 个人隔离：对象变更信号归属该对象的负责人。
    //   external_ref 无 owner 列 → 从粒子 payload 读（pool 可选：测试注入 store+resolver 时不查）。
    //   读不到就落 NULL（不臆造 owner）→ 走「无主 + target_role」广播兜底。
    let ownerId = null;
    if (pool) {
      ownerId = await pool
        .query(`SELECT payload->>'owner_id' AS oid FROM crm.particles WHERE id=$1`, [ref.particle_id])
        .then((res) => res?.rows?.[0]?.oid || null)
        .catch(() => null);
    }
    // 重算信号：同 dedup 幂等，open/acked 才建
    const sig = await s.create({
      tenant_id: tenantId, source: 'event-trigger', kind: 'object_changed',
      severity: 'medium', target_role: 'sales', owner_id: ownerId, particle_id: ref.particle_id,
      payload: { subject: `${object} ${externalId} 对象变化`, external_id: externalId },
      evidence: { object, external_id: externalId, ref_id: ref.id },
      dedup_key: `${object}:${externalId}:event`,
    }).catch(() => ({ ok: false }));
    // appendMemory：合并 discovery 子键，不覆盖既有
    let mem = null;
    if (memory && typeof memory.append === 'function') {
      mem = await memory.append(tenantId, { discovery: { last_reeval_at: new Date().toISOString(), last_external_id: externalId } }).catch(() => null);
    }
    return { ok: sig?.ok !== false, signal: sig?.alert || sig, memory: mem };
  }
  return { reevaluate };
}
