// scripts/seed-finance-receivables-config.mjs — S05 T5 应收配置幂等 seed（config_store['finance-receivables']）
// 用途：首次落地/换环境同步缺省三项（逾期天数=7、差额阈值=5%、账龄四档）
// 幂等：非空行跳过（保护管理员已手动调值）；用法：node scripts/seed-finance-receivables-config.mjs
import { pool } from '../src/db.js';

const KEY = 'finance-receivables';
const VAL = { payment_overdue_days: 7, gap_threshold_pct: 5, aging_buckets: [[0, 30], [31, 60], [61, 90], [91, 9999]] };

async function main() {
  const ex = await pool.query(`SELECT 1 FROM crm.config_store WHERE key=$1`, [KEY]);
  if (ex.rows.length) { console.log(`skipped: ${KEY} already seeded (非空行保护)`); await pool.end(); return; }
  await pool.query(
    `INSERT INTO crm.config_store (key, value, updated_by, updated_at)
     VALUES ($1, $2::jsonb, 'system', now())`,
    [KEY, JSON.stringify(VAL)]
  );
  console.log(`seeded ${KEY}:`, JSON.stringify(VAL));
  await pool.end();
}

main().catch((e) => { console.error(e.message); process.exit(1); });