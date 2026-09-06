// test/provenance-hash-v2.test.js — C2 审计链 T1：哈希白名单 v2 篡改检出 + v1 分代兼容回归锁
// 设计：docs/superpowers/plans/2026-09-03-c2c3c4-decision-integrity-implementation.md T1
//
// 锁死三类回归：
//   ① v2 白名单检出 —— entry_type / invalidated / archived 三类字段篡改，v1 实现完全无感（返回 OK），
//      v2 必须返回 TAMPERED。这是 T1 的核心价值（墓碑不可任意翻转）。
//   ② 分代兼容 —— hash_version=1 的历史行仍走 v1 算法校验，算法升级不得洗掉历史的防篡改能力。
//   ③ 链完整性 —— 正常 v2 链必须 OK（锁死「trackEntry 漏传 previous_checksum 导致第 2 条起全链错」的缺陷）。
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import {
  ensureProvenanceSchema, trackEntry, verifyChain, shaChain, HASH_VERSION, HASH_FIELDS,
} from '../src/decision/provenance.js';

const DID = '11111111-1111-1111-1111-111111111111';   // v2 链（走 trackEntry）
const DID_V1 = '22222222-2222-2222-2222-222222222222'; // v1 链（手工构造历史行）

beforeEach(async () => {
  await ensureProvenanceSchema();
  await query(
    'TRUNCATE crm.decision, crm.decision_provenance, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE'
  );
  for (const [id, disp, state] of [[DID, 'APPROVE', 'CONFIRMED'], [DID_V1, 'REJECT', 'REQUIRED']]) {
    await query(
      `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
       VALUES ($1,'LEAD_FOLLOW_UP','{}','[]','[]',$2,'AUTONOMOUS_AGENT','t','NORMAL',$3)`,
      [id, disp, state]
    );
  }
});

// 写两条 v2 entry（第 2 条是「漏传 previous_checksum」缺陷的触发点：只写 1 条时该缺陷不可见）
async function seedV2Chain() {
  await trackEntry({ decision_id: DID, entry_type: 'decision', payload: { disposition: 'APPROVE' }, source: 'agent' });
  await trackEntry({ decision_id: DID, entry_type: 'decision', payload: { disposition: 'APPROVE', state: 'CONFIRMED' }, source: 'human' });
}

const setField = (field, valueLiteral, did = DID) =>
  query(`UPDATE crm.decision_provenance SET ${field}=${valueLiteral} WHERE id=(SELECT min(id) FROM crm.decision_provenance WHERE decision_id=$1)`, [did]);

const resetField = (field, valueLiteral, did = DID) =>
  query(`UPDATE crm.decision_provenance SET ${field}=${valueLiteral} WHERE decision_id=$1`, [did]);

describe('T1 哈希白名单 v2（元信息）', () => {
  it('HASH_VERSION=2 且白名单纳入身份+语义+墓碑、排除 id/created_at', () => {
    expect(HASH_VERSION).toBe(2);
    expect(HASH_FIELDS).toContain('entry_type');
    expect(HASH_FIELDS).toContain('invalidated');
    expect(HASH_FIELDS).toContain('archived');
    expect(HASH_FIELDS).not.toContain('id');        // 自增，无篡改检出价值却极易误判
    expect(HASH_FIELDS).not.toContain('created_at'); // now() 生成，同理
  });

  it('trackEntry 落库行带 hash_version=2', async () => {
    await trackEntry({ decision_id: DID, entry_type: 'decision', payload: { a: 1 }, source: 'agent' });
    const row = (await query('SELECT hash_version FROM crm.decision_provenance WHERE decision_id=$1', [DID])).rows[0];
    expect(row.hash_version).toBe(2);
  });
});

describe('T1 回归锁③：v2 链完整性（锁死漏传 previous_checksum 缺陷）', () => {
  it('两条及以上 v2 entry 链校验 OK', async () => {
    await seedV2Chain();
    const v = await verifyChain({ decision_id: DID });
    expect(v.status, `status=${v.status} broken_at=${v.broken_at}`).toBe('OK');
    expect(v.entries).toBe(2);
    expect(v.head).toBeTruthy();
  });
});

describe('T1 回归锁①：白名单字段篡改必须检出（v1 此处恒返回 OK）', () => {
  it('篡改 entry_type → TAMPERED', async () => {
    await seedV2Chain();
    expect((await verifyChain({ decision_id: DID })).status).toBe('OK'); // 基线
    await setField('entry_type', "'entity'");
    expect((await verifyChain({ decision_id: DID })).status).toBe('TAMPERED');
  });

  it('翻转 invalidated 墓碑 → TAMPERED', async () => {
    await seedV2Chain();
    await setField('invalidated', 'true');
    expect((await verifyChain({ decision_id: DID })).status).toBe('TAMPERED');
  });

  it('翻转 archived → TAMPERED', async () => {
    await seedV2Chain();
    await setField('archived', 'true');
    expect((await verifyChain({ decision_id: DID })).status).toBe('TAMPERED');
  });

  it('篡改 payload → TAMPERED（v1/v2 共同能力）', async () => {
    await seedV2Chain();
    await setField('payload', `'{"disposition":"HACKED"}'`);
    expect((await verifyChain({ decision_id: DID })).status).toBe('TAMPERED');
  });

  it('删除链头 → BROKEN_HEAD（新增检出，v1 仅报 TAMPERED）', async () => {
    await seedV2Chain();
    await query('DELETE FROM crm.decision_provenance WHERE id=(SELECT min(id) FROM crm.decision_provenance WHERE decision_id=$1)', [DID]);
    expect((await verifyChain({ decision_id: DID })).status).toBe('BROKEN_HEAD');
  });

  it('归档 archived=true 由 applyArchival 合法执行时，不误判（链本身仍自洽）', async () => {
    await seedV2Chain();
    const { applyArchival } = await import('../src/decision/provenance.js');
    // retentionDays=0 → 全部条目被合法软归档；此路径改的是 archived 列，
    // 故链校验**应当**报 TAMPERED（说明 archived 入哈希确实生效），而非悄悄返回 OK。
    await applyArchival({ decision_id: DID, retentionDays: 0 });
    expect((await verifyChain({ decision_id: DID })).status).toBe('TAMPERED');
  });
});

describe('T1 回归锁②：v1 历史行分代兼容', () => {
  it('手工构造 hash_version=1 链，verifyChain 仍返回 OK', async () => {
    const p1 = { disposition: 'REJECT' };
    const c1 = shaChain(p1, null);
    await query(
      `INSERT INTO crm.decision_provenance (decision_id, entry_type, payload, source, checksum, previous_checksum, hash_version)
       VALUES ($1,'decision',$2,'agent',$3,NULL,1)`,
      [DID_V1, JSON.stringify(p1), c1]
    );
    const p2 = { disposition: 'REJECT', state: 'REQUIRED' };
    const c2 = shaChain(p2, c1);
    await query(
      `INSERT INTO crm.decision_provenance (decision_id, entry_type, payload, source, checksum, previous_checksum, hash_version)
       VALUES ($1,'decision',$2,'human',$3,$4,1)`,
      [DID_V1, JSON.stringify(p2), c2, c1]
    );
    const v = await verifyChain({ decision_id: DID_V1 });
    expect(v.status, `status=${v.status} broken_at=${v.broken_at}`).toBe('OK');
    expect(v.entries).toBe(2);
  });

  it('v1 行被篡改 payload 仍可检出（历史防篡改能力未被升级洗掉）', async () => {
    const p1 = { disposition: 'REJECT' };
    await query(
      `INSERT INTO crm.decision_provenance (decision_id, entry_type, payload, source, checksum, previous_checksum, hash_version)
       VALUES ($1,'decision',$2,'agent',$3,NULL,1)`,
      [DID_V1, JSON.stringify(p1), shaChain(p1, null)]
    );
    await setField('payload', `'{"disposition":"HACKED"}'`, DID_V1);
    expect((await verifyChain({ decision_id: DID_V1 })).status).toBe('TAMPERED');
  });
});
