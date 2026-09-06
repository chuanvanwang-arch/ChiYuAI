// scripts/seed-approval-rules.mjs — R1-R4 分业务审批规则 运行态物化（幂等）
//
// 依据：docs/2026-08-31-unified-s-taxonomy-approval-design.md §3（R1-R4 + 分级 T1/T2/T3 + §3.4 拓扑）
// 单一事实源：src/approval/ruleResolver.js（resolveApprovalChain 产出拓扑）
// 运行态事实源：CRM_APPROVAL_* 粒子（flow.js getFlowByDomain 按 domain 解析）
//
// 双态说明：默认连生产库 plm(5433)；仅追加写入（固定 UUID + ON CONFLICT (id) DO NOTHING），不 DELETE。
// 已知限制（与 seed-approval-demo.mjs 同口径，待 T6 修复）：
//   引擎当前 CONDITION 节点无审批人→AUTO_PASS（engine.js startInstance），
//   故 START→CONDITION 边在 T6 的 C1 materializeNode 修复前会让实例在 AI 闸处直接放行；
//   本脚本只负责"正确物化拓扑"，运行态 AI 闸生效依赖 T6。
//
// 拓扑（每条规则）：START → CONDITION(AI 自动校验) → APPROVER*(按档位 1/2/3 人) → END
import { query, queryWrite } from '../src/db.js';
import { resolveApprovalChain, listRules } from '../src/approval/ruleResolver.js';

const TENANT = 'system';

// 固定 UUID 前缀：R1=11 / R2=12 / R3=13 / R4=14（避开 seed.sql 既有 af000001..005 演示流）
const PREFIX = { R1: '11', R2: '12', R3: '13', R4: '14' };
// 合法 UUID（8-4-4-4-12）：首段 af00+PREFIX(2)+00 = 8 位；末段 9 零 + suffix(3) = 12 位
const uid = (rule, suffix) => `af00${PREFIX[rule]}00-0000-0000-0000-000000000${suffix}`;

async function seedRule(rule) {
  // B 策略（接管替换）：播种前软退休同域旧流（禁删铁律：仅 enabled=false + retired_at），
  // 消除 getFlowByDomain 解析二义（flow.js 已过滤 disabled 流）。R1(deal) 为新域无旧流，no-op。
  const retired = await queryWrite(
    `UPDATE crm.particles
     SET payload = jsonb_set(jsonb_set(payload, '{enabled}', 'false'::jsonb), '{retired_at}', to_jsonb($2::text))
     WHERE type='CRM_APPROVAL_FLOW' AND payload->>'domain'=$1 AND payload->>'enabled' != 'false'`,
    [rule.business, new Date().toISOString()]
  );
  if (retired.rowCount > 0) console.log(`  软退休同域旧流 domain=${rule.business}: ${retired.rowCount} 条（enabled=false，禁删）`);
  // 物化各规则「满档位」拓扑（T3 = 最大审批人链），作为运行态模板；
  // 实际起单时 T7 按金额 resolveTier → resolveApprovalChain 取当笔交易的档位链，
  // 经 engine.startInstance 的 approvers 参数覆盖节点审批人，实现分级（T1/T2/T3 节点数）。
  const chain = resolveApprovalChain(rule.id, { amount: 9_000_000, majorProject: true });
  const flowId = uid(rule.id, '101');
  const startId = uid(rule.id, '111');
  const condId = uid(rule.id, '112');
  const endId = uid(rule.id, '190');
  const condPartId = uid(rule.id, '160');
  const appIds = chain.approverChain.map((_, i) => uid(rule.id, `12${i}`)); // 120/121/122
  const approverIds = chain.approverChain.map((_, i) => uid(rule.id, `17${i}`)); // 170/171/172...
  const linkIds = [];
  linkIds.push(uid(rule.id, '131')); // START→COND
  linkIds.push(uid(rule.id, '132')); // COND→APP1
  for (let i = 0; i < appIds.length - 1; i++) linkIds.push(uid(rule.id, `13${3 + i}`)); // APPk→APPk+1
  linkIds.push(uid(rule.id, '1a0')); // APPn→END

  const rows = [];
  rows.push(['CRM_APPROVAL_FLOW', 'approval-flow', `审批流-${rule.id}`, 'ACTIVE', flowId,
    JSON.stringify({ name: `审批流-${rule.id}`, enabled: true, domain: rule.business, description: rule.description, stages: [], versions: [] })]);
  rows.push(['CRM_APPROVAL_NODE', 'approval-node', '开始', 'ACTIVE', startId,
    JSON.stringify({ flow_id: flowId, node_type: 'START', name: '开始', pos: 0 })]);
  rows.push(['CRM_APPROVAL_NODE', 'approval-node', 'AI自动校验', 'ACTIVE', condId,
    JSON.stringify({ flow_id: flowId, node_type: 'CONDITION', name: 'AI自动校验', pos: 1 })]);
  rows.push(['CRM_APPROVAL_CONDITION', 'approval-condition', '升级触发', 'ACTIVE', condPartId,
    JSON.stringify({ node_id: condId, field: chain.condition.field, operator: chain.condition.operator, value: chain.condition.value })]);
  chain.approverChain.forEach((role, i) => {
    rows.push(['CRM_APPROVAL_NODE', 'approval-node', `审批${i + 1}`, 'ACTIVE', appIds[i],
      JSON.stringify({ flow_id: flowId, node_type: 'APPROVER', name: `审批${i + 1}`, pos: 2 + i })]);
    rows.push(['CRM_APPROVAL_APPROVER', 'approval-approver', role, 'ACTIVE', approverIds[i],
      JSON.stringify({ node_id: appIds[i], approver_type: 'ROLE', role, multi_approver_mode: 'ANY', empty_approver_action: 'ASSIGN_ADMIN', same_submitter_action: 'ALLOW', approver_direction: 'BOTTOM_UP', cc_list: [], field_permissions: {}, pass_post_config: {}, reject_post_config: {} })]);
  });
  rows.push(['CRM_APPROVAL_NODE', 'approval-node', '结束', 'ACTIVE', endId,
    JSON.stringify({ flow_id: flowId, node_type: 'END', name: '结束', pos: 2 + appIds.length })]);
  // LINKS
  rows.push(['CRM_APPROVAL_LINK', 'approval-link', '连线', 'ACTIVE', linkIds[0],
    JSON.stringify({ from_node: startId, to_node: condId, condition_ref: null })]);
  rows.push(['CRM_APPROVAL_LINK', 'approval-link', '连线', 'ACTIVE', linkIds[1],
    JSON.stringify({ from_node: condId, to_node: appIds[0], condition_ref: null })]);
  for (let i = 0; i < appIds.length - 1; i++) {
    rows.push(['CRM_APPROVAL_LINK', 'approval-link', '连线', 'ACTIVE', linkIds[2 + i],
      JSON.stringify({ from_node: appIds[i], to_node: appIds[i + 1], condition_ref: null })]);
  }
  rows.push(['CRM_APPROVAL_LINK', 'approval-link', '连线', 'ACTIVE', linkIds[linkIds.length - 1],
    JSON.stringify({ from_node: appIds[appIds.length - 1], to_node: endId, condition_ref: null })]);

  for (const [type, slug, title, state, id, payload] of rows) {
    await queryWrite(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [id, TENANT, type, slug, title, state, payload]
    );
  }
  return { ruleId: rule.id, flowId, nodes: rows.length };
}

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name} ${extra}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function main() {
  console.log('== seed-approval-rules：R1-R4 运行态物化（幂等）==');
  const rules = listRules();
  for (const rule of rules) {
    const r = await seedRule(rule);
    check(`物化 ${rule.id}（${rule.business} ${rule.fromStage}→${rule.toStage}）`, !!r.flowId, `flow=${r.flowId} nodes=${r.nodes}`);
  }
  // 校验：每条规则 domain 可被 getFlowByDomain 解析（配置页↔运行态对齐，方案 A）
  const { getFlowByDomain } = await import('../src/approval/flow.js');
  for (const rule of rules) {
    const f = await getFlowByDomain(rule.business);
    check(`domain=${rule.business} 可解析`, !!f, f ? `flow_id=${f.id}` : '未找到');
  }
  console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('seed-approval-rules 失败:', e); process.exit(1); });
