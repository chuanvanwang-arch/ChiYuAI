// src/connectors/discovery/draftRepo.js — discovery_draft 暂存读写（软清理，禁物理 DELETE）
import { query, queryWrite } from '../../db.js';

export async function insertDraft({ tenantId = 'system', provider, kind, items = [] } = {}) {
  const r = await queryWrite(
    `INSERT INTO crm.discovery_draft (tenant_id, provider, kind, items)
     VALUES ($1,$2,$3,$4) RETURNING draft_id, status, created_at, expires_at`,
    [tenantId, provider, kind, JSON.stringify(items)]
  );
  return r.rows[0];
}

export async function getDraft(draftId, { tenantId = 'system' } = {}) {
  const r = await query(`SELECT * FROM crm.discovery_draft WHERE draft_id=$1 AND tenant_id=$2`, [draftId, tenantId]);
  return r.rows[0] || null;
}

// 软过期：置 consumed（已消费）或 expired（软过期清理），绝不物理删
export async function softExpireDraft(draftId, status = 'consumed') {
  await queryWrite(
    `UPDATE crm.discovery_draft SET status=$2, consumed_at=now() WHERE draft_id=$1 AND status='pending'`,
    [draftId, status]
  );
}

// 软过期清理（定时任务调用）：把超过 expires_at 的 pending 翻为 expired（不删行）
export async function sweepExpired({ tenantId = 'system' } = {}) {
  await queryWrite(
    `UPDATE crm.discovery_draft SET status='expired', consumed_at=now()
     WHERE tenant_id=$1 AND status='pending' AND expires_at < now()`,
    [tenantId]
  );
}
