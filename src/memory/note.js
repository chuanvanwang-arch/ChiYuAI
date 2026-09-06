// src/memory/note.js — L-User 常驻笔记（唯一键 upsert 重写，防膨胀）
import { query, queryWrite } from '../db.js';

export async function upsertNote({ layer = 'L-User', topic, content, ttlDays = 365 }) {
  const r = await queryWrite(
    `INSERT INTO crm.memory_note (layer, topic, content, ttl_days, updated_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (layer, topic) DO UPDATE SET content=EXCLUDED.content, ttl_days=EXCLUDED.ttl_days, updated_at=now(), archived=false
     RETURNING *`,
    [layer, topic, content, ttlDays]
  );
  return r.rows[0];
}

export async function getNote({ layer = 'L-User', topic }) {
  const r = await query(`SELECT * FROM crm.memory_note WHERE layer=$1 AND topic=$2 AND archived=false`, [layer, topic]);
  return r.rows[0] || null;
}
