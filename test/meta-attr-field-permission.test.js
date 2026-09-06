// test/meta-attr-field-permission.test.js — 字段级 RBAC（checkFieldPermission 纯判定 + executor 第 2.5 闸 DB 集成）
// 环境限制：DB 集成块需 PG@5433（沙箱无 PG 时标注环境限制，非回归；纯判定块先绿）
import { describe, it, expect, beforeAll } from 'vitest';
import { modeFor, checkPatchPermissions } from '../src/metaAttr/fieldPermission.js';
import { query } from '../src/db.js';
import { resetRegistry } from '../src/action/registry.js';
import { seedActions } from '../src/action/seed-actions.js';
import { actionExecutor } from '../src/action/executor.js';
import { seedMetaAttr, setMetaAttr } from '../src/metaAttr/metaAttrRepo.js';
import { seedProfiles } from '../src/context/roleProfiles.js';
import { createParticle } from '../src/particles/particleRepo.js';

describe('modeFor 纯判定（无 DB）', () => {
  it('未配置角色 → editable；hidden/readonly 按角色取', () => {
    const rec = { permission: { roles: { sales: 'editable', finance: 'hidden' } } };
    expect(modeFor(rec, 'exec')).toBe('editable');
    expect(modeFor(rec, 'finance')).toBe('hidden');
    expect(modeFor(rec, 'sales')).toBe('editable');
    expect(modeFor(null, 'sales')).toBe('editable');
    expect(modeFor({ permission: {} }, 'sales')).toBe('editable');
  });
});

// V3 字段级权限生效：设计 §6.3「某角色写被隐藏的私有字段 → field_denied」
// 此前仅测了 modeFor 纯逻辑，未验证第 2.5 闸（executor 接线）真正触发。
// 关键约束：第 1 闸 scope（数据范围，粗粒度）先于第 2.5 闸（字段级，细粒度）执行。
// 因此端到端用例须用「scope 放行、但字段隐藏」的角色（exec 高管档 model=all 可见全部粒子），
// 才能让第 2.5 闸被真正触达；scope 越界的角色（如 finance domain 不含 CRM_ACCOUNT）应在更前的 scope 闸被拦。
const SKIP = process.env.WB_PG_SKIP;
describe('V3 第 2.5 闸端到端（data-particle-update 字段权限）', () => {
  let execId = null, financeId = null, accountId = null;

  beforeAll(async () => {
    if (SKIP) return;
    await query(`TRUNCATE particles, edges, events, decision, decision_event, meta_attr CASCADE`).catch(() => {});
    resetRegistry(); seedActions(); await seedMetaAttr('system'); await seedProfiles();
    const exec = await createParticle('CRM_PERSON', { name: 'Exec User', role_tags: ['exec'] });
    const fin = await createParticle('CRM_PERSON', { name: 'Finance User', role_tags: ['finance'] });
    execId = exec.id; financeId = fin.id;
    // 给 CRM_ACCOUNT.name 配：对 exec 隐藏（exec 可见账户，但此字段禁写）
    await setMetaAttr('CRM_ACCOUNT', 'name',
      { permission: { roles: { exec: 'hidden' } } }, { actor: 'system' });
    const acct = await createParticle('CRM_ACCOUNT', { name: 'X 科技' });
    accountId = acct.id;
  });

  it('单元：checkPatchPermissions 对 hidden 字段拒绝、无限制字段放行', async () => {
    if (SKIP) return;
    const v1 = await checkPatchPermissions('CRM_ACCOUNT', { name: 'x' }, 'exec');
    expect(v1.ok).toBe(false);
    expect(v1.mode).toBe('hidden');
    const v2 = await checkPatchPermissions('CRM_ACCOUNT', { industry: 'y' }, 'exec');
    expect(v2.ok).toBe(true);
  });

  it('exec 写 hidden 字段 → 第 2.5 闸返回 field_permission', async () => {
    if (SKIP) return;
    const r = await actionExecutor.dispatch('data-particle-update',
      { type: 'CRM_ACCOUNT', id: accountId, patch: { name: '改不了' }, force: true,
        decision_id: '00000000-0000-0000-0000-000000000001' },
      { tenantId: 'system', actor: execId });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('field_permission');
  });

  it('exec 写无限制字段 → 第 2.5 闸放行（ok=true）', async () => {
    if (SKIP) return;
    const r = await actionExecutor.dispatch('data-particle-update',
      { type: 'CRM_ACCOUNT', id: accountId, patch: { industry: '制造业' }, force: true,
        decision_id: '00000000-0000-0000-0000-000000000002' },
      { tenantId: 'system', actor: execId });
    expect(r.ok).toBe(true);
  });

  it('scope 越界角色（finance domain 不含 CRM_ACCOUNT）在更前的 scope 闸被拦（优先级正确）', async () => {
    if (SKIP) return;
    const r = await actionExecutor.dispatch('data-particle-update',
      { type: 'CRM_ACCOUNT', id: accountId, patch: { name: 'x' }, force: true,
        decision_id: '00000000-0000-0000-0000-000000000003' },
      { tenantId: 'system', actor: financeId });
    expect(r.ok).toBe(false);
    expect(r.gate).toBe('scope_violation'); // scope 先于 field_permission，验证闸优先级
  });
});