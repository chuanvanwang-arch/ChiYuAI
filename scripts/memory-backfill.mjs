// scripts/memory-backfill.mjs — 存量记忆修补（S1–S4）
//
// **默认 dry-run**：只统计并打印将要变更的行数，不动数据。执行必须显式 --apply。
// **红线：全程 0 条 DELETE**。所有修补只 UPDATE（软删归档 / 补列 / 合并投影键）。
//
// 用法：
//   node scripts/memory-backfill.mjs --step=noise      --apply    # S1 噪声归档
//   node scripts/memory-backfill.mjs --step=tenant     --apply    # S2 决策记忆租户回填
//   node scripts/memory-backfill.mjs --step=anchor     --apply    # S3 客户锚点回填
//   node scripts/memory-backfill.mjs --step=project    --apply    # S4 决策记忆 C7 投影重放
//   node scripts/memory-backfill.mjs --step=all        --apply --limit=5000
//   PGDATABASE=crm_native_test node scripts/memory-backfill.mjs --step=all   # 先在测试库演练
//
// 顺序纪律：**先 S1 再 S2/S3/S4** —— 噪声未切断就回填，等于给 62 万条噪声补租户，白烧 IO。
// 前置检查：capture 白名单（C4）必须先上线，否则边补边污染（巡检指标「近24h新增噪声」必须=0）。
import pg from 'pg';
import { projectDecisionMemory, resolveEntityAnchor } from '../src/memory/memoryLog.js';

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
const arg = (k, d = null) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true) : d;
};
const APPLY = process.argv.includes('--apply');
const STEP = String(arg('step', 'all'));
const LIMIT = Number(arg('limit', 0)) || 0; // 0 = 不限
const lim = LIMIT ? 'LIMIT ' + LIMIT : '';

const db = new pg.Client(`postgres://agent2b:agent2b@localhost:5433/${process.env.PGDATABASE}`);
await db.connect();
await db.query('SET search_path TO crm,public');
const q = async (sql, p = []) => (await db.query(sql, p)).rows;

console.log(`模式: ${APPLY ? '⚠ APPLY（真实写入）' : 'dry-run（只读统计）'} | step=${STEP} | 库=${process.env.PGDATABASE}\n`);
const log = (n, sql, detail) => console.log(`  ${n} | 待变更 ${sql ?? '-'} | ${detail}`);

// ── S1 噪声归档（软删，不 DELETE）────────────────────────────────────────────
async function s1() {
  const r = (await q(`SELECT count(*)::int n FROM crm.memory_log WHERE topic LIKE 'event:trace:%' AND archived IS NOT TRUE`))[0];
  log('S1 噪声归档', r.n, `event:trace:* 未归档行（置 archived=true，行保留）`);
  if (APPLY && r.n) {
    await db.query(`UPDATE crm.memory_log SET archived=true WHERE id IN (
      SELECT id FROM crm.memory_log WHERE topic LIKE 'event:trace:%' AND archived IS NOT TRUE ${lim})`);
    console.log('    ✔ 已归档');
  }
}

// ── S2 决策记忆租户回填：join decision 反查真实 tenant_id ────────────────────
async function s2() {
  const r = (await q(`SELECT count(*)::int n FROM crm.memory_log m
    JOIN crm.decision d ON d.decision_id::text = split_part(m.topic, ':', 2)
    WHERE m.topic LIKE 'decision:%' AND m.tenant_id = 'system' AND d.tenant_id <> 'system'`))[0];
  log('S2 租户回填', r.n, `decision:* 记忆可归属到业务租户（UPDATE tenant_id）`);
  if (APPLY && r.n) {
    await db.query(`UPDATE crm.memory_log m SET tenant_id = d.tenant_id
      FROM crm.decision d
      WHERE d.decision_id::text = split_part(m.topic, ':', 2)
        AND m.topic LIKE 'decision:%' AND m.tenant_id = 'system' AND d.tenant_id <> 'system'
        AND m.id IN (SELECT id FROM crm.memory_log WHERE topic LIKE 'decision:%' AND tenant_id='system' ${lim})`);
    console.log('    ✔ 已回填');
  }
  // 告警类：payload 自带 tenant_id（存量 2,308 条）→ 提升到列
  const r2 = (await q(`SELECT count(*)::int n FROM crm.memory_log
    WHERE tenant_id='system' AND payload ? 'tenant_id' AND payload->>'tenant_id' NOT IN ('system','*')`))[0];
  log('S2b payload.tenant_id 提升', r2.n, `payload 自带租户的记忆（UPDATE tenant_id = payload->>'tenant_id'）`);
  if (APPLY && r2.n) {
    await db.query(`UPDATE crm.memory_log SET tenant_id = payload->>'tenant_id'
      WHERE tenant_id='system' AND payload ? 'tenant_id' AND payload->>'tenant_id' NOT IN ('system','*')
        AND id IN (SELECT id FROM crm.memory_log WHERE tenant_id='system' AND payload ? 'tenant_id' ${lim})`);
    console.log('    ✔ 已提升');
  }
}

// ── S3 客户锚点回填：payload.account_id → entity_id + entity_type ─────────────
async function s3() {
  const r = (await q(`SELECT count(*)::int n FROM crm.memory_log
    WHERE entity_id IS NULL AND payload ? 'account_id' AND payload->>'account_id' <> ''`))[0];
  log('S3 锚点回填', r.n, `payload.account_id 可提升为 entity_id（entity_type='ACCOUNT'）`);
  if (APPLY && r.n) {
    await db.query(`UPDATE crm.memory_log
      SET entity_id = payload->>'account_id', entity_type = 'ACCOUNT'
      WHERE entity_id IS NULL AND payload ? 'account_id' AND payload->>'account_id' <> ''
        AND id IN (SELECT id FROM crm.memory_log WHERE entity_id IS NULL AND payload ? 'account_id' ${lim})`);
    console.log('    ✔ 已回填');
  }
}

// ── S4 决策记忆 C7 投影重放：就地合并四段式键（只加键不删键，幂等）────────────
// 说明：不新增行（避免重复记忆），只把 summary/entities/evidence/gaps 合并进既有 payload。
//   旧键（scenario_id/disposition/…）全部保留 → 既有消费方零回归。
async function s4() {
  const rows = await q(`SELECT m.id, m.topic, m.payload, d.decision_id, d.scenario_id, d.disposition,
      d.business_tier, d.decider_type, d.rationale, d.trigger_context, d.involved_entities, d.conditions_evaluated
    FROM crm.memory_log m
    JOIN crm.decision d ON d.decision_id::text = split_part(m.topic, ':', 2)
    WHERE m.topic LIKE 'decision:%' AND NOT (m.payload ? 'summary')
    ORDER BY m.created_at DESC ${lim}`);
  console.log(`  S4 投影重放 | 待变更 ${rows.length} | 缺 summary 键的决策记忆（合并四段式，不新增行）`);
  if (!APPLY) return;
  let ok = 0;
  for (const r of rows) {
    const anchor = resolveEntityAnchor({
      payload: { ...(r.trigger_context || {}), ...(r.payload || {}) },
    });
    const proj = projectDecisionMemory({
      decision_id: r.decision_id, scenario_id: r.scenario_id, disposition: r.disposition,
      business_tier: r.business_tier, decider_type: r.decider_type, rationale: r.rationale,
      trigger_context: r.trigger_context, involved_entities: r.involved_entities,
      conditions_evaluated: r.conditions_evaluated,
      entity_id: anchor.entity_id, entity_type: anchor.entity_type,
    });
    const merged = { ...(r.payload || {}), ...proj };
    await db.query(`UPDATE crm.memory_log SET payload=$2, entity_id=COALESCE(entity_id,$3), entity_type=COALESCE(entity_type,$4) WHERE id=$1`,
      [r.id, merged, proj.entity_id, proj.entity_type]);
    ok++;
  }
  console.log(`    ✔ 已重放 ${ok} 条`);
}

const steps = { noise: s1, tenant: s2, anchor: s3, project: s4 };
const run = STEP === 'all' ? [s1, s2, s3, s4] : [steps[STEP]].filter(Boolean);
if (!run.length) { console.error(`未知 step: ${STEP}（可选 noise|tenant|anchor|project|all）`); process.exit(1); }
for (const f of run) await f();
console.log(`\n完成。${APPLY ? '' : '（dry-run：加 --apply 才会真实写入）'}`);
await db.end();
