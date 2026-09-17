// scripts/smoke-full-chain-e2e.mjs — 全链集成端到端取证（Q4-1）
// 判据来源：docs/2026-09-16-full-chain-integration-design.md §5.1（正向）+ §5.2（负向 N1–N9）
// 运行：node scripts/smoke-full-chain-e2e.mjs <tenantId>   （tenantId 缺省 system）
// 纪律：只读 + 只跑闸门判定（不 DELETE、不迁移状态、不写配置）；输出逐条判据的 PASS/FAIL，任一 FAIL → exit 1。
//
// ⚠ 常态说明：本脚本在「出口未接通」（生产 `crm.signal_delivery` 零行 / `signal-delivery` 未配置）时
//   **必然 FAIL 判据①与判据②** —— 这是设计 §1.4「Q3 回写与自治【存在但关闭】」的**预期状态**，
//   不是缺陷。它存在的意义是：把「链路是否真的通了」变成可复跑的机检，而不是靠人叙述。
import { query, pool } from '../src/db.js';
import { createExportGate } from '../src/sync/exportGate.js';
import { detectNegativePredicates } from '../src/monitor/signalMetrics.js';

const tenantId = process.argv[2] || 'system';
const since = new Date(Date.now() - 24 * 3600 * 1000);
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

console.log(`\n=== 全链集成端到端取证 · tenant=${tenantId} · since=${since.toISOString()} ===\n`);

// ── 判据 ①（出口，设计 §5.1）：窗口内存在 status='sent' 行；配置 off 的渠道零行 ──
const { rows: [d] } = await query(
  `SELECT COUNT(*) FILTER (WHERE status='sent' AND delivered_at IS NOT NULL) AS sent_delivered,
          COUNT(*) FILTER (WHERE status='sent') AS sent
     FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2`,
  [tenantId, since]
);
check('判据① 存在 status=sent 且 delivered_at 非空的投递行', Number(d.sent_delivered) > 0, `sent=${d.sent} sent_delivered=${d.sent_delivered}`);

const { rows: chRows } = await query(
  `SELECT DISTINCT channel FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2`,
  [tenantId, since]
);
const { rows: [cfgRow] } = await query(
  `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='signal-delivery'`,
  [tenantId]
);
const channels = (cfgRow?.value?.channels) || {};
const offChannels = Object.entries(channels).filter(([, v]) => v === 'off' || v === false).map(([k]) => k);
const offending = chRows.map(r => r.channel).filter(c => offChannels.includes(c));
check('判据① 配置为 off 的渠道零投递行', offending.length === 0,
  `配置渠道=${JSON.stringify(channels)} 越界渠道=${offending.join(',') || '（无）'}`);

// ── 判据 ②（入口/回写，设计 §5.1）──
const { rows: [sc] } = await query(`SELECT COUNT(*) AS c FROM crm.sync_cursor WHERE tenant_id=$1 AND last_status='ok'`, [tenantId]);
const { rows: [er] } = await query(`SELECT COUNT(*) AS c FROM crm.external_ref WHERE tenant_id=$1 AND external_id IS NOT NULL`, [tenantId]);
check('判据② crm.sync_cursor 存在 last_status=ok 行', Number(sc.c) >= 1, `count=${sc.c}`);
check('判据② crm.external_ref 存在真实外部 ID 行', Number(er.c) >= 1, `count=${er.c}`);

// ── 负向判据 N10（E1，2026-09-16 取证新增）：判据② 不得由 smoke/mock 自证 ──
//   理由：全域取证发现 sync_cursor/external_ref 全部行归属 smoke-* 租户，唯一 ok 行 provider='mock'。
//   不限定的后果 = smoke 脚本把自己的测试数据当作生产证据（「判据由被测方提供证据」的变体）。
const isSmokeTenant = /^smoke/i.test(tenantId);
const { rows: [mockOk] } = await query(
  `SELECT COUNT(*) AS c FROM crm.sync_cursor WHERE tenant_id=$1 AND last_status='ok' AND provider='mock'`,
  [tenantId]
);
check('N10 判据② 不得由 smoke/mock 自证',
  !isSmokeTenant && Number(mockOk.c) === 0,
  isSmokeTenant ? `租户名形如 smoke*（本次运行不构成生产证据）` : `mock_ok=${mockOk.c}`);

// ── 负向判据 N1 / N1b（防假绿：配置 on 的渠道的健康度）──
//   F-6(a)（2026-09-16 实测修正）：判据 A 已分两级——
//     `delivery_silent`      = 渠道 on 且窗口内**零行**（真静默：连失败原因都没有）→ 参与 exportGate 判据③；
//     `delivery_undelivered` = 渠道 on、有尝试但**零 sent**（`no_recipient` 等有明确留痕）→ **不**参与闸门。
//   N1 断言前者（原语义不变）；N1b 断言后者**从未被漏报**——修正前该形态被完全沉默（属漏报）。
const alerts = await detectNegativePredicates({ tenantId, since });
const silentAlerts = alerts.filter(a => a.type === 'delivery_silent');
const undelivAlerts = alerts.filter(a => a.type === 'delivery_undelivered');
check('N1 无 delivery_silent（配置 on 的渠道无「零行」真静默）',
  silentAlerts.length === 0,
  JSON.stringify(silentAlerts));

// N1b：用**独立查询**复算期望集合（不得直接采信 detectNegativePredicates 的自述——
//   判据必须独立于被测物，否则"判据自证"是本仓已登记的自指仪器反模式）。
const onChannels = Object.entries(channels).filter(([, v]) => v === 'on' || v === true).map(([k]) => k);
const { rows: zeroSentRows } = await query(
  `SELECT channel, COUNT(*)::int AS attempted
     FROM crm.signal_delivery
    WHERE tenant_id=$1 AND created_at >= $2
    GROUP BY channel
   HAVING COUNT(*) FILTER (WHERE status='sent') = 0`,
  [tenantId, since]
);
const expectUndeliv = zeroSentRows
  .filter(r => onChannels.includes(r.channel) && Number(r.attempted) > 0)
  .map(r => r.channel).sort();
const gotUndeliv = undelivAlerts.map(a => a.channel).sort();
check('N1b 零 sent 但**有尝试**的 on 渠道必报 delivery_undelivered（F-6(a)：修正前完全漏报）',
  JSON.stringify(expectUndeliv) === JSON.stringify(gotUndeliv),
  `期望=${JSON.stringify(expectUndeliv)} 实得=${JSON.stringify(gotUndeliv)} 明细=${JSON.stringify(undelivAlerts)}`);

// ── 负向判据 N2/N3（不静默纪律：失败/跳过必带原因；成功不得携带原因）──
//   注：原计划此处为 `check(..., true, ...)`（恒真锚点）——已改为**真实不变量**，
//   否则该条目永远 PASS，属于本项目已登记反模式「恒真断言」。
const { rows: [silent] } = await query(
  `SELECT COUNT(*) FILTER (WHERE status IN ('failed','skipped') AND last_error IS NULL) AS no_reason,
          COUNT(*) FILTER (WHERE status='sent' AND last_error IS NOT NULL)          AS sent_with_error,
          COUNT(*) FILTER (WHERE last_error='no_recipient')                        AS no_recipient
     FROM crm.signal_delivery WHERE tenant_id=$1 AND created_at >= $2`,
  [tenantId, since]
);
check('N2/N3 failed/skipped 必带 last_error 且 sent 不带 error（不静默）',
  Number(silent.no_reason) === 0 && Number(silent.sent_with_error) === 0,
  `no_reason=${silent.no_reason} sent_with_error=${silent.sent_with_error} no_recipient=${silent.no_recipient}`);

// ── 负向判据 N4：exportGate 在判据①不成立时不得返回 healthy ──
const gate = createExportGate();
const g = await gate.isExportHealthy({ tenantId });
check('N4 exportGate 与判据①一致（无 sent 行则 not healthy）',
  !(Number(d.sent) === 0 && g.healthy === true),
  `healthy=${g.healthy} reason=${g.reason} checks=${JSON.stringify(g.checks)}`);

// ── 汇总 ──
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 判据通过（tenant=${tenantId}）`);
if (failed.length) console.log(`未通过：${failed.map(f => f.name).join(' | ')}`);
await pool.end();
process.exit(failed.length ? 1 : 0);
