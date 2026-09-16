// src/signal/scheduleScanner.js — T15 时间型信号（signal-schedule 配置驱动）
// 三类：quote_approval_timeout / stage_silence / price_baseline_drift
// 阈值全读 config_store['signal-schedule']（零字面量）；命中落 crm.signal source='rule-scan'
import { readConfig as defaultRead } from '../config/configStore.js';

export function createScheduleScanner({ query, signalStore, readConfig = defaultRead } = {}) {
  // 单规则命中评估（纯函数，可单测）：返回 true 表示该实体命中
  function hitsRule(rule, entity, now = Date.now()) {
    const p = entity.payload || {};
    const cond = rule.condition || {};
    const fieldVal = p[cond.field];
    if (cond.op === 'eq' && fieldVal !== cond.value) return false;
    if (cond.op === 'ne' && fieldVal === cond.value) return false;
    if (rule.threshold_days != null) {
      const ts = p[rule.ts_field || 'updated_at'] || p.approval_requested_at || p.last_activity_at;
      if (!ts) return false;
      const ageDays = (now - new Date(ts).getTime()) / 86400000;
      if (ageDays < rule.threshold_days) return false;
    }
    return true;
  }

  async function scanOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const cfgRow = await readConfig('signal-schedule', { tenantId }).catch(() => null);
    const cfg = cfgRow?.value || {};
    if (cfg.enabled === false) return { scanned: 0, signals: 0 };
    const rules = Array.isArray(cfg.rules) ? cfg.rules.filter((r) => r.enabled !== false) : [];
    if (!rules.length) return { scanned: 0, signals: 0 };
    const types = [...new Set(rules.map((r) => r.entity_type))];
    const { rows } = await query(
      `SELECT id, tenant_id, payload FROM crm.particles WHERE type = ANY($1::text[]) AND tenant_id=$2`,
      [types, tenantId]
    );
    let signals = 0;
    for (const entity of rows) {
      for (const rule of rules) {
        if (entity.payload?.type && entity.payload.type !== rule.entity_type) continue;
        if (!hitsRule(rule, entity, now)) continue;
        const r = await signalStore.create({
          tenant_id: tenantId, source: 'rule-scan', kind: rule.kind,
          severity: rule.severity || 'medium', target_role: rule.target_role || 'sales',
          // T21 个人隔离：时间型信号的负责人取粒子 payload.owner_id（商机的跟进责任人是私人事务）。
          //   ⚠ 原实现**丢弃了**该键（entity.payload.owner_id 一直可读却从未传）→ 204 行 owner_id 全 NULL 的成因之一。
          //   无主的（如公海/未分配）落 NULL → 按 target_role 广播，符合语义。
          owner_id: entity.payload?.owner_id || null,
          particle_id: entity.id,
          payload: { subject: `${rule.kind} 命中`, rule_id: rule.id },
          evidence: { rule_id: rule.id, threshold_days: rule.threshold_days },
          dedup_key: `schedule:${rule.id}:${entity.id}:${rule.bucket || 'day'}`,
        });
        if (r?.ok) signals += 1;
      }
    }
    return { scanned: rows.length, signals };
  }
  return { scanOnce, hitsRule };
}
