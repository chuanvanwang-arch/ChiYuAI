// src/billing/subscriptionService.js — 订阅状态机 + 实时费用 + 模块归因
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { computeBilling, DEFAULT_PLAN } from './pricing.js';

async function getPlanDef(planId) {
  const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
  const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
  return plans.find((p) => p.plan_id === planId) || plans[0] || DEFAULT_PLAN;
}

// 创建订阅（初始/升级/续费共用入口）：
//   mode='create'  新建 pending 订阅
//   mode='renew'   延长现有 active 订阅 expires_at（+周期）
//   mode='upgrade' 切换 tenants.plan + 新订阅行（upgraded_from=旧档）
export async function createSubscription(tenantId, planId, cycle = 'monthly') {
  const plan = await getPlanDef(planId);
  const months = cycle === 'quarterly' ? 3 : 1;
  const res = await queryWrite(
    `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, expires_at)
     VALUES ($1,$2,'pending', now() + ($3 || ' months')::interval)
     RETURNING *`,
    [tenantId, planId, months]
  );
  return res.rows[0];
}

export async function renewSubscription(tenantId, planId, cycle = 'monthly', onlineOrderNo = null) {
  const months = cycle === 'quarterly' ? 3 : 1;
  const r = await queryWrite(
    `UPDATE crm.tenant_subscription SET expires_at = now() + ($3 || ' months')::interval,
       updated_at = now()
     WHERE tenant_id=$1 AND plan_id=$2 AND status='active'
     RETURNING *`,
    [tenantId, planId, months]
  );
  if (onlineOrderNo) {
    await queryWrite(
      `UPDATE crm.tenant_subscription SET online_order_no=$1 WHERE tenant_id=$2 AND plan_id=$3 AND status='active' ORDER BY started_at DESC LIMIT 1`,
      [onlineOrderNo, tenantId, planId]
    );
  }
  if (!r.rows[0]) return createSubscription(tenantId, planId, cycle);
  return r.rows[0];
}

export async function upgradeSubscription(tenantId, toPlanId, cycle = 'monthly') {
  const cur = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
  const from = cur.rows[0]?.plan || null;
  const months = cycle === 'quarterly' ? 3 : 1;
  // 新建升级订阅行 + 切换 tenants.plan（即时生效）
  const s = await queryWrite(
    `INSERT INTO crm.tenant_subscription (tenant_id, plan_id, status, expires_at, upgraded_from)
     VALUES ($1,$2,'active', now() + ($3 || ' months')::interval, $4)
     RETURNING *`,
    [tenantId, toPlanId, months, from]
  );
  await queryWrite(`UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`, [tenantId, toPlanId]);
  return s.rows[0];
}

// 到期停服：expires_at 已过且 grace 已过 → 订阅转 expired + tenants.plan 回落 default_plan(free)
export async function expireSweep() {
  const settingsRow = await readConfig('billing-settings', { tenantId: 'system' });
  const defaultPlan = settingsRow?.value?.default_plan || 'free';
  const r = await queryWrite(
    `UPDATE crm.tenant_subscription SET status='expired', updated_at=now()
     WHERE status IN ('active','grace') AND expires_at < now()
     RETURNING tenant_id`
  );
  for (const row of r.rows || []) {
    await queryWrite(`UPDATE crm.tenants SET plan=$2 WHERE tenant_id=$1`, [row.tenant_id, defaultPlan]);
  }
  return r.rows || [];
}

// 实时费用：当前周期累计 token + 当前席位 × 单价（复用 computeBilling）
export async function computeLiveCost(tenantId) {
  const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
  const settingsRow = await readConfig('billing-settings', { tenantId: 'system' });
  const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
  const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
  const plan = plans.find((p) => p.plan_id === (t.rows[0]?.plan || settingsRow?.value?.default_plan)) || plans[0] || DEFAULT_PLAN;
  const period = new Date().toISOString().slice(0, 7);
  const u = await query(
    `SELECT COALESCE(SUM(tokens_in),0)::int AS tin, COALESCE(SUM(tokens_out),0)::int AS tout
     FROM crm.token_accounting WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2`,
    [tenantId, period]
  );
  const seats = await query(`SELECT count(*)::int AS n FROM crm.crm_users WHERE tenant_id=$1 AND enabled=true`, [tenantId]);
  const seatLimit = Number(plan.included_seats ?? 0);
  const b = computeBilling(plan, u.rows[0].tin, u.rows[0].tout, seats.rows[0].n);
  const remainingSeats = seatLimit === -1 ? null : Math.max(0, seatLimit - seats.rows[0].n);
  return { tenant_id: tenantId, period, token_in: u.rows[0].tin, token_out: u.rows[0].tout,
    seats: seats.rows[0].n, seat_limit: seatLimit, remaining_seats: remainingSeats, ...b };
}

// 模块用量归因：按 (tenant_id, module, period) 增量累计
export async function bumpModuleUsage(tenantId, module, { calls = 0, tokensIn = 0, tokensOut = 0 } = {}) {
  const period = new Date().toISOString().slice(0, 7);
  await queryWrite(
    `INSERT INTO crm.module_usage (tenant_id, module, enabled, calls, tokens_in, tokens_out, period)
     VALUES ($1,$2,true,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, module, period) DO UPDATE
       SET calls = crm.module_usage.calls + EXCLUDED.calls,
           tokens_in = crm.module_usage.tokens_in + EXCLUDED.tokens_in,
           tokens_out = crm.module_usage.tokens_out + EXCLUDED.tokens_out,
           updated_at = now()`,
    [tenantId, module, calls, tokensIn, tokensOut, period]
  );
  return { ok: true };
}
