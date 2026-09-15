// 一次性脚本：把 db/seed-decision-scenarios.sql 幂等回灌到目标库（默认 crm_native）。
// 仅新增缺失行，绝不修改/删除既有行（ON CONFLICT (scenario_id, tenant_id) DO NOTHING）。
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
const fs = await import('node:fs');
const { query } = await import('../src/db.js');
const sql = fs.readFileSync(new URL('../db/seed-decision-scenarios.sql', import.meta.url), 'utf8');
const res = await query(sql);
console.log(`[apply] decision_scenario 回灌完成：本次新增 ${res.rowCount ?? 0} 行`);
const v = await query(
  `SELECT scenario_id, tenant_id, default_tier, autonomous_allowed FROM decision_scenario
   WHERE scenario_id IN ('PROSPECTING_CONFIRM','LEAD_FIT') ORDER BY scenario_id`,
);
console.log('[apply] 关键场景现状:', JSON.stringify(v.rows));
process.exit(0);
