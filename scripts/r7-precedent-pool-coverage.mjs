// scripts/r7-precedent-pool-coverage.mjs — R7 B/C（2026-09-10）闭环指标
// 输出先例池覆盖率：旧闸门(CONFIRMED/AUTONOMOUS) vs 新闸门(已决四态)，证明自锁消除。
import { poolRead } from '../src/db.js';
const q = (t, p = []) => poolRead.query(t, p).then((r) => r.rows);
try {
  const total = (await q(`SELECT count(*)::int n FROM crm.decision`)).map((r) => r.n)[0];
  const oldPool = (await q(`SELECT count(*)::int n FROM crm.decision WHERE state IN ('CONFIRMED','AUTONOMOUS')`)).map((r) => r.n)[0];
  const newPool = (await q(`SELECT count(*)::int n FROM crm.decision WHERE state IN ('CONFIRMED','AUTONOMOUS','DECIDED','PROCESSED')`)).map((r) => r.n)[0];
  console.log(JSON.stringify({
    total,
    old_pool: oldPool, old_coverage_pct: +((oldPool / total) * 100).toFixed(1),
    new_pool: newPool, new_coverage_pct: +((newPool / total) * 100).toFixed(1),
  }, null, 2));
} catch (e) {
  console.error('ERR', e?.message || e);
} finally {
  await poolRead.end();
}
