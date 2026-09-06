// test/particles/createParticle-account-owner.test.js
// 2026-08-31 根因修复：CRM_ACCOUNT 写路径必须保证 named_owner 兜底（AI/页面写账户漏主→指名看板不可见）
// 1) backfillAccountOwner：actor 非空时注入 named_owner/owner_id/owner
// 2) createParticle(type=CRM_ACCOUNT) 在 actor 模式下自动补 owner 三键
// 3) enforceNamedOwner=true 且缺 owner → 抛错
// 4) bootstrap/system 通道（actor='system'）放行允许无主
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { backfillAccountOwner, createParticle } from '../../src/particles/particleRepo.js';
import { getParticle } from '../../src/particles/particleRepo.js';

let insertedId = null;

describe('CRM_ACCOUNT 写路径 named_owner 兜底（2026-08-31 root cause fix）', () => {
  it('backfillAccountOwner: actor=alice 时缺 named_owner/owner_id/owner 自动补齐', () => {
    const out = backfillAccountOwner({ name: '测试-客户-A', industry: '制造' }, 'alice');
    expect(out.named_owner).toBe('alice');
    expect(out.owner_id).toBe('alice');
    expect(out.owner).toBe('alice');
    expect(out.name).toBe('测试-客户-A');
    expect(out.industry).toBe('制造');
  });

  it('backfillAccountOwner: 已有 named_owner 时不覆盖', () => {
    const out = backfillAccountOwner({ name: '测试-客户-B', named_owner: 'bob', owner_id: 'bob' }, 'alice');
    expect(out.named_owner).toBe('bob');
    expect(out.owner_id).toBe('bob');
    expect(out.owner).toBe('alice'); // owner 是旧键缺失，补齐回退
  });

  it('backfillAccountOwner: actor=system 或空时不动', () => {
    const out1 = backfillAccountOwner({ name: '系统引导-C' }, 'system');
    expect(out1.named_owner).toBeUndefined();
    expect(out1.owner_id).toBeUndefined();
    const out2 = backfillAccountOwner({ name: '空 actor-D' }, '');
    expect(out2.named_owner).toBeUndefined();
  });

  it('createParticle: type=CRM_ACCOUNT + actor=alice 自动补 named_owner；查回 OK', async () => {
    const p = await createParticle('CRM_ACCOUNT', { name: '兜底测试-青煜X', industry: '智能' }, { tenantId: 'system', actor: 'alice' });
    expect(p.payload.named_owner).toBe('alice');
    expect(p.payload.owner_id).toBe('alice');
    expect(p.payload.owner).toBe('alice');
    insertedId = p.id;
    const back = await getParticle(p.id);
    expect(back.payload.named_owner).toBe('alice');
  });

  it('createParticle: enforceNamedOwner=true 但缺 named_owner 应抛错', async () => {
    await expect(createParticle('CRM_ACCOUNT', { name: '强制校验-Y' }, { tenantId: 'system', actor: 'system', enforceNamedOwner: true })).rejects.toThrow(/必填 named_owner/);
  });

  it('createParticle: actor=system + enforceNamedOwner=false（bootstrap 场景）允许无主', async () => {
    const p = await createParticle('CRM_ACCOUNT', { name: '系统种子-Z' }, { tenantId: 'system', actor: 'system' });
    expect(p.payload.named_owner).toBeUndefined();
    // 清理
    insertedId = p.id;
  });

  afterAll(async () => {
    // 不直接 DELETE（铁律：禁 DELETE），用软合并标记 merged_into=null 即可
    // 测试库清理由 setup.sql 在下次 pretest 接管，本处不操作
  });
});
