// test/propagation/skill-promote.test.js — promoteSkill from=tenant 分支（Task 4）
import { describe, it, expect } from 'vitest';
import { promoteSkill, effectiveSkillSet } from '../../src/skill/skillScope.js';

function fakePool() {
  const rows = []; // skill_scope 行
  return {
    __rows: rows,
    query: async (t, a) => {
      if (t.startsWith('SELECT') && t.includes('crm.skill_scope')) {
        // 返回全部行（测试数据量小，由 SQL 语义在调用方过滤）；tenant 行须被 src 查询命中
        return { rows: [...rows] };
      }
      if (t.startsWith('INSERT INTO crm.skill_scope')) {
        const isTenant = t.includes('tenant_id');
        // tenant 分支实参：(skill, scope_level, owner, enabled, promoted_from, note, tenant_id)
        //   VALUES ($1,'system',NULL,true,$2,$3,NULL) → argv=[skill, promotedFrom, note]
        // user 分支实参：(skill, scope_level, owner, enabled, promoted_from, note)
        //   VALUES ($1,$2,$3,true,$4,$5) → argv=[skill, to, targetOwner, from, note]
        const row = isTenant
          ? { id: 'gen', skill: a[0], scope_level: 'system', owner: null, enabled: true, promoted_from: a[1], note: a[2], tenant_id: null }
          : { id: a[0], skill: a[1], scope_level: a[2], owner: a[3], enabled: a[4], promoted_from: a[5], note: a[6], tenant_id: a[7] ?? null };
        rows.push(row);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
}

describe('promoteSkill tenant→system', () => {
  it('from=tenant 写 system 行并溯源 promoted_from', async () => {
    const pool = fakePool();
    pool.__rows.push({ id: 'row-ta', skill: 'method-x', scope_level: 'tenant', owner: 't-a', enabled: true, promoted_from: null, note: null, tenant_id: 't-a' });
    const r = await promoteSkill(pool, { skill: 'method-x', from: 'tenant', to: 'system', tenantId: 't-a', by: 'sysadmin' });
    expect(r.ok).toBe(true);
    const sysRow = pool.__rows.find((x) => x.scope_level === 'system' && x.skill === 'method-x');
    expect(sysRow).toBeTruthy();
    expect(sysRow.promoted_from).toBe('tenant:t-a:method-x');
  });

  it('from=tenant 但缺 tenantId 抛错', async () => {
    const pool = fakePool();
    await expect(promoteSkill(pool, { skill: 'method-x', from: 'tenant', to: 'system', by: 'sysadmin' }))
      .rejects.toThrow(/tenantId|租户/);
  });

  it('tenant 源行不存在抛错', async () => {
    const pool = fakePool();
    await expect(promoteSkill(pool, { skill: 'ghost', from: 'tenant', to: 'system', tenantId: 't-z', by: 'sysadmin' }))
      .rejects.toThrow(/无.*定制行|无法推广/);
  });
});
