// 动态复验 id18 业务分级配置的跨租户读取缺陷
// 连接测试库，证明 computeBusinessTier 的查询无 tenant_id 隔离
import pg from 'pg';
const { Client } = pg;

const client = new Client({
  host: '::1',
  port: 5433,
  user: 'agent2b',
  password: 'agent2b',
  database: 'crm_native_test',
});

await client.connect();

function section(t) { console.log('\n=== ' + t + ' ==='); }

// 1) 表结构：是否含 tenant_id 列
section('1) business_tier_config 列结构');
const cols = await client.query(`
  SELECT column_name, data_type
  FROM information_schema.columns
  WHERE table_schema='crm' AND table_name='business_tier_config'
  ORDER BY ordinal_position`);
console.log(cols.rows.map(r => `${r.column_name}:${r.data_type}`).join('  |  '));
console.log('含 tenant_id 列?', cols.rows.some(r => r.column_name === 'tenant_id'));

// 2) 数据分布：多少租户、多少行
section('2) 数据分布（按租户）');
const dist = await client.query(`
  SELECT tenant_id, count(*) AS rows, count(DISTINCT dimension_value) AS distinct_vals
  FROM crm.business_tier_config GROUP BY tenant_id ORDER BY tenant_id`);
for (const r of dist.rows) console.log(`tenant=${r.tenant_id}  rows=${r.rows}  distinct_vals=${r.distinct_vals}`);

// 3) 复刻 computeBusinessTier 的 EXACT 查询（无 tenant 过滤），看是否能跨租户命中
section('3) 复刻 computeBusinessTier 静态查询（无 tenant 过滤）');
// 取一个真实存在的 dimension_value 做探针
const probe = await client.query(`SELECT dimension, dimension_value FROM crm.business_tier_config LIMIT 1`);
const d = probe.rows[0];
console.log('探针:', JSON.stringify(d));
const q = await client.query(
  `SELECT dimension, dimension_value, tier, tenant_id
   FROM crm.business_tier_config
   WHERE (dimension=$1 AND dimension_value=$2) OR (dimension=$3 AND dimension_value=$4)`,
  [d.dimension, d.dimension_value, d.dimension, d.dimension_value]);
console.log('静态查询返回行数:', q.rows.length);
for (const r of q.rows) console.log(`  -> tenant=${r.tenant_id} ${r.dimension}=${r.dimension_value} tier=${r.tier}`);

// 4) 跨租户碰撞证明：找出同一 dimension_value 在 >=2 租户出现（即便 tier 相同，也证明查询无法隔离租户）
section('4) 跨租户同名碰撞（证明无隔离）');
const collide = await client.query(`
  SELECT dimension_value, dimension, count(DISTINCT tenant_id) AS tenants
  FROM crm.business_tier_config
  GROUP BY dimension_value, dimension
  HAVING count(DISTINCT tenant_id) >= 2
  LIMIT 10`);
if (collide.rows.length === 0) {
  console.log('（该库无同名跨租户值——但查询仍无 tenant 过滤，隔离仅靠运气）');
} else {
  for (const r of collide.rows) {
    console.log(`dimension_value=${r.dimension_value} dimension=${r.dimension} 出现在 ${r.tenants} 个租户`);
    const detail = await client.query(
      `SELECT tenant_id, tier FROM crm.business_tier_config
       WHERE dimension=$1 AND dimension_value=$2`,
      [r.dimension, r.dimension_value]);
    for (const x of detail.rows) console.log(`    tenant=${x.tenant_id} tier=${x.tier}`);
  }
}
console.log('\n结论：computeBusinessTier 查询无 tenant_id 过滤 → 任一租户调用都会混读全表，跨租户隔离被破坏。');

await client.end();
