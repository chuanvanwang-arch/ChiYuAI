// scripts/snapshot-funnel-baseline.mjs — 漏斗 baseline 快照（算抖动率分母）
// 设计：docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §5.2①
// 调用时机：季度末月 21 日（与 SKILL「取值时间」一致）由调度器触发；幂等，可手动重跑。
// 语义：取值时漏斗内金额 = 商机当前 expected_amount，落 payload.funnel.baseline_amount。
//   抖动率 = (取消+降出+后延-中标未下单) / baseline_amount；缺快照看板显式标「无基线」而非 0。
import { query, queryWrite } from '../src/db.js';
import { applyBaselineSnapshot } from '../src/sales/funnelQuality.js';

const TENANT = 'system';

async function main() {
  const { rows } = await query(
    `SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`,
    [TENANT]
  );
  const updated = applyBaselineSnapshot(rows);
  let n = 0;
  for (const u of updated) {
    await queryWrite(
      `UPDATE crm.particles SET payload = payload || $1::jsonb WHERE id=$2`,
      [JSON.stringify({ funnel: u.payload.funnel }), u.id]
    );
    n += 1;
  }
  console.log(`[snapshot-funnel-baseline] 已快照 ${n} 个 CRM_DEAL 的 baseline_amount（幂等）`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
