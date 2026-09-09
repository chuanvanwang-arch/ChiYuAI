/**
 * E2E：审批起单不再失效（docs/2026-09-09-approval-failure-and-write-side-fix-design.md）
 *
 * 真实端到端验证（非单元测试）：真实 MCP stdio 客户端 → gateway 两阶段 → 审批引擎 → 待签任务落库。
 *
 * 验证五件事：
 *   ① MCP 连接 + crm_login
 *   ② **审批失效反锚点**：AUTO_PASS + ROLE:presales 的流，起单后是 APPROVING 且有 role:presales 待签任务
 *      （修复前：auto_pass → APPROVED，presales/manager 无人签批）
 *   ③ approvers 透传：显式指定审批链 → 落实例 tier_approvers
 *   ④ fail-closed：链长 < 节点数 → 拒绝起单，不产生实例
 *   ⑤ confirm 参数只增补禁覆盖：phase2 改写已确认字段 → confirm_params_conflict，不执行
 *
 * 用法：PGDATABASE=crm_native_test node scripts/e2e-approval-start-mcp.mjs
 * 注：改了 src/ 后必须重启实例（node 无 --watch），否则拿到旧进程结果。
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const results = [];
function check(name, pass, detail = '') {
  results.push({ name, pass });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function unpack(r) {
  const t = r?.content?.[0]?.text;
  if (!t) return r;
  try { return JSON.parse(t); } catch { return { ok: false, raw: String(t).slice(0, 300) }; }
}

// 准备：测试库播种「生产形态」审批流 —— 两节点（售前/经理），规则均 AUTO_PASS + ROLE
// （复刻生产：63 条规则中 50 条为空审批动作 AUTO_PASS 且带 role，修复前被整体架空）
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native_test';
const { query } = await import('../src/db.js');
const { createFlow, addNode, addApprover, addLink } = await import('../src/approval/flow.js');

const flow = await createFlow({ name: 'E2E报价审批流', enabled: true });
const start = await addNode(flow.id, { node_type: 'START', name: '开始', pos: 0 });
const n1 = await addNode(flow.id, { node_type: 'APPROVER', name: '售前审核', pos: 1 });
const n2 = await addNode(flow.id, { node_type: 'APPROVER', name: '经理审批', pos: 2 });
await addLink(start.id, n1.id, {});
await addLink(n1.id, n2.id, {});
await addApprover(n1.id, { approver_type: 'ROLE', role: 'presales', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });
await addApprover(n2.id, { approver_type: 'ROLE', role: 'manager', multi_approver_mode: 'ANY', empty_approver_action: 'AUTO_PASS' });

// 第 0 闸凭证：crm-approval-start 未声明 decisionScenario（gateway 不代 mint），
// 故按真实调用方合规路径先 mint 一个决策，再随写参数透传 decision_id。
const scn = await query(`SELECT scenario_id FROM crm.decision_scenario WHERE tenant_id='system' LIMIT 1`);
const { requireDecision } = await import('../src/decision/autonomyEngine.js');
const minted = await requireDecision(
  scn.rows[0]?.scenario_id || 'PARTICLE_CREATE',
  { action: 'crm-approval-start', business_id: 'E2E-approval' },
  [],
  { actor_id: 'alice' },
);
const DECISION_ID = minted?.decision?.decision_id || minted?.decision_id;
if (!DECISION_ID) throw new Error('决策 mint 失败，无法验证第0闸后的审批链路');
console.log(`（第0闸凭证已 mint：decision_id=${DECISION_ID} scenario=${scn.rows[0]?.scenario_id}）\n`);

// ─── MCP 通道 ───
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['src/mcp/server.js', '--stdio'],
  env: { ...process.env, PGDATABASE: process.env.PGDATABASE },
  stderr: 'pipe',
});
const client = new Client({ name: 'e2e-approval-start', version: '1.0.0' });

async function runWrite(actionName, args) {
  const p1 = unpack(await client.callTool({ name: actionName, arguments: { ...args, force: true } }));
  if (!p1.confirm_token) return p1;
  return unpack(await client.callTool({ name: actionName, arguments: { api_token: args.api_token, confirm_token: p1.confirm_token } }));
}

try {
  await client.connect(transport);
  check('① MCP 连接建立', true);

  const lr = unpack(await client.callTool({
    name: 'crm_login',
    arguments: { username: process.env.E2E_USER || 'alice', password: process.env.E2E_PASS || 'secret123' },
  }));
  if (!lr.ok || !lr.token) throw new Error(`登录失败: ${JSON.stringify(lr).slice(0, 200)}`);
  const auth = { api_token: lr.token };
  check('① crm_login 拿 token', !!lr.token, `actor=alice tenant=${lr.tenant_id || lr.tenantId || '?'}`);

  // ② 审批失效反锚点：不传 approvers（即生产默认调用形态）
  const inst1 = await runWrite('crm-approval-start', {
    ...auth, decision_id: DECISION_ID, flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'E2E-Q-1', ctx: { amount: 80000 },
  });
  check('② 起单调用成功（ok===true）', inst1.ok === true, JSON.stringify(inst1).slice(0, 220));

  const st1 = inst1?.data?.payload?.status || inst1?.result?.payload?.status || inst1?.payload?.status;
  const instId1 = inst1?.data?.id || inst1?.result?.id || inst1?.id;
  // 修复前此处必然是 APPROVED（AUTO_PASS 抢在 ROLE 之前）→ presales/manager 无人签批
  check('②【核心】起单为 APPROVING（不是起单即通过）', st1 === 'APPROVING', `status=${st1}`);

  const tasks1 = await query(
    `SELECT payload FROM crm.particles WHERE type='CRM_APPROVAL_TASK' AND payload->>'instance_id'=$1 ORDER BY (payload->>'seq')::int`,
    [String(instId1)],
  );
  check('② 生成 1 条待签任务', tasks1.rows.length === 1, `实际 ${tasks1.rows.length} 条`);
  check('② 待签人 = role:presales（ROLE 规则不再被 AUTO_PASS 架空）',
    tasks1.rows[0]?.payload?.approver === 'role:presales', `approver=${tasks1.rows[0]?.payload?.approver}`);
  check('② 任务状态 = TODO（真的等人签）',
    String(tasks1.rows[0]?.payload?.status).toUpperCase() === 'TODO', `status=${tasks1.rows[0]?.payload?.status}`);

  // ③ approvers 透传
  const inst2 = await runWrite('crm-approval-start', {
    ...auth, decision_id: DECISION_ID, flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'E2E-Q-2',
    ctx: { amount: 80000 }, approvers: ['role:presales', 'role:manager'],
  });
  const tier = inst2?.data?.payload?.tier_approvers || inst2?.result?.payload?.tier_approvers || inst2?.payload?.tier_approvers;
  check('③ approvers 透传：实例 tier_approvers 落库',
    Array.isArray(tier) && tier.length === 2 && tier[0] === 'role:presales' && tier[1] === 'role:manager',
    `tier_approvers=${JSON.stringify(tier)}`);

  // ④ fail-closed：链长 1 < 节点数 2
  const inst3 = await runWrite('crm-approval-start', {
    ...auth, decision_id: DECISION_ID, flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'E2E-Q-3',
    ctx: { amount: 80000 }, approvers: ['role:presales'],
  });
  check('④ fail-closed：链长不足 → 拒绝起单（不静默跳审）',
    inst3.ok === false && /审批链长度 1 少于审批节点数 2/.test(String(inst3.error || '')),
    `ok=${inst3.ok} error=${String(inst3.error || '').slice(0, 100)}`);
  const orphan = await query(
    `SELECT count(*)::int AS n FROM crm.particles WHERE type='CRM_APPROVAL_INSTANCE' AND payload->>'business_id'='E2E-Q-3'`);
  check('④ 拒绝后未留下半截实例（起单前校验，无需回滚）', orphan.rows[0].n === 0, `残留 ${orphan.rows[0].n} 条`);

  // ⑤ confirm 只增补禁覆盖
  const p1 = unpack(await client.callTool({
    name: 'crm-approval-start',
    arguments: { ...auth, decision_id: DECISION_ID, flow_id: flow.id, business_type: 'CRM_QUOTATION', business_id: 'E2E-Q-5', ctx: {}, force: true },
  }));
  if (p1.confirm_token) {
    const p2 = unpack(await client.callTool({
      name: 'crm-approval-start',
      arguments: { ...auth, confirm_token: p1.confirm_token, business_id: 'E2E-Q-CHANGED' }, // 改写已确认字段
    }));
    check('⑤ confirm 语义保护：改写已确认字段 → confirm_params_conflict 且拒绝执行',
      p2.ok === false && p2.gate === 'confirm_params_conflict',
      `ok=${p2.ok} gate=${p2.gate} error=${String(p2.error || '').slice(0, 80)}`);
  } else {
    check('⑤ confirm 语义保护（跳过：未拿到 confirm_token）', false, JSON.stringify(p1).slice(0, 150));
  }
} catch (e) {
  check('E2E 异常终止', false, String(e?.message || e).slice(0, 300));
} finally {
  await client.close().catch(() => {});
}

const pass = results.filter((r) => r.pass).length;
console.log(`\n=== E2E 结果：${pass}/${results.length} 通过 ===`);
process.exit(pass === results.length ? 0 : 1);
