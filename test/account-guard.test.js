// test/account-guard.test.js — §5 防复发守卫（根因报告 account-misbind）
// 覆盖：名称规范化 / 名称一致性硬校验 / 软外键 / find-or-create / 看板孤儿识别
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createParticle } from '../src/particles/particleRepo.js';
import {
  normalizeAccountName,
  assertNameConsistent,
  assertAccountExists,
  resolveDealAccount,
  AccountGuardError,
} from '../src/sales/accountGuard.js';
import { listOrphanDeals as boardOrphans } from '../src/sales/namedAccountBoard.js';

beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
});

describe('账户归属守卫（纯函数）', () => {
  it('normalizeAccountName 去空格/大小写', () => {
    expect(normalizeAccountName('  XX制造 ')).toBe('xx制造');
    expect(normalizeAccountName('XX制造')).toBe('xx制造');
  });

  it('assertNameConsistent 一致/缺字段放行，不一致抛错', () => {
    expect(() => assertNameConsistent(null, 'XX制造')).not.toThrow();
    expect(() => assertNameConsistent({ payload: { name: 'XX制造' } }, null)).not.toThrow();
    expect(() => assertNameConsistent({ payload: { name: 'XX制造' } }, 'xx制造')).not.toThrow();
    expect(() => assertNameConsistent({ payload: { name: '上海印通包装科技有限公司' } }, 'XX制造'))
      .toThrow(AccountGuardError);
  });
});

describe('账户归属守卫（集成：真实测试库）', () => {
  it('resolveDealAccount：绑定正确账户', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'XX制造', named_owner: 'alice' });
    const r = await resolveDealAccount({ payload: { account_id: acct.id, customer: 'XX制造' }, tenantId: 'system' });
    expect(r.status).toBe('bound');
    expect(r.account_id).toBe(acct.id);
  });

  it('resolveDealAccount：名称不一致拒绝（捕王总错绑印通类）', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: '上海印通包装科技有限公司', named_owner: 'alice' });
    await expect(resolveDealAccount({ payload: { account_id: acct.id, customer: 'XX制造' }, tenantId: 'system' }))
      .rejects.toThrow(AccountGuardError);
  });

  it('resolveDealAccount：account_id 不存在拒绝（软外键）', async () => {
    await expect(resolveDealAccount({ payload: { account_id: '00000000-0000-0000-0000-000000000000' }, tenantId: 'system' }))
      .rejects.toThrow(AccountGuardError);
  });

  it('resolveDealAccount：有 customer 无 account_id → find-or-create', async () => {
    const r = await resolveDealAccount({ payload: { customer: '新能科科技' }, tenantId: 'system', actor: 'alice' });
    expect(r.status).toBe('created');
    expect(r.account_id).toBeTruthy();
    // 二次解析应命中已建账户（不重复建）
    const r2 = await resolveDealAccount({ payload: { customer: '新能科科技' }, tenantId: 'system', actor: 'alice' });
    expect(r2.status).toBe('found');
    expect(r2.account_id).toBe(r.account_id);
  });

  it('assertAccountExists：合法 UUID 不存在也抛错', async () => {
    await expect(assertAccountExists('11111111-1111-1111-1111-111111111111', 'system'))
      .rejects.toThrow(AccountGuardError);
  });
});

describe('看板防呆：listOrphanDeals', () => {
  it('识别孤儿(缺账户)与错绑(名称不一致)', async () => {
    const acct = await createParticle('CRM_ACCOUNT', { name: 'XX制造', named_owner: 'alice' });
    const deals = [
      // 绑定到不存在账户 → 孤儿
      { id: 'd-missing', title: 'd-missing', payload: { name: '某单', account_id: '99999999-9999-9999-9999-999999999999' } },
      // 绑 XX制造 但 customer 写印通 → 错绑
      { id: 'd-mismatch', title: 'd-mismatch', payload: { name: '某单', account_id: acct.id, customer: '上海印通包装' } },
      // 正常
      { id: 'd-ok', title: 'd-ok', payload: { name: '某单', account_id: acct.id, customer: 'XX制造' } },
    ];
    const orphans = boardOrphans([acct], deals);
    expect(orphans).toHaveLength(2);
    const reasons = orphans.map((o) => o.reason).sort();
    expect(reasons).toEqual(['account_mismatch', 'account_missing']);
  });
});
