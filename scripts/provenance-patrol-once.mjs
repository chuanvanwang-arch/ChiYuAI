// scripts/provenance-patrol-once.mjs — C2 审计链巡检：手工触发一次（对齐 retro-once.mjs 运维范式）
// 用途：① 运维/排障时立即巡检（不等定时器周期）② 验证封印比对（篡改/分叉/删链尾）是否真的检得出。
//   ESM env 护栏：必须先设 PGDATABASE 再动态 import('../src/db.js')，否则静态 import 让 env 兜底失效。
//
// 用法：
//   PGDATABASE=crm_native_test node scripts/provenance-patrol-once.mjs --limit=200
//   node scripts/provenance-patrol-once.mjs --decision=<uuid>        # 只巡检指定链（默认生产库）
//   node scripts/provenance-patrol-once.mjs --self-test              # 自检：造链→篡改→删尾，验证三类检出
const arg = (k, d = null) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? m.split('=').slice(1).join('=') : d;
};
const has = (k) => process.argv.includes(`--${k}`);

process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';

const { query, queryWrite } = await import('../src/db.js');
const { trackEntry, patrolChains, verifyChain } = await import('../src/decision/provenance.js');
const { ensureMonitorSchema } = await import('../src/monitor/monitorSubscriber.js');

await ensureMonitorSchema();

// ───────────────────── 自检模式（仅测试库；造自己的链，跑完自清自数据） ─────────────────────
if (has('self-test')) {
  if (process.env.PGDATABASE !== 'crm_native_test') {
    console.error('[patrol] --self-test 只允许跑在测试库（PGDATABASE=crm_native_test），当前=', process.env.PGDATABASE);
    process.exit(1);
  }
  const { registerMonitorSubscriber } = await import('../src/monitor/monitorSubscriber.js');
  registerMonitorSubscriber();   // decision 域事件落 monitor_event（验收需要查留痕）
  const DID = '55555555-5555-5555-5555-555555555555';
  const cleanup = async () => {
    await query(`DELETE FROM crm.monitor_event WHERE decision_id=$1`, [DID]);
    await query(`DELETE FROM crm.provenance_seal WHERE decision_id=$1`, [DID]);
    await query(`DELETE FROM crm.decision_provenance WHERE decision_id=$1`, [DID]);
    await query(`DELETE FROM crm.decision WHERE decision_id=$1`, [DID]);
  };
  await cleanup();
  await query(
    `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,'LEAD_FOLLOW_UP','{}','[]','[]','APPROVE','AUTONOMOUS_AGENT','patrol-self-test','NORMAL','CONFIRMED')`,
    [DID]
  );
  const out = {};
  for (const p of [{ a: 1 }, { a: 2 }, { a: 3 }]) {
    await trackEntry({ decision_id: DID, entry_type: 'decision', payload: p, source: 'agent' });
  }
  out['① 首次巡检（建封印基准）'] = await patrolChains({ decisionIds: [DID] });

  // 篡改：把最小 id 那条 entry_type 改成 entity（v2 白名单内字段，v1 完全检不出）
  await query(`UPDATE crm.decision_provenance SET entry_type='entity' WHERE id=(SELECT min(id) FROM crm.decision_provenance WHERE decision_id=$1)`, [DID]);
  out['② 篡改 entry_type 后巡检'] = await patrolChains({ decisionIds: [DID] });
  const viol = (await query(
    `SELECT event_type, payload->>'status' st FROM crm.monitor_event WHERE decision_id=$1 AND event_type='provenance-chain-violation' ORDER BY id DESC LIMIT 1`,
    [DID]
  )).rows[0];
  out['②b monitor_event 留痕'] = viol || null;

  // 复原后删链尾（哈希链固有盲区：删尾后全链重算仍自洽，纯哈希链永远检不出，只能靠封印）
  await query(`UPDATE crm.decision_provenance SET entry_type='decision' WHERE decision_id=$1`, [DID]);
  out['③ 复原后链状态'] = (await verifyChain({ decision_id: DID })).status;
  await query(`DELETE FROM crm.decision_provenance WHERE id=(SELECT max(id) FROM crm.decision_provenance WHERE decision_id=$1)`, [DID]);
  out['④ 删链尾后巡检'] = await patrolChains({ decisionIds: [DID] });
  out['④b 封印快照'] = (await query(`SELECT entry_count, last_status FROM crm.provenance_seal WHERE decision_id=$1`, [DID])).rows[0];

  console.log(JSON.stringify(out, null, 2));
  await cleanup();
  process.exit(0);
}

// ───────────────────── 常规模式 ─────────────────────
const decision = arg('decision');
const limit = Number(arg('limit', 200));
const r = await patrolChains(decision ? { decisionIds: [decision] } : { limit });
console.log('[patrol]', JSON.stringify(r));
process.exit(r.tampered || r.forked || r.head_lost ? 2 : 0);   // 有异常 → 退出码 2（供 cron/运维告警）
