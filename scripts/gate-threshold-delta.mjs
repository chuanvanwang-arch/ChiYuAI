// scripts/gate-threshold-delta.mjs — T4 门控阈值回归（可重复执行，只读）
// 用途：六维 BANTCC 改造后，统计全量 CRM_DEAL 在 P3→P4 拦截率的前后变化，
//       若 delta>20% 输出回调建议（0.6→0.5），但绝不写配置（需人工确认）。
// 运行：node scripts/gate-threshold-delta.mjs   （裸 node 连生产库 plm；仅 SELECT，安全）
import { query } from '../src/db.js';
import { readThreshold, mergedThresholds } from '../src/sales/salesThresholds.js';
import { computeDelta, recommendBantccThreshold } from '../src/sales/gateThresholdDelta.js';

async function main() {
  // 1) 读可调阈值（config_store 优先，缺失回退默认 0.6）——只读，不写
  let pass = 0.6;
  try {
    const c = await query(`SELECT value FROM crm.config_store WHERE key='sales-thresholds'`);
    const cfg = c.rows[0]?.value || null;
    const th = mergedThresholds(cfg);
    pass = readThreshold(th, 'bantcc.pass', 0.6);
  } catch (e) {
    console.warn(`[warn] 读取 config_store 失败，回退默认 pass=0.6：${e.message}`);
  }

  // 2) 拉全量商机 payload（只读 SELECT）
  const r = await query(`SELECT payload FROM crm.particles WHERE type='CRM_DEAL'`);
  const deals = (r.rows || []).map((x) => x.payload).filter(Boolean);

  if (!deals.length) {
    console.log(JSON.stringify({ pass, deals: 0, note: '无 CRM_DEAL 样本，跳过统计' }, null, 2));
    return;
  }

  // 3) 统计前后拦截率 + 阈值建议
  const delta = computeDelta(deals, { pass });
  const rec = recommendBantccThreshold(delta.delta, pass);

  const out = {
    pass,
    sample_size: deals.length,
    before_intercept_rate: Number(delta.before.toFixed(4)),
    after_intercept_rate: Number(delta.after.toFixed(4)),
    delta: Number(delta.delta.toFixed(4)),
    recommendation: rec,
  };
  console.log(JSON.stringify(out, null, 2));

  if (rec.change) {
    console.log(`\n[建议] 拦截率变化 ${(delta.delta * 100).toFixed(1)}% > 20%，建议人工确认后回调 bantcc.pass 至 ${rec.suggested}（本脚本不自动改配置）。`);
  } else {
    console.log(`\n[结论] 拦截率变化 ${(delta.delta * 100).toFixed(1)}% ≤ 20%，阈值保持 ${pass}，无需回调。`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
