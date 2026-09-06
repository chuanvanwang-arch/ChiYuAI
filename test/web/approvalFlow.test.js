import { test, expect } from 'vitest';
import {
  DOMAIN_LABELS,
  domainLabel,
  renderApprovalFlows,
  renderStages,
  approvalFlowSummary,
  validateStages,
} from '../../src/portal/approvalFlow.js';

const FLOWS = [
  { flow_id: 'deal', name: '商机审批流', description: 'd', enabled: true,
    stages: [{ stage: 1, role: 'manager', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'admin', action: 'approve', auto_allowed: false }] },
  { flow_id: 'quote', name: '报价审批流', description: 'q', enabled: true,
    stages: [{ stage: 1, role: 'presales', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'manager', action: 'approve', auto_allowed: false }] },
  { flow_id: 'contract', name: '合同审批流', description: 'c', enabled: false,
    stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'contract_admin', action: 'approve', auto_allowed: false }] },
  { flow_id: 'invoice', name: '发票审批流', description: 'i', enabled: true,
    stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false },
             { stage: 2, role: 'finance', action: 'approve', auto_allowed: false }] },
];

test('DOMAIN_LABELS 含 4 个域', () => {
  expect(Object.keys(DOMAIN_LABELS)).toEqual(['deal', 'quote', 'contract', 'invoice']);
});

test('domainLabel 映射域→中文', () => {
  expect(domainLabel('deal')).toBe('商机');
  expect(domainLabel('quote')).toBe('报价');
  expect(domainLabel('contract')).toBe('合同');
  expect(domainLabel('invoice')).toBe('发票');
  expect(domainLabel('unknown')).toBe('unknown');
});

test('renderApprovalFlows 渲染 4 行 + 启用/停用徽标', () => {
  const html = renderApprovalFlows(FLOWS);
  for (const id of ['deal', 'quote', 'contract', 'invoice']) {
    expect(html).toContain(`data-flow="${id}"`);
  }
  expect(html).toContain('已启用'); // deal
  expect(html).toContain('已停用'); // contract
});

test('renderStages 渲染关卡 role/action/auto_allowed', () => {
  const html = renderStages(FLOWS[0].stages);
  expect(html).toContain('manager');
  expect(html).toContain('approve');
  expect(html).toContain('type="checkbox"'); // auto_allowed 开关
});

test('approvalFlowSummary 统计流数/启用数/关卡数', () => {
  const s = approvalFlowSummary(FLOWS);
  expect(s.count).toBe(4);
  expect(s.enabled).toBe(3); // deal/quote/invoice
  expect(s.stages).toBe(8);  // 4 × 2
});

test('validateStages 合法/非法', () => {
  expect(validateStages(FLOWS[0].stages)).toBe(true);
  expect(validateStages('not-array')).toBe(false);
  expect(validateStages([{ stage: 1, action: 'approve' }])).toBe(false); // 缺 role
  expect(validateStages([{ stage: 1, role: 'manager' }])).toBe(false);   // 缺 action
});

// ---- handler 单测（注入假 deps）----
import { createApprovalFlowRouter } from '../../src/portal/approvalFlow.js';

function makeDeps(over = {}) {
  const rows = {
    deal: { flow_id: 'deal', name: '商机审批流', description: 'd', enabled: true,
      stages: [{ stage: 1, role: 'manager', action: 'approve', auto_allowed: false }] },
  };
  return {
    listFlows: async () => Object.values(rows).map((r) => ({ ...r })),
    getFlow: async (id) => rows[id] || null,
    upsertFlow: async (flow) => { rows[flow.flow_id] = { ...flow }; return { ...flow }; },
    produceDecision: over.produceDecision || (async () => ({ decision_id: 'd1' })),
  };
}

test('GET /api/approval-flows 返回流列表', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  let cap = null;
  const res = { json: (x) => { cap = x; return x; } };
  await router.handlers.list({}, res);
  expect(cap.flows.length).toBe(1);
  expect(cap.flows[0].flow_id).toBe('deal');
});

test('PUT /api/approval-flows upsert 触发 produceDecision', async () => {
  let decided = null;
  const deps = makeDeps({ produceDecision: async (d) => { decided = d; return { decision_id: 'd2' }; } });
  const router = createApprovalFlowRouter(deps);
  const res = { json: (x) => x };
  const body = { flow_id: 'quote', name: '报价审批流', stages: [{ stage: 1, role: 'presales', action: 'approve' }], enabled: true };
  await router.handlers.put({ body }, res);
  expect(decided).not.toBeNull();
  expect(decided.flow_id).toBe('quote');
});

test('PUT 缺 flow_id → 400', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { name: 'x', stages: [] } }, res);
  expect(status).toBe(400);
});

test('PUT stages 非法 → 400', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  let status = null;
  const res = { status: (s) => { status = s; return { json: () => {} }; } };
  await router.handlers.put({ body: { flow_id: 'bad', name: 'x', stages: [{ stage: 1 }] } }, res);
  expect(status).toBe(400);
});

test('Router 不含 DELETE 路由（铁律：绝对禁删）', async () => {
  const router = createApprovalFlowRouter(makeDeps());
  expect(router.handlers.delete).toBeUndefined();
});
