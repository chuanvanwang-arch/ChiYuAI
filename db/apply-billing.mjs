// db/apply-billing.mjs — 计费域 DDL + 配置种子 一次性幂等应用（测试库/生产库复用）
// 用法：PGHOST=localhost PGDATABASE=crm_native_test node db/apply-billing.mjs
// 铁律：仅 ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS / ON CONFLICT DO UPDATE（幂等可重播）
import { readFileSync } from 'node:fs';

// 连接守护：本环境 PG 仅接受 IPv6 loopback（localhost/::1），强制覆盖 127.0.0.1 兜底
process.env.PGHOST = process.env.PGHOST || 'localhost';
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
process.env.PGPORT = process.env.PGPORT || '5433';
process.env.PGUSER = process.env.PGUSER || 'agent2b';
process.env.PGPASSWORD = process.env.PGPASSWORD || 'agent2b';

const { pool } = await import('../src/db.js');
const url = (f) => new URL(`./${f}`, import.meta.url);

async function run(label, sql) {
  try {
    await pool.query(sql);
    console.log(`[apply] ✓ ${label}`);
  } catch (e) {
    // 幂等容忍：列/表已存在（42P01 不存在 / 42703 列已存在 / 23505 唯一冲突等）不阻断
    if (/42P01|42703|23505|42P16|23514/.test(e.code)) {
      console.log(`[apply] ⊝ ${label}（幂等跳过 ${e.code}）`);
    } else {
      console.error(`[apply] ✗ ${label}:`, e.message);
      throw e;
    }
  }
}

// 1) config_store 多租户化（与 migrate-tenant.js 一致，确保 (tenant_id,key) 形态存在）
await run('config_store.tenant_id 维度补全',
  `ALTER TABLE crm.config_store ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
await run('config_store SET NOT NULL',
  `ALTER TABLE crm.config_store ALTER COLUMN tenant_id SET NOT NULL`);
await run('config_store 重建 PK 为 (tenant_id,key)',
  `ALTER TABLE crm.config_store DROP CONSTRAINT IF EXISTS config_store_pkey`);
await run('config_store ADD PK (tenant_id,key)',
  `ALTER TABLE crm.config_store ADD PRIMARY KEY (tenant_id, key)`);

// 2) 计费 DDL 迁移
await run('migration-billing-token-tenant.sql',
  readFileSync(url('migration-billing-token-tenant.sql'), 'utf8'));
await run('migration-billing-tables.sql',
  readFileSync(url('migration-billing-tables.sql'), 'utf8'));

// 3) 配置种子（ON CONFLICT 幂等可重播）
await run('seed-billing-config.sql',
  readFileSync(url('seed-billing-config.sql'), 'utf8'));

// 校验：读回 plans / settings
const plans = await pool.query(
  `SELECT value->>'default_plan' AS dp, jsonb_array_length(value) AS tiers
   FROM crm.config_store WHERE tenant_id='system' AND key='billing-plans'`);
const settings = await pool.query(
  `SELECT value->>'currency' AS cur, value->>'cycle' AS cyc
   FROM crm.config_store WHERE tenant_id='system' AND key='billing-settings'`);
console.log('[apply] billing-plans:', JSON.stringify(plans.rows[0] || null));
console.log('[apply] billing-settings:', JSON.stringify(settings.rows[0] || null));

await pool.end();
console.log('[apply] 完成');
