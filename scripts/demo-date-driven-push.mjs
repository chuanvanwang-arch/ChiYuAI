// scripts/demo-date-driven-push.mjs
// 需求③ 端到端演示：**日期到点 → 产出信号 → 推送到 消息(inbox)/邮件(email)/IM(im)/Webhook**。
//
// 与生产的同源性（判据⑤：演示路径不得用「形状不同的替身」）：
//   · 扫描器 = 生产同一个 createScheduleScanner（timers.js ⑫ 用的就是它）
//   · 投递泵 = 生产同一个 createDispatcher；registry 与生产**完全一致** `createDeliveryRegistry({})`
//     （timers.js:695 原文），store = createDeliveryStore(pool)，router = createDeliveryRouter({query})
//   · 唯一差异：生产 pumpAllTenants（全体租户、候选集=全量 open signal），
//     本脚本 pumpSignal **逐条**只投本演示租户的种子信号 —— 差异在**范围**，不在**实现**
//     （这一点必须明说：pumpAllTenants 会把既有租户的存量信号一起群发，是红线行为）。
//
// 用法：node scripts/demo-date-driven-push.mjs
import 'dotenv/config';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { createScheduleScanner } from '../src/signal/scheduleScanner.js';
import { createSignalStore } from '../src/signal/store.js';
import { createDispatcher } from '../src/signal/dispatcher.js';
import { createDeliveryRegistry, CHANNEL_IMPL_STATUS } from '../src/signal/delivery/index.js';
import { createDeliveryStore } from '../src/signal/delivery/signalDeliveryStore.js';
import { createDeliveryRouter } from '../src/signal/route.js';
import { buildIcs } from '../src/signal/ics.js';
import { readConfig } from '../src/config/configStore.js';
import { DEMO_TENANT } from './seed-date-driven-demo.mjs';

const SINK_PORT = Number(process.env.DEMO_SINK_PORT || 9099);
const SINK_URL = `http://127.0.0.1:${SINK_PORT}/im-bridge`;
// webhook 渠道的 URL 来源（构造期解析一次）——本演示把它指向本地 sink，
//   用来证明「出站 HTTP 通路」真的通（这就是钉钉/企微桥接器的落点）。
//   ⚠ 刻意只注入给本进程：**不改 .env**，也不重启用户的服务器。
process.env.SIGNAL_WEBHOOK_URL = process.env.SIGNAL_WEBHOOK_URL || SINK_URL;

const pool = new pg.Pool({
  host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b', password: process.env.PGPASSWORD || 'agent2b',
  database: process.env.PGDATABASE || 'crm_native', options: '-c search_path=crm,public',
});
const query = (t, p = []) => pool.query(t, p);

const OUT_DIR = path.join(os.tmpdir(), 'crm-date-driven-demo');
fs.mkdirSync(OUT_DIR, { recursive: true });
const received = [];

function startSink() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { parsed = { _raw: body.slice(0, 200) }; }
        received.push({ at: new Date().toISOString(), path: req.url, signal_id: parsed?.signal_id, kind: parsed?.kind, severity: parsed?.severity, payload: parsed?.payload });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    srv.listen(SINK_PORT, '127.0.0.1', () => resolve(srv));
  });
}

const main = async () => {
  console.log(`\n╔══ 日期驱动端到端演示 ══════════════════════════════════════════`);
  console.log(`║ 库=${process.env.PGDATABASE || 'crm_native'}  租户=${DEMO_TENANT}`);
  console.log(`║ webhook sink=${SINK_URL}（本地 HTTP 收件，模拟 IM 桥）`);
  console.log(`╚════════════════════════════════════════════════════════════════`);

  const sink = await startSink();

  // ── 1. 日期规则扫描（生产同一实现）────────────────────────────────
  console.log('\n【1】日期规则扫描 scanOnce（signal-schedule 配置驱动）');
  const scanner = createScheduleScanner({ query, signalStore: createSignalStore(pool), readConfig });
  const scan = await scanner.scanOnce({ tenantId: DEMO_TENANT });
  console.log(`    扫描粒子 ${scan.scanned} 条 → 新增信号 ${scan.signals} 条（被去重吸收 ${scan.deduped || 0}）`);
  if (scan.missing?.length) console.log(`    ⚠ 数据面缺失归因：${JSON.stringify(scan.missing)}`);

  // ── 2. 取出本次种子产生的信号（按 seed 粒子 slug 定位，范围精确）──
  const { rows: signals } = await query(
    `SELECT s.* FROM crm.signal s
      JOIN crm.particles p ON p.id::text = s.particle_id
     WHERE s.tenant_id = $1 AND s.status = 'open'
       AND p.payload->>'source' = 'demo-seed'
     ORDER BY s.kind`, [DEMO_TENANT]);
  console.log(`\n【2】本次种子产出的 open 信号 = ${signals.length} 条`);
  for (const s of signals) {
    console.log(`    ${String(s.kind).padEnd(24)} sev=${String(s.severity).padEnd(6)} owner=${String(s.owner_id).padEnd(16)} event_at=${s.payload?.event_at || '—'}`);
  }
  if (!signals.length) { console.log('    ✗ 零产出 —— 停止（不得宣称已推送）'); await pool.end(); sink.close(); process.exit(1); }

  // ── 3. 逐条投递（生产泵实现，范围收敛到本演示信号）────────────────
  console.log('\n【3】投递泵 pumpSignal（registry/store/router 与生产 timers.js 同装配）');
  const dispatcher = createDispatcher({
    query,
    deliveryRegistry: createDeliveryRegistry({}),
    deliveryStore: createDeliveryStore(pool),
    router: createDeliveryRouter({ query }),
    readConfig,
  });
  const totals = { sent: 0, failed: 0, skipped: 0, idle: {} };
  for (const signal of signals) {
    const r = await dispatcher.pumpSignal({ signal, tenantId: DEMO_TENANT, now: new Date() });
    totals.sent += r.sent; totals.failed += r.failed; totals.skipped += r.skipped;
    if (r.idleReason) totals.idle[r.idleReason] = (totals.idle[r.idleReason] || 0) + 1;
    console.log(`    ${String(signal.kind).padEnd(24)} → sent=${r.sent} failed=${r.failed} skipped=${r.skipped}${r.idleReason ? ` idle=${r.idleReason}` : ''}`);
  }
  console.log(`    合计 sent=${totals.sent} failed=${totals.failed} skipped=${totals.skipped}${Object.keys(totals.idle).length ? ` idle=${JSON.stringify(totals.idle)}` : ''}`);

  // ── 4. 投递台账（真实 DB 行）──────────────────────────────────────
  console.log('\n【4】crm.signal_delivery 台账（本演示租户）');
  const { rows: ledger } = await query(
    `SELECT channel, status, attempts, recipient, last_error, delivered_at
       FROM crm.signal_delivery WHERE tenant_id=$1 ORDER BY channel, status`, [DEMO_TENANT]);
  for (const r of ledger) {
    console.log(`    ${String(r.channel).padEnd(9)} ${String(r.status).padEnd(8)} try=${r.attempts} to=${String(r.recipient || '—').replace(/^(..).*(@.*)$/, '$1***$2').padEnd(18)} ${r.last_error || (r.delivered_at ? 'delivered@' + new Date(r.delivered_at).toISOString() : '')}`);
  }

  // ── 5. IM 桥收到的消息（webhook 通路的真实 2xx 往返）──────────────
  console.log(`\n【5】本地 IM 桥（${SINK_URL}）实收消息 = ${received.length} 条`);
  for (const m of received) console.log(`    ${m.kind} [${m.severity}] signal=${m.signal_id} subject="${m.payload?.subject || ''}"`);

  // ── 6. 日历载体：把带 event_at 的信号渲染成 .ics 落盘（可导入日历）──
  console.log('\n【6】日历载体 .ics（需求③「同时建立日历」的实体产物）');
  const icsFiles = [];
  for (const s of signals) {
    const ics = buildIcs(s);
    if (!ics) { console.log(`    ${String(s.kind).padEnd(24)} 无 event_at → 不造日程（ics.js 铁律②：缺日期不造幽灵日程）`); continue; }
    const f = path.join(OUT_DIR, `${s.kind}-${s.signal_id}.ics`);
    fs.writeFileSync(f, ics, 'utf8');
    icsFiles.push(f);
    const dt = (ics.match(/DTSTART:(\S+)/) || [])[1];
    console.log(`    ${String(s.kind).padEnd(24)} → ${path.basename(f)}  DTSTART=${dt}`);
  }

  // ── 7. 渠道实现状态（单源表；含 im 的真实处境）───────────────────
  console.log('\n【7】渠道实现状态 CHANNEL_IMPL_STATUS（唯一事实源）');
  for (const [name, st] of Object.entries(CHANNEL_IMPL_STATUS)) {
    console.log(`    ${name.padEnd(9)} implemented=${String(st.implemented).padEnd(5)} needs_credentials=${String(st.needs_credentials).padEnd(5)} ${st.note.slice(0, 52)}…`);
  }

  console.log(`\n【产物目录】${OUT_DIR}`);
  console.log(`【IM 桥日志】${path.join(OUT_DIR, 'im-bridge-received.json')}`);
  fs.writeFileSync(path.join(OUT_DIR, 'im-bridge-received.json'), JSON.stringify(received, null, 2), 'utf8');

  await pool.end();
  sink.close();
  process.exit(0);
};

await main();
