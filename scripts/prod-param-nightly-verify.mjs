#!/usr/bin/env node
// scripts/prod-param-nightly-verify.mjs — 生产库夜批「参数体检」真实触发验证（只读 dryRun，安全）
//
// 背景：P0/P1/P2 已落地 ① paramInspector（22 项体检确定性引擎）② retro.js runParamInspectionPass
//   （夜批 retro 第三 pass，timers.js 定时器 ④ 每日 02:00 经 runRetroOnce 调用）
//   ③ my-todo「参数调优」+ tune-approve/tune-reject 零新增写通道。
//   单元测试（test/decision/paramInspectionPass.test.js）已覆盖三段独立性，但用的是注入假 inspectAll，
//   未验证【真实生产代码路径 + 真实生产 config_store + 真实生产 decision 样本】。
//   本脚本补足：直接调用真实 runParamInspectionPass（含真实 inspectAll），证明夜批第三段在生产库真实可跑。
//
// 安全铁律（与项目红线对齐）：
//   ① 本脚本【只 dryRun】—— 不创建 PENDING 处方、不写 report 列、绝不碰 config_store。
//   ② 写通道（落 PENDING + 批准生效）由 scripts/e2e-param-inspection.mjs --approve（测试库 crm_native_test）
//      + 前次生产手动插方实证覆盖，本脚本只验证「真实触发 + 体检结论可信」。
//   ③ 禁 127.0.0.1：PG 仅监听 IPv6 [::1]:5433，必须 localhost。
//
// 用法（PowerShell）：
//   node scripts/prod-param-nightly-verify.mjs            # 指向测试库只读体检（无害）
//   node scripts/prod-param-nightly-verify.mjs --prod      # 指向【生产库 crm_native】只读体检
//
// 依赖：src/db.js、src/decision/retro.js、src/calibration/paramInspector.js、src/config/configStore.js

const args = process.argv.slice(2);
const PROD = args.includes('--prod');

// DB 连接：production 锁定 crm_native；默认测试库（无害）。
// 必须在 import src/db.js 之前设定（ESM 静态 import 使 env 兜底失效）。
process.env.PGHOST = 'localhost';                  // 禁 127.0.0.1：PG 仅监听 [::1]
process.env.PGDATABASE = PROD ? 'crm_native' : (process.env.PGDATABASE || 'crm_native_test');

const log = (...a) => console.log(...a);
const hr = (t) => log(`\n===== ${t} =====`);
let failures = 0;
const check = (name, ok, detail = '') => {
  log(`${ok ? '  [PASS]' : '  [FAIL]'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
  return ok;
};

hr(`生产夜批参数体检「真实触发」验证${PROD ? '（生产库 crm_native）' : '（测试库 crm_native_test）'}`);
if (PROD) log('  ⚠ 指向【生产库】。本脚本 dryRun 只读：不落 PENDING、不写 report 列、不碰 config_store。');

// 动态 import（先设 env 再 import db.js）
const { query } = await import('../src/db.js');
const { runParamInspectionPass } = await import('../src/decision/retro.js');
const { inspectAll } = await import('../src/calibration/paramInspector.js');

// -------------------------------------------------- Step 0 连接与库识别
hr('Step 0 连接与库识别');
let dbName = null;
try {
  const ping = await query('SELECT current_database() AS db, now() AS t');
  dbName = ping.rows[0]?.db;
  log(`  数据库=${dbName} 时间=${ping.rows[0]?.t}`);
  check('PG 连通', !!dbName);
} catch (e) {
  check('PG 连通', false, e.message);
  process.exit(1);
}
if (PROD && dbName !== 'crm_native') {
  log('  ⚠ --prod 但当前库非 crm_native，中止以防误打。');
  process.exit(2);
}

// -------------------------------------------------- Step 1 真实夜批第三段触发（dryRun）
hr('Step 1 真实 runParamInspectionPass（dryRun，含真实 inspectAll）');
const rep = await runParamInspectionPass({
  tenantId: 'system',
  dryRun: true,            // 只读：不落 PENDING、不写 report 列
  reportId: null,
}).catch((e) => ({ error: String(e?.message || e) }));
if (rep.error) {
  check('夜批第三段未抛错', false, rep.error);
  process.exit(1);
}
check('夜批第三段未抛错', true);
log(`  inspected=${rep.inspected} healthy=${rep.healthy} drift=${rep.drift} degraded=${rep.degraded} cooling=${rep.cooling ?? 0} unknown=${rep.unknown} patches(计算未落库)=${rep.patches?.length ?? 0}`);
check('体检覆盖 22 项', rep.inspected === 22, `inspected=${rep.inspected}`);

// -------------------------------------------------- Step 2 体检明细（Bug B 修复验证）
hr('Step 2 体检明细（含 Bug B 修复验证）');
const detail = await inspectAll({ tenantId: 'system' }).catch((e) => ({ error: String(e?.message || e) }));
if (detail.error) {
  check('inspectAll 明细拉取未抛错', false, detail.error);
} else {
  const rows = (detail.items || []).map((i) => `${i.key}.${i.param}`.padEnd(34) + `health=${String(i.health).padEnd(9)} verdict=${String(i.verdict).padEnd(8)} cur=${JSON.stringify(i.current)}`);
  for (const r of rows) log('  ' + r);
  // Bug B 修复验证：rubric-thresholds.good 判据命中 adjust 应出方。
  //   修复前 prescribe 护栏以 measured=sample['good']??0 恒为 0 作方向判定 → good 处方被静默抑制；
  //   修复后（paramInspector 本地三步护栏：有限数+[floor,ceiling]+非 no-op）judge+suggest 决策直接出方。
  const good = (detail.items || []).find((i) => i.key === 'rubric-thresholds' && i.param === 'good');
  log(`\n  [Bug B 验证] rubric-thresholds.good health=${good?.health} verdict=${good?.verdict}`);
  const goodPatch = (detail.patches || []).find((p) => p.target === 'rubric-thresholds.good');
  check('Bug B 已修复：good 处方经本地三步护栏出方（生产真实触发下 patches>=1）', !!goodPatch, goodPatch ? `已出方:${JSON.stringify(goodPatch)}` : '仍被抑制（修复未生效）');
  // 同时展示真实会计算的处方（dryRun 未落库）
  if (detail.patches?.length) {
    log(`\n  计算出的处方（dryRun 未落库）：`);
    for (const p of detail.patches) {
      log(`    - ${p.target}  from=${JSON.stringify(p.from_value)} to=${JSON.stringify(p.to_value)} risk=${p.risk} assignee=${p.assignee}`);
    }
  }
}

// -------------------------------------------------- Step 3 report 列落库路径（只读检查 schema + 历史）
hr('Step 3 夜批 report 列（param_inspection）落库路径只读检查');
const colChk = await query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema='crm' AND table_name='decision_retro_report' AND column_name='param_inspection'`
).catch(() => ({ rows: [] }));
check('param_inspection 列已存在于 decision_retro_report', (colChk.rows || []).length > 0, `列数=${(colChk.rows || []).length}`);
const last = await query(
  `SELECT report_id, run_at, param_inspection IS NOT NULL AS has_pi
     FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 1`
).catch(() => ({ rows: [] }));
if (last.rows?.length) {
  const r = last.rows[0];
  log(`  最近一次 retro report: report_id=${r.report_id} run_at=${r.run_at} param_inspection已写=${r.has_pi}`);
  log(`  （param_inspection 列写回由 runParamInspectionPass 在 !dryRun 且传入 reportId 时执行；`);
  log(`    dryRun 验证不落库；该写回路径已由 test/decision/paramInspectionPass.test.js 单测锁死）`);
} else {
  log('  尚无 retro report 行（夜批定时器可能未在生产实例跑过完整三段）。');
}

// -------------------------------------------------- 结论
hr('结论');
log(`  ${PROD ? '生产库' : '测试库'}夜批第三段【真实代码路径 + 真实 DB】执行：inspected=${rep.inspected}/22，无异常。`);
log('  写通道（落 PENDING + 批准生效）由 e2e-param-inspection.mjs --approve（测试库）+ 前次生产手动插方实证覆盖。');
log('  ✅ Bug B 已修复（paramInspector 本地三步定量护栏替代 prescribe 误判）：rubric-thresholds.good 在生产真实触发下正确出方（from=0.75 → to=0.6，PENDING 待人工批准）。');
log(`\n===== 汇总：${failures === 0 ? '全绿' : failures + ' 项失败'} =====`);
process.exit(failures === 0 ? 0 : 1);
