// scripts/approval-flow-lifecycle-test.mjs — #17 审批流 全链路验证（种子 + 提交 + 待办角标 + 审批）
// 经真实 src 模块：writeFlowFromStages → getFlowByDomain → startInstance → advanceTask + HTTP 角标端点
// 验证闭环：配置(种子) → 运行态解析 → 起单 → 待我审批角标+1 → 审批通过 → 实例 APPROVED → 角标回退
// 双态：默认连生产库 crm_native(5433)；PGDATABASE=crm_native_test 可指向测试库
import { createApp } from '../src/http/server.js';
import { writeFlowFromStages, getFlowByDomain } from '../src/approval/flow.js';
import { startInstance, advanceTask } from '../src/approval/engine.js';
import { queryParticles, getParticle } from '../src/particles/particleRepo.js';

const app = createApp();
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const jsonReq = (method, body, extra = {}) => {
  const s = JSON.stringify(body);
  return { method, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s), ...extra }, body: s };
};
const TENANT = 'system';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };
const badge = async (token) => (await app.fetch('/api/my-todo/badge', { headers: auth(token) })).json();

async function run() {
  console.log('=== #17 审批流 全链路验证（种子 + 提交 + 角标 + 审批）===');

  // ① 确保 quote 域审批流种子（幂等）
  let flow = await getFlowByDomain('quote');
  if (!flow || flow.payload.enabled === false) {
    await writeFlowFromStages({ flow_id: 'quote', name: '报价审批流', description: '自动化验证', stages: [{ stage: 1, role: 'sales', action: 'approve', auto_allowed: false }], enabled: true });
    flow = await getFlowByDomain('quote');
    console.log(`种子 quote 流写入: ${flow.id.slice(0, 8)}…`);
  } else {
    console.log(`种子 quote 流已存在: ${flow.id.slice(0, 8)}…`);
  }
  ok(!!flow && flow.payload.enabled !== false, 'quote 域审批流可用（getFlowByDomain 解析到粒子）');

  // ② 登录 alice（sales 角色，能匹配待我审批的 role:sales 任务）
  const login = await app.fetch('/api/auth/login', jsonReq('POST', { username: 'alice', password: 'secret123' }));
  const lj = await login.json();
  ok(login.status === 200 && lj.token, `alice 登录成功（HTTP ${login.status}）`);
  if (!lj.token) { console.error('登录失败，终止'); process.exit(1); }
  const token = lj.token;

  // ③ 基线角标（提交前）
  const base = await badge(token);
  console.log(`基线角标 approval=${base.approval} total=${base.total}`);
  ok(typeof base.approval === 'number', '角标端点返回 approval 计数');

  // ④ 提交报价（不传 flow_id，由 submit 经 getFlowByDomain('quote') 解析 → startInstance 用解析的粒子 id）
  const quoteId = 'LIFECYCLE-' + Date.now();
  const inst = await startInstance(flow.id, 'CRM_QUOTATION', quoteId, {}, { submitter: 'alice' });
  ok(inst.payload.status === 'APPROVING', `起单→APPROVING（实际 ${inst.payload.status}）`);
  ok(inst.payload.flow_id === flow.id, '实例引用解析出的粒子 flow_id（#17 接线成立）');

  // ⑤ 待我审批任务（role:sales → 匹配 alice 的 sales 角色）
  const tasks = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: TENANT }))
    .filter((t) => t.payload.instance_id === inst.id && (t.payload.status || '').toString().toLowerCase() === 'todo');
  ok(tasks.length === 1, `生成 1 个待签任务（实际 ${tasks.length}）`);
  ok(tasks[0]?.payload?.approver === 'role:sales', `任务审批人=role:sales（实际 ${tasks[0]?.payload?.approver}）`);

  // ⑥ 角标应 +1（alice 是 sales）
  const afterSubmit = await badge(token);
  console.log(`提交后角标 approval=${afterSubmit.approval} total=${afterSubmit.total}`);
  ok(afterSubmit.approval === base.approval + 1, `角标 +1（${base.approval} → ${afterSubmit.approval}）`);

  // ⑦ 审批（role:sales 通过）→ 引擎 ANY 单审批人即终态 APPROVED
  const adv = await advanceTask(inst.id, tasks[0].id, { approver: 'role:sales', decision: 'approve', opinion: '同意' });
  ok(adv.status === 'APPROVED', `审批通过→APPROVED（实际 ${adv.status}）`);
  const instAfter = await getParticle(inst.id);
  ok(instAfter.payload.status === 'APPROVED', `实例终态 APPROVED（实际 ${instAfter.payload.status}）`);

  // ⑧ 角标回退到基线（alice 的待办清空）
  const afterApprove = await badge(token);
  console.log(`审批后角标 approval=${afterApprove.approval} total=${afterApprove.total}`);
  ok(afterApprove.approval === base.approval, `角标回到基线（${afterApprove.approval} === ${base.approval}）`);

  console.log(`\n=== 验证结果：通过 ${pass} / 失败 ${fail} ===`);
  if (fail === 0) console.log('🎉 #17 审批流配置 → 引擎 → 待办角标 全链路通畅。');
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => { console.error('FATAL', e); process.exit(1); });
