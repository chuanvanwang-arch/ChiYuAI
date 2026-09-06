// src/sales/pool.js — 线索池规则服务（B6：池事件源 + 回收 Action；池 = 粒子集合视图 + 组织治理配置）
// 设计输入：综合详设 §3 B6（PickRule 领取规则 + RecycleRule 回收规则）+ 01 粒子设计 line 20（池不是粒子，是组织池配置）
// 铁律：线索 = DEAL 的 lead 阶段（01 文档 line 13），不新建 CRM_LEAD 粒子；池规则挂 CRM_ORGANIZATION.pool_config
import { query, queryWrite } from '../db.js';

// 默认池配置（B6 实证：PickRule 限每日领取数量 + 限前归属人领取 + 领取间隔 + 限新数据；RecycleRule 超期未跟进自动回收）
export const DEFAULT_POOL_CONFIG = {
  pick_rule: {
    daily_limit: 10,
    prev_owner_only: false,   // 限前归属人领取（避免抢单）
    pick_interval_hours: 24,  // 领取间隔
    new_data_only: true,      // 限新数据
  },
  recycle_rule: {
    operator: 'GT',
    condition: 'last_follow_up_age_days > 30',  // 超期未跟进自动回收
    recycle_days: 30,
  },
};

// 读组织池配置（幂等补齐默认值——存量库 org-hq 池配置为空占位（seed.sql:5））
// 2026-09-05 G4：读按 tenant_id 限定（scopeTenant 传入；缺省 system——平台组织）。租户无组织 → 默认。
// query 可注入（本地单测 stub；缺省走真库连接）
export async function getPoolConfig(orgId = 'org-hq', { query: q = query, tenantId = 'system' } = {}) {
  const r = await q(
    `SELECT payload FROM crm.particles WHERE slug=$1 AND type='CRM_ORGANIZATION' AND tenant_id=$2`,
    [orgId, tenantId]
  );
  if (!r.rows[0]) return { ...DEFAULT_POOL_CONFIG };
  const cfg = r.rows[0].payload.pool_config || {};
  return {
    pick_rule: { ...DEFAULT_POOL_CONFIG.pick_rule, ...(cfg.pick_rule || {}) },
    recycle_rule: { ...DEFAULT_POOL_CONFIG.recycle_rule, ...(cfg.recycle_rule || {}) },
  };
}

// 写组织池配置（T3-12 扩展；B6 池 = 组织治理配置，后台可配置不重启）
// 2026-09-05 G4：写按 tenant_id 限定（scopeOf 传入；永不通配）。读回显同样带租户。
// 写经 queryWrite（写池铁律；q 可注入仅供本地单测 stub，生产默认走写池）
export async function setPoolConfig(orgId, patch, { query: q = query, tenantId = 'system' } = {}) {
  const w = q === query ? queryWrite : q; // 默认走写池；注入 stub 时用注入值
  const r = await q(
    `SELECT payload FROM crm.particles WHERE slug=$1 AND type='CRM_ORGANIZATION' AND tenant_id=$2`,
    [orgId, tenantId]
  );
  if (!r.rows[0]) throw new Error(`组织不存在（租户 ${tenantId}）: ${orgId}`);
  const pool_config = { ...(r.rows[0].payload.pool_config || {}), ...patch };
  await w(
    `UPDATE crm.particles SET payload = payload || $1::jsonb, updated_at=now() WHERE slug=$2 AND type='CRM_ORGANIZATION' AND tenant_id=$3`,
    [JSON.stringify({ pool_config }), orgId, tenantId]
  );
  return getPoolConfig(orgId, { query: q, tenantId });
}

// —— 领取校验（PickRule 纯判定，可本地单测）——
// ctx: { owner, prev_owner, last_picked_at, today_picked_count, follow_up_at（最近跟进）, created_at, is_new }
export function checkPickRule(rule, ctx) {
  const errors = [];
  // 1) 每日限额
  if (rule.daily_limit != null && (ctx.today_picked_count || 0) >= rule.daily_limit) {
    errors.push(`daily_limit: 今日已领取 ${ctx.today_picked_count || 0}，已达上限 ${rule.daily_limit}`);
  }
  // 2) 领取间隔（防刷单）
  if (rule.pick_interval_hours != null && ctx.last_picked_at) {
    const hours = (Date.now() - new Date(ctx.last_picked_at).getTime()) / 3600000;
    if (hours < rule.pick_interval_hours) {
      errors.push(`pick_interval: 距上次领取仅 ${hours.toFixed(1)}h，需间隔 ${rule.pick_interval_hours}h`);
    }
  }
  // 3) 限前归属人领取
  if (rule.prev_owner_only && ctx.prev_owner && ctx.owner && ctx.prev_owner !== ctx.owner) {
    errors.push(`prev_owner_only: 该线索前归属 ${ctx.prev_owner}，限定其领取`);
  }
  // 4) 限新数据（回收池内超过配置视为非新，需 prev_owner_only 兜底）
  if (rule.new_data_only && ctx.follow_up_at && ctx.is_new === false) {
    errors.push(`new_data_only: 该线索已非新数据（有跟进记录）`);
  }
  return { ok: errors.length === 0, errors };
}

// —— 回收判据（RecycleRule 纯判定）——
// 超期未跟进：last_follow_up_age_days = (now - last_follow_up_at).days > recycle_days
export function checkRecycleRule(rule, { last_follow_up_at }) {
  if (!last_follow_up_at) return { ok: false, reason: 'never_followed_up' }; // 从未跟进，不回收（避免新线索误回收）
  const days = (Date.now() - new Date(last_follow_up_at).getTime()) / 86400000;
  const threshold = rule.recycle_days != null ? rule.recycle_days : 30;
  if (days > threshold) {
    return { ok: true, reason: `overdue_${Math.floor(days)}d > ${threshold}d` };
  }
  return { ok: false, reason: `followed_up_${Math.floor(days)}d_ago` };
}