// scripts/smoke-line-a-mount.mjs — 线A 挂载点端到端冒烟（真库 crm_native）
// 计划：docs/superpowers/plans/2026-09-16-line-a-mount-points.md §Task 6
// 链路：config_store 描述符（stub）→ loadTenantSyncTargets → runTenantSyncOnce → 同步内核
//       → resolver（真库 crm.external_ref / crm.particles）→ cursor（真库 crm.sync_cursor）
// 断言：
//   ① L1（global=L1，descriptor 声明 L3）→ 有效档被钳到 L1，**零写入**（external_ref/particles 行数不变）
//   ② L2 → 写入生效（external_ref +N、particles +N）且 cursor.decision_id 落第 0 闸锚点
//   ③ 二次同游标 → created=0（幂等，不重复建粒子）
// 运行：node scripts/smoke-line-a-mount.mjs
import pg from 'pg';
import { loadTenantSyncTargets, runTenantSyncOnce } from '../src/sync/mount.js';
import { createCursorStore } from '../src/sync/cursor.js';

// ⚠ 每次运行唯一租户：固定租户名会让二次运行命中前次粒子 → created 变 updated → 断言假红（非接线缺陷）。
const TENANT = `smoke-line-a-${process.pid.toString(36)}${Date.now().toString(36)}`;
const DECISION = '00000000-0000-4000-8000-000000000001'; // sync_cursor.decision_id 为 UUID 列
const OBJECTS = ['AccountObj', 'ContactObj'];

const pool = new pg.Pool({
  database: process.env.PGDATABASE || 'crm_native',
  host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b',
});
await pool.query('SET search_path TO crm,public');

const data = {
  AccountObj: [
    { _id: 'la-1', name: '线A客户1', industry: '制造' },
    { _id: 'la-2', name: '线A客户2', industry: '化工' },
  ],
  ContactObj: [
    { _id: 'la-c1', name: '线A联系人1', title: '采购经理' },
    { _id: 'la-c2', name: '线A联系人2', title: '技术总监' },
  ],
};

// 设计形状（§9.1）映射：验证 normalizeSyncMappings 能直落设计形状
const mappingRaw = {
  version: 1,
  mappings: [
    {
      object: 'AccountObj', particle_type: 'CRM_ACCOUNT', direction: 'in',
      identity: { external_id_field: '_id', since_field: 'last_modified_time' },
      fields: [{ external: 'name', particle: 'name' }, { external: 'industry', particle: 'industry' }],
    },
    {
      object: 'ContactObj', particle_type: 'CRM_CONTACT', direction: 'in',
      identity: { external_id_field: '_id', since_field: 'last_modified_time' },
      fields: [{ external: 'name', particle: 'name' }, { external: 'title', particle: 'title' }],
    },
  ],
};

const provider = {
  kind: 'mock',
  verifyAuth: async () => ({ ok: true }),
  discoverObjects: async () => ({ ok: true, objects: OBJECTS.map((name) => ({ name })) }),
  readIncremental: async ({ object, cursor }) => (
    cursor ? { ok: true, rows: [], cursor } : { ok: true, rows: data[object] || [], cursor: `c-${object}` }
  ),
};

const readConfigWith = (globalLevel) => async (key) => {
  if (key === 'integration-providers') {
    return {
      value: [{
        id: 'smoke-la-1', kind: 'mock', enabled: true,
        trust_level: 'L3', // 声明 L3 → 验证被 global 钳制（无自动提权）
        objects: OBJECTS.map((name) => ({ name, direction: 'in', cadence_min: 30, mapping_ref: name })),
      }],
    };
  }
  if (key === 'sync-trust') return { value: { default_level: globalLevel } };
  if (key === 'sync-mappings') return { value: mappingRaw };
  return null;
};

const factories = { mock: () => provider };
const cursorStore = createCursorStore(pool);
const counts = [];
const logs = [];

async function resetCursors() {
  for (const o of OBJECTS) {
    await cursorStore.set({ tenantId: TENANT, provider: 'mock', object: o, cursor: null, counts: {}, status: 'idle' });
  }
}
async function snap() {
  const refs = await pool.query(`SELECT count(*)::int n FROM crm.external_ref WHERE tenant_id=$1`, [TENANT]);
  const parts = await pool.query(`SELECT count(*)::int n FROM crm.particles WHERE tenant_id=$1`, [TENANT]);
  return { refs: refs.rows[0].n, parts: parts.rows[0].n };
}
const emit = (kind, name, payload) => { logs.push({ name, payload }); };
const recordFailure = (name, err) => { logs.push({ name, payload: { error: String(err?.message || err) } }); };

// ── ① L1（global=L1）→ 有效档 L1，零写入 ──
await resetCursors();
const before1 = await snap();
const t1 = await loadTenantSyncTargets({ tenantId: TENANT, readConfig: readConfigWith('L1'), factories });
const r1 = await runTenantSyncOnce({ tenantId: TENANT, targets: t1, deps: { pool, mappings: (await import('../src/sync/mount.js')).normalizeSyncMappings(mappingRaw), emit, recordFailure } });
const after1 = await snap();
const cur1 = await cursorStore.get({ tenantId: TENANT, provider: 'mock', object: 'AccountObj' });
const ok1 = t1[0]?.trustLevel === 'L1' && r1.errors === 0
  && after1.refs === before1.refs && after1.parts === before1.parts
  && cur1?.last_status === 'ok' && Number(cur1?.last_counts?.read) >= 2 && cur1?.decision_id === null;
counts.push(['① L1 只读（零写入 + cursor 留痕）', ok1]);
console.log('① L1:', { 有效信任档: t1[0]?.trustLevel, 声明档: t1[0]?.descriptorLevel, runs: r1.runs, errors: r1.errors,
  read: cur1?.last_counts?.read, external_ref: `${before1.refs}→${after1.refs}`, particles: `${before1.parts}→${after1.parts}`, decision_id: cur1?.decision_id });

// ── ② L2（global=L2）→ 写入生效 + 决策锚点落库 ──
await resetCursors();
const before2 = await snap();
const t2 = await loadTenantSyncTargets({ tenantId: TENANT, readConfig: readConfigWith('L2'), factories });
const r2 = await runTenantSyncOnce({
  tenantId: TENANT, targets: t2,
  deps: {
    pool, mappings: (await import('../src/sync/mount.js')).normalizeSyncMappings(mappingRaw),
    mintDecision: async () => ({ decisionId: DECISION }), emit, recordFailure,
  },
});
const after2 = await snap();
const cur2 = await cursorStore.get({ tenantId: TENANT, provider: 'mock', object: 'AccountObj' });
const cur2b = await cursorStore.get({ tenantId: TENANT, provider: 'mock', object: 'ContactObj' });
const ok2 = t2[0]?.trustLevel === 'L2' && r2.errors === 0 && r2.created === 4
  && after2.refs === before2.refs + 4 && after2.parts === before2.parts + 4
  && cur2?.decision_id === DECISION && cur2b?.decision_id === DECISION;
counts.push(['② L2 写入 + 第0闸决策锚点', ok2]);
console.log('② L2:', { 有效信任档: t2[0]?.trustLevel, created: r2.created, updated: r2.updated,
  external_ref: `${before2.refs}→${after2.refs}`, particles: `${before2.parts}→${after2.parts}`,
  AccountObj_decision: cur2?.decision_id, ContactObj_decision: cur2b?.decision_id });

// ── ③ 二次运行（游标已推进）→ created=0 幂等 ──
const before3 = await snap();
const r3 = await runTenantSyncOnce({
  tenantId: TENANT, targets: t2,
  deps: {
    pool, mappings: (await import('../src/sync/mount.js')).normalizeSyncMappings(mappingRaw),
    mintDecision: async () => ({ decisionId: DECISION }), emit, recordFailure,
  },
});
const after3 = await snap();
const ok3 = r3.created === 0 && after3.refs === before3.refs && after3.parts === before3.parts;
counts.push(['③ 幂等（二次 created=0，0 新粒子）', ok3]);
console.log('③ 幂等:', { read: r3.read, created: r3.created, external_ref: `${before3.refs}→${after3.refs}` });

// ── ④ 失败不静默：决策铸不出 → L2 拒绝本轮（写无决策不落库） ──
await resetCursors();
const before4 = await snap();
const r4 = await runTenantSyncOnce({
  tenantId: TENANT, targets: t2,
  deps: { pool, mappings: (await import('../src/sync/mount.js')).normalizeSyncMappings(mappingRaw),
    mintDecision: async () => ({ decisionId: null }), emit, recordFailure },
});
const after4 = await snap();
const ok4 = r4.errors === 2 && after4.refs === before4.refs
  && logs.some((l) => l.name === 'sync-run-failed');
counts.push(['④ 第0闸 fail-closed（无决策不写库）', ok4]);
console.log('④ fail-closed:', { errors: r4.errors, external_ref: `${before4.refs}→${after4.refs}` });

// ── ⑤ A-B5 单条对象变化事件路由（另一挂载点：connectorRouter webhook 调用的内核出口） ──
//   ⑤-1 L1 → 只读不写（观察期）  ⑤-2 L2 无决策 → 拒写（第 0 闸 fail-closed）  ⑤-3 L2 有决策 → 写入
const { handleObjectChanged, normalizeSyncMappings } = await import('../src/sync/mount.js');
const maps = normalizeSyncMappings(mappingRaw);
const before5 = await snap();
const evRow = { _id: 'ev-1', name: '事件客户' };
const e1 = await handleObjectChanged({ tenantId: TENANT, provider: 'mock', object: 'AccountObj', row: evRow,
  deps: { mappings: maps, pool, readConfig: async () => ({ value: { default_level: 'L1' } }) } });
const afterE1 = await snap();
const e2 = await handleObjectChanged({ tenantId: TENANT, provider: 'mock', object: 'AccountObj', row: evRow,
  deps: { mappings: maps, pool, readConfig: async () => ({ value: { default_level: 'L2' } }) } });
const afterE2 = await snap();
const e3 = await handleObjectChanged({ tenantId: TENANT, provider: 'mock', object: 'AccountObj', row: evRow,
  deps: { mappings: maps, pool, mintDecision: async () => ({ decisionId: DECISION }),
    readConfig: async () => ({ value: { default_level: 'L2' } }) } });
const afterE3 = await snap();
const ok5 = e1.ok === true && e1.readOnly === true && afterE1.parts === before5.parts
  && e2.ok === false && /decision_required/.test(e2.error || '') && afterE2.parts === before5.parts
  && e3.ok === true && e3.created === true && afterE3.parts === before5.parts + 1;
counts.push(['⑤ A-B5 事件路由（L1 只读 / 无决策拒写 / 有决策写入）', ok5]);
console.log('⑤ A-B5:', { L1只读: e1.readOnly, 无决策: e2.error, 有决策: { ok: e3.ok, created: e3.created },
  particles: `${before5.parts}→${afterE3.parts}` });

console.log('\n留痕事件：', [...new Set(logs.map((l) => l.name))].join(', ') || '(无)');
console.log('\n=== 冒烟结果 ===');
for (const [name, ok] of counts) console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}`);

await pool.end();
process.exit(counts.every(([, ok]) => ok) ? 0 : 1);
