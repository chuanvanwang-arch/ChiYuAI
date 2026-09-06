// db/backfill-tenant-config.js — 存量租户配置 backfill（一次性迁移，幂等）
// 设计：docs/2026-09-05-tenant-config-full-isolation-design.md §A-3
// 语义：把 system 基线的 8 个租户级键深拷贝到现有租户（只补缺，不覆盖已有定制；禁 DELETE）
// 运行：
//   预演（不写库）：node db/backfill-tenant-config.js --dry-run
//   真实运行（先经用户确认——零信任 HITL）：node db/backfill-tenant-config.js
// 测试库：PGDATABASE=crm_native_test node db/backfill-tenant-config.js --dry-run
import { query } from '../src/db.js';
import { DEFAULT_TENANT_SEED_KEYS, seedTenantDefaults } from './seed/tenantDefaults.js';

const DRY_RUN = process.argv.includes('--dry-run');
const TARGET_KEYS = DEFAULT_TENANT_SEED_KEYS;

async function collectTenants() {
  const tenants = new Set();
  // ① crm.tenants 注册表
  const t1 = await query(`SELECT tenant_id FROM crm.tenants`).catch(() => ({ rows: [] }));
  for (const r of t1.rows) tenants.add(r.tenant_id);
  // ② particles 中出现的租户（并集，防注册表缺失）
  const t2 = await query(
    `SELECT DISTINCT tenant_id FROM crm.particles WHERE tenant_id IS NOT NULL AND tenant_id <> ''`
  ).catch(() => ({ rows: [] }));
  for (const r of t2.rows) tenants.add(r.tenant_id);
  // system 是模板源，不 backfill 自身
  tenants.delete('system');
  // 过滤测试/内部残留租户（billing/seat/token/verify 测试产物，播 8 键无业务意义且污染断言）
  // 命名约定：__* 双下划线前缀 = 测试/内部系统租户；t-verify-* / t6_e2e_* / t_* / tok_test* = 测试标记
  const IGNORE_PREFIX = /^(__|t-verify-|t6_e2e_|t\d_|tok_)/;
  return [...tenants].filter((t) => !IGNORE_PREFIX.test(t)).sort();
}

async function main() {
  const tenants = await collectTenants();
  console.log(`[backfill] 目标租户 ${tenants.length} 个：${tenants.join(', ') || '（无）'}`);
  console.log(`[backfill] 目标键 ${TARGET_KEYS.length} 个：${TARGET_KEYS.join(', ')}`);
  if (DRY_RUN) {
    console.log('[backfill] ⚠ --dry-run：仅展示，不写库');
    // 展示各租户当前缺哪些键（只读）
    for (const t of tenants) {
      const rs = await query(
        `SELECT key FROM crm.config_store WHERE tenant_id=$1 AND key = ANY($2::text[])`,
        [t, TARGET_KEYS]
      ).catch(() => ({ rows: [] }));
      const have = new Set(rs.rows.map((r) => r.key));
      const missing = TARGET_KEYS.filter((k) => !have.has(k));
      console.log(`[backfill] ${t}: 已有 ${have.size}/8 键, 将补 ${missing.join(', ') || '（无）'}`);
    }
    console.log('[backfill] 预演结束——真实运行需用户确认后执行（零信任 HITL）');
    process.exit(0);
  }

  let backfilled = 0;
  let skipped = 0;
  for (const tenant of tenants) {
    const res = await seedTenantDefaults(tenant, { all: true });
    backfilled += res.seededKeys.length;
    skipped += res.skippedKeys.length;
    console.log(
      `[backfill] ${tenant}: seeded=${res.seededKeys.join(',') || '-'} skipped=${res.skippedKeys.join(',') || '-'}`
    );
  }
  console.log(`[backfill] 完成：租户 ${tenants.length} 个，播种 ${backfilled} 键，跳过 ${skipped} 键（只插不删）`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[backfill] 失败:', e?.message || e);
  process.exit(1);
});
