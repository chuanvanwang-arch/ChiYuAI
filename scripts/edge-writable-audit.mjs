// scripts/edge-writable-audit.mjs — BG-05a 只读风险台账：扫描各决策场景 required_dims 是否依赖不可写边
// 仅 SELECT，零写操作（遵循「绝对禁止 DELETE / 写操作过闸」铁律）。
// 用法：node scripts/edge-writable-audit.mjs
import { pool } from '../src/db.js';
import { checkRequiredDimsWritable, WRITABLE_EDGES, PENDING_WRITABLE_EDGES } from '../src/decision/writableEdges.js';

async function main() {
  const { rows } = await pool.query(
    `SELECT scenario_id, stage, required_dims FROM crm.decision_scenario WHERE required_dims IS NOT NULL AND jsonb_array_length(required_dims) > 0`
  );
  console.log(`可写边单一事实源 WRITABLE_EDGES = ${WRITABLE_EDGES.join(', ')}`);
  console.log(`待 BG-03 扩容 PENDING_WRITABLE_EDGES = ${PENDING_WRITABLE_EDGES.join(', ')}`);
  console.log(`扫描场景数：${rows.length}\n`);

  let risky = 0;
  for (const r of rows) {
    const chk = checkRequiredDimsWritable(r.required_dims);
    const dims = r.required_dims.map((d) => d.dim).join('/');
    if (chk.ok) {
      console.log(`✓ ${r.scenario_id} (${r.stage || '-'}) 维度[${dims}] → 依赖边全部可写`);
    } else {
      risky += 1;
      const detail = chk.unwritable.map((u) => `${u.dim}→${u.edges.join('/')}`).join('; ');
      console.log(`✗ ${r.scenario_id} (${r.stage || '-'}) 维度[${dims}] → 不可写边: ${detail}`);
    }
  }
  console.log(`\n结论：存在 ${risky} 个场景依赖不可写边（误报风险），待 BG-03 结构扩容后自动消解。`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
