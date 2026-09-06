// db/migrate-propagation-metrics.js — 复盘报告补列（config_snapshot + tenant_id）
// 运行：PGDATABASE=crm_native_test node db/migrate-propagation-metrics.js
// 约定同 migrate-tenant.js：queryWrite 来自 ../src/db.js；全部 ADD COLUMN IF NOT EXISTS（幂等、禁删）。
import { pathToFileURL } from 'node:url';
import { queryWrite } from '../src/db.js';

export async function migratePropagationMetrics() {
  // §8 P0 / §12.5：决策复盘报告补「运行时配置快照」与「租户」列，使配置变更↔报告双向可溯源。
  await queryWrite(`ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS config_snapshot JSONB`);
  await queryWrite(`ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_decision_retro_report_tenant ON crm.decision_retro_report(tenant_id)`);
  console.log('[migrate-propagation-metrics] done');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migratePropagationMetrics().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
