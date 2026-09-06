// scripts/prod-param-nightly-write.mjs — 生产真实落库（写通道放开专用）
// 调用真实 runParamInspectionPass({dryRun:false})：自动巡检 22 项 → 仅写 PENDING 处方到 calibration_patch
// 铁律：处方 PENDING 绝不自动 apply；config_store 改动须经 my-todo 人工批准（第0闸）。
//
// 用法：PGDATABASE=crm_native node scripts/prod-param-nightly-write.mjs --prod
//   --replace-manual <patch_id>  可选：先 REJECT 指定陈旧手动处方（非 DELETE，保留审计行），
//                                 让自动巡检能写出"全新" PENDING 以示自动链路生效。
import { runParamInspectionPass } from '../src/decision/retro.js';
import { query } from '../src/db.js';

const args = process.argv.slice(2);
const PROD = args.includes('--prod');
if (!PROD) {
  console.error('⚠ 必须带 --prod 显式授权生产写操作（防误跑测试库）');
  process.exit(2);
}
const replaceIdx = args.indexOf('--replace-manual');
const replaceId = replaceIdx >= 0 ? args[replaceIdx + 1] : null;

const tenantId = 'system';

// 可选：先 REJECT 陈旧手动处方（UPDATE，非 DELETE，保留审计）
if (replaceId) {
  const rj = await query(
    `UPDATE crm.calibration_patch SET status='REJECTED', resolved_at=now(), resolved_by='agent-replace'
     WHERE patch_id=$1 AND status='PENDING' RETURNING patch_id, target`,
    [replaceId]
  );
  console.log(`[replace-manual] REJECT 陈旧手动处方 ${replaceId} → ${rj.rows.length ? 'ok' : '未命中/已非 PENDING'}`);
}

// 真实落库：自动巡检写 PENDING
console.log('\n=== runParamInspectionPass({dryRun:false}) 真实落库 ===');
const out = await runParamInspectionPass({ tenantId, dryRun: false });
console.log(JSON.stringify({
  inspected: out.inspected, healthy: out.healthy, drift: out.drift,
  degraded: out.degraded, unknown: out.unknown, patches_created: out.patches_created,
}, null, 2));

// 验收：列出当前生产 PENDING 处方
console.log('\n=== 生产库 PENDING 处方（待 my-todo 参数调优批准）===');
const r = await query(
  `SELECT patch_id, knob, target, from_value, to_value, status, assignee, tenant_id, created_at
   FROM crm.calibration_patch WHERE status='PENDING' AND tenant_id=$1 ORDER BY created_at DESC LIMIT 20`,
  [tenantId]
);
if (!r.rows.length) {
  console.log('  (无 PENDING —— 自动巡检未产出新方或全被去重跳过)');
} else {
  for (const row of r.rows) {
    console.log(`  - ${row.target.padEnd(34)} ${JSON.stringify(row.from_value)} → ${JSON.stringify(row.to_value)}  [${row.status}]`);
    console.log(`      patch_id=${row.patch_id}  assignee=${row.assignee}`);
  }
}
console.log(`\n汇总：${r.rows.length} 条 PENDING 待办已落库（my-todo.html?view=tuning 可见，批准后才改 config）`);
process.exit(0);
