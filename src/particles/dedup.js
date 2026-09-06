// src/particles/dedup.js — P5 实体去重/解析：别名合并 + 确认闭环（软合并，不物理删）
// 设计输入：docs/superpowers/specs/2026-08-26-age-semantica-program-design.md P5
// 语义：同实体多名称（全称/简称/历史名）归一到 canonical id；确认用软合并（meta.merged_into），保留溯源。
import { query, queryWrite } from '../db.js';

// 幂等：particles.meta 列（与 db/migration-particle-meta.sql 一致）
export async function ensureDedupSchema() {
  await queryWrite(`ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS meta JSONB NOT NULL DEFAULT '{}'::jsonb`).catch(() => {});
}

// 合并候选：① 显式 alias_of ② 已确认 auto_weak 边 ③ 同域名（退化）
export async function suggestMerge(particleId) {
  const p = (await query(`SELECT payload, meta FROM crm.particles WHERE id=$1`, [particleId])).rows[0];
  if (!p) return { candidateId: null };
  if (p?.payload?.alias_of) return { candidateId: String(p.payload.alias_of) };
  const w = await query(
    `SELECT target_id FROM crm.edges
     WHERE source_id=$1 AND edge_type='auto_weak' AND meta->>'confirmed'='true' LIMIT 1`,
    [particleId]);
  if (w.rows[0]) return { candidateId: w.rows[0].target_id };
  const dom = p?.payload?.domains?.[0];
  if (dom) {
    const c = await query(
      `SELECT id FROM crm.particles WHERE type='CRM_ACCOUNT'
       AND payload->'domains' ? $1 AND id<>$2 LIMIT 1`, [dom, particleId]);
    if (c.rows[0]) return { candidateId: c.rows[0].id };
  }
  return { candidateId: null };
}

// 确认合并（软合并：标记 merged_into，不物理删除；保留双源溯源）
export async function confirmMerge(particleId, canonicalId) {
  await ensureDedupSchema();
  await queryWrite(
    `UPDATE crm.particles SET meta = COALESCE(meta,'{}') || jsonb_build_object('merged_into',$1::text) WHERE id=$2`,
    [String(canonicalId), particleId]);
  return { ok: true, mergedInto: canonicalId };
}
