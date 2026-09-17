// src/signal/activityDerivation.js — 内部可观测客户异动派生（设计 docs/2026-09-16-internal-signal-derivation-design.md §3.1）
//
// 立论：用户主张「可以筛选新客户，比如新战略、高层变动、人员招聘」此前只有一条**权重配置**
//   （src/config/discoveryRules.js:35 的 leadership_change），全仓无任何适配器产出该字段 —— 典型
//   「配置承诺 ≠ 实现」。本模块把该主张收敛为**内部可观测、可证伪**的两类信号。
//
// 数据面实测（2026-09-16，本地 crm_native）与据此的两处**口径收敛**（必须保留本注释）：
//   ① 「招聘 / 新战略」在本平台**零数据源**（无 HR、无战略情报面）⇒ 本模块**不产出**这两个字段。
//      绝不写"看起来在跑"的桩映射（P0 刚清掉的假绿形态）。
//   ② `decision_relation`（125 行：REFERENCED_PRECEDENT 71 / DECIDED_ON 49 / OVERRIDES / CAUSED…）
//      语义是「我方某决策作用于某实体」= 平台内部决策网，**不是**客户组织人事 ⇒ **不可**用作
//      「关键人变动」代理。据此派生等于新造一个桩，故排除。
//   ③ `relation_cooling` 原设计含「且无近期互动」。实测 `src/particles/interactionIndex.js` 声明的
//      email/calendar/call/meeting 枚举**全仓零外部消费者**（孤儿模块）、DB 侧亦无互动流水表
//      ⇒ 本批**只用粒子 updated_at 停滞**近似，并以此作为该信号的语义边界（不宣称"互动缺失"）。
//
// 铁律：
//   A. 派生信号必须自带来源与置信语义（source='derived'、payload.confidence_basis='internal_inference'），
//      且不得与实测情报同权（权重低于实测来源，见 discoveryRules.coverage 与守卫测试）。
//   B. 阈值/窗口/启停 100% 配置化（config_store['internal-signal-derivation']），零代码字面量。
//   C. fail-closed：读不到配置 / 实体缺失 → 不产出，并在返回值 missing[] 中显式归因（不静默、不造假）。
//   D. 零 DELETE；dedup_key 与 idx_signal_dedup 的部分索引谓词配合（同 (tenant_id,dedup_key) 未关闭唯一）。
import { readConfig as defaultRead } from '../config/configStore.js';

export function createActivityDerivation({ query, signalStore, readConfig = defaultRead } = {}) {
  // 桶键：决定「多久算一次新的异动提醒」。同日/同周/同月内重复派生 → 键相同 → 由 store.create 幂等吸收。
  function bucketKey(now = Date.now(), bucket = 'day') {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    if (bucket === 'month') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
    if (bucket === 'week') {
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - day);
      const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      return `${t.getUTCFullYear()}-W${p(Math.ceil(((t - yStart) / 86400000 + 1) / 7))}`;
    }
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 单实体命中评估（纯函数，可单测）：
  //   window_days  —— 近 N 天内**发生过变动**（= 近期变动）
  //   threshold_days —— 已停滞**超过 N 天**（= 冷却）
  //   两者语义相反，故必须由规则显式声明、互斥判定；缺字段一律不命中（不把"未知时间"当"刚更新"）。
  function hitsRule(rule, entity, now = Date.now()) {
    const ts = entity?.payload?.updated_at;
    if (!ts) return false;
    const t = new Date(ts).getTime();
    if (Number.isNaN(t)) return false;
    const ageDays = (now - t) / 86400000;
    if (rule.window_days != null) return ageDays <= Number(rule.window_days);
    if (rule.threshold_days != null) return ageDays > Number(rule.threshold_days);
    return false;   // 两条都没声明 → 规则不完整，不命中（不猜测语义）
  }

  async function loadConfig(tenantId) {
    try {
      const row = await readConfig('internal-signal-derivation', { tenantId });
      return row?.value || null;
    } catch {
      return null;
    }
  }

  async function deriveOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const cfg = await loadConfig(tenantId);
    const missing = [];
    if (!cfg || typeof cfg !== 'object') {
      return { scanned: 0, signals: 0, deduped: 0, missing: [{ reason: 'config_missing' }] };
    }
    if (cfg.enabled === false) return { scanned: 0, signals: 0, deduped: 0, missing: [] };
    const rules = Array.isArray(cfg.rules) ? cfg.rules.filter((r) => r.enabled !== false) : [];
    if (!rules.length) return { scanned: 0, signals: 0, deduped: 0, missing: [{ reason: 'no_rules' }] };

    let scanned = 0, signals = 0, deduped = 0;
    for (const rule of rules) {
      if (!rule.entity_type) { missing.push({ rule_id: rule.id, reason: 'entity_type_required' }); continue; }
      const { rows } = await query(
        `SELECT id, tenant_id, payload FROM crm.particles WHERE type=$1 AND tenant_id=$2`,
        [rule.entity_type, tenantId],
      ).catch(() => ({ rows: [] }));
      scanned += rows.length;
      let hit = 0;
      for (const entity of rows) {
        if (!hitsRule(rule, entity, now)) continue;
        hit += 1;
        const r = await signalStore.create({
          tenant_id: tenantId,
          source: 'derived',                                  // 铁律 A：来源可辨（低置信，不与实测情报同权）
          kind: rule.kind,
          severity: rule.severity || 'low',
          target_role: rule.target_role || 'sales',
          owner_id: entity.payload?.owner_id || null,
          particle_id: entity.id,
          payload: {
            subject: `${rule.kind}（内部推断）`,
            rule_id: rule.id,
            confidence_basis: 'internal_inference',           // 铁律 A：置信依据显式落 payload
            entity_type: rule.entity_type,
          },
          evidence: {
            rule_id: rule.id,
            window_days: rule.window_days ?? null,
            threshold_days: rule.threshold_days ?? null,
            updated_at: entity.payload?.updated_at || null,
          },
          dedup_key: `derived:${rule.id}:${entity.id}:${bucketKey(now, rule.bucket)}`,
        });
        if (r?.ok) { signals += 1; if (r.deduped) deduped += 1; }
      }
      // 铁律 C：规则就绪但零命中 → 显式归因（真库数据面缺失时不得静默）
      if (hit === 0) missing.push({ rule_id: rule.id, reason: 'zero_hit', scanned: rows.length });
    }
    return { scanned, signals, deduped, missing };
  }

  // 全部租户：单租户失败不中断其余（失败项收集返回，由调用方 emit trace）
  async function deriveAllTenants({ now = Date.now() } = {}) {
    const { rows } = await query(
      `SELECT DISTINCT tenant_id FROM crm.config_store WHERE key='internal-signal-derivation'`,
    ).catch(() => ({ rows: [] }));
    const totals = { tenants: rows.length, signals: 0, deduped: 0, missing: [], failures: [] };
    for (const { tenant_id } of rows) {
      try {
        const r = await deriveOnce({ tenantId: tenant_id, now });
        totals.signals += r.signals;
        totals.deduped += r.deduped;
        for (const m of r.missing) totals.missing.push({ tenant_id, ...m });
      } catch (e) {
        totals.failures.push({ tenant_id, error: String(e?.message || e) });
      }
    }
    return totals;
  }

  return { deriveOnce, deriveAllTenants, hitsRule, bucketKey };
}
