// test/meta-model/no-hardcode-system.test.js
// P1(T8): loadRelatedParticles 不得硬编码 tenant_id='system'，必须消费传入的 tenantId 参数（按租户隔离）。
import { describe, it, expect, beforeEach } from 'vitest';
import { loadRelatedParticles } from '../../src/account/insightService.js';
import { queryWrite } from '../../src/db.js';

describe('P1 loadRelatedParticles tenant param (no hardcoded system)', () => {
  beforeEach(async () => {
    await queryWrite(`DELETE FROM crm.particles WHERE slug LIKE 'mmtest-%'`);
  });

  it('filters by injected tenantId, not hardcoded system', async () => {
    await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,payload)
      VALUES ('acme','CRM_CONTACT','mmtest-acme','Acme C','{"account_id":"accZ"}')`);
    await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,payload)
      VALUES ('other','CRM_CONTACT','mmtest-other','Other C','{"account_id":"accZ"}')`);

    const byType = await loadRelatedParticles('accZ', [], 'acme');
    const contacts = byType['CRM_CONTACT'];
    // 仅 acme 租户的粒子应返回（other 被隔离）
    expect(contacts.find((c) => c.slug === 'mmtest-acme')).toBeDefined();
    expect(contacts.find((c) => c.slug === 'mmtest-other')).toBeUndefined();
  });

  it('with other tenant returns only other', async () => {
    await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,payload)
      VALUES ('acme','CRM_CONTACT','mmtest-acme','Acme C','{"account_id":"accZ"}')`);
    await queryWrite(`INSERT INTO crm.particles (tenant_id,type,slug,title,payload)
      VALUES ('other','CRM_CONTACT','mmtest-other','Other C','{"account_id":"accZ"}')`);

    const byType = await loadRelatedParticles('accZ', [], 'other');
    const contacts = byType['CRM_CONTACT'];
    expect(contacts.find((c) => c.slug === 'mmtest-other')).toBeDefined();
    expect(contacts.find((c) => c.slug === 'mmtest-acme')).toBeUndefined();
  });
});
