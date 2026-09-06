// scripts/seed-master-data.mjs — 业务主数据门户种子注入器（幂等增量）
// 设计：docs/superpowers/specs/2026-08-28-business-master-data-design.md
// 实施：docs/superpowers/plans/2026-08-28-business-master-data-impl.md
//
// 安全：db/seed-master-data.sql 仅 INSERT + ON CONFLICT (id) DO NOTHING，
// 不含 TRUNCATE/DELETE/DROP → 可安全重跑，绝不清理既有数据（P2P 项目 seed TRUNCATE 教训）。
// 用法：node scripts/seed-master-data.mjs
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const TYPES = ['CRM_PRODUCT', 'CRM_PRICE_LIST', 'CRM_OFFER_POLICY', 'CRM_DICT_ENTRY'];

async function main() {
  const sql = readFileSync(new URL('../db/seed-master-data.sql', import.meta.url), 'utf8');
  await pool.query(sql);
  console.log('[seed-master-data] 注入完成（幂等：ON CONFLICT (id) DO NOTHING）');
  for (const t of TYPES) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM crm.particles WHERE tenant_id='system' AND type=$1`,
      [t]
    );
    console.log(`  ${t}: ${rows[0].n} 条`);
  }
  // 商务规则包与回款政策共用 CRM_OFFER_POLICY 粒子，按 subtype 拆分统计
  const std = await pool.query(
    `SELECT count(*)::int AS n FROM crm.particles WHERE tenant_id='system' AND type='CRM_OFFER_POLICY'
     AND (payload->>'subtype' IS NULL OR payload->>'subtype'='standard')`
  );
  const pay = await pool.query(
    `SELECT count(*)::int AS n FROM crm.particles WHERE tenant_id='system' AND type='CRM_OFFER_POLICY'
     AND payload->>'subtype'='payment'`
  );
  console.log(`  ├ 商务规则包(subtype=standard): ${std.rows[0].n} 条`);
  console.log(`  └ 回款政策(subtype=payment): ${pay.rows[0].n} 条`);
  await pool.end();
}

main().catch((e) => {
  console.error('[seed-master-data] 失败:', e.message);
  process.exit(1);
});
