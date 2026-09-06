// test/meta-model/memory-tenant.test.js
// P1: memory_log 查询（retrieveMemory / rrfSearch）按 tenant_id 隔离（客户记忆全隔离，设计 §15）
import { describe, it, expect, beforeEach } from 'vitest';
import { retrieveMemory, rrfSearch } from '../../src/memory/memoryLog.js';
import { queryWrite } from '../../src/db.js';

describe('P1 memory tenant isolation', () => {
  beforeEach(async () => {
    await queryWrite(`DELETE FROM crm.memory_log WHERE tenant_id IN ('acme','other')`);
  });

  it('retrieveMemory scoped to tenant', async () => {
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id) VALUES ('account:a','decision','{"x":1}','acme','ent1')`);
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id) VALUES ('account:a','decision','{"x":2}','other','ent1')`);
    const r = await retrieveMemory({ topic: 'account:a', tenantId: 'acme' });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0].tenant_id).toBe('acme');
  });

  it('rrfSearch scoped to tenant', async () => {
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id) VALUES ('account:b','decision','{"note":"budget"}','acme','ent2')`);
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id) VALUES ('account:b','decision','{"note":"budget"}','other','ent2')`);
    const res = await rrfSearch('budget', { tenantId: 'acme' });
    expect(res.length).toBe(1);
    expect(res.every((x) => x.tenant_id === 'acme')).toBe(true);
  });
});
