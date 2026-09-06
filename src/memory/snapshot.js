// src/memory/snapshot.js — 不可变记忆快照（审批/凭证/报价版本）
import { query, queryWrite } from '../db.js';

export async function createSnapshot({ topic, refId, snapshot }) {
  const r = await queryWrite(
    `INSERT INTO crm.memory_snapshot (topic, ref_id, snapshot) VALUES ($1,$2,$3) RETURNING *`,
    [topic, refId, snapshot]
  );
  return r.rows[0];
}

export async function getSnapshot(refId) {
  const r = await query(`SELECT * FROM crm.memory_snapshot WHERE ref_id=$1 ORDER BY created_at DESC`, [refId]);
  return r.rows;
}
