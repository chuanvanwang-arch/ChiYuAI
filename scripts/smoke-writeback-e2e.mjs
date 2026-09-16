// scripts/smoke-writeback-e2e.mjs — S4 字段级 CAS 真库写/拒 全链路
// 链路：建 CRM_ACCOUNT 粒子 → updateParticle casExpectField 命中 → 写入；casExpectField 失配 → 拒（cas_mismatch）
// 断言：命中写入生效 + 失配抛错且值不变
// 运行：PGDATABASE=crm_native node scripts/smoke-writeback-e2e.mjs
import pg from 'pg';
import { createHash } from 'node:crypto';
import { updateParticle } from '../src/particles/particleRepo.js';

const pool = new pg.Pool({ database: process.env.PGDATABASE || 'crm_native', host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b' });
await pool.query('SET search_path TO crm,public');
const TENANT = 'smoke-writeback';
const PARTICLE_SLUG = 'account:wb-1';
const STABLE_KEY = createHash('sha256').update(`${TENANT}|CRM_ACCOUNT|${PARTICLE_SLUG}`).digest('hex');
const stableKey = (type, slug) => createHash('sha256').update(`${TENANT}|${type}|${slug}`).digest('hex');

// 重跑幂等：stable_key 唯一约束 → 复用既有粒子 id（零 DELETE），不存在才以固定 UUID 插入；并重置 phone 到初值
const ex = await pool.query(`SELECT id FROM crm.particles WHERE tenant_id=$1 AND stable_key=$2 LIMIT 1`, [TENANT, STABLE_KEY]);
let PID;
if (ex.rows.length) {
  PID = ex.rows[0].id;
  await pool.query(
    `UPDATE crm.particles SET payload=$1::jsonb, state='ACTIVE', updated_at=now() WHERE id=$2`,
    [JSON.stringify({ name: '客户W', phone: 'old-123' }), PID]
  );
} else {
  PID = '9b8c7d6e-5a4b-4c3d-8e7f-0000000000b1'; // 固定合法 UUID（首次插入）
  await pool.query(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, payload, state, stable_key)
     VALUES ($1,$2,'CRM_ACCOUNT',$3,$4,$5::jsonb,'ACTIVE',$6)
     ON CONFLICT (stable_key) DO NOTHING`,
    [PID, TENANT, PARTICLE_SLUG, '客户W', JSON.stringify({ name: '客户W', phone: 'old-123' }), STABLE_KEY]
  );
}

// ① 命中 CAS：phone 当前值='old-123' → 写入新值 + 静态 Source 标记
const r1 = await updateParticle(PID, {
  patch: { phone: 'new-456', Source: 'crm-ai-native' },
  casExpectField: { path: 'phone', value: 'old-123' },
  systemBypass: true, tenantId: TENANT,
});
const after1 = await pool.query(`SELECT payload->>'phone' AS phone, payload->>'Source' AS src FROM crm.particles WHERE id=$1`, [PID]);
const ok1 = after1.rows[0].phone === 'new-456' && after1.rows[0].src === 'crm-ai-native';
console.log('cas-hit write:', ok1 ? 'OK' : 'FAIL', JSON.stringify(after1.rows[0]));

// ② 失配 CAS：phone 已='new-456'（外部已被改）→ 用旧期望值 'old-123' 应拒
let rejected = false, unchanged = false;
try {
  await updateParticle(PID, {
    patch: { phone: 'hacked' },
    casExpectField: { path: 'phone', value: 'old-123' },
    systemBypass: true, tenantId: TENANT,
  });
} catch (e) {
  rejected = String(e.message).includes('cas_mismatch');
}
const after2 = await pool.query(`SELECT payload->>'phone' AS phone FROM crm.particles WHERE id=$1`, [PID]);
unchanged = after2.rows[0].phone === 'new-456'; // 拒绝后值未被覆盖
console.log('cas-mismatch reject:', (rejected && unchanged) ? 'OK' : 'FAIL', `(rejected=${rejected}, unchanged=${unchanged})`);

await pool.end();
if (ok1 && rejected && unchanged) console.log('\nE2E 冒烟通过 ✅（S4 字段级 CAS 真库写/拒）');
else { console.log('\nE2E 冒烟失败 ❌'); process.exit(1); }
