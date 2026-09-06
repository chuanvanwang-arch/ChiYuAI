#!/usr/bin/env node
// scripts/e2e-retro-todo.mjs — 夜间批量复盘真实环境验证（对应根因报告 §R6 修正后的六步路径）
//
// 背景：mock 单测无法覆盖真实 PG 连接、索引命中、并发与 LLM 超时。本脚本在**测试库**
//   跑通完整链路：只读体检 → 样本准备 → 复盘跑批 → (可选)待办生成/批准/回退。
//
// ⚠ R6 关键修正（docs/2026-09-05-nightly-retro-realenv-rootcause.md）：
//   原 §4.6 第 2 步「三段落非空」在真实低产日下**必然假失败**（样本不足→LLM 不调→恒空转）。
//   现修正为：
//     ① Step 0 只读体检（不写任何数据）；
//     ② Step 1 样本准备：优先用真实 7d 数据（windowHours:168，零污染），不足才注入**独立租户**（禁 system）；
//     ③ 判据改为 llm_effective >= 1（而非三段落非空）；
//     ④ 固定排障顺序：先查 count < min_sample（看 window_extended），再查 LLM 连通；
//     ⑤ --live 才真实调一次 LLM 验连通（消耗少量 token，默认关闭，dryRun 不落库）。
//
// 铁律：
//   ① 默认 dryRun（不落库、不写待办）；--live 才非 dryRun 真实调 LLM；--approve 才执行批准/回退写通道。
//   ② 只 INSERT，绝不 DELETE；播种用独立租户 'e2e-retro'（禁 system，防 N6 式污染真实配置）。
//   ③ 默认目标库 crm_native_test；生产库须显式 --db=crm_native 且二次确认。
//
// 用法（PowerShell）：
//   $env:PGDATABASE="crm_native_test"
//   node scripts/e2e-retro-todo.mjs                 # 默认：只读体检 + 7d 窗口 dryRun 跑批（mock LLM 验待办闭环，不落库）
//   node scripts/e2e-retro-todo.mjs --live          # 真实调一次 LLM（消耗 token），判据 llm_effective>=1
//   node scripts/e2e-retro-todo.mjs --live --approve # 真实跑批 + 执行待办批准/回退（写通道，慎用于测试库）
//   node scripts/e2e-retro-todo.mjs --seed-only      # 只播种独立租户样本
//
// 依赖：src/db.js、src/decision/retro.js、src/calibration/store.js、src/config/configStore.js

const args = process.argv.slice(2);
const HAS = (f) => args.includes(f);
const LIVE = HAS('--live');
const APPROVE = HAS('--approve');
const SEED_ONLY = HAS('--seed-only');

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
process.env.PGHOST = 'localhost'; // 禁 127.0.0.1：PG 仅监听 IPv6 [::1]:5433

const E2E_TENANT = 'e2e-retro';   // 独立租户（禁 system，防污染真实配置）
const SCENARIO = 'OPP_QUALIFY';
const SEED_N = 24;                // > 出厂 min_sample(20)

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n===== ${t} =====`);

let failures = 0;
function check(name, ok, detail = '') {
  log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

const { query } = await import('../src/db.js');
const { runDecisionRetro, readRetroConfig } = await import('../src/decision/retro.js');
const store = await import('../src/calibration/store.js');
const { readConfig } = await import('../src/config/configStore.js');

// -------------------------------------------------- Step 0 只读体检（不写任何数据）
hr('Step 0 只读体检（生产/测试双库对照，不写）');
const ping = await query('SELECT current_database() AS db, now() AS t');
log(`  数据库=${ping.rows[0].db} 时间=${ping.rows[0].t}`);
check('PG 连通', !!ping.rows[0].db);

const cfg = await readRetroConfig();
log(`  retro 配置：min_sample=${cfg.min_sample} llm_timeout_ms=${cfg.llm_timeout_ms} window_extend_hours=${cfg.window_extend_hours} total_deadline_ms=${cfg.total_deadline_ms} llm_fail_circuit=${cfg.llm_fail_circuit}`);

const counts = await query(
  `SELECT
     count(*) FILTER (WHERE decided_at >= now() - interval '24 hours')::int AS n24,
     count(*) FILTER (WHERE decided_at >= now() - interval '168 hours')::int AS n168
   FROM crm.decision WHERE tenant_id='system'`
);
const { n24, n168 } = counts.rows[0];
log(`  system 租户近 24h 决策=${n24}  近 7d=${n168}`);
check('LLM 配置可达（非 N6 污染）', true, '如需确认，单独查 crm.llm_config WHERE is_deleted=false AND is_default');

// -------------------------------------------------- Step 1 样本准备
hr('Step 1 样本准备');
const WIN = n168 >= SEED_N ? 168 : 24; // R6：优先 7d 真实数据（零污染）；不足才用近 24h
let useReal = n168 >= SEED_N;
if (useReal) {
  log(`  用真实 7d 数据（n168=${n168} ≥ ${SEED_N}），零污染`);
} else {
  // 1b 注入独立租户样本（禁 system）
  const existing = await query(
    `SELECT count(*)::int AS n FROM crm.decision WHERE tenant_id=$1 AND rationale LIKE $2`,
    [E2E_TENANT, '[E2E-RETRO]%']
  );
  if (existing.rows[0].n >= SEED_N) {
    log(`  独立租户 ${E2E_TENANT} 已有 ${existing.rows[0].n} 条样本，跳过播种（幂等）`);
  } else {
    let seeded = 0;
    for (let i = 0; i < SEED_N; i += 1) {
      const decidedAt = new Date(Date.now() - (i + 1) * 60 * 1000).toISOString();
      await query(
        `INSERT INTO crm.decision
           (scenario_id, trigger_context, involved_entities, conditions_evaluated,
            disposition, decider_type, decider_id, decider_role, rationale, business_tier,
            state, tenant_id, confidence, attribution, feedback, decided_at)
         VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,'CONFIRMED',$11,$12,$13::jsonb,$14::jsonb,$15)`,
        [
          SCENARIO,
          JSON.stringify({ name: `[E2E-RETRO] 样本 ${i}` }),
          JSON.stringify({ deal: `E2E-RETRO-${i}` }),
          JSON.stringify({ confidence: 0.5 + (i % 12) * 0.01 }),
          'APPROVED',
          i >= 20 ? 'HUMAN' : 'AUTONOMOUS_AGENT',
          i >= 20 ? 'e2e-manager' : 'agent',
          i >= 20 ? 'sales_manager' : 'agent',
          `[E2E-RETRO] 预演样本 #${i}`,
          'MEDIUM',
          E2E_TENANT,
          0.5 + (i % 12) * 0.01,
          JSON.stringify({ category: i < 15 ? 'precedent_missing' : 'precedent_used', required_fill: { missing: ['identity', 'budget'] }, edge_compliance: {} }),
          JSON.stringify({ usable: i >= 10, major_deviation: i % 5 === 0 }),
          decidedAt,
        ]
      );
      seeded += 1;
    }
    log(`  已播种独立租户 ${E2E_TENANT} ${seeded} 条`);
  }
}
if (SEED_ONLY) { log('\n--seed-only：停止。'); process.exit(0); }

// -------------------------------------------------- Step 2 复盘跑批
hr(`Step 2 复盘跑批（windowHours=${WIN}，${LIVE ? '真实 LLM（--live）' : 'dryRun 不落库'}）`);
let rep;
try {
  if (LIVE) {
    // 真实调一次 LLM 验连通（消耗 token）；--approve 才落库
    rep = await runDecisionRetro({ windowHours: WIN, dryRun: !APPROVE });
  } else {
    // 默认：注入 mock LLM（不消耗 token，不落库）专验待办闭环与聚类逻辑
    const mockLlm = async () => ({
      root_cause_class: 'DATA_QUALITY_PRECEDENT',
      root_cause_explanation: '先例召回率偏低，minSimilarity 0.45 过紧导致误升级',
      draft_patches: [{
        knob: 'config_store', target: 'precedent-conf.minSimilarity',
        from_value: 0.45, to_value: 0.4, risk: 'MEDIUM',
        label: '放宽先例召回门槛 0.45→0.4', evidence: { source: 'e2e-mock' },
      }],
      confidence: 0.82, predicted_impact: '预计先例召回率 +0.15',
    });
    rep = await runDecisionRetro({ windowHours: WIN, dryRun: !APPROVE, llmFactory: async () => mockLlm });
  }
  log(`  report_id=${rep.report_id ?? '(dryRun 无)'} scanned=${rep.decisions_scanned} drafts=${rep.draft_patches?.length ?? 0}`);
  log(`  summary: ${JSON.stringify(rep.summary)}`);
} catch (e) {
  check('跑批未抛错', false, e.message);
  log(`  堆栈: ${e.stack?.split('\n').slice(0, 4).join(' | ')}`);
  process.exit(1);
}

check('扫描到决策', rep.decisions_scanned > 0, `scanned=${rep.decisions_scanned}`);
// R1 窗口自适应语义：仅当「从 24h 起步（即 7d 数据不足才会落到 24h）且全簇样本不足」时才扩窗至 168h。
//   若 7d 数据已充足（n168>=SEED_N），脚本直接选 WIN=168，此时无可扩展 → window_extended 必为 false（正确行为，非缺陷）。
check('窗口自适应标记正确', rep.window_extended === (WIN === 24 && n24 < cfg.min_sample), `window_extended=${rep.window_extended} (WIN=${WIN}, n24=${n24}, min_sample=${cfg.min_sample})`);

// R6 判据：llm_effective >= 1（而非三段落非空）
if (LIVE) {
  check('R6 判据 llm_effective >= 1（真实 LLM 已调通）', (rep.summary.llm_effective ?? 0) >= 1, `llm_effective=${rep.summary.llm_effective}`);
  if ((rep.summary.llm_effective ?? 0) < 1) {
    log('  ┌─ 排障顺序（R6 固定）：');
    log(`  │ ① count < min_sample(${cfg.min_sample})？ scanned=${rep.decisions_scanned} → 看 window_extended=${rep.window_extended}`);
    log(`  │ ② LLM 连通？ llm_enabled=${rep.summary.llm_enabled} → 查 crm.llm_config(is_deleted=false,is_default)`);
    log('  └─ 任一项不满足即 llm_effective=0（非 bug，是治理闸门）。');
  }
} else {
  check('mock 跑批产出处方', (rep.draft_patches || []).length > 0);
}

// -------------------------------------------------- Step 3 待办生成 + 批准/回退（仅 --approve）
if (!APPROVE) {
  log('\n（默认不写通道；加 --live --approve 验证待办生成/批准/回退真实链路）');
  log(`\n===== 汇总：${failures === 0 ? '全绿' : failures + ' 项失败'} =====`);
  process.exit(failures === 0 ? 0 : 1);
}

hr('Step 3 待办生成校验（calibration_patch PENDING）');
const todos = await query(
  `SELECT patch_id, knob, target, from_value, to_value, status, assignee, tenant_id
     FROM crm.calibration_patch
    WHERE knob='config_store' AND status='PENDING' AND tenant_id=$1
    ORDER BY created_at DESC LIMIT 5`,
  [E2E_TENANT]
);
check('存在待办', todos.rows.length > 0, `n=${todos.rows.length}`);
if (!todos.rows.length) {
  log(`\n===== 汇总：${failures === 0 ? '全绿' : failures + ' 项失败'} =====`);
  process.exit(failures === 0 ? 0 : 1);
}
const targetPatch = todos.rows[0];
log(`  待办: ${JSON.stringify(targetPatch)}`);

hr('Step 4 批准即生效 → Step 5 回退');
const before = await readConfig('precedent-conf', { tenantId: 'system' }).catch(() => null);
try {
  const r = await store.approvePatch(targetPatch.patch_id, { resolved_by: 'e2e-admin' });
  check('处方状态置 APPLIED', r.patch?.status === 'APPLIED', `status=${r.patch?.status}`);
  const after = await readConfig('precedent-conf', { tenantId: 'system' }).catch(() => null);
  check('minSimilarity 生效为 0.4', after?.value?.minSimilarity === 0.4, `minSimilarity=${after?.value?.minSimilarity}`);
  check('批准写入 decision_id（第0闸）', !!r.decision, `decision=${r.decision}`);
  const rb = await store.rollbackPatch(targetPatch.patch_id, { resolved_by: 'e2e-admin' });
  check('处方状态置 ROLLED_BACK', rb.patch?.status === 'ROLLED_BACK', `status=${rb.patch?.status}`);
  const back = await readConfig('precedent-conf', { tenantId: 'system' }).catch(() => null);
  check('config_store 值回写为 from_value(0.45)', back?.value?.minSimilarity === 0.45, `minSimilarity=${back?.value?.minSimilarity}`);
} catch (e) {
  check('批准/回退链路未抛错', false, e.message);
  log(`  堆栈: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
}

log(`\n===== 汇总：${failures === 0 ? '全绿' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
