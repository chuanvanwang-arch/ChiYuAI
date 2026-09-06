// db/migrate-approval-flow-wiring.mjs — 方案 A 接线迁移（2026-08-31）
// 将 crm.approval_flow 现存配置翻译为 CRM_APPROVAL_* 粒子，接通运行态审批引擎。
//
// 幂等：writeFlowFromStages 写前软停同 domain 旧 FLOW（禁删铁律，仅置 enabled=false）；
//       重复运行安全（旧版本软停、新版本生效，拓扑一致）。
// 不 DROP crm.approval_flow 表（保留为只读兼容/审计）。
//
// 执行（属生产写操作，需用户授权）：
//   PGDATABASE=crm_native node db/migrate-approval-flow-wiring.mjs
// 测试库：
//   PGDATABASE=crm_native_test node db/migrate-approval-flow-wiring.mjs
import { query } from '../src/db.js';
import { writeFlowFromStages } from '../src/approval/flow.js';

async function main() {
  const { rows } = await query(
    'SELECT flow_id, name, description, stages, enabled FROM crm.approval_flow ORDER BY flow_id'
  );
  console.log(`[migrate] 读取 crm.approval_flow 行数: ${rows.length}`);
  let ok = 0;
  for (const r of rows) {
    const stages = Array.isArray(r.stages)
      ? r.stages
      : r.stages
        ? JSON.parse(r.stages)
        : [];
    const flow = {
      flow_id: r.flow_id,
      name: r.name,
      description: r.description ?? '',
      stages,
      enabled: r.enabled !== false,
    };
    const res = await writeFlowFromStages(flow);
    console.log(
      `[migrate] 已接线 domain=${res.flow_id} 关卡=${res.stages.length} enabled=${res.enabled}`
    );
    ok++;
  }
  console.log(`[migrate] 完成，共 ${ok} 个审批流接入运行态引擎`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[migrate] 失败:', e);
    process.exit(1);
  });
