// test/approval-engine.test.js — 审批引擎（状态机/路由/模式/兜底/回滚；Task 3-7 测试）
// API 对齐：stateMachine 导出 INSTANCE_STATES/OPERATIONS_BY_STATE/canTransition/assertTransition/nextState
//          flow.js 导出 createFlow/addNode/addApprover/addCondition/addLink（Task 2 已建）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { queryParticles, getParticle } from '../src/particles/particleRepo.js';
import { canTransition, assertTransition, nextState, OPERATIONS_BY_STATE, INSTANCE_STATES } from '../src/approval/stateMachine.js';
import { createFlow, addNode, addApprover, addCondition, addLink } from '../src/approval/flow.js';

// 通用辅助：按 seq 升序列出实例下任务（Task 4 补强测试用）
async function listApprovalTasks(instance_id) {
  return (await queryParticles({ type: 'CRM_APPROVAL_TASK' }))
    .filter(t => t.payload.instance_id === instance_id)
    .sort((a, b) => (a.payload.seq ?? 99) - (b.payload.seq ?? 99));
}

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);
});

describe('审批实例状态机（状态×操作矩阵，Task 3）', () => {
  it('五态清单完整（PENDING_SUBMIT/APPROVING/APPROVED/REJECTED/CANCELED）', () => {
    expect(INSTANCE_STATES).toEqual(['PENDING_SUBMIT', 'APPROVING', 'APPROVED', 'REJECTED', 'CANCELED']);
  });

  it('合法流转：PENDING_SUBMIT→APPROVING→APPROVED/REJECTED/CANCELED', () => {
    expect(canTransition('PENDING_SUBMIT', 'submit')).toBe(true);
    expect(canTransition('APPROVING', 'approve_all')).toBe(true);
    expect(canTransition('APPROVING', 'approve_any')).toBe(true);
    expect(canTransition('APPROVING', 'reject')).toBe(true);
    expect(canTransition('APPROVING', 'cancel')).toBe(true);
    expect(canTransition('APPROVING', 'withdraw')).toBe(true);
  });

  it('非法操作拒绝：PENDING_SUBMIT 不可直接 approve_all（须先 submit）', () => {
    expect(canTransition('PENDING_SUBMIT', 'approve_all')).toBe(false);
    expect(() => assertTransition('PENDING_SUBMIT', 'approve_all')).toThrow();
  });

  it('终态保护：APPROVED/REJECTED 不可再审批（仅 view）', () => {
    expect(canTransition('APPROVED', 'approve_all')).toBe(false);
    expect(canTransition('APPROVED', 'reject')).toBe(false);
    expect(canTransition('REJECTED', 'approve_all')).toBe(false);
    expect(canTransition('REJECTED', 'submit')).toBe(false);
  });

  it('状态×操作矩阵完整（五态全覆盖）', () => {
    const states = Object.keys(OPERATIONS_BY_STATE).sort();
    expect(states).toEqual(['PENDING_SUBMIT', 'APPROVING', 'APPROVED', 'REJECTED', 'CANCELED'].sort());
  });

  it('nextState 状态推进正确', () => {
    expect(nextState('PENDING_SUBMIT', 'submit')).toBe('APPROVING');
    expect(nextState('APPROVING', 'approve_all')).toBe('APPROVED');
    expect(nextState('APPROVING', 'approve_any')).toBe('APPROVED');
    expect(nextState('APPROVING', 'reject')).toBe('REJECTED');
    expect(nextState('APPROVING', 'cancel')).toBe('CANCELED');
  });
});

describe('审批引擎（条件路由/三种模式/兜底，Task 4）', () => {
  it('条件分支：金额>10万走多级审批，否则部门负责人（G22 实证）', async () => {
    const flow = await createFlow({ name: '报价审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const dept = await addNode(flow.id, { node_type: 'APPROVER', name: '部门负责人', pos: 1 });
    const multi = await addNode(flow.id, { node_type: 'APPROVER', name: '多级上级', pos: 2 });
    const cond = await addCondition(multi.id, { field: 'amount', operator: 'GT', value: 100000 });
    await addLink(start.id, dept.id, {});   // 无条件默认边（F4：先扫条件边，最后回退默认边）
    await addLink(start.id, multi.id, { condition_ref: cond.id });
    await addApprover(dept.id, { approver_type: 'DEPT_HEAD', multi_approver_mode: 'ANY' });
    await addApprover(multi.id, { approver_type: 'MULTIPLE_SUPERIOR', multi_approver_mode: 'ANY' });

    const { startInstance } = await import('../src/approval/engine.js');
    const instSmall = await startInstance(flow.id, 'QUOTATION', 'deal-1', { amount: 50000 }, { submitter: 'u1' });
    expect(instSmall.payload.current_node_name).toBe('部门负责人');

    const instBig = await startInstance(flow.id, 'QUOTATION', 'deal-2', { amount: 200000 }, { submitter: 'u1' });
    expect(instBig.payload.current_node_name).toBe('多级上级');
  });

  // 2026-09-09 审批失效根治：原用例固件为「ROLE:contract-admin + AUTO_PASS + approvers:[] → 断言 APPROVED」，
  // 该断言**锚定的正是被扭曲的语义**——节点规则明明配了 role（审批人非空），却因 AUTO_PASS 判定排在 ROLE
  // 之前而被架空、起单即通过。现拆成两条，分别锁定两种语义：
  it('兜底 AUTO_PASS：审批人**确实为空**（无 approver_type / 无 role）→ 自动通过', async () => {
    const flow = await createFlow({ name: '空审批人兜底流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '无人节点', pos: 1 });
    await addLink(start.id, n.id, {});
    // 只声明 empty_approver_action，不给 approver_type/role → 审批人真的解析不出
    await addApprover(n.id, { multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });

    const { startInstance } = await import('../src/approval/engine.js');
    const inst = await startInstance(flow.id, 'CONTRACT', 'c1', { amount: 10000 }, { submitter: 'u1', approvers: [] });
    expect(inst.payload.status).toBe('APPROVED');  // 真·无审批人 → AUTO_PASS 兜底（字段本意）
    expect(inst.payload.auto_pass_reason).toBe('empty_approver AUTO_PASS');
  });

  it('审批失效反锚点：AUTO_PASS 不得架空 ROLE 规则（配了 role 就必须生成待签任务）', async () => {
    const flow = await createFlow({ name: '合同审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '商务', pos: 1 });
    await addLink(start.id, n.id, {});
    await addApprover(n.id, { approver_type: 'ROLE', role: 'contract-admin', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });

    const { startInstance } = await import('../src/approval/engine.js');
    const inst = await startInstance(flow.id, 'CONTRACT', 'c1', { amount: 10000 }, { submitter: 'u1', approvers: [] });
    // 修复前：AUTO_PASS 抢在 ROLE 之前 → APPROVED（起单即通过，审批失效）
    // 修复后：ROLE 规则优先 → APPROVING + 1 条 role:contract-admin 待签任务
    expect(inst.payload.status).toBe('APPROVING');
    const tasks = await listApprovalTasks(inst.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].payload.approver).toBe('role:contract-admin');
    expect(tasks[0].payload.status).toBe('TODO');
  });

  it('SEQUENTIAL 顺序签全链路：逐次 approve，最后一人通过才 APPROVED（顺序闸拒绝越序）', async () => {
    const flow = await createFlow({ name: '逐级审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const chain = await addNode(flow.id, { node_type: 'APPROVER', name: '两级审批', pos: 1 });
    await addLink(start.id, chain.id, {});
    await addApprover(chain.id, { approver_type: 'ROLE', role: 'chain-approver', multi_approver_mode: 'SEQUENTIAL' });

    const { startInstance, advanceTask } = await import('../src/approval/engine.js');
    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-seq', { amount: 5000 }, {
      submitter: 'u1',
      approvers: ['role:manager', 'role:director'],   // 两审批人 → SEQUENTIAL 按序签
    });
    expect(inst.payload.status).toBe('APPROVING');

    const tasks = await listApprovalTasks(inst.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[0].payload.seq).toBe(1);   // 序位可见：第一个先签
    expect(tasks[1].payload.seq).toBe(2);

    // 顺序闸：第二人企图越序先签 → 引擎拒绝
    await expect(advanceTask(inst.id, tasks[1].id, { approver: 'role:director', decision: 'approve' }))
      .rejects.toThrow(/顺序|seq/i);

    // 第一人签 → 实例仍在审批中
    const r1 = await advanceTask(inst.id, tasks[0].id, { approver: 'role:manager', decision: 'approve', opinion: '业务确认' });
    expect(r1.status).toBe('APPROVING');

    // 最后一人签 → 实例终态 APPROVED
    const r2 = await advanceTask(inst.id, tasks[1].id, { approver: 'role:director', decision: 'approve' });
    expect(r2.status).toBe('APPROVED');

    const final = await getParticle(inst.id);
    expect(final.payload.status).toBe('APPROVED');
  });
});

describe('审批任务级操作（撤回/加签/转交，engine.js 补强）', () => {
  it('提交人撤回：APPROVING 态可撤回 → CANCELED，待办任务同撤（终态保护拒绝终态撤回）', async () => {
    const { withdrawInstance } = await import('../src/approval/engine.js');
    const flow = await createFlow({ name: '可撤回审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '审批人', pos: 1 });
    await addLink(start.id, n.id, {});
    await addApprover(n.id, { approver_type: 'ROLE', role: 'auditor', multi_approver_mode: 'ANY' });

    const { startInstance } = await import('../src/approval/engine.js');
    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-w', { amount: 1000 }, { submitter: 'u1', approvers: ['role:auditor'] });
    expect(inst.payload.status).toBe('APPROVING');

    const r = await withdrawInstance(inst.id, { by: 'u1' });
    expect(r.status).toBe('CANCELED');

    const final = await getParticle(inst.id);
    expect(final.payload.status).toBe('CANCELED');
    const tasks = await listApprovalTasks(inst.id);
    expect(tasks.every(t => t.payload.status === 'CANCELED')).toBe(true);  // 待办同撤（审计留痕）

    // 终态保护：CANCELED 不可再撤
    await expect(withdrawInstance(inst.id, { by: 'u1' })).rejects.toThrow(/状态机拒绝|CANCELED/);
  });

  it('加签：APPROVING 态追加审批人（SEQUENTIAL 尾续 seq，前序签完后新签生效）', async () => {
    const { addSignTask, startInstance, advanceTask } = await import('../src/approval/engine.js');
    const flow = await createFlow({ name: '可加签审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '两级审批', pos: 1 });
    await addLink(start.id, n.id, {});
    await addApprover(n.id, { approver_type: 'ROLE', role: 'chain', multi_approver_mode: 'SEQUENTIAL' });

    const inst = await startInstance(flow.id, 'CONTRACT', 'deal-ads', { amount: 5000 }, {
      submitter: 'u1', approvers: ['role:manager', 'role:director'],
    });
    expect(inst.payload.status).toBe('APPROVING');

    const added = await addSignTask(inst.id, { approver: 'role:finance', by: 'u1' });
    expect(added.seq).toBe(3);  // 尾续：前两位签完后第三位生效

    const tasks = await listApprovalTasks(inst.id);
    expect(tasks).toHaveLength(3);
    expect(tasks[2].payload.approver).toBe('role:finance');
    expect(tasks[2].payload.seq).toBe(3);
    expect(tasks[2].payload.added_by).toBe('u1');

    // 顺序闸仍生效：加签人（seq 3）越序先签被拒
    await expect(advanceTask(inst.id, tasks[2].id, { approver: 'role:finance', decision: 'approve' }))
      .rejects.toThrow(/顺序/);
  });

  it('转交：TODO 任务留痕 TRANSFERRED + 同位承接新任务（seq 不变，顺序闸不破序）', async () => {
    const { transferTask, startInstance, advanceTask } = await import('../src/approval/engine.js');
    const flow = await createFlow({ name: '可转交审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '审批人', pos: 1 });
    await addLink(start.id, n.id, {});
    await addApprover(n.id, { approver_type: 'ROLE', role: 'auditor', multi_approver_mode: 'SEQUENTIAL' });

    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-tr', { amount: 2000 }, {
      submitter: 'u1', approvers: ['role:manager', 'role:auditor'],
    });
    const tasks0 = await listApprovalTasks(inst.id);
    expect(tasks0[0].payload.approver).toBe('role:manager');

    // 审批人转交自己名下的 TODO 任务给他人（同 seq 承接）
    const r = await transferTask(inst.id, tasks0[0].id, { to: 'role:diretor', by: 'role:manager' });
    expect(r.transferred).toBe(tasks0[0].id);
    expect(r.seq).toBe(1);  // seq 不变：顺序闸下原序承接

    const tasks1 = await listApprovalTasks(inst.id);
    const transferred = tasks1.find(t => t.id === tasks0[0].id);
    expect(transferred.payload.status).toBe('TRANSFERRED');     // 留痕（from/to/by）
    expect(transferred.payload.transfer_by).toBe('role:manager');
    const replaced = tasks1.find(t => t.payload.seq === 1 && t.payload.status === 'TODO');
    expect(replaced.payload.approver).toBe('role:diretor');     // 同位承接
  });

  it('退回：打回节点重审（back 语义）——任务 RETURNED 留痕、打回节点新任务 seq 重排、实例仍 APPROVING', async () => {
    const { returnTask, startInstance, advanceTask } = await import('../src/approval/engine.js');
    const flow = await createFlow({ name: '可退回审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const n = await addNode(flow.id, { node_type: 'APPROVER', name: '审批人', pos: 1 });
    await addLink(start.id, n.id, {});
    await addApprover(n.id, { approver_type: 'ROLE', role: 'auditor', multi_approver_mode: 'ANY' });

    const inst = await startInstance(flow.id, 'QUOTATION', 'deal-r', { amount: 2000 }, {
      submitter: 'u1', approvers: ['role:auditor'],
    });
    expect(inst.payload.status).toBe('APPROVING');
    const tasks0 = await listApprovalTasks(inst.id);
    expect(tasks0).toHaveLength(1);

    // 缺省 back（无 back_node_id）= 退回流程首个 APPROVER 节点：当前任务 RETURNED + 重新生成任务
    const r = await returnTask(inst.id, tasks0[0].id, { approver: 'role:auditor', opinion: '资料不齐，打回重审', by: 'u1' });
    expect(r.status).toBe('APPROVING');
    expect(r.returned_tasks).toBe(1);
    expect(r.reissued_tasks).toBe(1);

    const cur = await getParticle(inst.id);
    expect(cur.payload.status).toBe('APPROVING');               // 实例主干不迁移（天然闭环）
    expect(cur.payload.current_node).toBe(n.id);                // 打回节点 = 原审批节点（重审）

    const tasks1 = await listApprovalTasks(inst.id);
    expect(tasks1).toHaveLength(2);                             // 原任务 RETURNED + 新任务 TODO
    const returned = tasks1.find(t => t.id === tasks0[0].id);
    expect(returned.payload.status).toBe('RETURNED');           // 原任务留痕（非 REJECTED 终态）
    expect(returned.payload.opinion).toBe('资料不齐，打回重审');
    const reissued = tasks1.find(t => t.payload.status === 'TODO');
    expect(reissued.payload.approver).toBe('role:auditor');     // 重新签批
    expect(reissued.payload.seq).toBe(1);                       // seq 重排，顺序闸重新生效

    // 原任务不可再签（已 RETURNED）
    await expect(advanceTask(inst.id, tasks0[0].id, { approver: 'role:auditor', decision: 'approve' }))
      .rejects.toThrow(/不存在|已处理/);
    // 新任务可签 → APPROVED（重审后通过，天然闭环）
    const r2 = await advanceTask(inst.id, reissued.id, { approver: 'role:auditor', decision: 'approve' });
    expect(r2.status).toBe('APPROVED');
  });
});

describe('审批回滚补偿（Task 5，H28 实证）', () => {
  it('写前快照 + 驳回/失败回滚恢复原值（落 memory_snapshot 不可变表）', async () => {
    const { snapshotFor, rollbackIfNeeded } = await import('../src/approval/compensation.js');

    // 写前快照：审批后动作前捕获将被修改的属性
    const snap = await snapshotFor('deal-1', { stage: 'quoted', amount: 100000 });

    // 快照落不可变 memory_snapshot 表（schema.sql:239 语义：禁 update/delete）
    expect(snap.ref_id).toBe('deal-1');
    expect(snap.snapshot.before.stage).toBe('quoted');

    // 模拟审批后动作执行（改了原值）→ 失败/驳回 → 回滚判定
    const rb = await rollbackIfNeeded('deal-1', { ok: false }, snap);
    expect(rb.rolled_back).toBe(true);
    expect(rb.restored.amount).toBe(100000);  // 恢复原值（由调用方 executor 应用)

    // 成功路径不回滚
    const ok = await rollbackIfNeeded('deal-1', { ok: true }, snap);
    expect(ok.rolled_back).toBe(false);
  });
});

describe('审批域 Action 表面 + 事件域（Task 6）', () => {
  it('crm-approval-* 三个写 Action 注册且 confirm:critical', async () => {
    const { seedActions } = await import('../src/action/seed-actions.js');
    const { getAction, resetRegistry } = await import('../src/action/registry.js');
    resetRegistry();
    await seedActions();
    // 首 Action 命名：并行推进后 seed-actions.js 收敛为 crm-approval-flow-define（能力动词，见 seed-actions.js:459）；
    // 保留对 crm-approval-flow-create 的兼容（计划契约名），二选一存在即可
    const first = getAction('crm-approval-flow-define') || getAction('crm-approval-flow-create');
    expect(first).not.toBeNull();
    expect(first.kind).toBe('write');
    expect(first.confirm).toBe('critical');
    for (const n of ['crm-approval-start','crm-approval-approve']) {
      const a = getAction(n);
      expect(a).not.toBeNull();
      expect(a.kind).toBe('write');
      expect(a.confirm).toBe('critical');  // 审批动作强制人类确认（action-confirm 闸）
    }
  });

  it('审批域事件经既有总线传播（flow-created/instance-started/task-approved）', async () => {
    const { on, emit } = await import('../src/events/bus.js');
    const got = [];
    const off = on('approval', m => got.push(m.type));
    emit('approval', 'flow-created', { flow_id: 'f1' });
    emit('approval', 'instance-started', { instance_id: 'i1' });
    emit('approval', 'task-approved', { task_id: 't1' });
    off();
    expect(got).toEqual(['flow-created','instance-started','task-approved']);
  });
});

describe('审批流四类配置项执行语义（Task 7，G22 实证）', () => {
  it('字段权限三态：HIDE/VIEW/EDIT → 动作映射', async () => {
    const { FIELD_PERM_ACTIONS } = await import('../src/approval/rules.js');
    expect(FIELD_PERM_ACTIONS['HIDE']).toBe('hide');
    expect(FIELD_PERM_ACTIONS['VIEW']).toBe('view');
    expect(FIELD_PERM_ACTIONS['EDIT']).toBe('edit');
  });

  it('审批结果后动作两态：通过/驳回 → 补偿挂钩', async () => {
    const { POST_ACTIONS } = await import('../src/approval/rules.js');
    expect(POST_ACTIONS).toHaveProperty('pass');
    expect(POST_ACTIONS).toHaveProperty('reject');
  });

  it('配置项 → 执行语义（条件分支/审批模式/字段权限/结果后动作）', async () => {
    const { buildApprovalRules } = await import('../src/approval/rules.js');
    const rules = buildApprovalRules({
      conditions: [{ field: 'amount', operator: 'GT', value: 100000 }],
      mode: 'ANY', field_perms: { amount: 'HIDE' },
      post: { pass: 'auto-update', reject: 'rollback' },
    });
    expect(rules.route).toBe('conditional');
    expect(rules.mode).toBe('ANY');
    expect(rules.field_perm.amount).toBe('hide');
    expect(rules.post.pass).toBe('auto-update');
    expect(rules.post.reject).toBe('rollback');
  });

  it('审批×规则闸联动（B7 实证：商机只进不退/合同金额超限升级审批）', async () => {
    const { approvalGateRules } = await import('../src/approval/rules.js');
    const gates = approvalGateRules();
    expect(gates.length).toBeGreaterThan(0);
    expect(gates[0].scope).toBe('CRM_DEAL');
    expect(gates[0].action).toBe('block_if_violation');
    expect(gates.some(g => g.scope === 'CRM_CONTRACT' && g.action === 'escalate_to_approval')).toBe(true);
  });
});