// scripts/seed-edge-demo-mark.mjs — Phase 5 A-T7 软标记 7 条 seed 演示边（零 DELETE）
//
// 设计依据：docs/2026-09-01-decision-accountability-unified-design.md §6 Phase 5 / §7.2 Q5
// 铁律：绝对禁止 DELETE；仅 jsonb_set 追加 props.demo=true 软标记。
//   与 relation.js listTypedEdges(runtimeOnly) 双口径排除 + edgeSource.js DEMO_EDGE_SOURCES 协同：
//   - source='seed-script' 边（演示来源）→ 双口径已排除
//   - props.demo=true 边（软标记）→ 双口径已排除（BG-04 Q5 软标记权威排除）
//   两者并集 = 演示边不计入供给健康分母，杜绝「演示边充真实边」假绿。
//
// 默认 dry-run（只读计数 + 预览，不写库）；传 --apply 才真正软标记（零 DELETE，幂等可重复执行）。
//
// 用法：
//   PGDATABASE=crm_native_test node scripts/seed-edge-demo-mark.mjs      # 测试库只读预览
//   PGDATABASE=crm_native       node scripts/seed-edge-demo-mark.mjs      # 生产库只读预览
//   PGDATABASE=crm_native       node scripts/seed-edge-demo-mark.mjs --apply  # 生产库真正软标记（需授权）

import { pool } from '../src/db.js';
import { DEMO_EDGE_SOURCES } from '../src/decision/edgeSource.js';

const APPLY = process.argv.includes('--apply');
const targetDb = process.env.PGDATABASE || '(默认)';

// 双口径一致口径（与 relation.js:78 runtimeOnly 完全一致）：
//   runtime = 来源非空且不在演示来源清单 + 未被软标记 demo=true
//   demo    = 来源在演示清单 或 被软标记 demo=true
function dualCaliberSql() {
  return `SELECT
     count(*) FILTER (WHERE source IS NOT NULL
                       AND source <> ALL($${1}::text[])
                       AND (props->>'demo' IS NULL OR props->>'demo' <> 'true')) AS runtime,
     count(*) FILTER (WHERE source = ANY($${1}::text[])
                       OR props->>'demo' = 'true') AS demo,
     count(*) AS total
   FROM crm.decision_relation`;
}

async function main() {
  await pool.query(`SET search_path TO crm, public`);
  console.log(`=== seed-edge-demo-mark (dry-run=${!APPLY}, db=${targetDb}) ===`);

  // 1. 待软标记的边：演示来源且尚未打 demo 标记
  const pending = await pool.query(
    `SELECT rel_type, from_id, to_id, source, (props->>'demo') AS demo
       FROM crm.decision_relation
      WHERE source = ANY($1::text[])
        AND (props->>'demo' IS NULL OR props->>'demo' <> 'true')`,
    [DEMO_EDGE_SOURCES]
  );
  const rows = pending.rows;
  console.log(`待软标记 demo 边：${rows.length} 条`);

  // 2. 软标前双口径
  const before = await pool.query(dualCaliberSql(), [DEMO_EDGE_SOURCES]);
  const b = before.rows[0];
  console.log(`软标前：runtime=${b.runtime} / demo=${b.demo} / total=${b.total}`);

  if (!APPLY) {
    console.log('— 预览（不写库）—');
    for (const r of rows) {
      console.log(`  - ${r.rel_type}  ${r.from_id.slice(0, 8)}→${r.to_id.slice(0, 8)}  source=${r.source}  demo=${r.demo}`);
    }
    console.log('传 --apply 真正软标记（零 DELETE，jsonb_set 追加 demo=true）。');
    await pool.end();
    return;
  }

  // 3. 真正软标记：jsonb_set 追加 demo=true（零 DELETE，幂等）
  const upd = await pool.query(
    `UPDATE crm.decision_relation
        SET props = jsonb_set(COALESCE(props, '{}'::jsonb), '{demo}', 'true'::jsonb)
      WHERE source = ANY($1::text[])
        AND (props->>'demo' IS NULL OR props->>'demo' <> 'true')`,
    [DEMO_EDGE_SOURCES]
  );
  console.log(`已软标记：${upd.rowCount} 条（零 DELETE）`);

  // 4. 软标后双口径
  const after = await pool.query(dualCaliberSql(), [DEMO_EDGE_SOURCES]);
  const a = after.rows[0];
  console.log(`软标后：runtime=${a.runtime} / demo=${a.demo} / total=${a.total}`);
  console.log(`双口径校验：demo 前=${b.demo} → 后=${a.demo}（应 +${rows.length}）；runtime 不变=${a.runtime}（=${b.runtime}）`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
  pool.end().catch(() => {});
});
