// scripts/seed-context-routing.mjs — 场景路由出厂默认 seed
// 设计：docs/2026-09-01-story-graph-fusion-design.md §1.4（批准 2026-09-02）
// 契约：写入 config_store['context-routing'] = { dims, scene_matrix, thresholds } 出厂默认
//   （常量单一事实源 = src/context/routing.js 的 DEFAULT_* 导出，脚本只 import 不复制）
// 幂等：仅当键**缺失**时写入（保留管理员已调整内容）；已有则跳过（可重跑）。
// 护栏：不 TRUNCATE、不 DELETE；测试库/生产库均可安全重跑。
//
// ⚠ 用法（生产库护栏，仿 scripts/seed-test-config.mjs）：
//   export PGDATABASE=crm_native_test   # 测试库
//   export PGDATABASE=crm_native        # 生产库（最小变更，仅本键）
//   node scripts/seed-context-routing.mjs
import pg from 'pg';
const { Pool } = pg;

const PGDATABASE = process.env.PGDATABASE || 'crm_native';
if (!/^(crm_native|crm_native_test)$/.test(PGDATABASE)) {
  console.error(`[seed-context-routing] 拒绝：PGDATABASE=${PGDATABASE} 不在白名单`);
  process.exit(2);
}

const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: PGDATABASE,
});

// import 出厂默认常量（单一事实源；routing.js 顶层无副作用的 readConfig 延迟执行，可安全 import）
const { DEFAULT_ROUTING, ROUTING_KEY } = await import('../src/context/routing.js');

const TENANT = 'system';
await pool.query('SET search_path TO crm, public');

const exist = await pool.query('SELECT 1 FROM crm.config_store WHERE key=$1 AND tenant_id=$2', [ROUTING_KEY, TENANT]);
if (exist.rowCount > 0) {
  console.log(`[seed-context-routing] ${PGDATABASE} 已有 ${ROUTING_KEY}（跳过，保留管理员配置）`);
  await pool.end();
  process.exit(0);
}

await pool.query(
  `INSERT INTO crm.config_store (key, value, decision_id, updated_by, tenant_id)
   VALUES ($1, $2::jsonb, NULL, 'system', $3)`,
  [ROUTING_KEY, JSON.stringify(DEFAULT_ROUTING), TENANT]
);
console.log(`[seed-context-routing] ${PGDATABASE} 已写入 ${ROUTING_KEY}（${Object.keys(DEFAULT_ROUTING.scene_matrix).length} 场景 × ${DEFAULT_ROUTING.dims.length} 维出厂默认）`);
await pool.end();