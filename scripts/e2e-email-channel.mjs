// scripts/e2e-email-channel.mjs — email 渠道「真实送达」验证（本地 SMTP sink 接住真实 ESMTP 往返）
//
// 用法：node scripts/e2e-email-channel.mjs
//   前置：dev 库可连；`demo-datadriven` 租户已配 signal-delivery（role_recipients 有 sales 收件人）。
//   产物：台账落 email=sent；本地 sink 实收 `.eml` 落 `%TEMP%/crm-email-e2e/`。
//

// 为什么需要它（根因，2026-09-18 实测）：
//   `crm.signal_delivery` 里 email 渠道**从未有一条 sent**：全库 1w+ 行 email 记录不是
//   `no_recipient`（收件人未配置）就是 `retry_exhausted`；唯一走到 SMTP 的租户 demo-datadriven
//   也因 `.env` 的 `SMTP_PASS` 是占位符（`__REPLACE_WI…`）而落 `Invalid login: 550`。
//   ⇒ 「email 渠道实现是否完整」这件事，此前**没有任何成功样本**可证。
// 本脚本把 SMTP 指向**本地 sink**：既验证 nodemailer 发信链路完整（含 .ics 附件），
//   又不向任何真实邮箱投递（零外发、零骚扰）。
//
// 与生产同装配：createDeliveryRegistry({}) / createDeliveryStore(pool) / createDeliveryRouter({query})
//   与 `src/scheduler/timers.js` 完全一致；唯一差异是进程级 env 覆盖 SMTP_*（不改 .env、不改配置）。
import 'dotenv/config';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pool } from '../src/db.js';
import { createScheduleScanner } from '../src/signal/scheduleScanner.js';
import { createSignalStore } from '../src/signal/store.js';
import { createDispatcher } from '../src/signal/dispatcher.js';
import { createDeliveryRegistry } from '../src/signal/delivery/index.js';
import { createDeliveryStore } from '../src/signal/delivery/signalDeliveryStore.js';
import { createDeliveryRouter } from '../src/signal/route.js';
import { readConfig } from '../src/config/configStore.js';
import { upsertParticleByStableKey } from '../src/particles/mintId.js';

const TENANT = 'demo-datadriven';
// slug 带时间戳 ⇒ 每次运行都产生**新信号**（既有信号的投递幂等键已消费，重跑不会重新外发）。
//   否则首跑之后脚本会因「零新信号」而无法复跑（这本身是幂等生效的正确行为，但不是可复跑的探针）。
//   ⚠ slug 必须**逐次唯一**：分钟级时间戳会让同分钟复跑撞上同一 slug → 信号已投递且状态非 open
//     → 脚本报「零信号/零实收」，看起来像链路坏了（实为幂等生效）。故用毫秒时间戳。
const SLUG = `demo-deal-emailcheck-${Date.now()}`;
const SOURCE = 'email-e2e';

// ── 1. 本地 SMTP sink（真实 ESMTP 会话：EHLO / AUTH LOGIN / MAIL / RCPT / DATA）──
const received = [];
let authStage = 0;
const sink = net.createServer((sock) => {
  let buf = '', inData = false, data = '', from = '', to = [];
  sock.write('220 local-smtp-sink ESMTP\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          received.push({ from, to: [...to], data });   // 收信瞬间快照 to（下一封会重置）
          to = [];
          sock.write('250 2.0.0 Ok: queued as SINK1\r\n');
        }
        else data += line + '\n';
        continue;
      }
      if (authStage === 1) { authStage = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
      if (authStage === 2) { authStage = 0; sock.write('235 2.7.0 Authentication successful\r\n'); continue; }
      const up = line.toUpperCase();
      if (up.startsWith('EHLO') || up.startsWith('HELO')) sock.write('250-local-smtp-sink\r\n250-AUTH LOGIN PLAIN\r\n250-8BITMIME\r\n250 SMTPUTF8\r\n');
      else if (up.startsWith('AUTH LOGIN')) { authStage = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (up.startsWith('AUTH PLAIN')) sock.write('235 2.7.0 Authentication successful\r\n');
      else if (up.startsWith('MAIL FROM')) { from = line.replace(/^MAIL FROM:\s*/i, ''); sock.write('250 2.1.0 Ok\r\n'); }
      else if (up.startsWith('RCPT TO')) { to.push(line.replace(/^RCPT TO:\s*/i, '')); sock.write('250 2.1.5 Ok\r\n'); }
      // ⚠ 不得在 DATA 时清空 to —— RCPT TO 已收集，清空会让「实收邮件」显示无收件人（伪缺陷）
      else if (up.startsWith('DATA')) { inData = true; data = ''; sock.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
      else if (up.startsWith('QUIT')) { sock.write('221 2.0.0 Bye\r\n'); sock.end(); }
      else sock.write('250 2.0.0 Ok\r\n');
    }
  });
  sock.on('error', () => {});
});
await new Promise((r) => sink.listen(0, '127.0.0.1', r));
const SINK_PORT = sink.address().port;
console.log(`【0】本地 SMTP sink 监听 127.0.0.1:${SINK_PORT}（真实 ESMTP 会话；不出网）`);

// ── 2. 进程级 env 覆盖（不改 .env；email.js 在 send() 时读 process.env）──
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(SINK_PORT);
process.env.SMTP_SECURE = 'false';
process.env.SMTP_USER = 'demo-sink';
process.env.SMTP_PASS = 'demo-sink-pass';
process.env.SMTP_FROM = 'crm-demo@chiyu.test';
console.log('[env] SMTP_* → 本地 sink（进程级覆盖，.env 与 config_store 均未改动）');

const query = (s, p) => pool.query(s, p);
const write = (s, p) => pool.query(s, p);

try {
  // ── 3. 造一条**新信号**用粒子（既有 5 条信号的 email 台账均已 retry_exhausted）──
  const d = new Date(Date.now() + 4 * 86400000).toISOString();
  const row = await upsertParticleByStableKey({
    type: 'CRM_DEAL', slug: SLUG, title: '邮件渠道验证-西北化工年度招标',
    payload: {
      name: '邮件渠道验证-西北化工年度招标', stage: 'S3', amount: 200000, owner_id: 'demo_sales01',
      account_name: '西北化工集团', tender_deadline: d, quote_status: 'none',
      last_activity_at: new Date().toISOString(), updated_at: new Date().toISOString(), source: SOURCE,
    },
    tenantId: TENANT,
  }, { write });
  console.log(`\n【1】新粒子 slug=${SLUG} id=${row.id}（tender_deadline=${d.slice(0, 10)}，命中 tender-deadline 规则）`);

  // ── 4. 扫描产信号（生产同一个 scanner）──
  const scanner = createScheduleScanner({ query, signalStore: createSignalStore(pool), readConfig });
  const scan = await scanner.scanOnce({ tenantId: TENANT });
  console.log(`【2】scanOnce → 扫描 ${scan.scanned} 条粒子、新增信号 ${scan.signals} 条（去重吸收 ${scan.deduped || 0}）`);

  // 只投**本次** slug 对应的信号（历次运行留下的同 source 信号不参与，避免输出混入历史）
  const { rows: signals } = await query(
    `SELECT s.* FROM crm.signal s JOIN crm.particles p ON p.id::text = s.particle_id
      WHERE s.tenant_id=$1 AND s.status='open' AND p.payload->>'source'=$2 AND p.slug=$3 ORDER BY s.kind`,
    [TENANT, SOURCE, SLUG]);
  for (const s of signals) console.log(`     ${s.signal_id.slice(0, 8)} kind=${s.kind} sev=${s.severity} role=${s.target_role} event_at=${s.payload?.event_at || '—'}`);
  if (!signals.length) { console.log('✗ 零信号产出，停止'); throw new Error('no_new_signal'); }

  // ── 5. 投递（生产同一个 dispatcher + registry({})）──
  const dispatcher = createDispatcher({
    query, deliveryRegistry: createDeliveryRegistry({}),
    deliveryStore: createDeliveryStore(pool), router: createDeliveryRouter({ query }), readConfig,
  });
  console.log('\n【3】投递泵 pumpSignal（生产同装配）');
  for (const s of signals) {
    const r = await dispatcher.pumpSignal({ signal: s, tenantId: TENANT, now: new Date() });
    console.log(`     ${String(s.kind).padEnd(18)} → sent=${r.sent} failed=${r.failed} skipped=${r.skipped}${r.idleReason ? ` idle=${r.idleReason}` : ''}`);
  }

  // ── 6. 台账（真实 DB 行）──
  console.log('\n【4】crm.signal_delivery 台账（本次信号）');
  const ids = signals.map((s) => s.signal_id);
  const { rows: led } = await query(
    `SELECT channel, status, attempts, recipient, last_error, delivered_at
       FROM crm.signal_delivery WHERE tenant_id=$1 AND signal_id = ANY($2::text[]) ORDER BY channel`, [TENANT, ids]);
  for (const r of led) {
    console.log(`     ${String(r.channel).padEnd(9)} ${String(r.status).padEnd(8)} try=${r.attempts} to=${String(r.recipient || '—').padEnd(20)} ${r.last_error || (r.delivered_at ? 'delivered@' + new Date(r.delivered_at).toISOString() : '')}`);
  }

  // ── 7. SMTP sink 实收（决定性证据）──
  console.log(`\n【5】本地 SMTP sink 实收邮件 = ${received.length} 封`);
  if (!received.length) { console.log('     ✗ 零实收 —— email 链路未打通'); throw new Error('sink_empty'); }
  const outDir = path.join(os.tmpdir(), 'crm-email-e2e');
  fs.mkdirSync(outDir, { recursive: true });
  received.forEach((m, i) => {
    const head = m.data.split('\n').slice(0, 12).join('\n');
    console.log(`     ── 第 ${i + 1} 封 ──`);
    console.log(`     MAIL FROM ${m.from}`);
    console.log(`     RCPT TO   ${m.to.join(', ')}`);
    console.log('     ' + head.replace(/\n/g, '\n     '));
    fs.writeFileSync(path.join(outDir, `mail-${i + 1}.eml`), m.data, 'utf8');
  });
  console.log(`\n     原始邮件落盘：${outDir}`);

  const emailLed = led.find((x) => x.channel === 'email');
  console.log(`\n【结论】email 渠道 = ${emailLed?.status === 'sent' ? '✅ sent（真实 SMTP 往返成功）' : '❌ ' + emailLed?.status}`);
} finally {
  await pool.end();
  sink.close();
}
