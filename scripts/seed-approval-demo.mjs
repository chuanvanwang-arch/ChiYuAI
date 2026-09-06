// scripts/seed-approval-demo.mjs — 评审(审批)引擎种子 + 全链路模拟
// 目的：① 幂等落地审批流拓扑(或签/会签/顺序签 + 分级三级链)，让引擎"启动"(有流程定义)；
//       ② 驱动真实 src/approval/engine.js 跑遍所有操作，验证"各个环节"。
// 双态说明：默认连生产库 crm_native(5433)；仅追加写入(固定 UUID + ON CONFLICT DO NOTHING)，不 DELETE。
// 已落地能力(经 T6/T7 修复)：节点间推进(B1) + CONDITION 透明物化(C1) + 分级审批(金额→节点数 T1/T2/T3)
//   + 漏斗 KPI 监控 + S-code 五段阶段门禁(附件硬闸)。本脚本按"单节点多审批人"与"多节点分级"两种拓扑
//   分别建模，覆盖可用全集。
import { query, queryWrite, pool, poolRead } from '../src/db.js';
import {
  startInstance, advanceTask, withdrawInstance, addSignTask, transferTask, returnTask,
} from '../src/approval/engine.js';
import { resolveApprovalChain } from '../src/approval/ruleResolver.js';
import { salesStageGate } from '../src/action/executor.js';
import { funnelConversionRates, funnelKpiWarnings } from '../src/sales/funnelKpi.js';
import { S_ATTACHMENT_GATES } from '../src/sales/stageTaxonomy.js';
import { getParticle, queryParticles } from '../src/particles/particleRepo.js';

const TENANT = 'system';

// 固定 UUID（幂等：重跑 DO NOTHING）
const U = {
  any: { flow: 'af000001-0000-0000-0000-0000000000a1', start: 'af000001-0000-0000-0000-0000000000b1', app: 'af000001-0000-0000-0000-0000000000c1', end: 'af000001-0000-0000-0000-0000000000d1', ap: 'af000001-0000-0000-0000-0000000000e1', l1: 'af000001-0000-0000-0000-0000000000f1', l2: 'af000001-0000-0000-0000-0000000000f2' },
  all: { flow: 'af000002-0000-0000-0000-0000000000a2', start: 'af000002-0000-0000-0000-0000000000b2', app: 'af000002-0000-0000-0000-0000000000c2', end: 'af000002-0000-0000-0000-0000000000d2', ap: 'af000002-0000-0000-0000-0000000000e2', l1: 'af000002-0000-0000-0000-0000000000f1', l2: 'af000002-0000-0000-0000-0000000000f2' },
  seq: { flow: 'af000003-0000-0000-0000-0000000000a3', start: 'af000003-0000-0000-0000-0000000000b3', app: 'af000003-0000-0000-0000-0000000000c3', end: 'af000003-0000-0000-0000-0000000000d3', ap: 'af000003-0000-0000-0000-0000000000e3', l1: 'af000003-0000-0000-0000-0000000000f1', l2: 'af000003-0000-0000-0000-0000000000f2' },
  graded: {
    flow: 'af000004-0000-0000-0000-0000000000a4', start: 'af000004-0000-0000-0000-0000000000b4',
    a: 'af000004-0000-0000-0000-0000000000c4', b: 'af000004-0000-0000-0000-0000000000d4', c: 'af000004-0000-0000-0000-0000000000e4',
    end: 'af000004-0000-0000-0000-0000000000f4',
    apA: 'af000004-0000-0000-0000-0000000000a5', apB: 'af000004-0000-0000-0000-0000000000a6', apC: 'af000004-0000-0000-0000-0000000000a7',
    l1: 'af000004-0000-0000-0000-0000000000b5', l2: 'af000004-0000-0000-0000-0000000000b6', l3: 'af000004-0000-0000-0000-0000000000b7', l4: 'af000004-0000-0000-0000-0000000000b8',
  },
};

async function seedTopology() {
  // 每个流：FLOW + START/APP/END 三节点 + APPROVER 规则 + 两条 LINK
  const rows = [];
  for (const k of ['any', 'all', 'seq']) {
    const u = U[k];
    const mode = k === 'any' ? 'ANY' : k === 'all' ? 'ALL' : 'SEQUENTIAL';
    const role = k === 'seq' ? 'ceo' : 'manager';
    rows.push(['CRM_APPROVAL_FLOW', 'approval-flow', '评审流-' + k, 'enabled', u.flow, JSON.stringify({ name: '评审流-' + k, enabled: true, versions: [] })]);
    rows.push(['CRM_APPROVAL_NODE', 'approval-node', '开始', 'active', u.start, JSON.stringify({ flow_id: u.flow, node_type: 'START', name: '开始', pos: 1 })]);
    rows.push(['CRM_APPROVAL_NODE', 'approval-node', '审批节点', 'active', u.app, JSON.stringify({ flow_id: u.flow, node_type: 'APPROVER', name: '审批节点', pos: 2 })]);
    rows.push(['CRM_APPROVAL_NODE', 'approval-node', '结束', 'active', u.end, JSON.stringify({ flow_id: u.flow, node_type: 'END', name: '结束', pos: 3 })]);
    rows.push(['CRM_APPROVAL_APPROVER', 'approval-approver', '审批人', 'active', u.ap, JSON.stringify({ node_id: u.app, approver_type: 'ROLE', role, multi_approver_mode: mode, empty_approver_action: 'ASSIGN_ADMIN' })]);
    rows.push(['CRM_APPROVAL_LINK', 'approval-link', '连线', 'active', u.l1, JSON.stringify({ from_node: u.start, to_node: u.app })]);
    rows.push(['CRM_APPROVAL_LINK', 'approval-link', '连线', 'active', u.l2, JSON.stringify({ from_node: u.app, to_node: u.end })]);
  }
  for (const [type, slug, title, state, id, payload] of rows) {
    await queryWrite(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [id, TENANT, type, slug, title, state, payload]
    );
  }
}

// 分级审批三级链拓扑（经理→总监→总裁，多 APPROVER 节点，供 T1/T2/T3 档位分发演示）
async function seedTopologyGraded() {
  const g = U.graded;
  const rows = [
    ['CRM_APPROVAL_FLOW', 'approval-flow', '分级审批流', 'enabled', g.flow, JSON.stringify({ name: '分级审批流', enabled: true, versions: [] })],
    ['CRM_APPROVAL_NODE', 'approval-node', '开始', 'active', g.start, JSON.stringify({ flow_id: g.flow, node_type: 'START', name: '开始', pos: 0 })],
    ['CRM_APPROVAL_NODE', 'approval-node', 'A经理', 'active', g.a, JSON.stringify({ flow_id: g.flow, node_type: 'APPROVER', name: 'A经理', pos: 1 })],
    ['CRM_APPROVAL_NODE', 'approval-node', 'B总监', 'active', g.b, JSON.stringify({ flow_id: g.flow, node_type: 'APPROVER', name: 'B总监', pos: 2 })],
    ['CRM_APPROVAL_NODE', 'approval-node', 'C总裁', 'active', g.c, JSON.stringify({ flow_id: g.flow, node_type: 'APPROVER', name: 'C总裁', pos: 3 })],
    ['CRM_APPROVAL_NODE', 'approval-node', '结束', 'active', g.end, JSON.stringify({ flow_id: g.flow, node_type: 'END', name: '结束', pos: 4 })],
    ['CRM_APPROVAL_APPROVER', 'approval-approver', '经理', 'active', g.apA, JSON.stringify({ node_id: g.a, approver_type: 'ROLE', role: 'manager', multi_approver_mode: 'ANY', empty_approver_action: 'ASSIGN_ADMIN' })],
    ['CRM_APPROVAL_APPROVER', 'approval-approver', '总监', 'active', g.apB, JSON.stringify({ node_id: g.b, approver_type: 'ROLE', role: 'director', multi_approver_mode: 'ANY', empty_approver_action: 'ASSIGN_ADMIN' })],
    ['CRM_APPROVAL_APPROVER', 'approval-approver', '总裁', 'active', g.apC, JSON.stringify({ node_id: g.c, approver_type: 'ROLE', role: 'president', multi_approver_mode: 'ANY', empty_approver_action: 'ASSIGN_ADMIN' })],
    ['CRM_APPROVAL_LINK', 'approval-link', '连线', 'active', g.l1, JSON.stringify({ from_node: g.start, to_node: g.a })],
    ['CRM_APPROVAL_LINK', 'approval-link', '连线', 'active', g.l2, JSON.stringify({ from_node: g.a, to_node: g.b })],
    ['CRM_APPROVAL_LINK', 'approval-link', '连线', 'active', g.l3, JSON.stringify({ from_node: g.b, to_node: g.c })],
    ['CRM_APPROVAL_LINK', 'approval-link', '连线', 'active', g.l4, JSON.stringify({ from_node: g.c, to_node: g.end })],
  ];
  for (const [type, slug, title, state, id, payload] of rows) {
    await queryWrite(
      `INSERT INTO particles (id, tenant_id, type, slug, title, state, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [id, TENANT, type, slug, title, state, payload]
    );
  }
}

async function tasksOf(instId) {
  const all = (await queryParticles({ type: 'CRM_APPROVAL_TASK', tenantId: TENANT }))
    .filter(t => t.payload.instance_id === instId)
    .sort((a, b) => (a.payload.seq || 0) - (b.payload.seq || 0));
  return all;
}
async function st(instId) { return (await getParticle(instId)).payload.status; }

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name} ${extra}`); }
  else { fail++; console.log(`  ❌ ${name} ${extra}`); }
}

async function run() {
  console.log('=== 评审引擎种子 + 全链路模拟 ===');
  await seedTopology();
  await seedTopologyGraded();
  const counts = {};
  for (const [label, type] of [['FLOW','CRM_APPROVAL_FLOW'],['NODE','CRM_APPROVAL_NODE'],['APPROVER','CRM_APPROVAL_APPROVER'],['LINK','CRM_APPROVAL_LINK']]) {
    const r = await query(`SELECT count(*)::int n FROM particles WHERE type=$1`, [type]);
    counts[label] = r.rows[0].n;
  }
  console.log(`种子拓扑已落地：FLOW=${counts.FLOW} NODE=${counts.NODE} APPROVER=${counts.APPROVER} LINK=${counts.LINK}`);

  console.log('\n[环节1] 起单 + 或签(ANY)：首个审批人通过即终态');
  {
    const inst = await startInstance(U.any.flow, 'CRM_QUOTATION', 'biz-any-001', {}, { submitter: 'alice', approvers: ['role:manager', 'role:finance'] });
    check('起单成功→APPROVING', (await st(inst.id)) === 'APPROVING');
    const ts = await tasksOf(inst.id);
    check('生成 2 个待签任务', ts.length === 2, `(seq=${ts.map(t=>t.payload.seq).join(',')})`);
    const r = await advanceTask(inst.id, ts[0].id, { approver: ts[0].payload.approver, decision: 'approve', opinion: '同意' });
    check('或签：一人通过即 APPROVED', r.status === 'APPROVED' && (await st(inst.id)) === 'APPROVED');
  }

  console.log('\n[环节2] 会签(ALL)：须全部通过');
  {
    const inst = await startInstance(U.all.flow, 'CRM_CONTRACT', 'biz-all-001', {}, { submitter: 'alice', approvers: ['role:manager', 'role:finance'] });
    const ts = await tasksOf(inst.id);
    const r1 = await advanceTask(inst.id, ts[0].id, { approver: ts[0].payload.approver, decision: 'approve' });
    check('会签：首签后仍 APPROVING', r1.status === 'APPROVING' && (await st(inst.id)) === 'APPROVING');
    const r2 = await advanceTask(inst.id, ts[1].id, { approver: ts[1].payload.approver, decision: 'approve' });
    check('会签：次签后 APPROVED', r2.status === 'APPROVED' && (await st(inst.id)) === 'APPROVED');
  }

  console.log('\n[环节3] 顺序签(SEQUENTIAL)：顺序闸拒绝越序');
  {
    const inst = await startInstance(U.seq.flow, 'CRM_ORDER', 'biz-seq-001', {}, { submitter: 'alice', approvers: ['role:ceo', 'role:cfo'] });
    const ts = await tasksOf(inst.id);
    check('顺序签：seq1=ceo seq2=cfo', ts[0].payload.approver === 'role:ceo' && ts[1].payload.approver === 'role:cfo');
    let threw = false;
    try { await advanceTask(inst.id, ts[1].id, { approver: ts[1].payload.approver, decision: 'approve' }); }
    catch (e) { threw = /顺序闸/.test(e.message); console.log('     越序报错：', e.message); }
    check('顺序闸：seq2 越序被拒', threw);
    const r1 = await advanceTask(inst.id, ts[0].id, { approver: ts[0].payload.approver, decision: 'approve' });
    check('顺序签：seq1 通过仍 APPROVING', r1.status === 'APPROVING');
    const r2 = await advanceTask(inst.id, ts[1].id, { approver: ts[1].payload.approver, decision: 'approve' });
    check('顺序签：seq2 通过 APPROVED', r2.status === 'APPROVED' && (await st(inst.id)) === 'APPROVED');
  }

  console.log('\n[环节4] 加签(addSign)：审批中追加签批人');
  {
    const inst = await startInstance(U.seq.flow, 'CRM_ORDER', 'biz-addsign-001', {}, { submitter: 'alice', approvers: ['role:ceo', 'role:cfo'] });
    const before = (await tasksOf(inst.id)).length;
    const r = await addSignTask(inst.id, { approver: 'role:legal', by: 'role:ceo' });
    const after = (await tasksOf(inst.id)).length;
    check('加签：任务数 +1', after === before + 1, `(seq=${r.seq}, new=${r.task_id.slice(0,8)})`);
  }

  console.log('\n[环节5] 转交(transfer)：改派审批人');
  {
    const inst = await startInstance(U.seq.flow, 'CRM_ORDER', 'biz-transfer-001', {}, { submitter: 'alice', approvers: ['role:ceo', 'role:cfo'] });
    const ts = await tasksOf(inst.id);
    const r = await transferTask(inst.id, ts[0].id, { to: 'role:finance', by: 'role:ceo' });
    const after = await tasksOf(inst.id);
    const transferred = after.find(t => t.payload.status === 'TRANSFERRED');
    const newOne = after.find(t => t.payload.approver === 'role:finance' && t.payload.status === 'TODO');
    check('转交：原任务TRANSFERRED+新任务给finance', !!transferred && !!newOne);
  }

  console.log('\n[环节6] 退回(return)：打回节点重审');
  {
    const inst = await startInstance(U.seq.flow, 'CRM_ORDER', 'biz-return-001', {}, { submitter: 'alice', approvers: ['role:ceo', 'role:cfo'] });
    const ts = await tasksOf(inst.id);
    const r = await returnTask(inst.id, ts[0].id, { approver: 'role:ceo', back_node_id: null, opinion: '材料不全', by: 'role:ceo' });
    check('退回：实例仍 APPROVING', (await st(inst.id)) === 'APPROVING');
    check('退回：current_node 回到审批节点', r.current_node === U.seq.app, `(node=${r.current_node_name})`);
    check('退回：重新生成待签任务', (await tasksOf(inst.id)).some(t => t.payload.status === 'TODO'));
  }

  console.log('\n[环节7] 撤回(withdraw)：提交人撤销');
  {
    const inst = await startInstance(U.seq.flow, 'CRM_ORDER', 'biz-withdraw-001', {}, { submitter: 'alice', approvers: ['role:ceo', 'role:cfo'] });
    const r = await withdrawInstance(inst.id, { by: 'alice' });
    check('撤回：实例 CANCELED', r.status === 'CANCELED' && (await st(inst.id)) === 'CANCELED');
  }

  console.log('\n[环节8] 驳回(reject)：审批人否决');
  {
    const inst = await startInstance(U.seq.flow, 'CRM_ORDER', 'biz-reject-001', {}, { submitter: 'alice', approvers: ['role:ceo', 'role:cfo'] });
    const ts = await tasksOf(inst.id);
    const r = await advanceTask(inst.id, ts[0].id, { approver: ts[0].payload.approver, decision: 'reject', opinion: '不通过' });
    check('驳回：实例 REJECTED', r.status === 'REJECTED' && (await st(inst.id)) === 'REJECTED');
  }

  console.log('\n[环节9] S-code 五段阶段门禁（salesStageGate）：硬附件闸拦截');
  {
    const fiveEdges = ['S1->S2', 'S2->S3', 'S3->S4', 'S4->S5', 'S5->S6'];
    const noAttach = { attachments: [] };
    const withAttach = {
      attachments: [
        { tag: S_ATTACHMENT_GATES['S2->S3'].tag },
        { tag: S_ATTACHMENT_GATES['S4->S5'].tag },
      ],
    };
    const rNoS3 = salesStageGate({ curStage: 'S2', toStage: 'S3', dealPayload: noAttach });
    const attachS3 = g => /技术评审|tech_review_proof/.test(g);
    check('S2→S3 缺技术评审附件→硬拦截(ok:false)', rNoS3.ok === false && rNoS3.gaps.some(attachS3), `(${rNoS3.gaps.join(';')})`);
    const rYesS3 = salesStageGate({ curStage: 'S2', toStage: 'S3', dealPayload: withAttach });
    check('S2→S3 带技术评审附件→附件闸满足(无附件缺口)', !rYesS3.gaps.some(attachS3), `(gaps=${rYesS3.gaps.join(';')})`);
    const rNoS5 = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: noAttach });
    const attachS5 = g => /客户确认|customer_approval_screenshot/.test(g);
    check('S4→S5 缺客户确认截图→硬拦截(ok:false)', rNoS5.ok === false && rNoS5.gaps.some(attachS5));
    const rYesS5 = salesStageGate({ curStage: 'S4', toStage: 'S5', dealPayload: withAttach });
    check('S4→S5 带客户确认截图→附件闸满足(无附件缺口)', !rYesS5.gaps.some(attachS5), `(gaps=${rYesS5.gaps.join(';')})`);
    const allRecog = fiveEdges.every(e => {
      const [f, t] = e.split('->');
      const r = salesStageGate({ curStage: f, toStage: t, dealPayload: withAttach });
      return r && typeof r.ok === 'boolean';
    });
    check('五段跃迁(S1→S2…S5→S6)均被门禁识别', allRecog);
  }

  console.log('\n[环节10] 分级审批档位链（resolveApprovalChain）：R1–R4 × T1/T2/T3');
  {
    const cases = [
      ['R1', 50_000, ['manager']],
      ['R2', 50_000, ['manager']],
      ['R2', 2_000_000, ['manager', 'director']],
      ['R2', 9_000_000, ['manager', 'director', 'president']],
      ['R3', 9_000_000, ['legal', 'vp', 'president']],
      ['R4', 9_000_000, ['finance_vp']],
    ];
    let allOk = true;
    for (const [rule, amt, expected] of cases) {
      const got = resolveApprovalChain(rule, { amount: amt }).approverChain;
      const ok = JSON.stringify(got) === JSON.stringify(expected);
      if (!ok) allOk = false;
      console.log(`     ${rule} @¥${amt}: ${JSON.stringify(got)} ${ok ? '✅' : '❌期望' + JSON.stringify(expected)}`);
    }
    check('R1–R4 各档位链映射正确', allOk);
  }

  console.log('\n[环节11] 漏斗转化率 KPI（funnelConversionRates + 预警）');
  {
    const deals = [
      { id: 'd1', stagesReached: ['S1', 'S2', 'S3', 'S4', 'S5'] },
      { id: 'd2', stagesReached: ['S1', 'S2'] },
      { id: 'd3', stagesReached: ['S1'] },
      { id: 'd4', stagesReached: ['S1', 'S2', 'S3', 'S4'] },
    ];
    const rates = funnelConversionRates(deals);
    check('S1→S2 率=3/4=0.75', Math.abs(rates['S1->S2'].rate - 0.75) < 1e-9, `(rate=${rates['S1->S2'].rate})`);
    check('S2→S3 率=2/3≈0.667≥0.5 健康', rates['S2->S3'].rate >= 0.5, `(rate=${rates['S2->S3'].rate})`);
    check('S4→S5 率=1/2=0.5<0.7 预警', rates['S4->S5'].rate < 0.7, `(rate=${rates['S4->S5'].rate})`);
    const warns = funnelKpiWarnings(rates);
    check('S4→S5 触发预警(warning=true)', warns.some(w => w.from === 'S4' && w.to === 'S5' && w.warning));
  }

  console.log('\n[环节12] 三级审批链端到端（B1 节点推进 + 分级分发）：T1 单签 / T3 全签');
  {
    // T1：仅经理签，总监/总裁 AUTO_PASS 跳过 → 1 次签批即 APPROVED
    const t1 = await startInstance(U.graded.flow, 'QUOTATION', 'biz-graded-t1', { amount: 50_000 }, { submitter: 'alice', approvers: ['manager'] });
    const t1Tasks = (await tasksOf(t1.id)).filter(t => t.payload.status === 'TODO');
    check('T1 仅生成 1 个待签任务(经理)', t1Tasks.length === 1 && t1Tasks[0].payload.approver === 'role:manager');
    const r1 = await advanceTask(t1.id, t1Tasks[0].id, { approver: 'role:manager', decision: 'approve' });
    check('T1 经理签后→APPROVED(总监/总裁自动跳过)', r1.status === 'APPROVED' && (await st(t1.id)) === 'APPROVED');

    // T3：经理→总监→总裁 三节点全签 → APPROVED
    const chain = resolveApprovalChain('R2', { amount: 9_000_000 }).approverChain; // ['manager','director','president']
    const t3 = await startInstance(U.graded.flow, 'QUOTATION', 'biz-graded-t3', { amount: 9_000_000 }, { submitter: 'alice', approvers: chain });
    check('T3 起单→APPROVING(首节点 A经理)', (await st(t3.id)) === 'APPROVING' && (await getParticle(t3.id)).payload.current_node_name === 'A经理');
    let cur = t3;
    for (const signer of ['role:manager', 'role:director', 'role:president']) {
      const pending = (await tasksOf(cur.id)).filter(t => t.payload.status === 'TODO');
      const t = pending.find(x => x.payload.approver === signer);
      const r = await advanceTask(cur.id, t.id, { approver: signer, decision: 'approve' });
      cur = await getParticle(cur.id);
      if (r.status === 'APPROVED') break;
    }
    check('T3 三节点全签→APPROVED', (await st(cur.id)) === 'APPROVED', `(current=${cur.payload.current_node_name})`);
  }

  console.log(`\n=== 模拟结果：通过 ${pass} / 失败 ${fail} ===`);
  console.log(fail === 0 ? '🎉 可用子集(单节点×三种会签模式 + 加签/转交/退回/撤回/驳回 + 分级三级链 + 漏斗KPI + 阶段门禁)全绿。' : '⚠️ 存在未通过环节，见上。');
}

// 优雅退出：关闭连接池，避免 process.exit 突杀连接导致 plm_test max_connections 耗尽
async function shutdown(code) {
  try { await pool.end(); } catch { /* ignore */ }
  try { await poolRead.end(); } catch { /* ignore */ }
  process.exit(code);
}
run().then(() => shutdown(0)).catch(e => { console.error('FATAL', e); shutdown(1); });
