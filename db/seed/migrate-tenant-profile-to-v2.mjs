// db/seed/migrate-tenant-profile-to-v2.mjs
// 一次性幂等迁移：把 tenant-profile 的 v1 单行业格式升级为 v2 多行业嵌套格式。
// 对齐「tenant-profile 多行业」设计：value 包 {version:2, industries:[]}（design §3.3）。
// 红线：① 备份表 config_store_profile_legacy_snapshot 保留不删；② 仅 UPDATE/INSERT，禁物理 DELETE；
//      ③ 保留原 decision_id（审计链）；
//      ④ 已是 v2（value.industries 为数组）则跳过。
//
// 运行：PGDATABASE=crm_native_test node db/seed/migrate-tenant-profile-to-v2.mjs
//      PGDATABASE=crm_native node db/seed/migrate-tenant-profile-to-v2.mjs   # 生产
import { pathToFileURL } from 'url';
import { query, queryWrite } from '../../src/db.js';
import { migrateFromV1 } from '../../src/config/profileMerger.js';

export async function migrateTenantProfileToV2() {
  // 1) 备份（保留不删）
  await queryWrite(
    `CREATE TABLE IF NOT EXISTS crm.config_store_profile_legacy_snapshot (LIKE crm.config_store INCLUDING ALL)`);
  await queryWrite(
    `INSERT INTO crm.config_store_profile_legacy_snapshot
     SELECT * FROM crm.config_store WHERE key='tenant-profile'
     ON CONFLICT DO NOTHING`);

  // 2) 逐行迁移
  const rows = (await query(
    `SELECT tenant_id, value, decision_id FROM crm.config_store WHERE key='tenant-profile'`)).rows;
  let migrated = 0, skipped = 0;
  for (const row of rows) {
    const v = row.value || {};
    if (Array.isArray(v.industries)) { skipped++; continue; } // 已是 v2
    const isSys = row.tenant_id === 'system';
    const { value: next } = migrateFromV1(v, {
      fallbackId: isSys ? '__baseline' : row.tenant_id,
      fallbackLabel: isSys ? '代码基线' : row.tenant_id,
    });
    await queryWrite(
      `INSERT INTO crm.config_store (tenant_id, key, value, decision_id, updated_by, updated_at)
       VALUES ($1,'tenant-profile',$2::jsonb,$3,'migration',now())
       ON CONFLICT (tenant_id, key) DO UPDATE SET value=$2::jsonb, decision_id=EXCLUDED.decision_id, updated_by='migration', updated_at=now()`,
      [row.tenant_id, JSON.stringify(next), row.decision_id || null]);
    migrated++;
  }
  return { total: rows.length, migrated, skipped };
}

const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  migrateTenantProfileToV2()
    .then((r) => { console.log('tenant-profile v2 迁移完成:', JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
