#!/usr/bin/env node
// scripts/seed-dialog-advisor-config.mjs — 对话决策建议配置幂等播种
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §4.2
// 用法：
//   node scripts/seed-dialog-advisor-config.mjs                 # 默认生产库 crm_native
//   PGDATABASE=crm_native_test node scripts/seed-dialog-advisor-config.mjs
// 铁律：只 INSERT ... ON CONFLICT DO NOTHING，禁 DELETE / 禁 TRUNCATE；禁覆盖租户已改配置。
//   与 db/seed.sql 末尾同款播种保持三源一致（seed.sql ≡ 本脚本 ≡ 代码 DEFAULT_* 兜底）。
import pg from 'pg';
// 直接 import 常量模块（二者均为纯常量、无 DB 依赖），避免解析源码文本——保证与运行时兜底值绝对同源
const { DEFAULT_SCENARIO_MAP } = await import('../src/decision/dialogAdvisor.js');
const { DEFAULT_ADVISOR_CONFIG } = await import('../src/decision/scenarioAdvisors.js');

const DB = process.env.PGDATABASE || 'crm_native';
const CONN = {
  host: process.env.PGHOST || 'localhost', // PG 仅监听 IPv6 回环；硬编码 127.0.0.1 会 ECONNREFUSED
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: DB,
};

const ROWS = [
  ['dialog-scenario-map', { map: DEFAULT_SCENARIO_MAP }],
  ['dialog-advisor-config', { ...DEFAULT_ADVISOR_CONFIG }],
];

const client = new pg.Client(CONN);
await client.connect();
try {
  for (const [key, value] of ROWS) {
    const r = await client.query(
      `INSERT INTO crm.config_store (tenant_id, key, value, updated_by)
       VALUES ('system', $1, $2::jsonb, 'system')
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING key`,
      [key, JSON.stringify(value)],
    );
    console.log(`[${DB}] ${key}: ${r.rowCount ? '已播种' : '已存在（未覆盖）'}`);
  }
} finally {
  await client.end();
}
console.log(`[${DB}] 对话决策建议配置播种完成`);
