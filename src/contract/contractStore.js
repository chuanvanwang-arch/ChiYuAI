// src/contract/contractStore.js — contract_feedback 持久化（绝对禁删：仅 upsert/状态迁移，无 DELETE）
import { query } from '../db.js';

export async function getFeedback({ docPath, task } = {}) {
  const clauses = [];
  const params = [];
  if (docPath) { params.push(docPath); clauses.push(`doc_path=$${params.length}`); }
  if (task) { params.push(task); clauses.push(`task=$${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const r = await query(`SELECT * FROM crm.contract_feedback ${where} ORDER BY updated_at DESC`, params);
  return r.rows;
}

export async function upsertFeedback(row = {}) {
  const { doc_path, task, gap_type, observed = null, expected = null, severity = 'warn', status = 'open' } = row;
  if (!doc_path || !task || !gap_type) throw new Error('doc_path/task/gap_type 必填');
  const r = await query(
    `INSERT INTO crm.contract_feedback (doc_path, task, gap_type, observed, expected, severity, status, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, now())
     ON CONFLICT (doc_path, task, gap_type)
     DO UPDATE SET observed=EXCLUDED.observed, expected=EXCLUDED.expected, severity=EXCLUDED.severity, status=EXCLUDED.status, updated_at=now()
     RETURNING *`,
    [doc_path, task, gap_type, observed, expected, severity, status]
  );
  return r.rows[0];
}
