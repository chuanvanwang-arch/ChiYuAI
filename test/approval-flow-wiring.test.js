// test/approval-flow-wiring.test.js — #17 审批流配置接通运行态引擎（方案 A）集成测试
// 验证：stages→粒子拓扑翻译 / getFlowByDomain 解析 / 软停 / 运行态闭环（submit 不传 flow_id 收到解析粒子 id）
import { describe, test, expect } from 'vitest';
import { writeFlowFromStages, getFlowByDomain } from '../src/approval/flow.js';
import { startInstance } from '../src/approval/engine.js';
import { queryParticles } from '../src/particles/particleRepo.js';

const TENANT = 'system';

describe('审批流配置接线（方案 A 直写粒子）', () => {
  test('writeFlowFromStages：stages 翻译为 FLOW+START/APPROVER×N/END+APPROVER+LINK', async () => {
    const flow = await writeFlowFromStages({
      flow_id: 'quote',
      name: '报价审批流',
      description: '报价单发出前审批',
      stages: [
        { stage: 1, role: 'presales', action: 'approve', auto_allowed: false },
        { stage: 2, role: 'manager', action: 'approve', auto_allowed: true },
      ],
      enabled: true,
    });
    expect(flow.flow_id).toBe('quote');

    const flowP = await getFlowByDomain('quote');
    expect(flowP).not.toBeNull();
    expect(flowP.payload.domain).toBe('quote');

    const nodes = (await queryParticles({ type: 'CRM_APPROVAL_NODE', tenantId: TENANT }))
      .filter((n) => n.payload.flow_id === flowP.id)
      .sort((a, b) => a.payload.pos - b.payload.pos);
    expect(nodes.map((n) => n.payload.node_type)).toEqual(['START', 'APPROVER', 'APPROVER', 'END']);

    const approvers = (await queryParticles({ type: 'CRM_APPROVAL_APPROVER', tenantId: TENANT }))
      .filter((a) => nodes.some((n) => n.id === a.payload.node_id));
    expect(approvers.length).toBe(2);
    // 第二节点 auto_allowed=true → 空审批人自动通过
    const second = approvers.find((a) => a.payload.node_id === nodes[2].id);
    expect(second.payload.empty_approver_action).toBe('AUTO_PASS');
    const first = approvers.find((a) => a.payload.node_id === nodes[1].id);
    expect(first.payload.empty_approver_action).toBe('ASSIGN_ADMIN');

    const links = (await queryParticles({ type: 'CRM_APPROVAL_LINK', tenantId: TENANT }))
      .filter((l) => nodes.some((n) => n.id === l.payload.from_node));
    expect(links.length).toBe(3);
  });

  test('软停：二次写同 domain → 旧 FLOW enabled=false，新 FLOW 生效', async () => {
    const f1 = await getFlowByDomain('quote');
    await writeFlowFromStages({
      flow_id: 'quote',
      name: '报价审批流',
      stages: [{ stage: 1, role: 'presales', action: 'approve', auto_allowed: false }],
      enabled: true,
    });
    const f2 = await getFlowByDomain('quote');
    expect(f2.id).not.toBe(f1.id);

    const all = await queryParticles({ type: 'CRM_APPROVAL_FLOW', tenantId: TENANT });
    const old = all.find((x) => x.id === f1.id);
    expect(old.payload.enabled).toBe(false); // 软停（禁删铁律）
    expect(f2.payload.enabled).toBe(true);
  });

  test('运行态闭环：getFlowByDomain 解析 → startInstance 收到粒子 id（非域字符串）', async () => {
    const f = await getFlowByDomain('quote');
    expect(f).not.toBeNull();
    const inst = await startInstance(f.id, 'CRM_QUOTATION', 'biz-quote-1', {}, { submitter: 'alice' });
    expect(inst.payload.flow_id).toBe(f.id); // 解析后的粒子 id
    expect(inst.payload.flow_id).not.toBe('quote'); // 非配置页域字符串
    expect(typeof inst.payload.flow_id).toBe('string');
  });
});
