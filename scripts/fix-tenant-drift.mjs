// scripts/fix-tenant-drift.mjs — 生产库租户数据漂移修复（2026-09-09）
// 背景：自助注册生成 co-<hash> 真实租户，而行业种子写死 acme-<行业> slug，导致孤儿引用
//       （crm_users / config_store 指向 tenants 表中不存在的租户行）。
// 方案 A（以真实租户表为准）：迁移孤儿引用 + 补建缺失租户行 + 友好名补正。
// 安全：默认 DRY-RUN（仅报告不写库）；显式 --apply 才写。
//       --apply 写前对 tenants / crm_users / config_store 建 _bak_20260909 快照（禁 DELETE）。
// 依赖：src/db.js（默认连 crm_native 生产库）、db/seed/tenantDefaults.js
import { queryWrite } from '../src/db.js';
import { seedTenantDefaults } from '../db/seed/tenantDefaults.js';

const APPLY = process.argv.includes('--apply');
const BAK = '20260909';

async function snapshot() {
  for (const t of ['tenants', 'crm_users', 'config_store']) {
    await queryWrite(`CREATE TABLE IF NOT EXISTS crm.${t}_bak_${BAK} AS SELECT * FROM crm.${t}`).catch(() => {});
  }
  console.log('[snapshot] 已建/复用备份表 crm.{tenants,crm_users,config_store}_bak_20260909');
}

async function migrate() {
  // ① acme-consult2 孤儿（无真实租户行）→ 管理咨询2 真实租户 co-036cq4k
  const u = await queryWrite(`UPDATE crm.crm_users SET tenant_id='co-036cq4k' WHERE tenant_id='acme-consult2'`);
  const c = await queryWrite(`UPDATE crm.config_store SET tenant_id='co-036cq4k' WHERE tenant_id='acme-consult2'`);
  console.log(`[migrate] acme-consult2 -> co-036cq4k : users=${u.rowCount}, config=${c.rowCount}`);
  await queryWrite(`UPDATE crm.tenants SET name='管理咨询2' WHERE tenant_id='co-036cq4k'`);

  // ② 补建缺失租户行（其 user/config 已指向这些 slug，补行即有家）
  //    注意：acme-consult 已由用户在自助注册时建好真实租户行（不在补建列表），不重复 seed 以免覆盖其通用键。
  const FRIENDLY = { 'acme-meddev': '医疗器械' };
  for (const [id, name] of Object.entries(FRIENDLY)) {
    const exists = await queryWrite('SELECT 1 FROM crm.tenants WHERE tenant_id=$1', [id]);
    if (exists.rowCount > 0) { console.log(`[skip] ${id} 租户行已存在，跳过补建`); continue; }
    const r = await seedTenantDefaults(id, { all: true });
    await queryWrite(`UPDATE crm.tenants SET name=$2 WHERE tenant_id=$1`, [id, name]);
    console.log(`[seed] ${id} (${name}) : seededKeys=${(r.seededKeys || []).join(',')}`);
  }
}

async function report(tag) {
  const ten = await queryWrite('SELECT tenant_id,name,status FROM crm.tenants ORDER BY tenant_id');
  const orphan = await queryWrite("SELECT COALESCE(tenant_id,'system') tid, count(*) n FROM crm.crm_users GROUP BY tenant_id ORDER BY n DESC");
  const prof = await queryWrite("SELECT tenant_id FROM crm.config_store WHERE key='tenant-profile' ORDER BY tenant_id");
  const tset = new Set(ten.rows.map((r) => r.tenant_id));
  const orphans = orphan.rows.map((r) => r.tid).filter((t) => t !== 'system' && !tset.has(t));
  console.log(`\n=== ${tag} ===`);
  console.log('tenants(' + ten.rows.length + '):', ten.rows.map((r) => `${r.tenant_id}(${r.name})`).join(', '));
  console.log('users by tenant:', orphan.rows.map((r) => `${r.tid}:${r.n}`).join(' | '));
  console.log('tenant-profile:', prof.rows.map((r) => r.tenant_id).join(', '));
  console.log('孤儿引用(users指向无租户行):', orphans.length ? orphans.join(', ') : '无 ✅');
}

(async () => {
  console.log(APPLY ? '⚠ 生产写模式 --apply：将修改 crm_native' : 'DRY-RUN：仅报告，不写库');
  await report('BEFORE');
  if (APPLY) {
    await snapshot();
    await migrate();
    await report('AFTER');
  } else {
    console.log('\n执行修复：`node scripts/fix-tenant-drift.mjs --apply`（写前自动备份三表，全程禁 DELETE）。');
  }
  process.exit(0);
})();
