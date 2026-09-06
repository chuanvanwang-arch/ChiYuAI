// test/particles/particleRepo-decision-gate.test.js
// 待办②（2026-09-03）深度防御：particles.decision_id 软强制 + 系统豁免 + 值持久化
// 依赖测试库已含 decision_id 列（db/migrate.js 对 crm_native_test 应用 ALTER 补列）+ FK 引用 crm.decision。
import { describe, it, expect, beforeAll } from 'vitest';
import { createParticle, updateParticle, getParticle } from '../../src/particles/particleRepo.js';
import { requireDecision } from '../../src/decision/autonomyEngine.js';

const TID = 'system';
const slug = (p) => `dg-${p}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// 铸造真实决策（FK 要求 decision_id 必须存在 crm.decision），供值持久化用例使用
async function mintRealDecision() {
  const res = await requireDecision(
    'OPP_QUALIFY',
    { test: true },
    [{ type: 'CRM_DEAL', id: '00000000-0000-0000-0000-000000000001' }],
    { actor_id: 'alice' }
  );
  return res.decision.decision_id;
}

describe('particles.decision_id 软强制（待办②）', () => {
  let realDid;
  beforeAll(async () => { realDid = await mintRealDecision(); });

  it('业务写 requireDecisionId 缺省(undefined)：不抛，decision_id 落库 NULL（向后兼容）', async () => {
    const p = await createParticle('CRM_KNOWLEDGE', { term: slug('compat'), type: 't', layer: 'L1' }, { tenantId: TID, actor: 'alice' });
    expect(p.decision_id).toBeNull();
  });

  it('业务写 requireDecisionId=真实uuid：decision_id 持久化锚定（FK 保证引用完整性）', async () => {
    const p = await createParticle('CRM_KNOWLEDGE', { term: slug('value'), type: 't', layer: 'L1' }, { tenantId: TID, actor: 'alice', requireDecisionId: realDid });
    expect(p.decision_id).toBe(realDid);
    const back = await getParticle(p.id);
    expect(back.decision_id).toBe(realDid);
  });

  it('业务写 requireDecisionId=伪造uuid：FK 违例（拒绝垃圾决策锚定，深度防御）', async () => {
    await expect(
      createParticle('CRM_KNOWLEDGE', { term: slug('fake'), type: 't', layer: 'L1' }, { tenantId: TID, actor: 'alice', requireDecisionId: '99999999-9999-9999-9999-999999999999' })
    ).rejects.toThrow(/foreign key|fkey|decision_id/);
  });

  it('软强制 requireDecisionId=true + actor=alice + 无 decision_id：抛「缺 decision_id」', async () => {
    await expect(
      createParticle('CRM_KNOWLEDGE', { term: slug('enforce'), type: 't', layer: 'L1' }, { tenantId: TID, actor: 'alice', requireDecisionId: true })
    ).rejects.toThrow(/缺 decision_id/);
  });

  it('软强制 requireDecisionId=true + actor=alice + payload.decision_id 有值：不抛，落库', async () => {
    const p = await createParticle('CRM_KNOWLEDGE', { term: slug('payload'), type: 't', layer: 'L1', decision_id: realDid }, { tenantId: TID, actor: 'alice', requireDecisionId: true });
    expect(p.decision_id).toBe(realDid);
  });

  it('系统豁免 requireDecisionId=true + actor=system：不抛，decision_id NULL', async () => {
    const p = await createParticle('CRM_KNOWLEDGE', { term: slug('sys'), type: 't', layer: 'L1' }, { tenantId: TID, actor: 'system', requireDecisionId: true });
    expect(p.decision_id).toBeNull();
  });

  it('系统豁免 systemBypass=true + actor=alice + requireDecisionId=true：不抛，decision_id NULL', async () => {
    const p = await createParticle('CRM_KNOWLEDGE', { term: slug('bypass'), type: 't', layer: 'L1' }, { tenantId: TID, actor: 'alice', systemBypass: true, requireDecisionId: true });
    expect(p.decision_id).toBeNull();
  });

  it('updateParticle requireDecisionId=真实uuid：decision_id 落库锚定', async () => {
    const p = await createParticle('CRM_KNOWLEDGE', { term: slug('upd'), type: 't', layer: 'L1' }, { tenantId: TID, actor: 'alice' });
    const u = await updateParticle(p.id, { patch: { foo: 'bar' }, requireDecisionId: realDid });
    expect(u.decision_id).toBe(realDid);
  });
});
