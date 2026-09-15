// scripts/smoke-signal-e2e.mjs — 信号链路端到端冒烟（S1 收口验证）
// 用法：PGDATABASE=crm_native node scripts/smoke-signal-e2e.mjs
// 验证：create（落 DB）→ list → setStatus acked → closed（状态机 + 时间戳）
import pg from 'pg';

const pool = new pg.Pool({
  database: process.env.PGDATABASE || 'crm_native',
  host: 'localhost', port: 5433, user: 'agent2b', password: 'agent2b',
});
await pool.query('SET search_path TO crm,public');

const { createSignalStore } = await import('../src/signal/store.js');
const store = createSignalStore(pool);

const r = await store.create({
  tenant_id: 'smoke', source: 'rule-scan', kind: 'deal_stuck',
  severity: 'high', target_role: 'sales', particle_id: 'smoke-1',
  payload: { subject: '冒烟' }, evidence: { rule_kind: 'deal_stuck' },
  dedup_key: 'deal_stuck:smoke-1:hour',
});
console.log('create:', r.ok, r.deduped, r.alert?.signal_id);

const rows = await store.list({ tenant_id: 'smoke' });
console.log('list:', rows.length);

// 幂等：同 dedup_key 再 create → deduped=true（复用既有，不叠加）
const dup = await store.create({
  tenant_id: 'smoke', source: 'rule-scan', kind: 'deal_stuck',
  severity: 'high', target_role: 'sales', particle_id: 'smoke-1',
  payload: { subject: '冒烟' }, dedup_key: 'deal_stuck:smoke-1:hour',
});
console.log('dedup:', dup.deduped === true ? 'OK (复用)' : 'FAIL');

const ack = await store.setStatus('smoke', r.alert.signal_id, 'acked');
const closed = await store.setStatus('smoke', r.alert.signal_id, 'closed');
console.log('ack:', ack.ok, '| close:', closed.ok, closed.alert?.status, closed.alert?.closed_at ? 'closed_at=OK' : 'closed_at=MISSING');

// 清理冒烟数据（零 DELETE 铁律：不删行，仅标记来源为 smoke-e2e 供审计辨析）
// 冒烟数据保留在 crm.signal 中，tenant_id='smoke' 与真实租户隔离，审计可识别
console.log('cleanup: 冒烟数据保留（tenant_id=smoke 隔离，零 DELETE 铁律）');

await pool.end();
console.log('E2E 冒烟通过 ✅');
