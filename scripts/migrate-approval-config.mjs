// scripts/migrate-approval-config.mjs — 审批业务参数配置铺底（幂等）
//
// 铁律（用户 2026-08-31）：审批业务参数（R1-R4 / 金额档位 / 角色链 / 默认兜底）一律后台可配，
//   禁止硬编码。本脚本将出厂默认写入 config_store['approval-config'] 作为单一事实源种子。
//
// 单一事实源：src/approval/approvalConfig.js（DEFAULT_APPROVAL_CONFIG）；本脚本不重复定义任何默认值。
// 双态说明：默认连生产库 plm(5433)；仅追加写入（ON CONFLICT (key) DO NOTHING），不 DELETE。
// 运行：node scripts/migrate-approval-config.mjs
import { queryWrite } from '../src/db.js';
import { DEFAULT_APPROVAL_CONFIG } from '../src/approval/approvalConfig.js';

async function main() {
  console.log('== migrate-approval-config：铺底 config_store[\'approval-config\']（幂等）==');
  const value = JSON.parse(JSON.stringify(DEFAULT_APPROVAL_CONFIG));
  const r = await queryWrite(
    `INSERT INTO config_store (key, value, decision_id, updated_by, updated_at)
     VALUES ($1, $2, NULL, 'system', now())
     ON CONFLICT (key) DO NOTHING`,
    ['approval-config', JSON.stringify(value)]
  );
  // 判断是否已存在（ON CONFLICT DO NOTHING 不抛错，也不返回行数语义可靠的 inserted）
  const chk = await queryWrite(`SELECT key FROM config_store WHERE key=$1`, ['approval-config']);
  const existed = chk.rowCount > 0;
  console.log(`  结果：${existed ? '已存在（跳过，未覆盖客户配置）' : '已写入'} key=approval-config`);
  console.log(`  结构：rules(R1-R4) / tierThresholds(t2,t3) / tierChains(R1-R4×T1-T3) / majorProjectForceT3 / defaultEmptyApproverAction=${value.defaultEmptyApproverAction}`);
  console.log('完成。前端配置页：/approval-config.html（写经决策第0闸+sysadmin）');
}

main().catch((e) => { console.error('migrate-approval-config 失败:', e); process.exit(1); });
