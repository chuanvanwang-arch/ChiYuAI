// test/meta-model/timeline-tenant.test.js
// P1(T7): retrieveTimeline 记忆源按 tenant_id 隔离（客户记忆全隔离，设计 §15）。
// 同一 entity_id 在 acme / other 两租户各写入一条记忆，传 tenantId='acme' 应只回 acme 那条。
import { describe, it, expect, beforeEach } from 'vitest';
import { retrieveTimeline } from '../../src/context/timelineSource.js';
import { queryWrite } from '../../src/db.js';

describe('P1 timeline memory tenant isolation', () => {
  beforeEach(async () => {
    await queryWrite(`DELETE FROM crm.memory_log WHERE entity_id='entT-tenant'`);
  });

  it('retrieveTimeline memory source scoped to tenant', async () => {
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
      VALUES ('account:entT','decision','{"title":"mem:acme"}','acme','entT-tenant')`);
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
      VALUES ('account:entT','decision','{"title":"mem:other"}','other','entT-tenant')`);

    const rows = await retrieveTimeline({ accountId: 'entT-tenant', tenantId: 'acme' });
    const memRows = rows.filter((r) => r.type === 'memory');
    // acme 租户的记忆必须可见
    expect(memRows.find((r) => r.title === 'mem:acme')).toBeDefined();
    // other 租户的记忆必须被隔离（不可串扰）
    expect(memRows.find((r) => r.title === 'mem:other')).toBeUndefined();
  });

  it('retrieveTimeline with other tenant sees only other', async () => {
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
      VALUES ('account:entT','decision','{"title":"mem:acme"}','acme','entT-tenant')`);
    await queryWrite(`INSERT INTO crm.memory_log (topic,kind,payload,tenant_id,entity_id)
      VALUES ('account:entT','decision','{"title":"mem:other"}','other','entT-tenant')`);

    const rows = await retrieveTimeline({ accountId: 'entT-tenant', tenantId: 'other' });
    const memRows = rows.filter((r) => r.type === 'memory');
    expect(memRows.find((r) => r.title === 'mem:other')).toBeDefined();
    expect(memRows.find((r) => r.title === 'mem:acme')).toBeUndefined();
  });
});
