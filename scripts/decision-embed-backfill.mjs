// scripts/decision-embed-backfill.mjs — R7 B/C（2026-09-10）
// 回填 DECIDED/PROCESSED 决策的 embedding 列（生产库该两态 0 embedding，导致 searchPrecedents 每查询即时重嵌放大）。
// 幂等：仅补 embedding IS NULL 的行；零 DELETE；--apply 才写，否则 dry-run 仅统计。
import { query, queryWrite } from '../src/db.js';
import { embedText, stableStringify } from '../src/ontology/embedding.js';

const DRY = !process.argv.includes('--apply');
const stats = { scanned: 0, embedded: 0, skipped: 0, errors: 0 };

try {
  const { rows } = await query(
    `SELECT decision_id, scenario_id, trigger_context, conditions_evaluated
       FROM crm.decision WHERE state IN ('DECIDED','PROCESSED') AND embedding IS NULL`
  );
  stats.scanned = rows.length;
  for (const r of rows) {
    try {
      const ev = await embedText(stableStringify({
        scenario_id: r.scenario_id,
        ctx: r.trigger_context || {},
        cond: r.conditions_evaluated || [],
      }), { metering: { tenantId: 'system', actor: 'decision', action: 'precedent-backfill-embed' } });
      if (!ev?.vector?.length) { stats.skipped++; continue; }
      const vec = JSON.stringify(ev.vector); // 与 decisionRepo.js:160 写入格式一致
      if (DRY) { stats.embedded++; continue; }
      await queryWrite(`UPDATE crm.decision SET embedding=$2 WHERE decision_id=$1`, [r.decision_id, vec]);
      stats.embedded++;
    } catch (e) {
      stats.errors++;
      console.error('ERR', r.decision_id, e?.message || e);
    }
  }
  console.log(JSON.stringify({ dry: DRY, ...stats }, null, 2));
} catch (e) {
  console.error('FATAL', e?.message || e);
  process.exit(1);
} finally {
  process.exit(0);
}
