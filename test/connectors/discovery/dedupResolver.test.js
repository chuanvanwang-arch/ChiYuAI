// test/connectors/discovery/dedupResolver.test.js
import { describe, it, expect, vi } from 'vitest';
import { resolveExistingOrCreate } from '../../../src/connectors/discovery/dedupResolver.js';

describe('dedupResolver', () => {
  it('finds existing account by domain before create', async () => {
    const find = vi.fn(async () => ({ id: 'acc-existing' }));
    const create = vi.fn(async () => ({ id: 'acc-new' }));
    const out = await resolveExistingOrCreate('CRM_ACCOUNT', { domain: 'x.com', name: 'X' }, { find, create });
    expect(find).toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(out.id).toBe('acc-existing');
  });

  // ⚠ 契约校正（2026-09-11）：原稿把「并发兜底」写成「第二次 create 成功」——与实现语义相反。
  //   实现语义 = 唯一约束冲突（23505）后**重查赢家**（find 二次命中）→ 转 update 或直接复用，
  //   **绝不重试 create**（重试 = 可能建出重复行）。原稿测试必然失败（find 恒 null → 无赢家 → throw e）。
  it('concurrent unique-constraint collision falls back to the winner found by re-query', async () => {
    const find = vi.fn()
      .mockResolvedValueOnce(null)          // 首轮扫描：未命中
      .mockResolvedValue({ id: 'acc-race' }); // 冲突后重查：并发赢家已落库
    const create = vi.fn().mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    const out = await resolveExistingOrCreate('CRM_ACCOUNT', { domain: 'y.com' }, { find, create });
    expect(create).toHaveBeenCalledTimes(1); // 绝不重试 create
    expect(out.id).toBe('acc-race');
  });

  it('honors config-driven criteria groups (OR) instead of hardcoded keys', async () => {
    const find = vi.fn(async () => null);
    const create = vi.fn(async () => ({ id: 'acc-cfg' }));
    const out = await resolveExistingOrCreate('CRM_ACCOUNT', { domain: 'z.com' }, {
      find, create,
      criteria: [['domain'], ['vat_id']], // 来自 config.duplicate_criteria，非硬编码
    });
    expect(find).toHaveBeenCalledWith('CRM_ACCOUNT', 'domain', 'z.com');
    expect(create).toHaveBeenCalled();
    expect(out.id).toBe('acc-cfg');
  });
});
