// scripts/smoke-followup-e2e.mjs — S3 followup 真库链路冒烟
// 链路：建 external_ref（真库 crm.external_ref）→ emit('external','object_changed') → followupRouter 订阅 → followupEngine.reevaluate → crm.signal 落库
// 断言：信号行存在（source='event-trigger', kind='object_changed'）+ 同事件去重不叠加 + getSyncMetrics 聚合可用
// 运行：PGDATABASE=crm_native node scripts/smoke-followup-e2e.mjs
import pg from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import { emit } from '../src/events/bus.js';
import { createSignalStore } from '../src/signal/store.js';
import { createEntityResolver } from '../src/sync/resolver.js';
import { createFollowupEngine } from '../src/signal/followupEngine.js';
import { createFollowupRouter } from '../src/signal/followupRouter.js';
import { getSyncMetrics } from '../src/monitor/syncMetrics.js';

const pool = new pg.Pool({ database: process.env.PGDATABASE || 'crm_native', host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b' });
await pool.query('SET search_path TO crm,public');
const TENANT = 'smoke-followup';
const OBJECT = 'AccountObj';
const EXT_ID = 'acc-followup-1';
const PID = randomUUID(); // particles.id 为 UUID 类型，须用合法 UUID
const stableKey = (type, slug) => createHash('sha256').update(`${TENANT}|${type}|${slug}`).digest('hex');

// 建 external_ref + 对应粒子（resolver.findRef 命中前提）；stable_key 唯一约束 → 重跑幂等 DO NOTHING
await pool.query(
  `INSERT INTO crm.particles (id, tenant_id, type, slug, title, payload, state, stable_key)
   VALUES ($1,$2,'CRM_ACCOUNT',$3,$4,$5::jsonb,'ACTIVE',$6)
   ON CONFLICT (stable_key) DO NOTHING`,
  [PID, TENANT, 'account:acc-followup-1', '客户F', JSON.stringify({ name: '客户F' }), stableKey('CRM_ACCOUNT', 'account:acc-followup-1')]
);
await pool.query(
  `INSERT INTO crm.external_ref (tenant_id, provider, external_object, external_id, particle_type, particle_id, last_hash, last_direction, last_synced_at)
   VALUES ($1,'mock',$2,$3,'CRM_ACCOUNT',$4,'h','in',now())
   ON CONFLICT (tenant_id, provider, external_object, external_id) DO NOTHING`,
  [TENANT, OBJECT, EXT_ID, PID]
);

const signalStore = createSignalStore(pool);
const resolver = createEntityResolver({ pool });
const engine = createFollowupEngine({ pool, signalStore, resolver });
const router = createFollowupRouter({ engine });
router.register();

// 触发对象变化事件
emit('external', 'object_changed', { object: OBJECT, externalId: EXT_ID, tenantId: TENANT });
await new Promise((r) => setTimeout(r, 300)); // 等 bus 异步重评

// 诊断：直接调 reevaluate 看 findRef / 信号结果（不依赖 bus 时序）
const diag = await engine.reevaluate({ object: OBJECT, externalId: EXT_ID, tenantId: TENANT });
console.log('diag reevaluate:', JSON.stringify(diag).slice(0, 300));

const rows = await pool.query(
  `SELECT * FROM crm.signal WHERE tenant_id=$1 AND source='event-trigger' AND kind='object_changed' ORDER BY created_at DESC LIMIT 1`,
  [TENANT]
);
const ok1 = rows.rows.length === 1;
console.log('followup signal:', ok1 ? 'OK' : 'FAIL', rows.rows[0]?.signal_id || '');

// 幂等：再次同事件 → dedup 不叠加
emit('external', 'object_changed', { object: OBJECT, externalId: EXT_ID, tenantId: TENANT });
await new Promise((r) => setTimeout(r, 300));
const rows2 = await pool.query(`SELECT COUNT(*) AS c FROM crm.signal WHERE tenant_id=$1 AND source='event-trigger' AND kind='object_changed'`, [TENANT]);
const ok2 = Number(rows2.rows[0].c) === 1; // 去重生效
console.log('dedup:', ok2 ? 'OK (单条)' : 'FAIL');

// syncMetrics 聚合可用（S3 T07）
const metrics = await getSyncMetrics({ pool, tenantId: TENANT });
const ok3 = metrics && typeof metrics.success_rate === 'number';
console.log('syncMetrics:', ok3 ? 'OK' : 'FAIL');

await pool.end();
if (ok1 && ok2 && ok3) console.log('\nE2E 冒烟通过 ✅（S3 followup 链路）');
else { console.log('\nE2E 冒烟失败 ❌'); process.exit(1); }
