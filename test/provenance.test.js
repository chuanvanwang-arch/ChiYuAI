import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { query } from '../src/db.js';
import { ensureMonitorSchema } from '../src/monitor/monitorSubscriber.js';
import {
  ensureProvenanceSchema, trackEntry, verifyChain, exportAudit,
} from '../src/decision/provenance.js';

// 固定 UUID 用于满足 decision_provenance → crm.decision 外键（plan 原稿用假 UUID 会违反 FK，此处插入裸决策补齐）
const DID_A = '11111111-1111-1111-1111-111111111111';
const DID_B = '22222222-2222-2222-2222-222222222222';

beforeAll(async () => {
  await ensureMonitorSchema();
  await ensureProvenanceSchema();
});

// 隔离：清空运行时决策表（级联清 provenance/precedent/event/memory），插入两条裸决策满足 FK
beforeEach(async () => {
  await query(
    'TRUNCATE crm.decision, crm.decision_provenance, crm.decision_precedent_rel, crm.decision_event, crm.memory_log RESTART IDENTITY CASCADE'
  );
  await query(
    `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,'LEAD_FOLLOW_UP','{}','[]','[]','APPROVE','AUTONOMOUS_AGENT','t','NORMAL','CONFIRMED')`,
    [DID_A]
  );
  await query(
    `INSERT INTO crm.decision (decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, disposition, decider_type, rationale, business_tier, state)
     VALUES ($1,'LEAD_FOLLOW_UP','{}','[]','[]','REJECT','AUTONOMOUS_AGENT','t','NORMAL','REQUIRED')`,
    [DID_B]
  );
});

describe('数据层扩展（monitor_event 两列 + decision_provenance 表）', () => {
  it('monitor_event 含 agent_id / context_facts 两列（G4 agent 认知记录落点）', async () => {
    const r = (await query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='crm' AND table_name='monitor_event'`
    )).rows.map((x) => x.column_name);
    expect(r).toContain('agent_id');
    expect(r).toContain('context_facts');
  });

  it('decision_provenance 表存在且结构符合设计 §4.3', async () => {
    const r = (await query(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_schema='crm' AND table_name='decision_provenance'`
    )).rows;
    const cols = Object.fromEntries(r.map((c) => [c.column_name, c.data_type]));
    expect(cols).toMatchObject({
      decision_id: 'uuid',
      entry_type: 'text',
      payload: 'jsonb',
      checksum: 'text',
      previous_checksum: 'text',
    });
    // 外键约束存在（决策链不可孤儿）
    const fk = (await query(
      `SELECT count(*)::int n FROM information_schema.table_constraints
       WHERE table_schema='crm' AND table_name='decision_provenance'
         AND constraint_type='FOREIGN KEY'`
    )).rows[0].n;
    expect(fk).toBeGreaterThanOrEqual(1);
  });
});

describe('C4 校验和链', () => {
  it('trackEntry 链式写链，verifyChain 检测篡改', async () => {
    const did = DID_A;
    await trackEntry({ decision_id: did, entry_type: 'decision', payload: { disposition: 'APPROVE' }, source: 'agent' });
    await trackEntry({ decision_id: did, entry_type: 'decision', payload: { disposition: 'APPROVE', state: 'CONFIRMED' }, source: 'human' });
    const ok = await verifyChain({ decision_id: did });
    expect(ok.status).toBe('OK');
    // 模拟篡改：改一条 payload（jsonb 键序变化不应误判，canonical 已处理）
    await query(
      `UPDATE crm.decision_provenance SET payload = '{"disposition":"HACKED"}' WHERE id = (SELECT min(id) FROM crm.decision_provenance WHERE decision_id=$1)`,
      [did]
    );
    const tampered = await verifyChain({ decision_id: did });
    expect(tampered.status).toBe('TAMPERED');
    expect(tampered.broken_at).toBeDefined();
  });

  it('jsonb 键序变化不误报（canonical 深度排序键）', async () => {
    const did = DID_B;
    await trackEntry({ decision_id: did, entry_type: 'decision', payload: { b: 2, a: 1, c: [3, 1, 2] }, source: 'agent' });
    // 同语义、键序打乱后的 payload 重算校验和应一致（验证链连续性不被键序影响）
    const ok = await verifyChain({ decision_id: did });
    expect(ok.status).toBe('OK');
  });

  it('exportAudit 返回结构化报告（含 chainStatus / entries / 上游下游）', async () => {
    const did = DID_B;
    await trackEntry({ decision_id: did, entry_type: 'decision', payload: { disposition: 'REJECT' }, source: 'agent' });
    const rep = await exportAudit({ decision_id: did });
    expect(rep.decision_id).toBe(did);
    expect(rep.entries.length).toBeGreaterThanOrEqual(1);
    expect(rep.chainStatus).toBeDefined();
    expect(Array.isArray(rep.upstream)).toBe(true);
    expect(Array.isArray(rep.downstream)).toBe(true);
  });
});
