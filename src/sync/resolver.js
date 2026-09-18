// src/sync/resolver.js — entityResolver：external_ref 幂等 upsert + 软删除语义
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §T03
// 核心：同 (tenant, provider, object, external_id) 命中既有 → 更新不新建；外部删 → 软标记不物理删
// ⚠ 粒子插入对齐 src/particles/mintId.js 惯例（slug/title/stable_key 列 NOT NULL，不可照抄计划缺列 SQL）
import { randomUUID, createHash } from 'node:crypto';

export function createEntityResolver({ pool } = {}) {
  function hash(obj) { return createHash('sha256').update(JSON.stringify(obj || {})).digest('hex'); }

  function stableKey(type, slug, tenantId) {
    // 对齐 src/particles/mintId.js computeParticleStableKey：sha256(tenant|type|slug)
    return hash(`${tenantId}|${type}|${slug}`);
  }

  async function findRef({ tenantId, provider, object, externalId }) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.external_ref WHERE tenant_id=$1 AND provider=$2 AND external_object=$3 AND external_id=$4`,
      [tenantId, provider, object, externalId],
    );
    return rows[0] || null;
  }

  async function markOutbound({ tenantId = 'system', provider, object, externalId, fields = {} } = {}) {
    const existing = await findRef({ tenantId, provider, object, externalId });
    if (!existing) return { ok: false, error: 'ref_not_found' };
    // P0-3（2026-09-18，ROX §1.3③）：我方回写成功 → 记 last_direction='out' + last_hash（写入内容哈希）。
    //   供 upsert 前置 classifyOrigin 判定「读回的是我方写出的回声」→ 不计 created/updated、不触发下游信号。
    const h = hash({ ...fields });
    const { rows } = await pool.query(
      `UPDATE crm.external_ref SET last_direction='out', last_hash=$2, outbound_at=now(), last_synced_at=now(), updated_at=now() WHERE id=$1 RETURNING *`,
      [existing.id, h],
    );
    return { ok: true, direction: 'out', hash: h, external_ref: rows[0] };
  }

  // —— P0-3 classifyOrigin：回声（我方此前回写成功且内容未变）识别 ——
  // 判据：existing.last_direction==='out' && existing.last_hash===本次写入哈希。
  //   命中即「我方写出被读回」，视为回声：不计 created/updated、不触发下游信号、只刷新 last_synced_at。
  function isEcho(existing, h) {
    return !!existing && existing.last_direction === 'out' && existing.last_hash === h;
  }

  async function upsert({ tenantId = 'system', provider, object, externalId, particleType, payload = {} }) {
    const existing = await findRef({ tenantId, provider, object, externalId });
    const h = hash({ ...payload });
    if (existing) {
      // P0-3 回声检测前置：我方写出的被读回 → 落回声分支（防 ROX 回环），不进正常更新。
      if (isEcho(existing, h)) {
        await pool.query(
          `UPDATE crm.external_ref SET last_synced_at=now(), updated_at=now() WHERE id=$1`,
          [existing.id],
        );
        return { created: false, updated: false, echo: true, particle_id: existing.particle_id, external_ref: existing };
      }
      // 已有：更新粒子 payload + external_ref（幂等：last_hash 同则仍更新，无副作用）
      const { rows: pRows } = await pool.query(
        `UPDATE crm.particles SET payload=$2, updated_at=now() WHERE id=$1 RETURNING id`,
        [existing.particle_id, JSON.stringify(payload)],
      );
      const { rows: rRows } = await pool.query(
        `UPDATE crm.external_ref SET last_hash=$2, last_direction='in', last_synced_at=now(), external_deleted_at=NULL, updated_at=now() WHERE id=$1 RETURNING *`,
        [existing.id, h],
      );
      return { created: false, updated: pRows.length > 0, particle_id: existing.particle_id, external_ref: rRows[0] };
    }
    // 新建：粒子 + external_ref
    const pid = randomUUID();
    const slug = `${object}:${externalId}`.toLowerCase(); // 对齐粒子 slug 惯例（类型可读标识）
    const title = payload.name || payload.title || slug;
    const key = stableKey(particleType, slug, tenantId);
    const { rows: pRows } = await pool.query(
      `INSERT INTO crm.particles (id, tenant_id, type, slug, title, payload, state, stable_key)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7) RETURNING id`,
      [pid, tenantId, particleType, slug, title, JSON.stringify(payload), key],
    );
    const { rows: rRows } = await pool.query(
      `INSERT INTO crm.external_ref (tenant_id, provider, external_object, external_id, particle_type, particle_id, last_hash, last_direction, last_synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'in',now()) RETURNING *`,
      [tenantId, provider, object, externalId, particleType, pid, h],
    );
    return { created: true, updated: false, particle_id: pid, external_ref: rRows[0] };
  }

  async function markDeleted({ tenantId, provider, object, externalId }) {
    const existing = await findRef({ tenantId, provider, object, externalId });
    if (!existing) return { ok: false, error: 'ref_not_found' };
    await pool.query(
      `UPDATE crm.external_ref SET external_deleted_at=now(), updated_at=now() WHERE id=$1`,
      [existing.id],
    );
    // 粒子保留（零 DELETE 铁律）
    return { ok: true, particle_id: existing.particle_id, external_ref: existing };
  }

  return { upsert, markOutbound, markDeleted, findRef };
}
