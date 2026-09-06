// test/approval/engine-node-advance.test.js — T6 引擎缺口修复验证（B1 节点推进 + C1 条件物化）
// 设计依据：docs/2026-08-31-unified-s-taxonomy-approval-design.md §5（B1/C1）
//   B1：多 APPROVER 节点链（经理→总监→总裁）一审完须推进下一节点，末节点签完才 APPROVED
//   C1：START→CONDITION(AI)→APPROVER 流，CONDITION 节点须透明跳过（不再 auto_pass 直接放行）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../../src/db.js';
import { getParticle, queryParticles, updateParticle } from '../../src/particles/particleRepo.js';
import { createFlow, addNode, addApprover, addCondition, addLink } from '../../src/approval/flow.js';
import { startInstance, advanceTask } from '../../src/approval/engine.js';
import { on } from '../../src/events/bus.js';

async function tasksOf(instId) {
  return (await queryParticles({ type: 'CRM_APPROVAL_TASK' }))
    .filter(t => t.payload.instance_id === instId)
    .sort((a, b) => (a.payload.seq ?? 99) - (b.payload.seq ?? 99));
}

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('【SSE 接线】审批引擎事件总线 emit（approval 域）', () => {
  // 引擎签批须 emit approval 域事件（task-approved/task-rejected/instance-withdrawn），
  // 否则 SSE 客户端（我的待办页）收不到签批实时刷新（此前仅 route 手动刷新）。
  it('advanceTask approve → emit task-approved（含 instance_id/task_id/decision）', async () => {
    const received = [];
    const off = on('approval', (m) => received.push(m));
    try {
      const flow = await createFlow({ name: 'SSE审批流', enabled: true });
      const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
      const app = await addNode(flow.id, { node_type: 'APPROVER', name: '审批节点', pos: 1 });
      const end = await addNode(flow.id, { node_type: 'END', name: '结束', pos: 2 });
      await addLink(start.id, app.id, {});
      await addLink(app.id, end.id, {});
      await addApprover(app.id, { approver_type: 'ROLE', role: 'admin', multi_approver_mode: 'ANY' });
      const inst = await startInstance(flow.id, 'CRM_QUOTATION', 'sse-approve-001', {}, { submitter: 'alice', approvers: ['role:admin'] });
      const t = (await tasksOf(inst.id))[0];
      const r = await advanceTask(inst.id, t.id, { approver: 'role:admin', decision: 'approve', opinion: '同意' });
      expect(r.status).toBe('APPROVED');
      const ev = received.find(e => e.type === 'task-approved');
      expect(ev).toBeTruthy();
      expect(ev.summary.instance_id).toBe(inst.id);
      expect(ev.summary.task_id).toBe(t.id);
      expect(ev.summary.decision).toBe('approve');
      expect(ev.domain).toBe('approval');
    } finally {
      off();
    }
  });

  it('advanceTask reject → emit task-rejected', async () => {
    const received = [];
    const off = on('approval', (m) => received.push(m));
    try {
      const flow = await createFlow({ name: 'SSE审批流2', enabled: true });
      const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
      const app = await addNode(flow.id, { node_type: 'APPROVER', name: '审批节点', pos: 1 });
      const end = await addNode(flow.id, { node_type: 'END', name: '结束', pos: 2 });
      await addLink(start.id, app.id, {});
      await addLink(app.id, end.id, {});
      await addApprover(app.id, { approver_type: 'ROLE', role: 'admin', multi_approver_mode: 'ANY' });
      const inst = await startInstance(flow.id, 'CRM_QUOTATION', 'sse-reject-001', {}, { submitter: 'alice', approvers: ['role:admin'] });
      const t = (await tasksOf(inst.id))[0];
      const r = await advanceTask(inst.id, t.id, { approver: 'role:admin', decision: 'reject', opinion: '不同意' });
      expect(r.status).toBe('REJECTED');
      const ev = received.find(e => e.type === 'task-rejected');
      expect(ev).toBeTruthy();
      expect(ev.summary.instance_id).toBe(inst.id);
      expect(ev.summary.decision).toBe('reject');
    } finally {
      off();
    }
  });
});

describe('【T6-B1】节点间推进状态机（多审批人链）', () => {
  // 构建 START → A(经理) → B(总监) → C(总裁) → END 三级链
  async function buildChainFlow() {
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
    return { flow, start, a, b, c, end };
  }

  it('起单落在首节点 A，一审完推进到 B（不提前终态）', async () => {
    const { flow, a, b } = await buildChainFlow();
    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-chain', { amount: 9_000_000 }, { submitter: 'u1' });
    expect(inst.payload.status).toBe('APPROVING');
    expect(inst.payload.current_node).toBe(a.id);

    const t = (await tasksOf(inst.id))[0];
    const r = await advanceTask(inst.id, t.id, { approver: 'role:manager', decision: 'approve' });
    expect(r.status).toBe('APPROVING');                 // 仍审批中
    const cur = await getParticle(inst.id);
    expect(cur.payload.current_node).toBe(b.id);        // 已推进到 B
    expect(cur.payload.current_node_name).toBe('B总监');
  });

  it('三级链逐节点签完才终态 APPROVED（经理→总监→总裁）', async () => {
    const { flow, a, b, c, end } = await buildChainFlow();
    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-chain2', { amount: 9_000_000 }, { submitter: 'u1' });

    // A 经理
    let tasks = await tasksOf(inst.id);
    expect(tasks[0].payload.approver).toBe('role:manager');
    await advanceTask(inst.id, tasks[0].id, { approver: 'role:manager', decision: 'approve' });
    expect((await getParticle(inst.id)).payload.current_node).toBe(b.id);

    // B 总监
    tasks = await tasksOf(inst.id);
    const bTask = tasks.find(t => t.payload.node_id === b.id && t.payload.status === 'TODO');
    expect(bTask.payload.approver).toBe('role:director');
    await advanceTask(inst.id, bTask.id, { approver: 'role:director', decision: 'approve' });
    expect((await getParticle(inst.id)).payload.current_node).toBe(c.id);

    // C 总裁
    tasks = await tasksOf(inst.id);
    const cTask = tasks.find(t => t.payload.node_id === c.id && t.payload.status === 'TODO');
    expect(cTask.payload.approver).toBe('role:president');
    const r = await advanceTask(inst.id, cTask.id, { approver: 'role:president', decision: 'approve' });
    expect(r.status).toBe('APPROVED');
    const final = await getParticle(inst.id);
    expect(final.payload.status).toBe('APPROVED');
    expect(final.payload.current_node).toBe(end.id);    // 末节点签完落到 END
  });
});

describe('【T6-C1】CONDITION(AI) 节点透明物化', () => {
  it('START→CONDITION→APPROVER 流：起单落在 APPROVER（不再 auto_pass 直接放行）', async () => {
    const flow = await createFlow({ name: 'AI闸流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const cond = await addNode(flow.id, { node_type: 'CONDITION', name: 'AI自动校验', pos: 1 });
    const app = await addNode(flow.id, { node_type: 'APPROVER', name: '人工审批', pos: 2 });
    const end = await addNode(flow.id, { node_type: 'END', name: '结束', pos: 3 });
    const condP = await addCondition(cond.id, { field: 'amount', operator: 'GT', value: 5_000_000 });
    await addLink(start.id, cond.id, {});
    await addLink(cond.id, app.id, {});                  // 默认（PASS）分支
    await addLink(cond.id, app.id, { condition_ref: condP.id }); // FLAG 分支（同节点，演示条件双链）
    await addLink(app.id, end.id, {});
    await addApprover(app.id, { approver_type: 'ROLE', role: 'manager', multi_approver_mode: 'ANY' });

    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-cond', { amount: 1_000 }, { submitter: 'u1' });
    // C1 修复前：CONDITION 无审批人 → auto_pass → APPROVED；修复后：透明落到 APPROVER
    expect(inst.payload.status).toBe('APPROVING');
    expect(inst.payload.current_node).toBe(app.id);
    expect(inst.payload.current_node_name).toBe('人工审批');

    // 签 APPROVER → END → APPROVED
    const t = (await tasksOf(inst.id))[0];
    const r = await advanceTask(inst.id, t.id, { approver: 'role:manager', decision: 'approve' });
    expect(r.status).toBe('APPROVED');
  });
});

describe('【回归】待签任务 status 大小写归一（小写 todo 也能签）', () => {
  // 背景：seed.sql 历史约定用小写 'todo'，而 engine.advanceTask 原严格按大写 'TODO' 过滤，
  // 导致「列表可见、点批准却报 审批任务不存在或已处理」。修复后引擎对 status 做大小写归一。
  it('种子数据用小写 todo 时 advanceTask 仍能定位并签批', async () => {
    const flow = await createFlow({ name: '小写回归流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const a = await addNode(flow.id, { node_type: 'APPROVER', name: 'A经理', pos: 1 });
    const end = await addNode(flow.id, { node_type: 'END', name: '结束', pos: 2 });
    await addLink(start.id, a.id, {});
    await addLink(a.id, end.id, {});
    await addApprover(a.id, { approver_type: 'ROLE', role: 'manager', multi_approver_mode: 'ANY' });

    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-case', { amount: 9_000_000 }, { submitter: 'u1' });
    const t = (await tasksOf(inst.id))[0];
    expect(t.payload.status).toBe('TODO'); // 引擎默认写大写
    // 模拟 seed.sql 小写约定：把任务状态翻成小写 todo
    await updateParticle(t.id, { patch: { ...t.payload, status: 'todo' } });
    expect((await tasksOf(inst.id))[0].payload.status).toBe('todo');
    // 修复前此处抛「审批任务不存在或已处理」；修复后单节点链签完即终态 APPROVED
    const r = await advanceTask(inst.id, t.id, { approver: 'role:manager', decision: 'approve' });
    expect(r.status).toBe('APPROVED');
  });
});
