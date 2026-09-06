#!/usr/bin/env node
// scripts/e2e-param-inspection.mjs — 参数闭环端到端验收（P2-2：夜批体检 → 处方 → 待办 → 批准 → config_store 生效 → 回滚）
//
// 背景：P0/P1 已落地 paramInspector（22 项体检）+ runParamInspectionPass（retro 第三 pass）
//   + my-todo「参数调优」视角 + tune-approve/tune-reject 零新增写通道。P2-2 需在**真实测试库**
//   验证完整链路，单测无法覆盖真实 PG 连接与 approvePatch→readConf 的 ConfigStoreStrategy.apply 路径。
//
// 铁律（对齐 e2e-retro-todo.mjs 与项目红线）：
//   ① 默认 dryRun：只读体检 + 不落库；--approve 才写通道（PENDING 处方 + 批准 + 回退）。
//   ② 播种用独立租户 e2e-param（禁 system，防污染真实配置）；绝不 DELETE。
//   ③ 默认目标 crm_native_test；生产库须显式 --db=crm_native 且二次确认（本脚本拒绝生产默认）。
//   ④ 处方批准走 approvePatch（第0闸 produceDecision 锚定 + 事务原子），回滚走 rollbackPatch。
//
// 用法（PowerShell）：
//   $env:PGDATABASE="crm_native_test" ; node scripts/e2e-param-inspection.mjs          # dryRun 体检 + 播种样本
//   $env:PGDATABASE="crm_native_test" ; node scripts/e2e-param-inspection.mjs --approve # 完整写通道验收
//
// 依赖：src/db.js、src/calibration/paramInspector.js、src/decision/retro.js、src/calibration/store.js、src/config/configStore.js

const args = process.argv.slice(2);
const APPROVE = HAS(args, '--approve');
const SEED_ONLY = HAS(args, '--seed-only');

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
process.env.PGHOST = 'localhost'; // 禁 127.0.0.1：PG 仅监听 IPv6 [::1]:5433

// 独立租户（禁 system）。⚠ 曾用 e2e-param 首跑播种缺 human_disposition/outcome_verified 列
//   （判据恒空）且幂等跳过；v2 补列但 OVERRIDDEN 6/24=0.25 恰不触发严格 >0.25 判据；故 v3 用 7/24。
//   旧 e2e-param / e2e-param-v2 行残留无害（禁 DELETE 铁律，不动）。
const E2E_TENANT = 'e2e-param-v3';
const SCENARIO = 'OPP_QUALIFY';
const SEED_N = 24;                // > 出厂 min_sample(20)

function HAS(arr, f) { return arr.includes(f); }

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n===== ${t} =====`);

let failures = 0;
function check(name, ok, detail = '') {
  log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
}

const { query } = await import('../src/db.js');
const { runParamInspectionPass } = await import('../src/decision/retro.js');
const store = await import('../src/calibration/store.js');
const { readConfig } = await import('../src/config/configStore.js');

// -------------------------------------------------- Step 0 只读体检
hr('Step 0 只读体检（写通道前禁止）');
const ping = await query('SELECT current_database() AS db, now() AS t');
log(`  数据库=${ping.rows[0].db} 时间=${ping.rows[0].t}`);
check('PG 连通', !!ping.rows[0].db);
if (ping.rows[0].db !== 'crm_native_test') {
  log('  ⚠ 非测试库 —— 本脚本只允许在 crm_native_test 执行完整链路，中止。');
  process.exit(2);
}

// -------------------------------------------------- Step 1 样本准备（独立租户，禁 system）
hr('Step 1 样本准备（独立租户）');
const existing = await query(
  `SELECT count(*)::int AS n FROM crm.decision WHERE tenant_id=$1 AND rationale LIKE $2`,
  [E2E_TENANT, '[E2E-PARAM]%']
);
if (existing.rows[0].n >= SEED_N) {
  log(`  独立租户 ${E2E_TENANT} 已有 ${existing.rows[0].n} 条样本，跳过播种（幂等）`);
} else {
  let seeded = 0;
  for (let i = 0; i < SEED_N; i += 1) {
    // 造出「人工覆写率>25%」样本（human_disposition=OVERRIDDEN 占 7/24≈29%>25%）
    //   → autonomy-conf.threshold drift 触发。⚠ 判据是严格 >0.25，6/24=0.25 恰好不触发（边界），故取 7。
    // ⚠ 判据消费 human_disposition（buildSample 覆写率）与 outcome_verified（场景通过率），
    //   必须写入这两列（e2e-retro-todo 播种未写，曾致 override_rate 恒 0 误判）。
    const overrideThis = i < 7;
    const disposition = overrideThis ? 'RETURNED' : (i % 3 === 0 ? 'ESCALATED' : 'APPROVED');
    const humanDisposition = overrideThis ? 'OVERRIDDEN' : null;
    const outcome = overrideThis ? 'lost' : (i % 4 === 0 ? 'won' : (i % 5 === 0 ? 'stalled' : 'won'));
    const deciderType = overrideThis || i % 4 === 0 ? 'HUMAN' : 'AUTONOMOUS_AGENT';
    await query(
      `INSERT INTO crm.decision
         (scenario_id, trigger_context, involved_entities, conditions_evaluated,
          disposition, human_disposition, decider_type, decider_id, decider_role, rationale, business_tier,
          state, tenant_id, confidence, attribution, feedback, outcome_verified, decided_at)
       VALUES ($1,$2::jsonb,$3::jsonb,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,'CONFIRMED',$12,$13,$14::jsonb,$15::jsonb,$16,$17)`,
      [
        SCENARIO,
        JSON.stringify({ name: `[E2E-PARAM] 样本 ${i}` }),
        JSON.stringify({ deal: `E2E-PARAM-${i}` }),
        JSON.stringify({ confidence: 0.5 + (i % 12) * 0.01 }),
        disposition,
        humanDisposition,
        deciderType,
        overrideThis || i % 4 === 0 ? 'e2e-manager' : 'agent',
        overrideThis || i % 4 === 0 ? 'sales_manager' : 'agent',
        `[E2E-PARAM] 预演样本 #${i}`,
        'MEDIUM',
        E2E_TENANT,
        0.5 + (i % 12) * 0.01,
        JSON.stringify({ category: i < 15 ? 'precedent_missing' : 'precedent_used', required_fill: { missing: ['identity', 'budget'] }, edge_compliance: {} }),
        JSON.stringify({ usable: i >= 10, major_deviation: i % 5 === 0 }),
        outcome,
        new Date(Date.now() - (i + 1) * 60 * 1000).toISOString(),
      ]
    );
    seeded += 1;
  }
  log(`  已播种独立租户 ${E2E_TENANT} ${seeded} 条`);
}
if (SEED_ONLY) { log('\n--seed-only：停止。'); process.exit(0); }

// -------------------------------------------------- Step 2 参数体检（dryRun 或落库）
hr(`Step 2 参数体检（${APPROVE ? '真实落库' : 'dryRun 不落库'}）`);
// 注入按租户过滤的 query：巡检器生产 SQL 是全库 30d 采样（设计如此，体检系统级配置），
//   验收需锁定在独立租户样本方可复现判据（对齐 P0「依赖注入」范式；闭环链路本身仍走真实代码）。
const tenantQuery = async (sql, params = []) => {
  if (sql.includes('FROM crm.decision') && sql.includes('WHERE created_at')) {
    // ⚠ 参数占位符语义：原 SQL 的 $1 是窗口天数（如 `($1::int || ' days')`），必须原位保留；
    //   租户条件追加为 $2（尾部参数）。曾误把租户放 $1 前插 → 窗口占位符被租户字符串占用
    //   → 类型错误 → 采样 catch 吞掉 → 样本空 → 判据恒 healthy（fail-open 掩蔽，端到端实测）。
    const filtered = sql.replace('WHERE created_at', 'WHERE tenant_id=$2 AND created_at');
    return query(filtered, [...params, E2E_TENANT]);
  }
  return query(sql, params);
};
const rep = await runParamInspectionPass({
  tenantId: E2E_TENANT,
  dryRun: !APPROVE,
  reportId: null,
  inspectAll: async (o) => (await import('../src/calibration/paramInspector.js')).inspectAll({ ...o, query: tenantQuery }),
}).catch((e) => ({ error: String(e?.message || e) }));
if (rep.error) {
  check('参数体检未抛错', false, rep.error);
  process.exit(1);
}
log(`  inspected=${rep.inspected} healthy=${rep.healthy} drift=${rep.drift} degraded=${rep.degraded} cooling=${rep.cooling} unknown=${rep.unknown} patches=${rep.patches?.length ?? 0}${rep.patches_created != null ? ` created=${rep.patches_created}` : ''}`);
check('体检覆盖 22 项', rep.inspected === 22, `inspected=${rep.inspected}`);
if (!APPROVE) {
  // dryRun：只验证体检结论正确（判据/样本/裸值），不写通道
  const autonomy = (rep.items || []).find((i) => i.key === 'autonomy-conf' && i.param === 'threshold');
  check('autonomy-conf.threshold 判据命中 drift', autonomy?.health === 'drift', `health=${autonomy?.health} verdict=${autonomy?.verdict}`);
  const patch = (rep.patches || []).find((p) => p.target === 'autonomy-conf.threshold');
  if (patch) {
    check('处方 value 裸值契约（to_value 为数字非包裹）', typeof patch.to_value === 'number', `to_value=${JSON.stringify(patch.to_value)}`);
    check('处方 target 含 key.sub', patch.target === 'autonomy-conf.threshold', `target=${patch.target}`);
  } else {
    log('  （本次样本未触发 autonomy-conf.threshold 处方 —— 若 override_rate 采样异常会在此暴露）');
  }
  log(`\n===== 汇总：${failures === 0 ? '全绿' : failures + ' 项失败'} =====`);
  process.exit(failures === 0 ? 0 : 1);
}

// -------------------------------------------------- Step 3 待办落库（PENDING）
hr('Step 3 待办落库校验（calibration_patch PENDING）');
const todos = await query(
  `SELECT patch_id, knob, target, from_value, to_value, status, assignee, tenant_id
     FROM crm.calibration_patch
    WHERE status='PENDING' AND tenant_id=$1
    ORDER BY created_at DESC LIMIT 5`,
  [E2E_TENANT]
);
check('存在 PENDING 处方（待办落库）', todos.rows.length > 0, `n=${todos.rows.length}`);
if (!todos.rows.length) {
  log(`\n===== 汇总：${failures === 0 ? '全绿' : failures + ' 项失败'} =====`);
  process.exit(failures === 0 ? 0 : 1);
}
const targetPatch = todos.rows.find((r) => r.target === 'autonomy-conf.threshold') || todos.rows[0];
log(`  待办: ${JSON.stringify(targetPatch)}`);

// -------------------------------------------------- Step 4 批准即生效 → Step 5 回退
hr('Step 4 批准即生效（第0闸）→ Step 5 回退');
const before = await readConfig('autonomy-conf', { tenantId: E2E_TENANT }).catch(() => null);
log(`  批准前 config_store['autonomy-conf'].threshold=${before?.value?.threshold}`);
try {
  const r = await store.approvePatch(targetPatch.patch_id, { resolved_by: 'e2e-admin' });
  check('处方状态置 APPLIED', r.patch?.status === 'APPLIED', `status=${r.patch?.status}`);
  const after = await readConfig('autonomy-conf', { tenantId: E2E_TENANT }).catch(() => null);
  log(`  批准后 threshold=${after?.value?.threshold}（期望=${targetPatch.to_value}）`);
  check('threshold 生效为目标值（裸值，非嵌套对象）', Number(after?.value?.threshold) === Number(targetPatch.to_value), `threshold=${after?.value?.threshold}`);
  check('批准写入 decision_id（第0闸锚定）', !!r.decision, `decision=${r.decision?.decisionId ?? r.decision?.decision_id ?? ''}`);
  const rb = await store.rollbackPatch(targetPatch.patch_id, { resolved_by: 'e2e-admin' });
  check('处方状态置 ROLLED_BACK', rb.patch?.status === 'ROLLED_BACK', `status=${rb.patch?.status}`);
  const back = await readConfig('autonomy-conf', { tenantId: E2E_TENANT }).catch(() => null);
  log(`  回退后 threshold=${back?.value?.threshold}（期望=${targetPatch.from_value}）`);
  check('config_store 值回写为 from_value', Number(back?.value?.threshold) === Number(targetPatch.from_value), `threshold=${back?.value?.threshold}`);
} catch (e) {
  check('批准/回退链路未抛错', false, e.message);
  log(`  堆栈: ${e.stack?.split('\n').slice(0, 3).join(' | ')}`);
}

log(`\n===== 汇总：${failures === 0 ? '全绿' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
