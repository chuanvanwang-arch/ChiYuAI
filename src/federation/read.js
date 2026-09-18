// src/federation/read.js — 联邦感知读（最小改动读路径）
// 设计：docs/2026-09-18-dealer-portal-design.md §13.2
// 纪律：仅返回 tenantIds 集合内的粒子（tenant_id = ANY($1)）；普通单租户读仍走 listParticles，不受此影响（零侵入）
import { query as _query } from '../db.js';

// 联邦感知列表读：调用方须先经 federationReadScope 取得 tenantIds 集合再传入。
// 任意不在集合内的 tenant_id 行一律不返回（cross_tenant_read_denied 语义）。
export async function listFederatedParticles(
  { tenantIds, type = null, limit = 50, excludes = [], query = _query } = {},
) {
  if (!Array.isArray(tenantIds) || !tenantIds.length) return [];
  const params = [tenantIds];
  let sql = 'SELECT * FROM crm.particles WHERE tenant_id = ANY($1::text[])';
  if (type) {
    params.push(type);
    sql += ` AND type = $${params.length}`;
  }
  if (excludes.length) {
    params.push(excludes);
    sql += ` AND state <> ALL($${params.length}::text[])`;
  }
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const r = await query(sql, params);
  return r.rows;
}
