// src/signal/prospectScanner.js — T16 拓客信号（lead-pool-config 驱动）
// 三类：s0_stale（公海 S0 超期未认领）/ s0p_recycle_warn（S0P 回收前 T-3 天）/ candidate_touch_window（候选池触达窗口）
// 只提醒不改归属（写入为零）；dedup_key 用 prospect: 前缀，与 lead-pool-recycle（emit 事件）不撞键
import { readConfig as defaultRead } from '../config/configStore.js';
import { POOL_CONFIG_KEY } from '../sales/pool.js';

export function createProspectScanner({ query, signalStore, readConfig = defaultRead } = {}) {
  async function scanOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const poolRow = await readConfig(POOL_CONFIG_KEY, { tenantId }).catch(() => null);
    const pools = (poolRow?.value?.pools) || [];
    const recycleDays = pools[0]?.recycle_rule?.recycle_days ?? 30;
    const { rows } = await query(
      `SELECT id, tenant_id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`,
      [tenantId]
    );
    let signals = 0;
    for (const e of rows) {
      const p = e.payload || {};
      const ageDays = p.pooled_at ? (now - new Date(p.pooled_at).getTime()) / 86400000 : null;
      const followAge = p.last_follow_up_at ? (now - new Date(p.last_follow_up_at).getTime()) / 86400000 : null;
      // ① S0 公海超期未认领（无归属 + 入池超 recycleDays）
      if (p.stage === 'S0' && !p.owner_id && ageDays != null && ageDays > recycleDays) {
        await emitSignal(signalStore, tenantId, e.id, 's0_stale', 'high', 'sales', `prospect:s0_stale:${e.id}:day`, { ageDays: Math.floor(ageDays) });
        signals += 1;
      }
      // ② S0P 回收前 T-3 天预警（有归属 + 跟进超 recycleDays-3）
      if (p.stage === 'S0P' && p.owner_id && followAge != null && followAge > (recycleDays - 3)) {
        await emitSignal(signalStore, tenantId, e.id, 's0p_recycle_warn', 'medium', 'sales', `prospect:s0p_recycle_warn:${e.id}:day`, { followAgeDays: Math.floor(followAge) });
        signals += 1;
      }
      // ③ 候选池触达窗口（candidate 标记 + 入池超触达窗口 5 天）
      if (p.candidate && p.stage === 'S0' && !p.owner_id && ageDays != null && ageDays > 5) {
        await emitSignal(signalStore, tenantId, e.id, 'candidate_touch_window', 'low', 'sales', `prospect:candidate_touch:${e.id}:day`, { ageDays: Math.floor(ageDays) });
        signals += 1;
      }
    }
    return { scanned: rows.length, signals };
  }
  return { scanOnce };
}

async function emitSignal(signalStore, tenantId, particleId, kind, severity, targetRole, dedupKey, payload) {
  await signalStore.create({
    tenant_id: tenantId, source: 'rule-scan', kind, severity, target_role: targetRole,
    particle_id: particleId, payload: { subject: `${kind} 预警`, ...payload },
    evidence: { scanner: 'prospect' }, dedup_key: dedupKey,
  });
}
