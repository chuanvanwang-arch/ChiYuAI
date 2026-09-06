#!/usr/bin/env node
// 手动补跑决策复盘（与夜间 02:00 定时任务同一入口 runDecisionRetro）
// 用途：① 夜间窗口因进程挂起/DB 不可达而错过后的补跑；② 调参后即时验证。
// 语义：仅追加写 crm.decision_retro_report（绝不 DELETE、不触碰 calibration_patch 写通道）。
// 用法：
//   node scripts/retro-once.mjs                # 落库跑批（windowHours=24）
//   node scripts/retro-once.mjs --dry-run      # 只跑不落库
//   node scripts/retro-once.mjs --hours=48     # 自定义窗口
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => {
  const hit = args.find((a) => a.startsWith(`--${f}=`));
  return hit ? hit.split('=')[1] : d;
};

const { runDecisionRetro } = await import('../src/decision/retro.js');

const t0 = Date.now();
const r = await runDecisionRetro({
  windowHours: Number(val('hours', 24)),
  dryRun: has('--dry-run'),
});

console.log('== SUMMARY ==');
console.log(JSON.stringify(r.summary, null, 1));
console.log('report_id:', r.report_id ?? '(dry-run, 未落库)');
console.log('decisions_scanned:', r.decisions_scanned);
console.log('elapsed(s):', ((Date.now() - t0) / 1000).toFixed(1));
for (const p of r.draft_patches || []) {
  console.log(`PATCH [${p.scenario_id}] ${p.root_cause_class} ${p.knob} -> ${JSON.stringify(p.to_value)}`);
}
process.exit(0);
