#!/usr/bin/env node
// scripts/seed-particle-create.mjs — 播种 PARTICLE_CREATE 决策场景（MCP 建档第 0 闸 mint 载体）
//
// 背景：2026-09-04 开放 MCP 建档通道（data-particle-create 经 mcpExpose 上 MCP 暴露面）。
//   gateway.mcpWritePhase1 在调用方未带 decision_id 时，按 Action 的 decisionScenario 代为 mint
//   决策（requireDecision）——场景行缺失则 mint 无落点，写操作退回 DECISION_NEEDED（无决策不写）。
//   故本场景是通道生效的前置条件，与 db/seed.sql 中的 INSERT 同值。
//
// 用法（PowerShell，生产库 crm_native）：
//   node scripts/seed-particle-create.mjs
// 指定库（如先灌测试库）：
//   $env:PGDATABASE='crm_native_test'; node scripts/seed-particle-create.mjs
//
// 幂等：ON CONFLICT (scenario_id, tenant_id) DO NOTHING，可重复执行。
// 注意：本脚本默认写【生产库 crm_native】——与 db/seed.sql 语义一致，属预期行为。

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
process.env.PGHOST = process.env.PGHOST || 'localhost'; // PG 5433 仅收 IPv6 回环，127.0.0.1 会被拒

const { query } = await import('../src/db.js');

const SCENARIO_ID = 'PARTICLE_CREATE';
const VALUES = [
  SCENARIO_ID,
  'meta',
  'MCP/对话通道粒子建档（客户/商机/合同等主数据创建）',
  '{"action":["data-particle-create"]}',
  [], // methodology_ids：传 JS 空数组由 pg 驱动序列化为 Postgres 的 {}（写 '[]' 会被 array_in 拒）
  '[{"cond":"data_origin","label":"数据来源与字段合法","weight":0.34},{"cond":"identity_dedup","label":"主体查重（不重复建档）","weight":0.33},{"cond":"ownership","label":"归属完整（named_owner 必填）","weight":0.33},{"cond":"governance_approval","label":"人工确认","weight":0.15}]',
  'NORMAL',
  true,
];

const before = await query(`SELECT scenario_id FROM crm.decision_scenario WHERE scenario_id=$1`, [SCENARIO_ID]);
await query(
  `INSERT INTO crm.decision_scenario
     (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
   VALUES ($1,$2,$3,$4::jsonb,$5::text[],$6::jsonb,$7,$8)
   ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
  VALUES,
);
const after = await query(
  `SELECT scenario_id, tenant_id, default_tier, autonomous_allowed FROM crm.decision_scenario WHERE scenario_id=$1`,
  [SCENARIO_ID],
);
console.log(`[seed] 库=${process.env.PGDATABASE} host=${process.env.PGHOST}`);
console.log(`[seed] ${SCENARIO_ID}: ${before.rows[0] ? '已存在（跳过）' : '已插入'}`);
console.log(`[seed] 当前行: ${JSON.stringify(after.rows[0])}`);
process.exit(0);
