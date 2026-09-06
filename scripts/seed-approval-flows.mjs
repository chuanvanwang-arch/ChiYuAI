// scripts/seed-approval-flows.mjs — #17 审批流配置种子（域驱动、幂等、单一事实源）
// 经 writeFlowFromStages（配置页 PUT /api/approval-flows/:id 同款逻辑）写入 CRM_APPROVAL_* 粒子
// 幂等：同 domain 已存在 enabled 流则跳过（writeFlowFromStages 自带「软停同域旧流」保证单一事实源）
// 双态：默认连生产库 crm_native(5433)；PGDATABASE=crm_native_test 可指向测试库（对齐 vitest 强制库）
// 注意：本脚本写入业务配置数据，属生产写操作；仅在你授权后运行（默认 crm_native）。
import { writeFlowFromStages, getFlowByDomain } from '../src/approval/flow.js';

// 四业务域审批流种子（角色按业务语义：报价→销售、合同→经理、发票→财务、订单→经理）
// 每域单关卡（引擎当前单节点推进；多关卡需在引擎支持节点间推进后扩展）
const SEED = [
  { flow_id: 'quote',    name: '报价审批流', description: '报价提交后由销售主管核准', stages: [{ stage: 1, role: 'sales',    action: 'approve', auto_allowed: false }] },
  { flow_id: 'contract', name: '合同审批流', description: '合同提交后由经理核准',     stages: [{ stage: 1, role: 'manager',  action: 'approve', auto_allowed: false }] },
  { flow_id: 'invoice',  name: '发票审批流', description: '发票开票后由财务核准',     stages: [{ stage: 1, role: 'finance',   action: 'approve', auto_allowed: false }] },
  { flow_id: 'order',    name: '订单审批流', description: '订单提交后由经理核准',     stages: [{ stage: 1, role: 'manager',  action: 'approve', auto_allowed: false }] },
];

async function seed() {
  console.log('=== #17 审批流配置种子（域驱动）===');
  let created = 0, skipped = 0;
  for (const f of SEED) {
    const existing = await getFlowByDomain(f.flow_id);
    if (existing && existing.payload.enabled !== false) {
      console.log(`⏭  domain=${f.flow_id} 已存在 enabled 流(${existing.id.slice(0, 8)}…)，跳过`);
      skipped++;
      continue;
    }
    const r = await writeFlowFromStages({
      flow_id: f.flow_id, name: f.name, description: f.description, stages: f.stages, enabled: true,
    });
    const written = await getFlowByDomain(f.flow_id);
    console.log(`✅ domain=${f.flow_id} 写入流(${written.id.slice(0, 8)}…) name=${r.name} 关卡数=${r.stages.length}`);
    created++;
  }
  console.log(`\n种子完成：新建 ${created} / 跳过 ${skipped}（共 ${SEED.length} 域）`);
  console.log('提示：可在 approval-flow.html 配置页查看；提交报价/合同/发票/订单时按域自动解析本流。');
}

seed().then(() => process.exit(0)).catch((e) => { console.error('FATAL', e); process.exit(1); });
