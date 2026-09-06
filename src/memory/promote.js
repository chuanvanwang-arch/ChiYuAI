// src/memory/promote.js — task→tenant 推广：把某客户记忆（memory_log）提升为租户级经验模板（tenant_precedent）。
// 红线：仅本租户内（防 PII 跨租户泄漏）；append-only（INSERT，禁 DELETE）；须带 decision_id（第0闸）。
// 设计依据：docs/2026-09-04-param-propagation-hub-design.md §3.3 轴 A / §4.3
import { emit } from '../events/bus.js';

export async function promoteMemoryToTenant(pool, { memoryId, tenantId, by = 'system', decisionId = null, title = null }) {
  if (!memoryId || !tenantId) throw new Error('promoteMemoryToTenant 需要 memoryId 与 tenantId');
  const m = await pool.query(
    `SELECT id, tenant_id, topic, payload FROM crm.memory_log WHERE id=$1`,
    [memoryId]
  );
  const src = m.rows[0];
  if (!src) throw new Error('源记忆不存在');
  if (src.tenant_id !== tenantId) {
    throw new Error(`租户不匹配：记忆属 ${src.tenant_id}，请求 ${tenantId}（禁止跨租户推广 PII）`);
  }
  const r = await pool.query(
    `INSERT INTO crm.tenant_precedent (tenant_id, memory_id, title, payload, source_kind, promoted_from, decision_id, created_by)
     VALUES ($1,$2,$3,$4,'memory',$5,$6,$7) RETURNING *`,
    [tenantId, memoryId, title || src.topic || '未命名经验', JSON.stringify(src.payload || {}), memoryId, decisionId, by]
  );
  emit('trace', 'memory-promoted', { memoryId, tenantId, by, decisionId });
  return { ok: true, row: r.rows[0] };
}

export async function listTenantPrecedents(pool, tenantId) {
  const r = await pool.query(
    `SELECT id, tenant_id, memory_id, title, source_kind, created_at FROM crm.tenant_precedent WHERE tenant_id=$1 ORDER BY created_at DESC`,
    [tenantId]
  );
  return r.rows;
}
