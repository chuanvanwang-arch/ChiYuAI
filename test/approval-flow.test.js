// test/approval-flow.test.js — 审批域六层粒子 + 配置层（Task 1/2 测试）
// API 对齐（evidence：particleRepo.js:9/42 真实导出 createParticle/queryParticles，返回数组；updateParticle 签名 { patch, state, event }）
import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { createParticle, queryParticles } from '../src/particles/particleRepo.js';
import { resetRegistry } from '../src/action/registry.js';
import { PARTICLE_TYPES } from '../src/particles/particleModel.js';
import { createFlow, addNode, addApprover, addCondition, addLink, getFlow, writeFlowFromStages, getFlowByDomain, getFlowByDomainWithFallback } from '../src/approval/flow.js';

beforeEach(async () => {
  await query(`TRUNCATE particles, edges, events CASCADE`);  // 对齐既有测试惯例（particles.test.js:7）
});

describe('审批域六层粒子（Task 1）', () => {
  it('PARTICLE_TYPES 已登记审批域 8 类型（六层配置 + 实例/任务运行态）', () => {
    for (const t of ['CRM_APPROVAL_FLOW','CRM_APPROVAL_VERSION','CRM_APPROVAL_NODE','CRM_APPROVAL_APPROVER','CRM_APPROVAL_CONDITION','CRM_APPROVAL_LINK','CRM_APPROVAL_INSTANCE','CRM_APPROVAL_TASK']) {
      expect(PARTICLE_TYPES[t]).toBeTruthy();
    }
  });

  it('六层结构可建可查（FLOW→VERSION→NODE→APPROVER→CONDITION→LINK）', async () => {
    const flow = await createParticle('CRM_APPROVAL_FLOW', { name: '报价审批流', enabled: true }, { tenantId: 'system' });
    const version = await createParticle('CRM_APPROVAL_VERSION', { flow_id: flow.id, version_no: 1, nodes: [] }, { tenantId: 'system' });
    const node = await createParticle('CRM_APPROVAL_NODE', { flow_id: flow.id, node_type: 'APPROVER', name: '部门负责人', pos: 1 }, { tenantId: 'system' });
    const approver = await createParticle('CRM_APPROVAL_APPROVER', { node_id: node.id, approver_type: 'DEPT_HEAD', multi_approver_mode: 'ANY' }, { tenantId: 'system' });
    const cond = await createParticle('CRM_APPROVAL_CONDITION', { node_id: node.id, field: 'amount', operator: 'GT', value: 100000 }, { tenantId: 'system' });
    const link = await createParticle('CRM_APPROVAL_LINK', { from_node: node.id, to_node: node.id }, { tenantId: 'system' });

    for (const t of ['CRM_APPROVAL_FLOW','CRM_APPROVAL_VERSION','CRM_APPROVAL_NODE','CRM_APPROVAL_APPROVER','CRM_APPROVAL_CONDITION','CRM_APPROVAL_LINK']) {
      const r = await queryParticles({ type: t, tenantId: 'system' });
      expect(r.length).toBeGreaterThan(0);
    }
    expect(flow.type).toBe('CRM_APPROVAL_FLOW');
    // version_no 元模型：attr_type='number' 且 enabled=false（normalizeFacts.js:63 跳过归一 → 透传原类型）
    // 故此处断言数字 1（与元模型语义一致）；将来若启用 enabled，toNumber 归一后仍为数字 1，断言依旧成立
    expect(version.payload.version_no).toBe(1);
    expect(approver.payload.multi_approver_mode).toBe('ANY');
    expect(cond.payload.operator).toBe('GT');
  });
});

describe('审批流配置层（Task 2）', () => {
  it('createFlow→addNode→addApprover→addCondition→addLink→getFlow 全链', async () => {
    const flow = await createFlow({ name: '合同审批流', enabled: true });
    const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
    const approverNode = await addNode(flow.id, { node_type: 'APPROVER', name: '商务负责人', pos: 1 });
    const approver = await addApprover(approverNode.id, { approver_type: 'ROLE', role: 'contract-admin', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });
    const cond = await addCondition(approverNode.id, { field: 'amount', operator: 'GT', value: 200000 });
    const link = await addLink(start.id, approverNode.id, {});  // 3 参解构：无条件默认边（condition_ref 缺省 null）
    const got = await getFlow(flow.id);

    expect(got.payload.enabled).toBe(true);
    expect(approver.payload.empty_approver_action).toBe('AUTO_PASS');
    expect(cond.payload.operator).toBe('GT');
    expect(link.payload.from_node).toBe(start.id);
    expect(got.payload.nodes.length).toBe(2);  // START + APPROVER 两节点
  });

  it('getFlowByDomainWithFallback：租户缺流则懒克隆 system 模板（隔离不串租户）', async () => {
    // system 模板流
    await writeFlowFromStages({ flow_id: 'quote', name: '报价审批流', description: 't', stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false }], enabled: true }, 'system');
    expect(await getFlowByDomain('quote', 'tenantA')).toBeNull(); // 租户 A 初始无流

    // 租户 A 解析 → 应克隆 system 模板到 tenantA
    const cloned = await getFlowByDomainWithFallback('quote', 'tenantA');
    expect(cloned).not.toBeNull();
    expect(cloned.tenant_id).toBe('tenantA'); // 克隆到本租户（tenant_id 为 particles 表列，非 payload 内）
    expect(cloned.payload.name).toBe('报价审批流');

    // system 模板仍在，且未被改动
    const sys = await getFlowByDomain('quote', 'system');
    expect(sys).not.toBeNull();
    expect(sys.tenant_id).toBe('system');

    // 租户 B 解析 → 各自独立克隆，互不影响
    const clonedB = await getFlowByDomainWithFallback('quote', 'tenantB');
    expect(clonedB.tenant_id).toBe('tenantB');
    expect(await getFlowByDomain('quote', 'tenantA')).not.toBeNull(); // 互不影响

    // 幂等：再次解析不重复克隆（仍只有 1 条 tenantA 流）
    await getFlowByDomainWithFallback('quote', 'tenantA');
    const allA = await queryParticles({ type: 'CRM_APPROVAL_FLOW', tenantId: 'tenantA' });
    expect(allA.filter((p) => p.payload.domain === 'quote').length).toBe(1);
  });
});