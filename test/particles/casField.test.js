// test/particles/casField.test.js — A-B4 字段级 CAS（S4 回写安全地基）
// 契约：updateParticle 支持 casExpectField {path, value}，WHERE 层校验；
//   不匹配（外部已改）→ rowCount=0 → throw 'cas_mismatch' 并回传最新值（不静默覆盖）
import { describe, it, expect, beforeAll } from 'vitest';
import { createParticle, updateParticle, getParticle } from '../../src/particles/particleRepo.js';

const TID = 'system';
const slug = (p) => `cas-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

describe('particle CAS field（A-B4 字段级 CAS）', () => {
  let pid;
  beforeAll(async () => {
    const p = await createParticle('CRM_ACCOUNT', { name: slug('acct'), ai_fit_score: 80 }, { tenantId: TID, actor: 'alice' });
    pid = p.id;
  });

  it('casExpectField 命中 → 更新成功', async () => {
    const p = await updateParticle(pid, {
      patch: { ai_fit_score: 90 },
      casExpectField: { path: 'ai_fit_score', value: 80 },
      systemBypass: true,
    });
    expect(p.payload.ai_fit_score).toBe(90);
  });

  it('casExpectField 不匹配（外部已改）→ throw cas_mismatch 并回传最新值', async () => {
    // 先把字段改成 95（模拟外部已修改），再带旧期望值 80 更新 → 应拒绝
    await updateParticle(pid, { patch: { ai_fit_score: 95 }, systemBypass: true });
    let err = null;
    try {
      await updateParticle(pid, {
        patch: { ai_fit_score: 100 },
        casExpectField: { path: 'ai_fit_score', value: 80 }, // 期望旧值，实际 95
        systemBypass: true,
      });
    } catch (e) { err = e; }
    expect(err).toBeTruthy();
    expect(String(err.message)).toContain('cas_mismatch');
    expect(String(err.message)).toContain('95'); // 回传最新值
    const cur = await getParticle(pid);
    expect(cur.payload.ai_fit_score).toBe(95); // 未被覆盖
  });
});
