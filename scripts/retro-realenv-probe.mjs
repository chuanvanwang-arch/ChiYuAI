#!/usr/bin/env node
// scripts/retro-realenv-probe.mjs — 夜间复盘「真实环境」四类盲点诊断探针（只读）
//
// 背景：Task 11/12 全部经 mock 验证，真实 PG + 真实 LLM 从未跑通，存在四类盲点：
//   ① 真实连接   —— LLM 配置是否真能取到函数（而非 null 降级）
//   ② 索引命中   —— 复盘 5 条主查询在真实数据量下是否走索引
//   ③ 并发       —— 跑批期间连接池占用 / 长事务 / 与业务写入争抢
//   ④ LLM 超时   —— retroTimeoutMs 生效值、attempts=2 放大后的最坏总耗时
//
// 铁律：
//   - 默认**只读**，不写任何业务表、不落复盘报告、不创建待办。
//   - 只有显式 --live 才会真实调用一次 LLM（消耗 token），且仅 1 次、小 max_tokens。
//   - PG host 必须用 localhost（PG 仅监听 IPv6 ::1，127.0.0.1 会 ECONNREFUSED）。
//
// 用法：
//   PGDATABASE=crm_native node scripts/retro-realenv-probe.mjs
//   PGDATABASE=crm_native node scripts/retro-realenv-probe.mjs --live   # 追加真实 LLM 单次连通性测试
import pg from 'pg';

const DB = process.env.PGDATABASE || 'crm_native';
const LIVE = process.argv.includes('--live');
const CLIENT = new pg.Client({
  host: process.env.PGHOST || 'localhost',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: DB,
});

const say = (...a) => console.log(...a);
const hr = (t) => say('\n=== ' + t + ' ===');

async function main() {
  await CLIENT.connect();
  await CLIENT.query('SET search_path TO crm,public');
  say('[目标库] ' + DB + '  (host=' + (process.env.PGHOST || 'localhost') + ')');

  // ── ① 真实连接：DB 侧 ───────────────────────────────────────────────
  hr('① 真实连接');
  const ping = await CLIENT.query('SELECT current_database() db, current_user usr, now() ts');
  say('  DB 连通 :', ping.rows[0].db, '/ user=' + ping.rows[0].usr);
  const retroTables = ['decision', 'tasks', 'agent_sla', 'decision_retro_report', 'calibration_patch'];
  for (const t of retroTables) {
    const r = await CLIENT.query('SELECT count(*)::int n FROM crm.' + t).catch((e) => ({ rows: [{ n: 'ERR:' + e.code }] }));
    say('  crm.' + t.padEnd(24), r.rows[0].n);
  }

  // LLM 配置真实可用性（不打印密钥内容）
  const llm = await CLIENT
    .query('SELECT count(*)::int total, count(*) FILTER (WHERE NOT is_deleted)::int active, count(*) FILTER (WHERE is_default AND NOT is_deleted)::int usable FROM crm.llm_config')
    .catch((e) => ({ rows: [{ total: 'ERR:' + e.code, active: '-', usable: '-' }] }));
  const L = llm.rows[0];
  say('  llm_config: 总=' + L.total + ' 未删=' + L.active + ' 默认可用=' + L.usable);
  if (L.usable === 0) say('  ⚠ 无可用 LLM 配置 → runDecisionRetro 必然全簇降级（drafts=0、待办不生成）');

  // ── ② 索引命中 ──────────────────────────────────────────────────────
  hr('② 索引命中（EXPLAIN ANALYZE，真实执行）');
  const W1 = '2026-09-04T00:00:00Z';
  const W2 = '2026-09-05T00:00:00Z';
  const QUERIES = [
    ['R1 retro 窗口扫描', 'SELECT * FROM crm.decision WHERE decided_at >= $1 ORDER BY decided_at DESC LIMIT 2000', [W1]],
    ['R2 dailyOps decision', "SELECT COUNT(*) FILTER (WHERE decider_type='AUTONOMOUS_AGENT') FROM crm.decision WHERE decided_at >= $1 AND decided_at < $2", [W1, W2]],
    ['R3 dailyOps tasks', "SELECT COUNT(*) FILTER (WHERE status='done') FROM crm.tasks WHERE updated_at >= $1 AND updated_at < $2", [W1, W2]],
    ['R4 dailyOps agent_sla', 'SELECT auditability_pct FROM crm.agent_sla WHERE measured_at >= $1 ORDER BY measured_at DESC LIMIT 1', [W1]],
    ['R5 catchUp 探测', 'SELECT run_at FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 1', []],
  ];
  const noIndex = [];
  for (const [name, sql, params] of QUERIES) {
    let plan = '';
    try {
      const r = await CLIENT.query('EXPLAIN (ANALYZE) ' + sql, params);
      plan = r.rows.map((x) => x['QUERY PLAN']).join('\n');
    } catch (e) {
      say('  [' + name + '] EXPLAIN 失败: ' + e.message);
      continue;
    }
    const scan = /Seq Scan/.test(plan) ? '❌ Seq Scan' : /Index Scan|Bitmap/.test(plan) ? '✅ 走索引' : '— 其他';
    const tm = (plan.match(/Execution Time: ([0-9.]+)/) || [])[1] || '?';
    const node = (plan.split('\n').find((l) => /Scan on/.test(l)) || '').trim().replace(/\s+/g, ' ');
    say('  [' + name.padEnd(20) + '] ' + scan + ' | ' + tm + 'ms');
    if (node) say('      ' + node.slice(0, 140));
    if (scan === '❌ Seq Scan') noIndex.push(name);
  }
  if (noIndex.length) {
    say('\n  ⚠ 全表扫描查询: ' + noIndex.join('、'));
    say('    当前数据量小故耗时可忽略；生产规模化后（decision 日增）将线性劣化。');
  }

  // ── ③ 并发 ──────────────────────────────────────────────────────────
  hr('③ 并发与连接');
  const conn = await CLIENT.query(
    "SELECT count(*)::int total, count(*) FILTER (WHERE state='active')::int active, count(*) FILTER (WHERE state='idle in transaction')::int idle_tx FROM pg_stat_activity WHERE datname = current_database()"
  ).catch(() => ({ rows: [{ total: -1, active: -1, idle_tx: -1 }] }));
  say('  当前连接: 总=' + conn.rows[0].total + ' 活跃=' + conn.rows[0].active + ' 空闲事务=' + conn.rows[0].idle_tx);
  const locks = await CLIENT.query("SELECT count(*)::int n FROM pg_locks WHERE NOT granted").catch(() => ({ rows: [{ n: -1 }] }));
  say('  未授予锁(阻塞): ' + locks.rows[0].n);
  const longTx = await CLIENT
    .query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction' AND now()-xact_start > interval '30 seconds'")
    .catch(() => ({ rows: [{ n: -1 }] }));
  say('  超 30s 长事务: ' + longTx.rows[0].n);

  // 复盘报告历史（判断到底真实跑过没有）
  const hist = await CLIENT
    .query("SELECT report_id, run_at, decisions_scanned, llm_enabled, summary->>'llm_effective' llm_eff, summary->>'drafts' drafts FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 10")
    .catch(() => ({ rows: [] }));
  say('\n  复盘报告历史(最多10条): ' + (hist.rowCount || 0) + ' 条');
  hist.rows.forEach((x) => say('    id=' + x.report_id + ' run_at=' + x.run_at + ' scanned=' + x.decisions_scanned + ' llm_enabled=' + x.llm_enabled + ' llm_effective=' + x.llm_eff + ' drafts=' + x.drafts));

  // ── ④ LLM 超时 ──────────────────────────────────────────────────────
  hr('④ LLM 超时与最坏耗时');
  const cfg = await CLIENT.query("SELECT value FROM crm.config_store WHERE key='decision-retro'").catch(() => ({ rows: [] }));
  const timeoutMs = Number(cfg.rows[0]?.value?.llm_timeout_ms) || 180000;
  say('  config_store[decision-retro].llm_timeout_ms = ' + (cfg.rows[0]?.value?.llm_timeout_ms ?? '(未配置)'));
  say('  生效超时 = ' + timeoutMs + 'ms (兜底 180000)');
  const clusters = await CLIENT.query("SELECT count(DISTINCT scenario_id)::int n FROM crm.decision WHERE decided_at >= now() - interval '24 hours'").catch(() => ({ rows: [{ n: 0 }] }));
  const n = clusters.rows[0].n;
  say('  昨日场景簇数 = ' + n);
  say('  ⚠ getLlmJson(round-robin) attempts=2 → 单簇最坏 ' + (timeoutMs * 2 / 1000).toFixed(0) + 's');
  say('  ⚠ 串行跑批最坏总耗时 = ' + n + ' × ' + (timeoutMs * 2 / 1000).toFixed(0) + 's = ' + ((n * timeoutMs * 2) / 60000).toFixed(1) + ' 分钟（无全局 deadline）');

  // ── ⑤ 可选：真实 LLM 单次连通 ──────────────────────────────────────
  if (LIVE) {
    hr('⑤ 真实 LLM 单次连通性（--live，消耗 token）');
    try {
      const { getLlmJson } = await import('../src/llm/client.js');
      const llmJson = await getLlmJson({ strategy: 'round-robin' });
      if (!llmJson) {
        say('  ❌ getLlmJson 返回 null → 配置不可用，跑批必然全降级');
      } else {
        say('  ✅ getLlmJson 返回函数（配置可用）');
        const t0 = Date.now();
        const out = await llmJson('你是 JSON 生成器。', '输出 {"ok":true}', { timeoutMs: 60000, max_tokens: 64 });
        say('  单次调用耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's | 返回: ' + JSON.stringify(out));
      }
    } catch (e) {
      say('  ❌ 真实调用异常: ' + e.name + ': ' + e.message);
    }
  } else {
    hr('⑤ 真实 LLM 连通性');
    say('  已跳过（未传 --live）。加 --live 将真实调用一次，消耗少量 token。');
  }

  await CLIENT.end();
}

main().catch((e) => {
  console.error('[PROBE FATAL]', e);
  process.exit(1);
});
