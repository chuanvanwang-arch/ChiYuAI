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
    // L3 前瞻语义（2026-09-16）：'due_within_days' —— 「截止日落在未来 N 天内」
    //   存在理由：既有实现只支持 threshold_days 的「已逾期 N 天」（age ≥ N），而「投标截止」「汇报到期」
    //   属**前瞻**型；用 age 语义会得到「截止日过去 N 天之后才提醒」（时机反了）。
    //   与既有 age 语义互斥且不改后者：本分支只认 condition.op，**不读** rule.threshold_days，
    //   故旧规则（有 threshold_days、无该 op）走原路径 → 零回归（见测试负向对照）。
    if (cond.op === 'due_within_days') {
      // ts_field 必须由规则**显式**声明：回退 updated_at 会把「最近改过」当截止日 → 假提醒
      if (!rule.ts_field) return false;
      const ts = p[rule.ts_field];
      if (!ts) return false;
      const win = Number(cond.threshold_days);
      if (!Number.isFinite(win)) return false;
      const dueInDays = (new Date(ts).getTime() - now) / 86400000;
      if (Number.isNaN(dueInDays)) return false;   // 非 ISO 文本（实测 payload.bidding.started_at 即此类）
      return dueInDays >= 0 && dueInDays <= win;   // 已过期（<0）与超窗（>win）均不命中
    }
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
