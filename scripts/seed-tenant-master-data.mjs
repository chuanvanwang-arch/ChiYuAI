// scripts/seed-tenant-master-data.mjs — 按租户播种主数据（Plan B 落地）
// 设计：docs/2026-09-03-tenant-master-data-seeding-design.md
// 从 system 模板库复制四类主数据到目标租户，幂等（stable_key 冲突跳过），
// 可选 tenant-profile.masterData 行级筛选（默认全复制）。
//
// 安全：仅 INSERT ... ON CONFLICT (stable_key) DO NOTHING；无 DELETE/TRUNCATE/DROP（禁 DELETE 铁律）。
// 系统运维写：decision_id 保持 NULL（与 system 历史行一致，豁免决策第0闸）。
// 复制后 embedding/content_hash/fts = NULL（首次编辑触发写时索引）。
//
// 用法：
//   生产：node scripts/seed-tenant-master-data.mjs --tenant acme-chem
//   测试：PGDATABASE=crm_native_test node scripts/seed-tenant-master-data.mjs --tenant acme-chem
//   演练：node scripts/seed-tenant-master-data.mjs --tenant acme-chem --dry-run
import { pathToFileURL } from 'url';
import { pool, query, queryWrite } from '../src/db.js';
import { computeParticleStableKey } from '../src/particles/mintId.js';
import { readConfig } from '../src/config/configStore.js';

export const TYPES = ['CRM_PRODUCT', 'CRM_PRICE_LIST', 'CRM_OFFER_POLICY', 'CRM_DICT_ENTRY'];

// 纯函数：将源行按筛选规则映射为目标租户待插入行（不触 DB，便于单测）。
export function planCopy({ sourceRows, type, tenantId, filter = {} }) {
  const out = [];
  for (const r of sourceRows) {
    if (!passFilter(type, r, filter)) continue;
    out.push({
      tenant_id: tenantId,
      type,
      slug: r.slug,
      title: r.title,
      state: r.state || 'ACTIVE',
      payload: r.payload || {},
      created_at: r.created_at || null,
      updated_at: r.updated_at || null,
      stable_key: computeParticleStableKey(type, r.slug, tenantId),
    });
  }
  return out;
}

// 行级筛选：仅 CRM_PRODUCT 支持 payload.category ∈ 白名单；其余类型默认放行。
export function passFilter(type, row, filter = {}) {
  if (type !== 'CRM_PRODUCT') return true;
  const cats = filter && filter.category;
  if (!Array.isArray(cats) || cats.length === 0) return true;
  const c = row && row.payload && row.payload.category;
  return cats.includes(c);
}

// 解析 tenant-profile.masterData 配置 → { enabled, types, filter }
function resolveMasterData(profileValue) {
  const md = (profileValue && profileValue.masterData) || {};
  if (md.enabled === false) return { enabled: false, types: [], filter: {} };
  const types = Array.isArray(md.types) && md.types.length > 0 ? md.types : TYPES;
  return { enabled: true, types, filter: md.filter || {} };
}

// 主播种函数（不 pool.end，供 main 与 seed-all-tenants.mjs 复用）。
// 返回 { tenantId, copied, skipped, types, dryRun }。
export async function seedTenantMasterData(tenantId, { dryRun = false, readConfigFn = readConfig } = {}) {
  if (!tenantId || tenantId === 'system') {
    throw new Error("tenantId 非法：必须为非空且非 'system'（禁止把模板复制回模板）");
  }
  const prof = await readConfigFn('tenant-profile', { tenantId });
  const md = resolveMasterData(prof && prof.value);
  if (!md.enabled) {
    console.log(`[seed-tenant-master-data] ${tenantId}: masterData.enabled=false → 不复制任何主数据`);
    return { tenantId, copied: 0, skipped: 0, types: {}, dryRun };
  }
  const stats = { tenantId, copied: 0, skipped: 0, types: {}, dryRun };
  for (const type of md.types) {
    const { rows } = await query(
      `SELECT id, type, slug, title, state, payload, created_at, updated_at
       FROM crm.particles WHERE tenant_id='system' AND type=$1`,
      [type]
    );
    const plan = planCopy({ sourceRows: rows, type, tenantId, filter: md.filter[type] || {} });
    let copied = 0;
    let skipped = 0;
    for (const row of plan) {
      if (dryRun) { copied += 1; continue; }
      const res = await queryWrite(
        `INSERT INTO crm.particles
           (tenant_id, type, slug, title, state, payload, created_at, updated_at, stable_key,
            embedding, content_hash, fts, decision_id)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9, NULL, NULL, NULL, NULL)
         ON CONFLICT (stable_key) DO NOTHING`,
        [row.tenant_id, row.type, row.slug, row.title, row.state,
         JSON.stringify(row.payload), row.created_at, row.updated_at, row.stable_key]
      );
      if ((res.rowCount ?? 0) > 0) copied += 1; else skipped += 1;
    }
    stats.types[type] = { source: rows.length, planned: plan.length, copied, skipped };
    stats.copied += copied;
    stats.skipped += skipped;
    console.log(`[seed-tenant-master-data] ${tenantId}/${type}: 源 ${rows.length} → 计划 ${plan.length} → 复制 ${copied} / 跳过 ${skipped}`);
  }
  return stats;
}

// CLI 入口（仅作为入口运行时执行）
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const ti = args.indexOf('--tenant');
  const tenantId = ti >= 0 ? args[ti + 1] : undefined;
  if (!tenantId) {
    console.error('用法: node scripts/seed-tenant-master-data.mjs --tenant <id> [--dry-run]');
    process.exit(2);
  }
  const stats = await seedTenantMasterData(tenantId, { dryRun });
  console.log(JSON.stringify(stats, null, 2));
  await pool.end();
}

// Windows 适配：import.meta.url 与 process.argv[1] 在盘符大小写/分隔符上不一致，
// 用 pathToFileURL 归一化后忽略大小写比较，确保 CLI 入口在 win32 下正确触发。
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  main().catch((e) => {
    console.error('[seed-tenant-master-data] 失败:', e.message);
    process.exit(1);
  });
}
