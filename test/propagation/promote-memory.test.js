// test/propagation/promote-memory.test.js — promoteMemoryToTenant（Task 3，task→tenant 经验推广）
import { describe, it, expect } from 'vitest';
import { promoteMemoryToTenant, listTenantPrecedents } from '../../src/memory/promote.js';

function fakePool() {
  const store = []; // tenant_precedent 行
  return {
    __store: store,
    query: async (t, a) => {
      if (t.includes('FROM crm.memory_log WHERE id=$1')) {
        return { rows: fakePool.__mem?.(a[0]) ? [fakePool.__mem(a[0])] : [] };
      }
      if (t.startsWith('INSERT INTO crm.tenant_precedent')) {
        // 实参顺序：(tenant_id, memory_id, title, payload, source_kind, promoted_from, decision_id, created_by)
        const row = { id: 'gen', tenant_id: a[0], memory_id: a[1], title: a[2], source_kind: 'memory', promoted_from: a[4] };
        store.push(row);
        return { rows: [row] };
      }
      if (t.startsWith('SELECT') && t.includes('crm.tenant_precedent')) {
        return { rows: store.filter((r) => r.tenant_id === a[0]) };
      }
      return { rows: [] };
    },
  };
}

describe('promoteMemoryToTenant', () => {
  it('同租户内提升为租户先例，溯源保留', async () => {
    const pool = fakePool();
    fakePool.__mem = (id) => ({ id, tenant_id: 't-a', topic: 'deal', payload: { note: '客户对价格敏感' } });
    const r = await promoteMemoryToTenant(pool, { memoryId: 'm1', tenantId: 't-a', by: 'alice', decisionId: 'd1' });
    expect(r.ok).toBe(true);
    expect(r.row.tenant_id).toBe('t-a');
    expect(r.row.memory_id).toBe('m1');
    expect((await listTenantPrecedents(pool, 't-a')).length).toBe(1);
  });

  it('跨租户拒绝（防 PII 泄漏）', async () => {
    const pool = fakePool();
    fakePool.__mem = (id) => ({ id, tenant_id: 't-b', topic: 'deal', payload: {} });
    await expect(promoteMemoryToTenant(pool, { memoryId: 'm1', tenantId: 't-a', by: 'alice', decisionId: 'd1' }))
      .rejects.toThrow(/租户不匹配|tenant mismatch/i);
  });

  it('源记忆不存在抛错', async () => {
    const pool = fakePool();
    fakePool.__mem = () => null;
    await expect(promoteMemoryToTenant(pool, { memoryId: 'nope', tenantId: 't-a', by: 'alice' }))
      .rejects.toThrow(/不存在/);
  });
});
