// scripts/backfill-decision-display-name.mjs — 历史决策 display_name 回填（【C 方案 2026-09-03】）
// 根因：此前「名称」列仅读 trigger_context.name，而 QUOTE_PRICING / LOSS_REVIEW 等场景创建决策时未填 .name → 恒显示「—」。
// 根治：crm.decision 新增 display_name 列，写时由 deriveDisplayName 统一生成；本脚本对历史行按同规则补齐。
//
// 用法：
//   node scripts/backfill-decision-display-name.mjs            # DRY-RUN：仅统计待回填行，不写库、不执行迁移
//   node scripts/backfill-decision-display-name.mjs --apply    # ① 先执行迁移 ALTER（幂等）  ② 回填 display_name
//
// 单一事实源：迁移 SQL 取自 db/migration-decision-display-name.sql；名称规则取自 src/decision/decisionName.js（与 createDecision 同函数）。
// 零信任：默认 DRY-RUN，必须显式 --apply 才触碰生产库（写操作需显式授权）。
import { readFileSync } from 'fs';

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native'; // 兜底生产库（ESM 静态 import 前设 env，遵循铁律）
const { pool } = await import('../src/db.js');
const { deriveDisplayName } = await import('../src/decision/decisionName.js');

const APPLY = process.argv.includes('--apply');

async function runMigration() {
  const migrationPath = new URL('../db/migration-decision-display-name.sql', import.meta.url);
  const sql = readFileSync(migrationPath, 'utf8');
  // 先逐行去除 -- 注释（避免「注释开头 + ALTER」的整段被误删），再按 ; 拆句（每条独立幂等）。
  const stmts = sql.split('\n')
    .map((l) => l.replace(/--.*$/, '').trim())
    .join(' ')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const stmt of stmts) {
    await pool.query(stmt);
    console.log(`[migrate] ✓ ${stmt.slice(0, 60).replace(/\s+/g, ' ')}`);
  }
}

async function main() {
  if (APPLY) {
    console.log('[backfill] --apply：先执行迁移（幂等 ALTER ADD COLUMN display_name）…');
    await runMigration();
  } else {
    console.log('[backfill] DRY-RUN：不写库、不执行迁移。确认无误加 --apply 执行。');
  }

  const { rows } = await pool.query(
    `SELECT decision_id, scenario_id, trigger_context FROM crm.decision WHERE display_name IS NULL`
  );
  console.log(`[backfill] 待回填决策（display_name IS NULL）: ${rows.length} 条`);
  if (!rows.length) { await pool.end(); return; }

  let done = 0, skip = 0;
  for (const r of rows) {
    const name = deriveDisplayName(r.scenario_id, r.trigger_context || {});
    if (!name || name === '—') { skip++; continue; }
    if (APPLY) {
      await pool.query(
        `UPDATE crm.decision SET display_name = $1 WHERE decision_id = $2`,
        [name, r.decision_id]
      );
    }
    done++;
  }
  console.log(`[backfill] ${APPLY ? '已写入' : 'DRY-RUN 将写入'}: ${done} 条，跳过 ${skip} 条`);
  await pool.end();
}

main().then(() => process.exit(0)).catch((e) => { console.error('[backfill] 失败:', e); process.exit(1); });
