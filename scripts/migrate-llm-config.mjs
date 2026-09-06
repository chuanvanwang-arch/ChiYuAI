// scripts/migrate-llm-config.mjs — 把现有 config_store('llm') 单条迁入 crm.llm_config 并标默认
// 用法：node scripts/migrate-llm-config.mjs  （目标库由 PGDATABASE 决定，默认 crm_native）
// 铁律：幂等（已迁移则跳过）；绝不删 config_store('llm') 原行（保留过渡期回退读取）
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
const { query } = await import('../src/db.js');

const ex = await query("SELECT value FROM crm.config_store WHERE key='llm' AND tenant_id='system'");
if (!ex.rows.length) {
  console.log('[migrate-llm-config] 无现有 config_store(llm)，跳过');
  process.exit(0);
}
const v = ex.rows[0].value;
const dup = await query('SELECT 1 FROM crm.llm_config WHERE name=$1 AND NOT is_deleted', [v.provider || 'siliconflow']);
if (dup.rows.length) {
  console.log('[migrate-llm-config] 已迁移（name=' + (v.provider || 'siliconflow') + '），跳过');
  process.exit(0);
}
await query(
  `INSERT INTO crm.llm_config (name,provider,model,base_url,api_key,temp,max_tokens,is_default,tenant_id,updated_by)
   VALUES ($1,$2,$3,$4,$5,$6,$7,true,'system','migration')`,
  [v.provider || 'siliconflow', v.provider, v.model, v.base_url, v.api_key, v.temp ?? 0.7, v.max_tokens ?? 1024]
);
console.log('[migrate-llm-config] 迁移完成：', v.provider, '→ crm.llm_config（is_default=true）');
process.exit(0);
