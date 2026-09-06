// E2E：#17 审批流配置接通运行态引擎（方案 A 直写粒子，单一事实源）
// 全链路经 HTTP：登录(alice) → PUT 配置(写粒子) → GET 配置(读粒子) → 提交报价(解析域→startInstance 用解析粒子id)
// 范式：createApp().fetch（对齐 home-page.test.js / particles-write.test.js 注入式）
// 注意：app.fetch 适配器只读 opts.headers，Content-Type 须置于 headers 内（不能顶层）
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../src/http/server.js';
import { randomUUID } from 'node:crypto';

const app = createApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const jsonReq = (method, body, extraHeaders = {}) => {
  const s = JSON.stringify(body);
  return { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), ...extraHeaders }, body: s };
};
const DOMAIN = 'quote'; // 业务域（配置页 flow_id 即域字符串）
const CUSTOM_STAGES = [
  { stage: 1, role: 'e2e_first', action: 'approve', auto_allowed: false },
  { stage: 2, role: 'e2e_second', action: 'approve', auto_allowed: true },
];
// 按值归一化（存储时 key 顺序可能变化：role 在前）后比较
const norm = (a) => JSON.stringify([...a].map((s) => ({ stage: s.stage, role: s.role, action: s.action, auto_allowed: s.auto_allowed })).sort((x, y) => x.stage - y.stage));

describe('E2E #17 审批流配置接通运行态引擎', () => {
  let token;
  beforeAll(async () => {
    const res = await app.fetch('/api/auth/login', jsonReq('POST', { username: 'alice', password: 'secret123' }));
    const j = await res.json();
    token = j.token;
  });

  it('E2E-1: PUT 审批流配置 → 直写 CRM_APPROVAL_* 粒子（单一事实源，非原 crm.approval_flow 表）', async () => {
    const put = await app.fetch(`/api/approval-flows/${DOMAIN}`, jsonReq('PUT', { flow_id: DOMAIN, name: 'E2E报价流', description: 'e2e', stages: CUSTOM_STAGES, enabled: true }, auth(token)));
    expect(put.status).toBe(200);
    const pj = await put.json();
    expect(pj.ok).toBe(true);

    // /api/particles 按单 type 过滤，需分类型查
    const parts = await (await app.fetch('/api/particles?type=CRM_APPROVAL_FLOW', { headers: auth(token) })).json();
    const flow = parts.items.find((x) => x.payload.domain === DOMAIN && x.payload.enabled !== false);
    expect(flow, '应写出 CRM_APPROVAL_FLOW 粒子（domain=quote）').toBeTruthy();

    const nodes = await (await app.fetch('/api/particles?type=CRM_APPROVAL_NODE', { headers: auth(token) })).json();
    const myNodes = nodes.items.filter((x) => x.payload.flow_id === flow.id);
    expect(myNodes.length, 'START + 2 APPROVER + END = 4 节点').toBe(4);
    const approvers = await (await app.fetch('/api/particles?type=CRM_APPROVAL_APPROVER', { headers: auth(token) })).json();
    const myApprovers = approvers.items.filter((x) => myNodes.some((n) => n.id === x.payload.node_id));
    expect(myApprovers.length, '2 个 APPROVER 节点各 1 审批人').toBe(2);
    // 第二关卡 auto_allowed=true → 翻译为 empty_approver_action=AUTO_PASS
    expect(myApprovers.find((a) => a.payload.empty_approver_action === 'AUTO_PASS'), 'auto_allowed=true 应映射 AUTO_PASS').toBeTruthy();
  });

  it('E2E-2: GET 审批流配置 → 经粒子读回（配置读路径已接粒子，闭环可读）', async () => {
    const get = await app.fetch(`/api/approval-flows/${DOMAIN}`, { headers: auth(token) });
    expect(get.status).toBe(200);
    const gj = await get.json();
    expect(gj.flow.flow_id).toBe(DOMAIN);
    expect(norm(gj.flow.stages)).toBe(norm(CUSTOM_STAGES));
    expect(gj.flow.name).toBe('E2E报价流');
  });

  it('E2E-3: 提交报价(不传 flow_id) → submit 解析域 → startInstance 用解析的粒子 id（闭环核心）', async () => {
    // 解析出的运行态 FLOW 粒子 id
    const parts = await (await app.fetch('/api/particles?type=CRM_APPROVAL_FLOW', { headers: auth(token) })).json();
    const flow = parts.items.find((x) => x.payload.domain === DOMAIN && x.payload.enabled !== false);
    const resolvedFlowId = flow.id;
    expect(typeof resolvedFlowId).toBe('string');
    expect(resolvedFlowId, '运行态 flow_id 必须是粒子 uuid，非域字符串 quote').not.toBe(DOMAIN);

    const dummyQuote = randomUUID();
    const sub = await app.fetch('/api/action/crm-quote-submit', jsonReq('POST', { quote_id: dummyQuote }, auth(token)));
    expect(sub.status, '提交报价应通过 HTTP 200').toBe(200);
    const sj = await sub.json();
    expect(sj.ok).toBe(true);

    // 反查实例，证明 startInstance 用的是解析后的粒子 id（接线成立）
    const inst = await (await app.fetch('/api/particles?type=CRM_APPROVAL_INSTANCE', { headers: auth(token) })).json();
    const created = inst.items.find((x) => x.payload.business_id === dummyQuote);
    expect(created, '应创建 CRM_APPROVAL_INSTANCE 且引用解析的 flow_id').toBeTruthy();
    expect(created.payload.flow_id).toBe(resolvedFlowId);
    expect(created.payload.business_type).toBe('CRM_QUOTATION');
    // 配置驱动行为：首关卡（e2e_first, auto_allowed=false）未自动通过 → 进入审批中
    expect(['APPROVING', 'APPROVED']).toContain(created.payload.status);
  });
});
