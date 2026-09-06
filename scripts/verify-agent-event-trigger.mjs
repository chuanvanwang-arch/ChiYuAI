// scripts/verify-agent-event-trigger.mjs — T5 生产验收（只读，零信任合规）
//
// 原则（铁律）：不在生产库写任何数据。零信任 → 任何写操作前需显式 HITL 确认；
// 且「绝对禁止 DELETE」是硬规则。故本脚本：
//   ① 读真实 B能源 deal 粒子（确认实体存在 + 真实 stage）
//   ② 读生产 config_store['agent-event-trigger']（确认开关 + 矩阵）
//   ③ 纯函数 matchTrigger 断言「若发生 ontology-sync 事件，矩阵会命中并派发只读 SKILL」
//   ④ 读生产 crm.tasks 中该 deal 的真实任务（用户手动操作留下的痕迹，仅展示不删不改）
// 不 emit 真实事件、不 INSERT、不 DELETE。业务侧「真实推进/知识入库」由用户手动操作触发。
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';

const { query, pool } = await import('../src/db.js');
const { loadTriggerConfig, matchTrigger } = await import('../src/agent/eventTrigger.js');

const DEAL_ID = '7fdebf95-126b-4294-8e85-47a7a1d653f1';
const TENANT = 'system';
const EV_TYPE = 'ontology-sync';

let ok = true;
const log = (...a) => console.log(...a);

try {
  // ① 真实粒子
  const deal = await query(
    `SELECT id, payload->>'name' AS name, payload->>'stage' AS stage
     FROM crm.particles WHERE id=$1`, [DEAL_ID]
  );
  if (!deal.rows.length) { log('FAIL: 生产库不存在 B能源 deal', DEAL_ID); ok = false; }
  else {
    log('① B能源 deal 实体:', JSON.stringify(deal.rows[0]));
  }

  // ② 生产配置
  const cfg = await loadTriggerConfig({ tenantId: TENANT });
  log('② 生产 config[agent-event-trigger]:', JSON.stringify({ enabled: cfg.enabled, matrix_len: cfg.matrix?.length }));
  if (!cfg.enabled) { log('FAIL: 触发器在生产未启用 (enabled=false)'); ok = false; }

  // ③ 矩阵命中（纯函数，零写入）
  const m = matchTrigger(EV_TYPE, { entity_type: 'CRM_DEAL', entity_id: DEAL_ID, tenant_id: TENANT }, cfg);
  if (!m) { log('FAIL: 矩阵未命中 CRM_DEAL ontology-sync（触发器不会派发）'); ok = false; }
  else {
    log('③ 矩阵命中 → 拟派发:', JSON.stringify({ intent: m.intent, agent: m.agent, skill_slug: m.skill_slug }));
  }

  // ④ 生产任务现状（只读，仅展示该 deal 既有派发痕迹，不清理）
  const tasks = await query(
    `SELECT id, status, payload->>'dedup_key' AS dk, payload->>'skill_slug' AS sk, created_at
     FROM crm.tasks WHERE payload->>'entity_id'=$1 ORDER BY created_at DESC LIMIT 10`, [DEAL_ID]
  );
  log('④ 生产 crm.tasks 中该 deal 既有任务数:', tasks.rows.length);
  tasks.rows.forEach((t) => log('   -', JSON.stringify(t)));

  if (ok && m) {
    log('\nPASS: 事件触发派发链路在生产配置 + 真实数据下「会命中并派发只读 SKILL」(' + m.skill_slug + ')');
    log('      业务侧真实任务出现需由用户手动操作该 deal（推进/知识入库）触发 ontology-sync 落库钩子。');
  } else {
    log('\nFAIL: 见上。');
  }
} catch (e) {
  log('ERR:', e.message);
  ok = false;
} finally {
  await pool.end();
  process.exit(ok ? 0 : 1);
}
