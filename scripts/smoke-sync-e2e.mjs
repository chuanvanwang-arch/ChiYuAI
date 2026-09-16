// scripts/smoke-sync-e2e.mjs — S2 同步内核端到端冒烟（真库）
// 链路：mock provider → mapping → resolver（真库 crm.external_ref/crm.particles）→ trust(L2) → engine.runOnce
// 断言：read/created 计数 → 幂等（二次 created=0）→ sync_cursor 落 last_counts
// 运行：PGDATABASE=crm_native node scripts/smoke-sync-e2e.mjs
import pg from 'pg';
import { createSyncEngine } from '../src/sync/engine.js';
import { createMappingResolver } from '../src/sync/mapping.js';
import { createEntityResolver } from '../src/sync/resolver.js';
import { createTrustManager } from '../src/sync/trust.js';
import { createCursorStore } from '../src/sync/cursor.js';

const pool = new pg.Pool({
  database: process.env.PGDATABASE || 'crm_native',
  host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b',
});
await pool.query('SET search_path TO crm,public');

const TENANT = 'smoke-sync';
const OBJECT = 'AccountObj';
const provider = {
  kind: 'mock',
  verifyAuth: async () => ({ ok: true }),
  discoverObjects: async () => ({ objects: [{ name: OBJECT }] }),
  readIncremental: async ({ cursor }) => ({
    rows: cursor
      ? [] // 幂等验证：第二批次无增量
      : [
          { id: 'acc-1', name: '客户A', industry: '制造' },
          { id: 'acc-2', name: '客户B', industry: '化工' },
        ],
    cursor: 'cursor-2',
  }),
};

const mapping = createMappingResolver({
  mappings: {
    [OBJECT]: {
      particle_type: 'CRM_ACCOUNT',
      fields: [
        { ext: 'name', particle: 'name' },
        { ext: 'industry', particle: 'industry' },
      ],
    },
  },
});

const resolver = createEntityResolver({ pool });
const trust = createTrustManager({
  readConfig: async () => ({ value: { default_level: 'L2' } }), // L2 允许写
});
const cursor = createCursorStore(pool);
const engine = createSyncEngine({ provider, mapping, resolver, trust, cursor });

// 清理冒烟租户旧 cursor（无 DELETE：只重置 cursor 行 last_status——直接 set 覆盖）
await cursor.set({ tenantId: TENANT, provider: 'mock', object: OBJECT, cursor: null, counts: { read: 0, created: 0 }, status: 'idle' });

const r1 = await engine.runOnce({ object: OBJECT, tenantId: TENANT });
const ok1 = r1.ok && r1.read === 2 && r1.created === 2 && r1.readOnly === false;
console.log('run#1:', JSON.stringify(r1), ok1 ? 'OK' : 'FAIL');

const r2 = await engine.runOnce({ object: OBJECT, tenantId: TENANT });
const ok2 = r2.ok && r2.read === 0 && r2.created === 0 && r2.readOnly === false;
console.log('run#2(幂等):', JSON.stringify(r2), ok2 ? 'OK' : 'FAIL');

const cur = await cursor.get({ tenantId: TENANT, provider: 'mock', object: OBJECT });
const ok3 = cur && cur.last_status === 'ok' && Number(cur.last_counts?.read) === 0;
console.log('cursor:', JSON.stringify(cur?.last_counts || null), cur?.last_status, ok3 ? 'OK' : 'FAIL');

await pool.end();
if (ok1 && ok2 && ok3) {
  console.log('\nE2E 冒烟通过 ✅（S2 同步内核全链路）');
} else {
  console.log('\nE2E 冒烟失败 ❌');
  process.exit(1);
}
