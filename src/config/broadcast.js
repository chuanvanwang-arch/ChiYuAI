// src/config/broadcast.js — 参数强制下发（broadcast）：将某 config_store 旋钮从 system 层批量落到一组租户。
// 铁律：全部走 writeConfig（upsert，禁删）；fill-only 不破坏既有定制；override 由调用方（HTTP）已 mint decision_id。
// 设计依据：docs/2026-09-04-param-propagation-hub-design.md §3.2 / §15.5
import { writeConfig } from './configStore.js';
import { emit } from '../events/bus.js';

/** 枚举所有业务租户（排除平台种子 'system'） */
export async function listTenants(pool) {
  const r = await pool.query(
    `SELECT DISTINCT tenant_id FROM crm.crm_users WHERE tenant_id <> 'system' ORDER BY tenant_id`
  );
  return r.rows.map((x) => x.tenant_id);
}

/**
 * @param {object} pool
 * @param {object} p { key, value, mode='fill-only'|'override', targets?:string[], by, decisionId }
 * @returns {Promise<{written:string[], skipped:string[], mode:string}>}
 */
export async function broadcastConfig(pool, { key, value, mode = 'fill-only', targets = null, by = 'system', decisionId = null }) {
  if (!key || value == null) throw new Error('broadcastConfig 需要 key 与 value');
  if (!['fill-only', 'override'].includes(mode)) throw new Error(`非法 mode: ${mode}`);
  const tenants = targets && targets.length ? targets : await listTenants(pool);
  const written = [];
  const skipped = [];
  for (const tid of tenants) {
    if (mode === 'fill-only') {
      // 仅查「租户自有行」：存在则已定制，不动（保留 system 继承态以外的定制）；
      // 注意不走 readConfig（其带 system 回退，会误判「继承 system 者」为已定制）。
      const ex = await pool
        .query(`SELECT 1 FROM crm.config_store WHERE tenant_id=$1 AND key=$2`, [tid, key])
        .catch(() => ({ rows: [] }));
      if (ex.rows.length) {
        skipped.push(tid);
        continue;
      }
    }
    await writeConfig(key, value, { tenantId: tid, decisionId, updatedBy: by });
    written.push(tid);
  }
  emit('trace', 'config-broadcast', { key, mode, written, skipped, by, decisionId });
  return { written, skipped, mode };
}
