// scripts/backup-crm-pre-migration.mjs — #12 生产迁移前只读全量逻辑备份
// 说明：本机无 pg_dump 二进制，改用 SELECT 全量快照 crm.particles → 时间戳 JSON 文件。
//      仅读取，不修改任何数据；migrate-stage-s.mjs / seed-approval-rules.mjs 均为
//      幂等 UPDATE(0行) / INSERT ON CONFLICT DO NOTHING（零 DELETE、可逆），备份用于事后核对与回滚分析。
import { queryRead } from '../src/db.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TARGET = process.env.PGDATABASE || 'crm_native';
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(__dirname, `../tmp/backup-crm-${TARGET}-${ts}.json`);

async function main() {
  process.env.PGDATABASE = TARGET;
  const r = await queryRead(
    `SELECT id, tenant_id, type, slug, title, state, payload
     FROM crm.particles ORDER BY type, id`);
  const byType = {};
  for (const row of r.rows) {
    byType[row.type] = (byType[row.type] || 0) + 1;
  }
  const dump = {
    target: TARGET,
    dumped_at: new Date().toISOString(),
    total_rows: r.rows.length,
    by_type: byType,
    rows: r.rows,
  };
  writeFileSync(out, JSON.stringify(dump, null, 2));
  console.log(`BACKUP_OK target=${TARGET} rows=${r.rows.length}`);
  console.log('按类型:', JSON.stringify(byType));
  console.log('文件:', out);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
