// scripts/calibration-triage.mjs — 校准补丁待办分级清单（只读，零写操作）
// 用途：D6 治理缺口（edge ⑦ 参数生效）的人工审阅辅助。
//   校准循环(⑥)持续产出 calibration_patch，按 HITL 铁律必须经管理员审批流
//   （POST /api/calibration/patches/:id/approve 或 /api/my-todo/tune-approve）才落地。
//   本脚本只把 PENDING 补丁按风险分级列出，供人审阅消项；绝不自动应用。
// 用法：
//   node scripts/calibration-triage.mjs                # 控制台分级清单
//   node scripts/calibration-triage.mjs --json out.json  # 导出 JSON
// 连接：沿用 kmd-closure-probe 的 sql() 通道（PGDATABASE 或 default crm_native）。

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// PG 仅监听 IPv6 回环（项目铁律）：硬编码 127.0.0.1 会 ECONNREFUSED → 用 localhost
const DB = {
  host: 'localhost',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'crm_native',
};
const pool = new pg.Pool(DB);
async function sql(text) {
  const r = await pool.query(text);
  return r.rows;
}

async function main() {
  const r = await sql(
    `SELECT patch_id, knob, target, to_value, risk, scenario_id, created_at, expected_impact
     FROM crm.calibration_patch WHERE status='PENDING' ORDER BY
       CASE risk WHEN 'LOW' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
       created_at DESC`);
  if (!Array.isArray(r)) { console.error('查询失败'); process.exit(1); }

  const rows = r.map((x) => ({
    patch_id: x.patch_id,
    knob: x.knob,
    target: x.target,
    to_value: x.to_value,
    risk: x.risk,
    scenario_id: x.scenario_id,
    created_at: x.created_at,
    expected_impact: x.expected_impact,
  }));

  const byRisk = { LOW: [], MEDIUM: [], HIGH: [] };
  for (const x of rows) (byRisk[x.risk] || byRisk.MEDIUM).push(x);

  const totals = {
    total: rows.length,
    LOW: byRisk.LOW.length,
    MEDIUM: byRisk.MEDIUM.length,
    HIGH: byRisk.HIGH.length,
  };

  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
  if (jsonOut) {
    fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify({ generated_at: new Date().toISOString(), totals, rows }, null, 2));
    console.log(`✓ 已导出 ${rows.length} 条待办 → ${jsonOut}`);
  }

  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║ 校准补丁待办分级清单 (PENDING)  | 总 ${totals.total} 条`);
  console.log(`║ LOW ${totals.LOW} · MEDIUM ${totals.MEDIUM} · HIGH ${totals.HIGH}`);
  console.log(`╠══════════════════════════════════════════════════════════════╣`);
  console.log(`║ ⚠ 本清单只读，绝不自动应用。消项须管理员经第0闸审批：`);
  console.log(`║   POST /api/calibration/patches/<patch_id>/approve`);
  console.log(`║   POST /api/my-todo/tune-approve  { patch_id }`);
  console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

  for (const risk of ['LOW', 'MEDIUM', 'HIGH']) {
    const list = byRisk[risk];
    if (!list.length) continue;
    console.log(`── ${risk} 风险 (${list.length} 条) ─────────────────────────────────`);
    for (const x of list) {
      const tv = typeof x.to_value === 'object' ? JSON.stringify(x.to_value) : String(x.to_value);
      console.log(`  [${x.knob}] target=${x.target ?? '∅'} → ${tv}`);
      console.log(`     patch_id=${x.patch_id}  scenario=${x.scenario_id ?? '∅'}  created=${x.created_at}`);
    }
    console.log('');
  }
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => pool.end());
