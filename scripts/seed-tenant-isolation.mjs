// scripts/seed-tenant-isolation.mjs — Phase 1 按租户隔离播种（审批流 + 业务分级）
// 语义：把 system 基线（平台模板）按租户深拷贝到各业务租户，使「不同租户可各自分化审批路径/分级」。
// 对齐 db/backfill-tenant-config.js 的租户枚举范式；只插不删（禁 DELETE 铁律），幂等可重跑。
// 运行：
//   生产：node scripts/seed-tenant-isolation.mjs
//   测试：PGDATABASE=crm_native_test node scripts/seed-tenant-isolation.mjs
//   预演：node scripts/seed-tenant-isolation.mjs --dry-run
import { query } from '../src/db.js';
import { getFlowByDomain, getFlowByDomainWithFallback, writeFlowFromStages } from '../src/approval/flow.js';

const DRY_RUN = process.argv.includes('--dry-run');

// 业务审批域（与 seed-approval-flows.mjs 对齐）
const FLOW_DOMAINS = ['quote', 'contract', 'invoice', 'order'];

const IGNORE_PREFIX = /^(__|t-verify-|t6_e2e_|t\d_|tok_)/;

async function collectTenants() {
  const tenants = new Set();
  const t1 = await query(`SELECT tenant_id FROM crm.tenants`).catch(() => ({ rows: [] }));
  for (const r of t1.rows) tenants.add(r.tenant_id);
  const t2 = await query(
    `SELECT DISTINCT tenant_id FROM crm.particles WHERE tenant_id IS NOT NULL AND tenant_id <> ''`
  ).catch(() => ({ rows: [] }));
  for (const r of t2.rows) tenants.add(r.tenant_id);
  tenants.delete('system');
  return [...tenants].filter((t) => !IGNORE_PREFIX.test(t)).sort();
}

async function seedApprovalFlows(tenant) {
  let created = 0;
  for (const domain of FLOW_DOMAINS) {
    const existing = await getFlowByDomain(domain, tenant);
    if (existing) continue;
    if (DRY_RUN) {
      console.log(`  [dry-run] ${tenant}/${domain}: 将克隆 system 流`);
      continue;
    }
    const cloned = await getFlowByDomainWithFallback(domain, tenant);
    if (cloned) created++;
  }
  return created;
}

async function seedBusinessTiers(tenant) {
  const sys = await query(
    `SELECT dimension, dimension_value, tier FROM crm.business_tier_config WHERE tenant_id='system'`
  ).catch(() => ({ rows: [] }));
  if (!sys.rows.length) return 0;
  const own = await query(
    `SELECT 1 FROM crm.business_tier_config WHERE tenant_id=$1 LIMIT 1`,
    [tenant]
  ).catch(() => ({ rows: [] }));
  if (own.rows.length) return 0;
  if (DRY_RUN) {
    console.log(`  [dry-run] ${tenant}: 将克隆 ${sys.rows.length} 条 business_tier 规则`);
    return 0;
  }
  let created = 0;
  for (const r of sys.rows) {
    await query(
      `INSERT INTO crm.business_tier_config (tenant_id, dimension, dimension_value, tier)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, dimension, dimension_value) DO NOTHING`,
      [tenant, r.dimension, r.dimension_value, r.tier]
    ).catch(() => {});
    created++;
  }
  return created;
}

async function seedAlertRules(tenant) {
  const sys = await query(
    `SELECT kind, match, check_params, severity, target_role, enabled, version
     FROM crm.alert_rule WHERE tenant_id='system'`
  ).catch(() => ({ rows: [] }));
  if (!sys.rows.length) return 0;
  const own = await query(
    `SELECT 1 FROM crm.alert_rule WHERE tenant_id=$1 LIMIT 1`,
    [tenant]
  ).catch(() => ({ rows: [] }));
  if (own.rows.length) return 0; // 幂等：已播种则跳过
  if (DRY_RUN) {
    console.log(`  [dry-run] ${tenant}: 将克隆 ${sys.rows.length} 条 alert_rule`);
    return 0;
  }
  let created = 0;
  for (const r of sys.rows) {
    await query(
      `INSERT INTO crm.alert_rule (kind, match, check_params, severity, target_role, enabled, version, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (kind, tenant_id) DO NOTHING`,
      [r.kind, JSON.stringify(r.match || {}), JSON.stringify(r.check_params || {}), r.severity, r.target_role, r.enabled !== false, r.version || 1, tenant]
    ).catch(() => {});
    created++;
  }
  return created;
}

async function main() {
  const tenants = await collectTenants();
  console.log(`[seed] 目标租户 ${tenants.length} 个：${tenants.join(', ') || '（无）'}`);
  if (DRY_RUN) console.log('[seed] ⚠ --dry-run：仅展示，不写库');

  let totalFlows = 0;
  let totalTiers = 0;
  let totalRules = 0;
  for (const tenant of tenants) {
    const flows = await seedApprovalFlows(tenant);
    const tiers = await seedBusinessTiers(tenant);
    const rules = await seedAlertRules(tenant);
    totalFlows += flows;
    totalTiers += tiers;
    totalRules += rules;
    if (flows || tiers || rules) console.log(`[seed] ${tenant}: 审批流 +${flows} / 分级 +${tiers} / 预警 +${rules}`);
  }
  console.log(`[seed] 完成：审批流共克隆 ${totalFlows} / 分级共克隆 ${totalTiers} / 预警共克隆 ${totalRules}（幂等，只插不删）`);
  process.exit(0);
}

main().catch((e) => { console.error('[seed] 失败:', e?.message || e); process.exit(1); });
