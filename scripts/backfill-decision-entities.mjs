// backfill-decision-entities.mjs
// 目的：消除 prod 陈旧决策（BG-03 修复前创建）缺实体边的数据漂移，
//       使 BG-03(BG-05b) 对存量数据也清零。
// 铁律：零 DELETE（仅 INSERT 补边，ON CONFLICT DO NOTHING 幂等）；
//       复用 relation.js linkDecisions 同源写入口（单一写入口铁律）。
// 用法：默认 dry-run（只读，打印将写入的边，不加写）；--apply 真写。
import { pool } from '../src/db.js';
import { linkDecisions } from '../src/decision/relation.js';

const APPLY = process.argv.includes('--apply');

async function main() {
  await pool.query('SET search_path TO crm, public');
  const decs = await pool.query(
    `SELECT decision_id, scenario_id, involved_entities, trigger_context
     FROM crm.decision
     WHERE involved_entities IS NOT NULL AND jsonb_array_length(involved_entities) > 0`
  );
  const plan = [];
  for (const r of decs.rows) {
    const ents = Array.isArray(r.involved_entities) ? r.involved_entities : [];
    for (const e of ents) {
      const entId = typeof e === 'object' && e.id ? e.id : e;
      const entType = typeof e === 'object' && e.type ? e.type : null;
      // 已存在运行时 DECIDED_ON 边则跳过（幂等，不重复写、不删）
      const ex = await pool.query(
        `SELECT 1 FROM crm.decision_relation
         WHERE from_id=$1 AND to_id=$2 AND rel_type='DECIDED_ON'
           AND source <> ALL(ARRAY['seed-script'])`,
        [r.decision_id, entId]
      );
      if (ex.rows.length > 0) continue;
      plan.push({ decisionId: r.decision_id, entId, entType });
    }
  }

  console.log(`[mode] ${APPLY ? 'APPLY(真写)' : 'DRY-RUN(只读)'}`);
  console.log(`[plan] 待补 DECIDED_ON 边: ${plan.length} 条（覆盖 ${decs.rows.length} 个决策）`);
  for (const p of plan) {
    console.log(`  DECIDED_ON: ${p.decisionId.slice(0,8)} -> ${p.entId.slice(0,8)} (${p.entType || '?'})`);
  }

  if (!APPLY) {
    console.log('\n[dry-run] 未写入任何数据。加 --apply 执行真实补边。');
    await pool.end();
    return;
  }

  let ok = 0, fail = 0;
  for (const p of plan) {
    try {
      await linkDecisions(p.decisionId, p.entId, 'DECIDED_ON', {
        servesDimension: 'identity',
        props: { entity_type: p.entType, backfilled: true },
        source: 'backfill',
      });
      ok++;
      console.log(`  ✓ ${p.decisionId.slice(0,8)} -> ${p.entId.slice(0,8)}`);
    } catch (e) {
      fail++;
      console.error(`  ✗ ${p.decisionId.slice(0,8)} -> ${p.entId.slice(0,8)}: ${e.message}`);
    }
  }
  console.log(`\n[apply] 补边完成: ok=${ok} / fail=${fail}`);
  await pool.end();
}

main().catch((e) => {
  console.error('FATAL', e.message);
  pool.end();
  process.exit(1);
});
