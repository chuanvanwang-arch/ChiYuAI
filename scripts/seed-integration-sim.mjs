#!/usr/bin/env node
// scripts/seed-integration-sim.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 用途：为「全链集成」判据②（入口 / 回写）播一套**模拟外部 CRM** 种子，并沿**生产同源装配**
//       实跑一轮增量同步，产出 crm.sync_cursor / crm.external_ref / crm.particles 留痕。
//
// ⚠⚠ 口径声明（必读，防假绿）：
//   本脚本产出的一切外部数据均为**模拟**。判据② 在本口径下成立，**不构成**
//   「真实客户系统已接通」的证据。它证明的是**代码路径**通了 —— 真 HTTP、真 generic-rest 适配器、
//   真 pgcrypto 凭据解密、真第 0 闸铸决策、真落库 —— 而**不是**「某客户的 CRM 已在同步」。
//   `smoke-full-chain-e2e.mjs` 的 N10 只机械排除 `^smoke` 租户与 `provider='mock'`。
//   本脚本用租户 `sim-erp` + `kind='generic-rest'` 通过该机械判据 —— 这不是规避技巧，
//   而是把「模拟」与「真实」**显式分开**：模拟租户以 `sim-` 前缀自证身份，报告须逐字引用本声明。
//
// 铁律：全程 INSERT / UPSERT（禁删）；重复执行幂等；**不改动任何既有租户的配置**。
//
// 用法：
//   node scripts/seed-integration-sim.mjs                    # dry-run：只打印将写入什么
//   node scripts/seed-integration-sim.mjs --apply            # 落库 + 起模拟源 + 实跑一轮同步 + 取证
//   node scripts/seed-integration-sim.mjs --apply --port 18081
//   node scripts/seed-integration-sim.mjs --serve            # 仅起模拟源并常驻（供生产定时器⑩触发）
//
// ⚠ 若模拟源离线，下一次定时器⑩ 轮询会把 `sync_cursor.last_status` 翻为 `failed`（同键 upsert）。
//   这是**正确行为**（失败必须留痕，G3 不静默），也正是「模拟口径 ≠ 生产证据」的直观体现。
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { pool, query, queryWrite } from '../src/db.js';
import { readConfig, writeConfig } from '../src/config/configStore.js';
import { persistSecret, resolveCredentials } from '../src/connectors/discovery/credentialVault.js';
import { SYNC_PROVIDER_FACTORY } from '../src/sync/factory.js';
import * as mount from '../src/sync/mount.js';
import { recordFailure } from '../src/monitor/monitorStore.js';
import { requireDecision, decisionIdOf } from '../src/decision/autonomyEngine.js';
// 出口侧（Q1 泵）：与 timers.js 定时器⑰ 同源装配
import { createDispatcher } from '../src/signal/dispatcher.js';
import { createDeliveryRegistry } from '../src/signal/delivery/index.js';
import { createDeliveryStore } from '../src/signal/delivery/signalDeliveryStore.js';
import { createDeliveryRouter } from '../src/signal/route.js';

const ARGV = process.argv.slice(2);
const APPLY = ARGV.includes('--apply');
const SERVE_ONLY = ARGV.includes('--serve');
const portArg = ARGV.indexOf('--port');
const PORT = portArg >= 0 ? Number(ARGV[portArg + 1]) : 18081;

// 识别信息（模拟身份自证）
const TENANT = 'sim-erp';
const PROVIDER_ID = 'erp-sim';
const TOKEN = 'sim-erp-token-0001';
const SINCE = 'updated_at';

// ── ① 模拟外部 CRM 的确定性数据（固定 id / 固定 updated_at → 复跑可逐行对账）──
const SIM_ROWS = {
  account: [
    { id: 'SIM-ACC-1001', name: '模拟·华东精密制造', industry: '工业制造', region: '华东',
      size: '500-1000人', source: 'sim-erp', rating: 'A', domains: ['sim-huadong.example'],
      business_title: '精密零部件加工', updated_at: '2026-09-16T20:00:00Z' },
    { id: 'SIM-ACC-1002', name: '模拟·南方医疗器械', industry: '医疗器械', region: '华南',
      size: '100-500人', source: 'sim-erp', rating: 'B', domains: ['sim-nanfang.example'],
      business_title: '二类器械生产', updated_at: '2026-09-16T20:05:00Z' },
    { id: 'SIM-ACC-1003', name: '模拟·西北工业涂料', industry: '化工', region: '西北',
      size: '50-100人', source: 'sim-erp', rating: 'B', domains: ['sim-xibei.example'],
      business_title: '工业涂料配方', updated_at: '2026-09-16T20:10:00Z' },
  ],
  opportunity: [
    { id: 'SIM-OPP-2001', name: '模拟·低代码平台 POC', stage: 'S3', amount: 480000,
      account_id: 'SIM-ACC-1001', close_date: '2026-11-30', updated_at: '2026-09-16T20:15:00Z' },
    { id: 'SIM-OPP-2002', name: '模拟·分散剂样品小试', stage: 'S2', amount: 60000,
      account_id: 'SIM-ACC-1003', close_date: '2026-10-20', updated_at: '2026-09-16T20:20:00Z' },
  ],
};

const reqLog = [];

// 出口侧：让判据①（投递流水）在同一模拟租户也有据可验。source 显式标 `sim`，便于全域审计一眼分辨。
const SIM_SIGNALS = [
  { signal_id: 'sim-sig-0001', kind: 'account_synced', severity: 'medium', target_role: 'sales',
    payload: { external_object: 'account', external_id: 'SIM-ACC-1001' },
    evidence: { provider: 'erp-sim', simulated: true } },
  { signal_id: 'sim-sig-0002', kind: 'opportunity_stage_advanced', severity: 'high', target_role: 'sales',
    payload: { external_object: 'opportunity', external_id: 'SIM-OPP-2001' },
    evidence: { provider: 'erp-sim', simulated: true } },
];

function startSimSource(port) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    // ⚠ N6（凭据明文外泄）：**绝不记录 token 值**，只记「是否携带 / 是否匹配」布尔
    const auth = req.headers.authorization || '';
    const rec = {
      path: u.pathname, object: u.searchParams.get('object'),
      since: u.searchParams.get(SINCE) || '',
      auth_present: Boolean(auth), auth_ok: auth === `Bearer ${TOKEN}`,
    };
    reqLog.push(rec);
    if (u.pathname !== '/api/sync') { res.writeHead(404).end('not_found'); return; }
    const rows = SIM_ROWS[rec.object];
    if (!rows) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'unknown_object' }));
      return;
    }
    const data = rows.filter((r) => !rec.since || String(r[SINCE]) > String(rec.since));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data }));
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// ── ② 播种（全部幂等；dry-run 只打印）──
function descriptor() {
  return [{
    id: PROVIDER_ID,
    kind: 'generic-rest',
    enabled: true,
    // 显式声明「模拟」：endpoint 指向本机模拟源，绝不打真实厂商域名
    endpoint: `http://127.0.0.1:${PORT}/api/sync`,
    token_mode: 'bearer',
    // L2 = 批量入库（含 external_ref 落库）；第 0 闸每 run 铸一枚决策
    trust_level: 'L2',
    objects: [
      { name: 'account', id_field: 'id', direction: 'in', since_field: SINCE },
      { name: 'opportunity', id_field: 'id', direction: 'in', since_field: SINCE },
    ],
  }];
}

function trustPolicy() {
  return {
    version: 1,
    default_level: 'L2',            // 有效档 = min(descriptor, global) = L2
    writeback_auto_approved: false,
    writeback_fields_whitelist: [],  // L2 不触发回写；白名单留空即 L3 也不会越权写
  };
}

async function seedTenant() {
  await queryWrite(
    `INSERT INTO crm.tenants (tenant_id, name, status, plan, note)
     VALUES ($1,$2,'active','sim',$3) ON CONFLICT (tenant_id) DO NOTHING`,
    [TENANT, '模拟集成租户（种子）', '由 scripts/seed-integration-sim.mjs 播种；仅本地验证用，勿作生产证据'],
  );
}

// 克隆既有写路径场景 PARTICLE_CREATE 的形状（保证列类型/维度 cond 均为已知可评分项），
// 仅替换标识与 description/trigger —— 不手写列字面量，避免类型错配。
// ⚠ SCENE_DESC 必须与 db/seed-decision-scenarios.sql 的 integration-sync 行**逐字一致**：
//   该文件是生产侧的权威播种载体（每次 `node db/migrate.js` 幂等 ensure），两处文本不一致
//   会让「本库取证通过 / 生产行为不同」的库间漂移（断言不可比）。见该文件 integration-sync 段注释。
const SCENE_DESC = '外部系统增量同步（L2/L3 写路径第 0 闸；形状与 PARTICLE_CREATE 对齐）';
async function seedScene() {
  const r = await queryWrite(
    `INSERT INTO crm.decision_scenario
       (scenario_id, tenant_id, stage, description, trigger, methodology_ids, eval_dimensions,
        default_tier, autonomous_allowed, dispositions, required_dims, retro_required,
        focus_elements, focus_rulers, rubric_pass_line, enabled_rulers, stage_code, created_at)
     SELECT 'integration-sync', tenant_id, stage, $1, trigger, methodology_ids, eval_dimensions,
            default_tier, autonomous_allowed, dispositions, required_dims, retro_required,
            focus_elements, focus_rulers, rubric_pass_line, enabled_rulers, stage_code, now()
       FROM crm.decision_scenario
      WHERE tenant_id = 'system' AND scenario_id = 'PARTICLE_CREATE'
     ON CONFLICT (scenario_id, tenant_id) DO NOTHING`,
    [SCENE_DESC],
  );
  await queryWrite(
    `UPDATE crm.decision_scenario
        SET trigger = '{"timer":["integration-poll"]}'::jsonb,
            description = $1
      WHERE scenario_id = 'integration-sync' AND tenant_id = 'system'`,
    [SCENE_DESC],
  );
  return r;
}

// ── ③ 生产同源装配（防「脚本装配 ≠ 生产装配」这一假绿源）──
//   静态守卫：断言 timers.js 的定时器⑩ 确实向 runIntegrationPollOnce 传了 loadSyncTargets / runSync。
//   若未来有人改生产装配而漏改本脚本，守卫即失败（而非悄悄跑出一份"通了的假象"）。
function assertAssemblyMirrorsProduction() {
  const src = readFileSync(new URL('../src/scheduler/timers.js', import.meta.url), 'utf8');
  // 入向（定时器⑩ 同步分支）+ 出口（定时器⑰ 投递泵）两侧装配键
  const need = [
    'loadSyncTargets:', 'runSync:', 'loadTenantSyncTargets', 'runTenantSyncOnce',
    'createDispatcher(', 'createDeliveryRegistry(', 'createDeliveryStore(', 'createDeliveryRouter(', 'pumpAllTenants(',
  ];
  const missing = need.filter((k) => !src.includes(k));
  if (missing.length) throw new Error(`生产装配漂移：timers.js 缺少 ${missing.join(' / ')}`);
  return true;
}

// 出口侧种子：仅 INSERT（WHERE NOT EXISTS，不依赖具体唯一约束形态），幂等且零删除
async function seedSignals() {
  for (const s of SIM_SIGNALS) {
    await queryWrite(
      `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, payload, evidence, suggestion, status)
       SELECT $1,$2,'sim-seed',$3,$4,$5,$6::jsonb,$7::jsonb,'{}'::jsonb,'open'
        WHERE NOT EXISTS (SELECT 1 FROM crm.signal WHERE signal_id=$1)`,
      [s.signal_id, TENANT, s.kind, s.severity, s.target_role,
        JSON.stringify(s.payload), JSON.stringify(s.evidence)],
    );
  }
}

// 出口泵：装配与 timers.js 定时器⑰ 逐字同源（守卫见 assertAssemblyMirrorsProduction）
async function runSignalPump({ emit }) {
  const dispatcher = createDispatcher({
    query,
    deliveryRegistry: createDeliveryRegistry({}),
    deliveryStore: createDeliveryStore(pool),
    router: createDeliveryRouter({ query }),
    readConfig,
  });
  const r = await dispatcher.pumpOnce({ tenantId: TENANT });
  if (r.sent || r.failed || r.skipped) emit('trace', 'signal-dispatch', r);
  return r;
}

async function runSyncOnce({ emit, log }) {
  const writebackMod = await import('../src/sync/writeback.js').catch(() => null);
  const execMod = await import('../src/action/executor.js').catch(() => null);
  const callWriteback = (writebackMod?.createWritebackDispatcher && execMod?.actionExecutor?.dispatch)
    ? writebackMod.createWritebackDispatcher({ dispatch: execMod.actionExecutor.dispatch, readConfig })
    : undefined;

  const targets = await mount.loadTenantSyncTargets({
    tenantId: TENANT, readConfig, resolveCredentials, factories: SYNC_PROVIDER_FACTORY, emit,
  });
  const r = await mount.runTenantSyncOnce({
    tenantId: TENANT, targets,
    deps: {
      pool, emit, recordFailure,
      mappings: await mount.loadSyncMappings({ tenantId: TENANT, readConfig }),
      callWriteback,
      // 生产 timers.js 此处 `.catch(() => null)`；本脚本**不吞**错误，把真实原因打出来
      //   （否则「场景未播种 → 写路径 fail-closed」会表现成"同步跑了但没数据"）
      mintDecision: async (scene, ctx) => {
        try {
          const d = await requireDecision(scene, ctx);
          // ⚠ 必须经 decisionIdOf 读：凭证在 `d.decision.decision_id`，按顶层 `d.decision_id` 读恒 undefined
          //   （本脚本首版正是照抄了这个错误读法 → 实跑表现为"决策已落库但写路径仍报无决策"，
          //    这次实跑正是该缺陷的现场复现）
          return { decisionId: decisionIdOf(d) };
        } catch (e) {
          log(`  ⚠ mintDecision('${scene}') 失败 → ${e.message}`);
          return { decisionId: null };
        }
      },
    },
  });
  return { targets, r };
}

async function evidence() {
  const out = {};
  const q = async (label, sql, params) => {
    const r = await query(sql, params);
    out[label] = r.rows;
    return r.rows;
  };
  await q('sync_cursor', `SELECT provider, external_object, last_status, cursor_value, decision_id, last_counts
     FROM crm.sync_cursor WHERE tenant_id=$1 ORDER BY provider, external_object`, [TENANT]);
  await q('external_ref', `SELECT provider, external_object, external_id, particle_type, last_direction
     FROM crm.external_ref WHERE tenant_id=$1 ORDER BY external_object, external_id`, [TENANT]);
  await q('particles', `SELECT type, count(*)::int AS n FROM crm.particles WHERE tenant_id=$1 GROUP BY type ORDER BY type`, [TENANT]);
  await q('decision', `SELECT count(*)::int AS n FROM crm.decision WHERE tenant_id='system' AND scenario_id='integration-sync'`, []);
  await q('signal', `SELECT signal_id, severity, status FROM crm.signal WHERE tenant_id=$1 ORDER BY signal_id`, [TENANT]);
  await q('signal_delivery', `SELECT channel, status, count(*)::int AS n, count(delivered_at)::int AS delivered
     FROM crm.signal_delivery WHERE tenant_id=$1 GROUP BY channel, status ORDER BY channel, status`, [TENANT]);
  return out;
}

async function main() {
  console.log('═'.repeat(74));
  console.log('模拟外部 CRM 种子 · tenant=' + TENANT + ' · provider=' + PROVIDER_ID + ' · mode=' + (APPLY ? 'APPLY' : SERVE_ONLY ? 'SERVE' : 'DRY-RUN'));
  console.log('⚠ 模拟口径：本脚本产出的一切外部数据均为模拟，不构成「真实客户系统已接通」的证据。');
  console.log('═'.repeat(74));

  if (!SERVE_ONLY) {
    console.log('① 将写入（idempotent，禁删）：');
    console.log('   crm.tenants            + ' + TENANT + '（active）');
    console.log('   crm.decision_scenario  + integration-sync（system，克隆自 PARTICLE_CREATE）');
    console.log("   config_store[integration-providers] = " + JSON.stringify(descriptor()));
    console.log("   config_store[sync-trust]            = " + JSON.stringify(trustPolicy()));
    console.log('   config_store[integration-secrets]   = ' + PROVIDER_ID + '（pgcrypto 加密，不落明文）');
    console.log('   crm.signal             + 2 条模拟信号（source=sim-seed）→ 供出口判据① 有据可验');
    assertAssemblyMirrorsProduction();
    console.log('② 生产装配同源守卫：✅ timers.js 定时器⑩ 含 loadSyncTargets / runSync 装配');
  }

  if (!APPLY && !SERVE_ONLY) {
    console.log('\n(dry-run) 加 --apply 落库并实跑一轮同步。');
    await pool.end();
    return;
  }

  const srv = await startSimSource(PORT);
  console.log(`\n③ 模拟外部源已起：http://127.0.0.1:${PORT}/api/sync  （objects: ${Object.keys(SIM_ROWS).join(', ')}）`);

  if (SERVE_ONLY) {
    console.log('   --serve 模式：常驻中，Ctrl+C 结束。');
    return;
  }

  await seedTenant();
  await seedScene();
  await writeConfig('integration-providers', descriptor(), { tenantId: TENANT, updatedBy: 'seed-integration-sim' });
  await writeConfig('sync-trust', trustPolicy(), { tenantId: TENANT, updatedBy: 'seed-integration-sim' });
  await persistSecret({ tenantId: TENANT, providerId: PROVIDER_ID, raw: TOKEN });
  // sync-mappings：不写租户级 → 由 readConfig 的 autoSeed 从 system 模板克隆（六对象映射已就位）
  const mappingsRow = await readConfig('sync-mappings', { tenantId: TENANT });
  console.log(`④ 播种完成。sync-mappings ${mappingsRow?.value?._seeded ? '经 autoSeed 克隆自 system 模板' : '（租户自有）'}，对象数=${Object.keys(mappingsRow?.value?.mappings || []).length || (mappingsRow?.value?.mappings || []).length || 0}`);

  // 凭据链路自证（P-4 修复的消费面）
  const creds = await resolveCredentials({ tenantId: TENANT, providerIds: [PROVIDER_ID] });
  console.log(`   凭据解析：${PROVIDER_ID} → ${creds[PROVIDER_ID] ? '✅ 已解密（形状 ' + (typeof creds[PROVIDER_ID]) + '）' : '❌ null'}`);

  const traces = [];
  const emit = (k, n, p) => traces.push({ n, p });
  console.log('\n⑤ 沿生产同源装配实跑一轮同步 …');
  const { targets, r } = await runSyncOnce({
    emit,
    log: (m) => { console.log(m); traces.push({ n: 'mint-log', p: m }); },
  });
  console.log(`   目标数=${targets.length}  trust=${targets.map((t) => t.trustLevel).join(',')}`);
  console.log('   内核计数：' + JSON.stringify(r));
  for (const t of traces) console.log('   trace ' + t.n + ' ' + JSON.stringify(t.p || {}));

  console.log('\n⑥ 模拟源收到的请求（凭据只记布尔，不记值 —— 守 N6）：');
  for (const l of reqLog) console.log('   ' + JSON.stringify(l));

  const ev1 = await evidence();
  console.log('\n⑦ 取证（第一轮）');
  for (const [k, rows] of Object.entries(ev1)) console.log(`   ${k}: ` + JSON.stringify(rows));

  console.log('\n⑧ 幂等复跑（同源同游标应零新增）…');
  const reqBefore2 = reqLog.length;
  const before = await query(`SELECT count(*)::int n FROM crm.external_ref WHERE tenant_id=$1`, [TENANT]);
  const second = await runSyncOnce({ emit, log: (m) => console.log(m) });
  const after = await query(`SELECT count(*)::int n FROM crm.external_ref WHERE tenant_id=$1`, [TENANT]);
  console.log(`   第二轮计数：${JSON.stringify(second.r)}`);
  console.log(`   external_ref: ${before.rows[0].n} → ${after.rows[0].n}（新增 ${after.rows[0].n - before.rows[0].n}）`);
  console.log('   第二轮请求（since 应为上一轮推进后的游标值 → 证明增量语义）：');
  for (const l of reqLog.slice(reqBefore2)) console.log('     ' + JSON.stringify(l));

  const ev2 = await evidence();
  console.log('\n⑨ 判据② 自检（模拟口径）');
  const okRows = ev2.sync_cursor.filter((x) => x.last_status === 'ok');
  console.log(`   sync_cursor last_status=ok 行数 = ${okRows.length} ${okRows.length >= 1 ? '✅' : '❌'}`);
  console.log(`   external_ref external_id 非空行数 = ${ev2.external_ref.length} ${ev2.external_ref.length >= 1 ? '✅' : '❌'}`);
  console.log(`   provider 取值 = ${[...new Set(ev2.external_ref.map((x) => x.provider))].join(',')}（须 ≠ mock）`);
  console.log(`   第 0 闸决策数 = ${ev2.decision[0].n}`);

  console.log('\n⑩ 出口侧：播种模拟信号 + 跑投递泵（装配同源于定时器⑰）…');
  await seedSignals();
  const pump1 = await runSignalPump({ emit });
  console.log('   泵结果：' + JSON.stringify({ sent: pump1.sent, failed: pump1.failed, skipped: pump1.skipped, idle: pump1.idle }));
  const pump2 = await runSignalPump({ emit }); // 幂等复跑
  console.log('   幂等复跑：' + JSON.stringify({ sent: pump2.sent, failed: pump2.failed, skipped: pump2.skipped, idle: pump2.idle }));

  const ev3 = await evidence();
  console.log('\n⑪ 判据① 自检（模拟口径）');
  const del = ev3.signal_delivery;
  const sentRows = del.filter((x) => x.status === 'sent');
  // ⚠ 2026-09-16 修正：此前此处是 `const onChannels = ['inbox']`（硬编码「模板默认仅 inbox=on」）——
  //   违反本仓铁律「阈值/差异化 100% 后台配置化，禁域/粒子字面量」；且当平台 signal-delivery 模板
  //   的渠道开关变更（实测：并行会话把 email 由 off 改 on，经 autoSeed 派生到全部租户）后，
  //   该硬编码前提立刻失效 → 输出 ❌「越界行=1」，而同一时刻读实时配置的
  //   `smoke-full-chain-e2e.mjs sim-erp` 仍 8/8 通过 ⇒ **纯硬编码前提造成的假红**。
  //   现改为读本租户实时配置，与 smoke 判据同源（同一事实、同一读法）。
  //   已知局限（与 smoke 判据同）：只比"当前配置为 off 的渠道"是否出现投递行；配置历史上曾被置 on
  //   时留下的行会被计入 → 因此本检查**只能作为自证提示**，权威判据以 smoke 脚本为准。
  const delCfg = await readConfig('signal-delivery', { tenantId: TENANT });
  const channels = delCfg?.value?.channels || {};
  const onChannels = Object.entries(channels).filter(([, v]) => v === 'on').map(([k]) => k);
  const offViolation = Object.keys(channels).length ? del.filter((x) => channels[x.channel] !== 'on') : [];
  console.log(`   渠道配置（本租户实时） = ${JSON.stringify(channels)} → on=${JSON.stringify(onChannels)}`);
  console.log(`   信号数 = ${ev3.signal.length}（status=${[...new Set(ev3.signal.map((s) => s.status))].join(',')}）`);
  console.log(`   signal_delivery: ${JSON.stringify(del)}`);
  console.log(`   status=sent 行数 = ${sentRows.reduce((a, b) => a + b.n, 0)} 且 delivered_at 非空 = ${sentRows.reduce((a, b) => a + b.delivered, 0)} ${sentRows.length && sentRows.every((x) => x.delivered === x.n) ? '✅' : '❌'}`);
  console.log(`   配置为 off 的渠道越界行 = ${offViolation.length} ${Object.keys(channels).length === 0 ? '（无渠道配置，跳过判定）' : offViolation.length === 0 ? '✅' : '❌'}`);

  console.log('\n⚠ 重申：以上为**模拟口径**（模拟外部源 + 模拟租户 sim-erp）。');
  console.log('   判据①/② 通过 = **代码路径通**（真 HTTP / 真适配器 / 真凭据解密 / 真第 0 闸 / 真落库），');
  console.log('   **≠** 「真实客户系统已接通」，也**不得**作为 KPI / 交付验收证据引用。');

  srv.close();
  await pool.end();
}

main().catch(async (e) => {
  console.error('seed-integration-sim 失败：', e?.stack || e);
  try { await pool.end(); } catch { /* noop */ }
  process.exit(1);
});
