// scripts/fix-billing-plan-entitlements.mjs — 套餐权益单调性修复：pro 档补 memory（升级丢功能缺陷）+ enabled 标记对齐
// 背景：现网 pro 档（10 权益）缺 memory，而更便宜的 starter/free 都有 → 客户从 starter 升到 pro 反而丢功能。
//       由 test/billing/planSourceConsistency.test.js 的「高档位权益必须包含低档位权益」用例守住院。
// 用法（默认 dry-run，加 --apply 才写库）：
//   本地：PGDATABASE=crm_native     node scripts/fix-billing-plan-entitlements.mjs [--apply]
//   生产：docker exec crm-app sh -c 'PGDATABASE=crm_native node scripts/fix-billing-plan-entitlements.mjs --apply'
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';
const APPLY = process.argv.includes('--apply');
const { query, queryWrite } = await import('../src/db.js');

const r = await query(`SELECT value FROM crm.config_store WHERE tenant_id='system' AND key='billing-plans'`);
const plans = r.rows[0]?.value || [];
const pro = plans.find((p) => p.plan_id === 'pro');
console.log('当前 pro.entitlements =', JSON.stringify(pro?.entitlements));
if (!pro) { console.log('未找到 pro 档，退出'); process.exit(1); }
if (pro.entitlements.includes('memory')) { console.log('pro 已含 memory，无需修复'); process.exit(0); }

const next = plans.map((p) => {
  const q = { ...p };
  if (q.plan_id === 'pro') q.entitlements = [...q.entitlements, 'memory'];
  if (q.enabled === undefined) q.enabled = true;
  return q;
});
console.log('修复后 pro.entitlements =', JSON.stringify(next.find((p) => p.plan_id === 'pro').entitlements));
if (!APPLY) { console.log('\n[DRY-RUN] 未写入。加 --apply 执行'); process.exit(0); }
await queryWrite(`INSERT INTO crm.config_store (tenant_id,key,value,updated_by)
  VALUES ('system','billing-plans',$1::jsonb,'plan-fix') ON CONFLICT (tenant_id,key)
  DO UPDATE SET value=EXCLUDED.value, updated_by=EXCLUDED.updated_by, updated_at=now()`, [JSON.stringify(next)]);
const after = await query(`SELECT value FROM crm.config_store WHERE tenant_id='system' AND key='billing-plans'`);
console.log('已写入，回读 pro.entitlements =', JSON.stringify(after.rows[0].value.find((p) => p.plan_id === 'pro').entitlements));
process.exit(0);
