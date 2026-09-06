// scripts/seed-seven-dim.mjs — S20 七维矩阵预置（幂等）
// 仅对 required_dims 为空的场景写入；已配置的场景跳过，绝不覆盖管理员调整。
// 全部 on_missing='warn'：打 missing_context 标记、禁 AI 脑补，但不拒写。
// 用法：node scripts/seed-seven-dim.mjs
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST || '127.0.0.1',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'crm_native',
  options: '-c search_path=crm,public',
});

const ALL7 = ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'];

// 7×7 初始配置：7 类销售决策 × 7 维（identity/structure/semantics/time_config/decision_history/operational_state/governance）。
// 依据领域决策框架设定每类决策的必填维度；on_missing 全为 warn（与 S20 设计一致：缺失打 missing_context 标记、
// 禁 AI 脑补，但不拒写；管理员可经 S20 页面逐格升 block）。
// 弱依赖（用户明确标注"次要/弱依赖"）不入必填：
//   - 线索：structure/decision_history 为弱依赖（线索阶段关系未建立、历史少）→ 仅 5 维必填
//   - 商务谈判：structure 标注"次要" → 6 维必填
//   - 其余（机会/客户策略/方案/签约/终局）用户明确要求"全部 7 维必须具备" → ALL7
const PRESET = {
  LEAD_FOLLOW_UP: ['identity', 'semantics', 'time_config', 'operational_state', 'governance'],
  OPP_QUALIFY: ALL7,
  CLIENT_STRATEGY: ALL7,
  SOLUTION_VALUE: ALL7,
  QUOTE_PRICING: ['identity', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'],
  SIGN_RISK: ALL7,
  POST_CONTRACT: ALL7,
  LOSS_REVIEW: ALL7,
  ATTR_SCHEMA_CHANGE: ['identity', 'structure', 'governance'],
  SC_DEMO_DISCOUNT: ['identity', 'structure', 'governance'],
  SC_DEMO_TERMS: ['identity', 'structure', 'governance'],
};
const FALLBACK = ['identity', 'structure', 'governance'];

const rows = (await pool.query(`SELECT scenario_id, required_dims FROM crm.decision_scenario`)).rows;
let seeded = 0;
let skipped = 0;

for (const r of rows) {
  const already = Array.isArray(r.required_dims) && r.required_dims.length > 0;
  if (already) { console.log(`skip   ${r.scenario_id}（已配置 ${r.required_dims.length} 维）`); skipped++; continue; }
  const dims = PRESET[r.scenario_id] || FALLBACK;
  const val = JSON.stringify(dims.map((d) => ({ dim: d, on_missing: 'warn' })));
  await pool.query(`UPDATE crm.decision_scenario SET required_dims=$2::jsonb WHERE scenario_id=$1`, [r.scenario_id, val]);
  console.log(`seed   ${r.scenario_id} → ${dims.length} 维（warn）`);
  seeded++;
}

// 全局默认严格度：覆盖旧的 0–5 形状（无消费方、非蓝图契约），改为 default_strictness
await pool.query(
  `INSERT INTO crm.config_store (key, value, updated_by)
   VALUES ('seven-dim', '{"default_strictness":"warn"}'::jsonb, 'system')
   ON CONFLICT (key) DO UPDATE SET value='{"default_strictness":"warn"}'::jsonb, updated_at=now()`
);
console.log(`\n完成：seeded=${seeded} skipped=${skipped}；default_strictness=warn`);

await pool.end();