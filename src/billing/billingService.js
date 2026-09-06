// src/billing/billingService.js — 计费聚合 / 出账 / 缴费 / 对账 / 导出（平台内缴费流，不接真实支付网关）
// 设计基线：docs/2026-09-04-tenant-billing-page-design.md §4.3 / §6
// 铁律：绝对禁 DELETE（缴费=插入 billing_payment + 状态机流转；逾期=读时幂等翻转）；tenant 隔离由调用方经 applyTenantOverride 收敛
import { query, queryWrite } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { computeBilling, DEFAULT_PLAN } from './pricing.js';

// 解析某租户生效档位（tenants.plan 缺省回退 billing-settings.default_plan）
export async function getPlan(tenantId) {
  const t = await query(`SELECT plan FROM crm.tenants WHERE tenant_id=$1`, [tenantId]);
  const settingsRow = await readConfig('billing-settings', { tenantId: 'system' });
  const planId = t.rows[0]?.plan || settingsRow?.value?.default_plan;
  const plansRow = await readConfig('billing-plans', { tenantId: 'system' });
  const plans = Array.isArray(plansRow?.value) ? plansRow.value : [];
  // 无效 planId → 回落 default_plan（与 resolveEntitlements 同口径），避免静默降级到数组首项
  return plans.find((p) => p.plan_id === planId)
    || plans.find((p) => p.plan_id === settingsRow?.value?.default_plan)
    || plans[0]
    || DEFAULT_PLAN;
}

// 周期内 Token 用量（in/out 合计），周期粒度 = to_char(created_at,'YYYY-MM')（账期可配为 monthly；quarterly 由调用方换算 period 字符串）
async function tokenUsage(tenantId, period) {
  const r = await query(
    `SELECT COALESCE(SUM(tokens_in),0)::int AS tin, COALESCE(SUM(tokens_out),0)::int AS tout
     FROM crm.token_accounting WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')= $2`,
    [tenantId, period]
  );
  return r.rows[0];
}

// 活跃账号数（crm_users.enabled = true，tenant 隔离）
async function activeSeats(tenantId) {
  const r = await query(
    `SELECT count(*)::int AS n FROM crm.crm_users WHERE tenant_id=$1 AND enabled = true`,
    [tenantId]
  );
  return r.rows[0].n;
}

// 计算某租户某周期账单明细（不落库，供预览/汇总）
export async function computeStatement(tenantId, period) {
  const plan = await getPlan(tenantId);
  const u = await tokenUsage(tenantId, period);
  const seats = await activeSeats(tenantId);
  const b = computeBilling(plan, u.tin, u.tout, seats);
  return { tenant_id: tenantId, period, token_in: u.tin, token_out: u.tout, ...b };
}

// 出账：写入/更新 billing_statement（幂等 ON CONFLICT tenant_id+period+cycle），状态置 issued
export async function issueStatement(tenantId, period, cycle = 'monthly', graceDays = 15) {
  const s = await computeStatement(tenantId, period);
  const res = await query(
    `INSERT INTO crm.billing_statement (tenant_id, period, cycle, token_in, token_out, token_fee, seat_count, seat_fee, total_fee, status, issued_at, due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'issued',now(),now() + ($10 || ' days')::interval)
     ON CONFLICT (tenant_id, period, cycle) DO UPDATE
       SET token_in=EXCLUDED.token_in, token_out=EXCLUDED.token_out, token_fee=EXCLUDED.token_fee,
           seat_count=EXCLUDED.seat_count, seat_fee=EXCLUDED.seat_fee, total_fee=EXCLUDED.total_fee,
           status='issued', issued_at=now(), due_at=now() + ($10 || ' days')::interval
     RETURNING *`,
    [tenantId, period, cycle, s.token_in, s.token_out, s.token_fee, s.seat_count, s.seat_fee, s.total_fee, graceDays]
  );
  return res.rows[0];
}

// 读时幂等：把已过 due_at 且仍 issued 的账单翻为 overdue（fail-open，重复调用安全）
export async function flipOverdue() {
  await query(`UPDATE crm.billing_statement SET status='overdue'
    WHERE status='issued' AND due_at < now()`);
}

// 缴费：插入 billing_payment（金额=账单 total_fee）+ 账单状态机 issued/overdue → paid
export async function pay(statementId, { method = 'other', note = '', txn_ref = '' } = {}) {
  const st = await query(`SELECT * FROM crm.billing_statement WHERE id=$1`, [statementId]);
  if (!st.rows[0]) throw new Error('statement not found');
  const s = st.rows[0];
  await query(`INSERT INTO crm.billing_payment (tenant_id, statement_id, amount, method, status, paid_at, txn_ref, note)
    VALUES ($1,$2,$3,$4,'paid',now(),$5,$6)`, [s.tenant_id, statementId, s.total_fee, method, txn_ref, note]);
  await query(`UPDATE crm.billing_statement SET status='paid', paid_at=now() WHERE id=$1`, [statementId]);
  return { ok: true };
}

// 对账：按状态聚合某周期账单笔数与金额
export async function reconcile(period) {
  const r = await query(
    `SELECT status, count(*)::int AS n, COALESCE(SUM(total_fee),0)::numeric AS amt
     FROM crm.billing_statement WHERE period=$1 GROUP BY status`, [period]);
  return r.rows;
}

// 导出 CSV（租户自助=单租户，admin 集中=全量）
export async function exportCsv(period, tenantScope = '*') {
  const sql = tenantScope === '*'
    ? `SELECT tenant_id, period, total_fee, status FROM crm.billing_statement WHERE period=$1 ORDER BY tenant_id`
    : `SELECT tenant_id, period, total_fee, status FROM crm.billing_statement WHERE period=$1 AND tenant_id=$2 ORDER BY tenant_id`;
  const r = tenantScope === '*'
    ? await query(sql, [period])
    : await query(sql, [period, tenantScope]);
  const head = 'tenant_id,period,total_fee,status\n';
  return head + r.rows.map((row) => `${row.tenant_id},${row.period},${row.total_fee},${row.status}`).join('\n');
}

// —— Token 三级聚合（租户→账号→动作），账期粒度 YYYY-MM ——

// 租户额度卡：含额度 / 已用 / 剩余 / 超量费
export async function tokenQuota(tenantId, period) {
  const plan = await getPlan(tenantId);
  const u = await tokenUsage(tenantId, period);
  const used = Number(u.tin) + Number(u.tout);
  const included = plan.included_tokens;
  const unlimited = included === -1;
  const remaining = unlimited ? null : Math.max(0, (Number(included) || 0) - used);
  const b = computeBilling(plan, u.tin, u.tout, 0);
  return {
    plan_id: plan.plan_id, plan_name: plan.name,
    included_tokens: unlimited ? -1 : Number(included) || 0,
    used_total: used, remaining, overage_fee: b.token_fee, unlimited,
  };
}

// 按账号（actor）聚合；关联 crm_users 取 username，无法匹配标 is_unattributed
export async function tokenByAccount(tenantId, period) {
  const r = await query(
    `SELECT actor,
            COALESCE(SUM(tokens_in),0)::int  AS tin,
            COALESCE(SUM(tokens_out),0)::int AS tout,
            COALESCE(SUM(tokens_in)+SUM(tokens_out),0)::int AS total
     FROM crm.token_accounting
     WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2
     GROUP BY actor ORDER BY total DESC`,
    [tenantId, period]
  );
  const rows = r.rows;
  const sum = rows.reduce((a, x) => a + Number(x.total), 0);
  const actors = rows.map((x) => x.actor);
  const userRows = actors.length
    ? (await query(
        `SELECT username, user_id FROM crm.crm_users WHERE username = ANY($1) OR user_id::text = ANY($1)`,
        [actors]
      )).rows
    : [];
  const known = new Set(userRows.flatMap((u) => [u.username, u.user_id]));
  return rows.map((x) => {
    const u = userRows.find((ru) => ru.username === x.actor || ru.user_id === x.actor);
    return {
      actor: x.actor,
      username: u?.username || null,
      tokens_in: Number(x.tin), tokens_out: Number(x.tout), total: Number(x.total),
      share_pct: sum ? Math.round((Number(x.total) / sum) * 1000) / 10 : 0,
      is_unattributed: !known.has(x.actor),
    };
  });
}

// 套餐档位维护（admin/sysadmin；禁物理删——启用/停用靠 enabled 软标记；INSERT..ON CONFLICT 幂等重播，写池）
export async function updateBillingPlans(plans, by = 'admin') {
  await queryWrite(`INSERT INTO crm.config_store (tenant_id, key, value, updated_by)
    VALUES ('system','billing-plans',$1::jsonb,$2)
    ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()
    RETURNING *`, [JSON.stringify(plans), by]);
  return { ok: true, plans };
}

// 计费设置维护（含 stripe 凭据；禁物理删，写池）
export async function updateBillingSettings(settings, by = 'admin') {
  await queryWrite(`INSERT INTO crm.config_store (tenant_id, key, value, updated_by)
    VALUES ('system','billing-settings',$1::jsonb,$2)
    ON CONFLICT (tenant_id, key) DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()
    RETURNING *`, [JSON.stringify(settings), by]);
  return { ok: true, settings };
}

// 按动作（action）聚合
export async function tokenByAction(tenantId, period) {
  const r = await query(
    `SELECT action,
            COALESCE(SUM(tokens_in),0)::int  AS tin,
            COALESCE(SUM(tokens_out),0)::int AS tout,
            COALESCE(SUM(tokens_in)+SUM(tokens_out),0)::int AS total
     FROM crm.token_accounting
     WHERE tenant_id=$1 AND to_char(created_at,'YYYY-MM')=$2
     GROUP BY action ORDER BY total DESC`,
    [tenantId, period]
  );
  const sum = r.rows.reduce((a, x) => a + Number(x.total), 0);
  return r.rows.map((x) => ({
    action: x.action,
    tokens_in: Number(x.tin), tokens_out: Number(x.tout), total: Number(x.total),
    share_pct: sum ? Math.round((Number(x.total) / sum) * 1000) / 10 : 0,
  }));
}
