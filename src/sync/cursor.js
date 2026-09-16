// src/sync/cursor.js — sync_cursor 读写（运行留痕，禁删 upsert）
// 设计输入：docs/2026-09-15-final-design-coexistence-and-proactive.md §8.2 + §T07
export function createCursorStore(pool) {
  async function get({ tenantId, provider, object }) {
    const { rows } = await pool.query(
      `SELECT * FROM crm.sync_cursor WHERE tenant_id=$1 AND provider=$2 AND external_object=$3`,
      [tenantId, provider, object],
    );
    return rows[0] || null;
  }

  async function set({ tenantId, provider, object, cursor = null, counts = {}, status = 'ok', error = null, decisionId = null }) {
    const { rows } = await pool.query(
      `INSERT INTO crm.sync_cursor (tenant_id, provider, external_object, cursor_value, last_run_at, last_status, last_error, last_counts, decision_id, updated_at)
       VALUES ($1,$2,$3,$4,now(),$5,$6,$7,$8,now())
       ON CONFLICT (tenant_id, provider, external_object)
       DO UPDATE SET cursor_value=EXCLUDED.cursor_value, last_run_at=now(), last_status=EXCLUDED.last_status,
         last_error=EXCLUDED.last_error, last_counts=EXCLUDED.last_counts, decision_id=EXCLUDED.decision_id, updated_at=now()
       RETURNING *`,
      [tenantId, provider, object, cursor, status, error, JSON.stringify(counts), decisionId],
    );
    return rows[0];
  }

  return { get, set };
}
