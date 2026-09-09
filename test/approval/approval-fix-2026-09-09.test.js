// test/approval/approval-fix-2026-09-09.test.js — 审批失效根治 + 写入侧两缺陷 锚点用例
// 设计文档：docs/2026-09-09-approval-failure-and-write-side-fix-design.md
//
// 背景（用户报）：「起单即通过，presales 和 manager 没有任何人签批。这不是审批通过，是审批失效。」
// 根因：engine.js 把 empty_approver_action='AUTO_PASS' 的判定排在 ROLE 规则之前 →
//       生产 63 条规则中 50 条（含 role:presales / role:manager）被整体架空。
//
// 本文件锁定 4 条不可回退的锚点：
//   ① AUTO_PASS 不得架空 ROLE（判定顺序）
//   ② crm-approval-start 支持 approvers 透传
//   ③ requireFullChain fail-closed（链长 < 节点数 → 拒绝起单，不静默跳审）
//   ④ meta_attr 并发登记幂等（不再撞 meta_attr_pkey 抛错 → 不再留孤儿粒子）
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { createFlow, addNode, addApprover, addLink } from '../../src/approval/flow.js';
import { queryParticles } from '../../src/particles/particleRepo.js';
import { ensureAdaptiveRegistration, getMetaAttr } from '../../src/metaAttr/metaAttrRepo.js';
import { seedActions } from '../../src/action/seed-actions.js';
import { actionExecutor } from '../../src/action/executor.js';

beforeAll(() => seedActions());
beforeEach(async () => { await query(`TRUNCATE particles, edges, events CASCADE`); });

// 两节点审批流：node1(presales) → node2(manager)，两节点规则均显式配成 AUTO_PASS
// （复刻生产形态：50/63 条规则为 AUTO_PASS 且带 role）
async function buildTwoNodeFlow(name = '报价审批流') {
  const flow = await createFlow({ name, enabled: true });
  const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
  const n1 = await addNode(flow.id, { node_type: 'APPROVER', name: '售前审核', pos: 1 });
  const n2 = await addNode(flow.id, { node_type: 'APPROVER', name: '经理审批', pos: 2 });
  await addLink(start.id, n1.id, {});
  await addLink(n1.id, n2.id, {});
  await addApprover(n1.id, { approver_type: 'ROLE', role: 'presales', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });
  await addApprover(n2.id, { approver_type: 'ROLE', role: 'manager', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });
  return { flow, n1, n2 };
}

const CTX = { tenantId: 'system', actor: 'alice', decision_id: 'd-appr-fix', channel: 'system' };

describe('审批失效根治（2026-09-09）', () => {
  it('① 反锚点：AUTO_PASS + ROLE 规则 → 起单为 APPROVING，生成真实待签任务（不得起单即通过）', async () => {
    const { flow, n1 } = await buildTwoNodeFlow();
    const r = await actionExecutor.dispatch(
      'crm-approval-start',
      { flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'q-fix-1', ctx: { amount: 10000 }, force: true },
      CTX,
    );
    expect(r.ok).toBe(true);
    const inst = r.result || r.data || r;
    const instId = inst.payload?.id || inst.id;
    const got = await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' });
    const instRow = got.find((p) => p.id === instId) || got[0];
    // 修复前：AUTO_PASS 抢在 ROLE 之前 → APPROVED（审批失效）
    expect(instRow.payload.status).toBe('APPROVING');

    const tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK' }))
      .filter((t) => t.payload.instance_id === instRow.id);
    expect(tasks).toHaveLength(1);
    // 首个节点规则是 role:presales → 待签任务必须落在售前，而不是被 AUTO_PASS 吞掉
    expect(tasks[0].payload.approver).toBe('role:presales');
    expect(tasks[0].payload.status).toBe('TODO');
    expect(n1.id).toBeTruthy();
  });

  it('② approvers 透传：显式指定审批链 → 落实例 tier_approvers 且首节点按链首位派签', async () => {
    const { flow } = await buildTwoNodeFlow('透传审批流');
    const r = await actionExecutor.dispatch(
      'crm-approval-start',
      {
        flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'q-fix-2',
        ctx: { amount: 10000 }, approvers: ['role:presales', 'role:manager'], force: true,
      },
      CTX,
    );
    expect(r.ok).toBe(true);
    const instRow = (await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' }))[0];
    expect(instRow.payload.status).toBe('APPROVING');
    expect(instRow.payload.tier_approvers).toEqual(['role:presales', 'role:manager']);
    const tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK' }))
      .filter((t) => t.payload.instance_id === instRow.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.approver).toBe('role:presales');
  });

  it('③ fail-closed：显式链长 < 审批节点数 → 拒绝起单，不产生实例（避免静默跳审）', async () => {
    const { flow } = await buildTwoNodeFlow('链长不足流');
    const before = (await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' })).length;
    const r = await actionExecutor.dispatch(
      'crm-approval-start',
      {
        flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'q-fix-3',
        ctx: { amount: 10000 }, approvers: ['role:presales'], force: true,  // 只 1 个，却有 2 个审批节点
      },
      CTX,
    );
    // executor 捕获 handler 异常 → 返回 { ok:false, error }（不 reject）
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/审批链长度 1 少于审批节点数 2/);
    expect(r.error).toMatch(/fail-closed/);
    // 关键：拒绝后**没有**留下半截实例（起单前校验，无需回滚，符合禁删铁律）
    const after = (await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' })).length;
    expect(after).toBe(before);
  });

  it('④ 真·无审批人时 AUTO_PASS 语义保留（字段本意：解析不出审批人才自动通过）', async () => {
    const flow = await createFlow({ name: '空审批人流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '无人', pos: 1 });
    await addLink(start.id, n.id, {});
    await addApprover(n.id, { multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' }); // 无 approver_type/role
    const r = await actionExecutor.dispatch(
      'crm-approval-start',
      { flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'q-fix-4', ctx: {}, force: true },
      CTX,
    );
    expect(r.ok).toBe(true);
    const instRow = (await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' }))[0];
    expect(instRow.payload.status).toBe('APPROVED');
    expect(instRow.payload.auto_pass_reason).toBe('empty_approver AUTO_PASS');
  });
});

describe('meta_attr 并发登记幂等（孤儿粒子根治）', () => {
  it('20 并发登记同一 (type, slug, tenant) → 不抛错、meta_attr 仅 1 行', async () => {
    const slug = `conc_fix_${Math.random().toString(36).slice(2, 10)}`;
    const type = 'CRM_DEAL';
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        ensureAdaptiveRegistration(type, { [slug]: 'v1' }, 'system', 'test')),
    );
    // 修复前：check-then-act 竞态 → 部分 promise 撞 meta_attr_pkey rejected
    //   → 而粒子已在 particleRepo.js 的 INSERT 处落库 → 孤儿粒子
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const row = await getMetaAttr(type, slug, 'system');
    expect(row).toBeTruthy();                       // 至少 1 行
    const all = await query(
      `SELECT count(*)::int AS n FROM crm.meta_attr WHERE particle_type=$1 AND attr_slug=$2 AND tenant_id='system'`,
      [type, slug],
    );
    expect(all.rows[0].n).toBe(1);                  // 且**只有** 1 行（主键唯一，无重复）
  });
});
