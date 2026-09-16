// scripts/verify-s5-proactive.mjs — S5 真链路产出验证（防假绿收口）
// 直接对真实 crm_native 库驱动 T15/T16/T17 三扫描器，确认 crm.signal 真实增长 + dedup 生效。
// 注意：本脚本写真实信号到 crm_native（S5 感知层设计行为，非 DELETE，非对外动作，不需 decision_id）。
import { pool } from '../src/db.js';
import { createScheduleScanner } from '../src/signal/scheduleScanner.js';
import { createProspectScanner } from '../src/signal/prospectScanner.js';
import { createResearchScheduler } from '../src/signal/researchScheduler.js';
import { createSignalStore } from '../src/signal/store.js';

const q = (text, params) => pool.query(text, params);
const signalStore = createSignalStore(pool);

async function countAllSignals() {
  const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM crm.signal`);
  return Number(rows[0].n);
}
async function signalKinds() {
  const { rows } = await pool.query(
    `SELECT kind, source, COUNT(*) AS n FROM crm.signal GROUP BY kind, source ORDER BY n DESC`
  );
  return rows;
}

async function main() {
  // 1) 枚举真实租户与粒子类型分布（决定扫描目标）
  const { rows: dist } = await pool.query(
    `SELECT tenant_id, type, COUNT(*) AS n FROM crm.particles GROUP BY tenant_id, type ORDER BY tenant_id, n DESC`
  );
  console.log('=== crm.particles 分布（tenant / type / count）===');
  for (const r of dist) console.log(`  ${r.tenant_id}\t${r.type}\t${r.n}`);

  const tenants = [...new Set(dist.map((r) => r.tenant_id))];
  const before = await countAllSignals();
  console.log(`\nBEFORE total crm.signal: ${before}`);

  let totalScanned = 0, totalSignals = 0;

  // 2) T15 时间型信号（per-tenant）
  const sched = createScheduleScanner({ query: q, signalStore });
  for (const t of tenants) {
    const r = await sched.scanOnce({ tenantId: t });
    if (r.scanned || r.signals) console.log(`[T15] tenant=${t} scanned=${r.scanned} signals=${r.signals}`);
    totalScanned += r.scanned; totalSignals += r.signals;
  }

  // 3) T16 拓客信号（per-tenant）
  const pros = createProspectScanner({ query: q, signalStore });
  for (const t of tenants) {
    const r = await pros.scanOnce({ tenantId: t });
    if (r.scanned || r.signals) console.log(`[T16] tenant=${t} scanned=${r.scanned} signals=${r.signals}`);
    totalScanned += r.scanned; totalSignals += r.signals;
  }

  // 4) T17 L3 主动研究（per-tenant，runSkill=noop 验证写入路径，不耗 LLM）
  const res = createResearchScheduler({ query: q, signalStore, runSkill: async () => ({ reasoning: null, evidence_refs: [] }) });
  for (const t of tenants) {
    const r = await res.runOnce({ tenantId: t });
    if (r.researched || r.cards) console.log(`[T17] tenant=${t} researched=${r.researched} cards=${r.cards}`);
    totalSignals += r.cards;
  }

  const after = await countAllSignals();
  console.log(`\nAFTER total crm.signal: ${after}`);
  console.log(`DELTA signals: ${after - before}  (scanned particles: ${totalScanned})`);

  // 5) dedup 复跑：再跑一次 T15（同 tenant 集合），新增应为 0
  let dupSignals = 0;
  for (const t of tenants) {
    const r = await sched.scanOnce({ tenantId: t });
    dupSignals += r.signals;
  }
  console.log(`DEDUP re-run T15 new signals: ${dupSignals}  (期望 0 = 去重生效)`);

  console.log('\n=== crm.signal 当前 kind/source 分布 ===');
  for (const r of await signalKinds()) console.log(`  ${r.kind}\t${r.source}\t${r.n}`);

  await pool.end();
  console.log('\n[verify-s5] done');
}

main().catch((e) => { console.error('VERIFY ERROR', e); process.exit(1); });
