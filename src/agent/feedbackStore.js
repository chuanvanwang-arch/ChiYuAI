// src/agent/feedbackStore.js — 非合规回写：落库（幂等 upsert）+ 镜像 <doc>.feedback.json
import { query, queryWrite } from '../db.js';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export async function upsertFeedback({ contractTaskId, agent, gapType, observed, expected, severity = 'medium' }) {
  const r = await queryWrite(
    `INSERT INTO crm.agent_contract_feedback
       (contract_task_id, agent, gap_type, observed, expected, severity)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (contract_task_id, gap_type)
     DO UPDATE SET observed=EXCLUDED.observed, expected=EXCLUDED.expected,
                   severity=EXCLUDED.severity, ts=now(), resolved=false
     RETURNING *`,
    [contractTaskId, agent, gapType, observed, expected, severity]
  );
  return r.rows[0];
}

export function mirrorFeedback(docPath, entry) {
  if (!docPath) return { ok: false, reason: 'no_doc' };
  const fpath = docPath.replace(/\.md$/, '.feedback.json');
  let arr = [];
  try {
    if (existsSync(fpath)) arr = JSON.parse(readFileSync(fpath, 'utf8'));
    if (!Array.isArray(arr)) arr = [];
  } catch { arr = []; }
  const normalized = {
    ...entry,
    task: entry.task ?? entry.contractTaskId ?? null,
    gap_type: entry.gap_type ?? entry.gapType ?? null,
    contractTaskId: entry.contractTaskId ?? entry.task ?? null,
    gapType: entry.gapType ?? entry.gap_type ?? null,
  };
  arr.push({ ...normalized, ts: new Date().toISOString() });
  try { writeFileSync(fpath, JSON.stringify(arr, null, 2)); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}

export async function markSuccess(contractTaskId, marked) {
  const r = await queryWrite(
    `INSERT INTO crm.agent_contract_feedback
       (contract_task_id, gap_type, observed, expected, severity)
     VALUES ($1,'success',$2,$3,'info')
     ON CONFLICT (contract_task_id, gap_type)
     DO UPDATE SET observed=EXCLUDED.observed, ts=now()
     RETURNING *`,
    [contractTaskId, marked ? 'pass' : 'fail', marked ? '人工标记通过' : '人工标记不通过']
  );
  return r.rows[0];
}
