// test/approval/gradedTier.test.js — T7 分级审批节点分发（金额 T1/T2/T3 → 节点数）
// 设计依据：docs/2026-08-31-unified-s-taxonomy-approval-design.md §3.3（分级审批）+ §3.4（拓扑）
// 机制：handler 经 resolveApprovalChain(ruleId,{amount}) 算档位链 → startInstance(approvers=链)
//   engine.resolveNodeApprover 按节点序位分发：链内 → 该审批人；链尽 → AUTO_PASS 跳过。
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { queryParticles } from '../../src/particles/particleRepo.js';
import { createFlow, addNode, addApprover, addLink } from '../../src/approval/flow.js';
import { startInstance, advanceTask } from '../../src/approval/engine.js';
import { resolveApprovalChain } from '../../src/approval/ruleResolver.js';

async function tasksOf(instId) {
  return (await queryParticles({ type: 'CRM_APPROVAL_TASK' }))
    .filter((t) => t.payload.instance_id === instId)
    .sort((a, b) => (a.payload.seq ?? 99) - (b.payload.seq ?? 99));
}

// 构建经理→总监→总裁 三级链（APPROVER 序位 0/1/2，与 pos 绝对编号无关）
async function buildThreeNodeFlow() {
  const flow = await createFlow({ name: '三级审批链', enabled: true });
  const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
  const a = await addNode(flow.id, { node_type: 'APPROVER', name: 'A经理', pos: 1 });
  const b = await addNode(flow.id, { node_type: 'APPROVER', name: 'B总监', pos: 2 });
  const c = await addNode(flow.id, { node_type: 'APPROVER', name: 'C总裁', pos: 3 });
  const end = await addNode(flow.id, { node_type: 'END', name: '结束', pos: 4 });
  await addLink(start.id, a.id, {});
  await addLink(a.id, b.id, {});
  await addLink(b.id, c.id, {});
  await addLink(c.id, end.id, {});
  await addApprover(a.id, { approver_type: 'ROLE', role: 'manager', multi_approver_mode: 'ANY' });
  await addApprover(b.id, { approver_type: 'ROLE', role: 'director', multi_approver_mode: 'ANY' });
  await addApprover(c.id, { approver_type: 'ROLE', role: 'president', multi_approver_mode: 'ANY' });
  return { flow, a, b, c, end };
}

// 按档位链驱动：逐节点签完，返回终态
async function drive(inst, signers) {
  for (const signer of signers) {
    const t = (await tasksOf(inst.id)).find((x) => x.payload.status === 'TODO' && x.payload.approver === signer);
    if (!t) break;
    const r = await advanceTask(inst.id, t.id, { approver: signer, decision: 'approve' });
    if (r.status === 'APPROVED') return r;
  }
  return advanceTask(inst.id, (await tasksOf(inst.id))[0].id, { approver: 'role:manager', decision: 'approve' });
}

describe('【T7-分级】resolveApprovalChain 档位链', () => {
  it('R2 按金额映射 T1/T2/T3 审批链节点数', () => {
    expect(resolveApprovalChain('R2', { amount: 50_000 }).approverChain).toEqual(['manager']);                       // T1
    expect(resolveApprovalChain('R2', { amount: 2_000_000 }).approverChain).toEqual(['manager', 'director']);          // T2
    expect(resolveApprovalChain('R2', { amount: 9_000_000 }).approverChain).toEqual(['manager', 'director', 'president']); // T3
  });
  it('R4 固定财务VP（无分级）', () => {
    expect(resolveApprovalChain('R4', { amount: 9_000_000 }).approverChain).toEqual(['finance_vp']);
  });
});

describe('【T7-分级】engine 按档位链分发节点（T1/T2/T3 节点数）', () => {
  beforeEach(async () => {
    await query(`TRUNCATE particles, edges, events CASCADE`);
  });

  it('T1（链=[manager]）：仅经理签，总监/总裁 AUTO_PASS 跳过 → 1 次签批即 APPROVED', async () => {
    const { flow, end } = await buildThreeNodeFlow();
    const inst = await startInstance(flow.id, 'QUOTATION', 'q-t1', { amount: 50_000 }, { submitter: 'u1', approvers: ['manager'] });
    // 首节点 = 经理
    let tasks = await tasksOf(inst.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.approver).toBe('role:manager');
    const r = await advanceTask(inst.id, tasks[0].id, { approver: 'role:manager', decision: 'approve' });
    expect(r.status).toBe('APPROVED'); // 总监/总裁被跳过
    const final = await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' });
    const f = final.find((x) => x.id === inst.id);
    expect(f.payload.status).toBe('APPROVED');
    expect(f.payload.current_node).toBe(end.id); // 末节点（END）落点
  });

  it('T2（链=[manager,director]）：经理+总监签，总裁跳过 → 2 次签批 APPROVED', async () => {
    const { flow, b, end } = await buildThreeNodeFlow();
    const inst = await startInstance(flow.id, 'QUOTATION', 'q-t2', { amount: 2_000_000 }, { submitter: 'u1', approvers: ['manager', 'director'] });
    // 首节点经理
    const tasks0 = await tasksOf(inst.id);
    expect(tasks0[0].payload.approver).toBe('role:manager');
    await advanceTask(inst.id, tasks0[0].id, { approver: 'role:manager', decision: 'approve' });
    // 推进到总监
    let tasks = await tasksOf(inst.id);
    const dTask = tasks.find((t) => t.payload.node_id === b.id && t.payload.status === 'TODO');
    expect(dTask.payload.approver).toBe('role:director');
    const r = await advanceTask(inst.id, dTask.id, { approver: 'role:director', decision: 'approve' });
    expect(r.status).toBe('APPROVED'); // 总裁被跳过
    const f = (await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' })).find((x) => x.id === inst.id);
    expect(f.payload.status).toBe('APPROVED');
    expect(f.payload.current_node).toBe(end.id);
  });

  it('T3（链=[manager,director,president]）：三节点全签 → APPROVED', async () => {
    const { flow, end } = await buildThreeNodeFlow();
    const inst = await startInstance(flow.id, 'QUOTATION', 'q-t3', { amount: 9_000_000 }, { submitter: 'u1', approvers: ['manager', 'director', 'president'] });
    await drive(inst, ['role:manager', 'role:director', 'role:president']);
    const f = (await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' })).find((x) => x.id === inst.id);
    expect(f.payload.status).toBe('APPROVED');
    expect(f.payload.current_node).toBe(end.id);
  });

  it('未传 approvers（向后兼容）：回退 seeded role → 三节点全签（等同 T3 满链）', async () => {
    const { flow, end } = await buildThreeNodeFlow();
    const inst = await startInstance(flow.id, 'QUOTATION', 'q-compat', { amount: 9_000_000 }, { submitter: 'u1' });
    // 首节点回退 seeded → 经理
    expect((await tasksOf(inst.id))[0].payload.approver).toBe('role:manager');
    await drive(inst, ['role:manager', 'role:director', 'role:president']);
    const f = (await queryParticles({ type: 'CRM_APPROVAL_INSTANCE' })).find((x) => x.id === inst.id);
    expect(f.payload.status).toBe('APPROVED');
    expect(f.payload.current_node).toBe(end.id);
  });
});
