// src/particles/mintId.js — 6.7 确定性标识铸造（借鉴 Semantica mint_entity_iri / mint_relationship_iri）
// 设计输入：docs/2026-08-30-semantica-decision-accountability-design.md §11 增量 A
// 核心立场：UUID 主键不变（gen_random_uuid），额外派生 stable_key 做幂等定址；
//   content_hash 负责"判变"（内容未变不重算），stable_key 负责"定址"（同一事实跨运行同标识，dedup 不产生孤儿）。
// 与 Semantica 差异：我们不改主键、不引入 rdflib/owlready2，纯 sha256 + 文本 IRI，零外部依赖。
import { createHash } from 'crypto';
import { query as defaultQuery, queryWrite as defaultWrite } from '../db.js';

// 单一事实源：tenant|type|naturalKey → 64 位 hex（确定性，跨进程/跨运行一致）
export function stableKey({ tenantId = 'system', type, naturalKey }) {
  if (type == null || naturalKey == null) throw new Error('stableKey requires type and naturalKey');
  return createHash('sha256')
    .update(`${tenantId}|${type}|${naturalKey}`)
    .digest('hex');
}

// 实体 IRI（与 Semantica mint_entity_iri 同语义，文本协议 crm:// 便于跨系统对齐）
export function mintEntityIri({ tenantId = 'system', type, naturalKey }) {
  return `crm://entity/${stableKey({ tenantId, type, naturalKey })}`;
}

// 关系 IRI（与 Semantica mint_relationship_iri 同语义：fromIri|relType|toIri 铸键）
export function mintRelationshipIri({ fromIri, relType, toIri }) {
  if (!fromIri || !relType || !toIri) throw new Error('mintRelationshipIri requires fromIri, relType, toIri');
  return `crm://rel/${createHash('sha256').update(`${fromIri}|${relType}|${toIri}`).digest('hex')}`;
}

// 粒子自然键 = slug（人类可读标识）；tenant 默认 system
export function computeParticleStableKey(type, slug, tenantId = 'system') {
  return stableKey({ tenantId, type, naturalKey: slug });
}

// 回填：为已存在粒子补 stable_key（幂等；唯一索引保证并发安全）
export async function backfillStableKeys({ query: q = defaultQuery, write: w = defaultWrite } = {}) {
  const rows = await q(
    `SELECT id, tenant_id, type, slug FROM crm.particles WHERE stable_key IS NULL AND slug IS NOT NULL`
  );
  let n = 0;
  for (const r of rows.rows) {
    const key = computeParticleStableKey(r.type, r.slug, r.tenant_id || 'system');
    try {
      await w(`UPDATE crm.particles SET stable_key=$2 WHERE id=$1`, [r.id, key]);
      n += 1;
    } catch (e) {
      // 唯一冲突（理论上 slug 应唯一，极个别脏数据）→ 跳过，不阻断
      console.error('[mintId] backfill skip', r.id, e?.message);
    }
  }
  return { backfilled: n };
}

// 幂等 upsert：按 stable_key 命中则更新、未命中则插入（解决 dedup 孤儿 + 重复写入）
export async function upsertParticleByStableKey(
  { type, slug, title, payload = {}, tenantId = 'system', state = 'ACTIVE', decision_id = null },
  { write: w = defaultWrite } = {}
) {
  const key = computeParticleStableKey(type, slug, tenantId);
  const res = await w(
    `INSERT INTO crm.particles (tenant_id, type, slug, title, payload, state, stable_key, decision_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     ON CONFLICT (stable_key) DO UPDATE
       SET title=EXCLUDED.title, payload=EXCLUDED.payload, state=EXCLUDED.state, updated_at=now()
     RETURNING id, stable_key`,
    [tenantId, type, slug, title, JSON.stringify(payload), state, key, decision_id]
  );
  return res.rows[0];
}
