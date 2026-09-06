// db/seed/tenant-profile-demo.js
// DEMO 演示租户 `tenant-profile` 配置画像（与 tenant-profile-training.js 完全同构）。
// 纪律：DEMO 是「演示标准 CRM 能力」的租户，复用通用 CRM 基线 9 粒子，
//   不声明任何行业自有 prototype（零粒子类型字面量、零新增代码）。
//   prototype 留空 → resolvePrototype 回退代码基线（CRM_ACCOUNT/CRM_DEAL/CRM_CONTRACT…），
//   客户/价格/商机/线索/合同等全部天然可用且按 tenant_id 隔离。
//   仅声明 masterData = 从 system 模板复制四类主数据（产品/价格/政策/字典），
//   使 DEMO 开箱即有非空产品目录与价格表。
import { writeConfig } from '../../src/config/configStore.js';

export const DEMO_TENANT = 'acme-demo';

export async function seedDemoProfile(tenantId = DEMO_TENANT) {
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {},
    masterData: {
      enabled: true,
      types: ['CRM_PRODUCT', 'CRM_PRICE_LIST', 'CRM_OFFER_POLICY', 'CRM_DICT_ENTRY'],
    },
    approvalDomains: ['quote', 'contract', 'deal'],
  }, { tenantId });
  return { ok: true, tenantId };
}

// 允许直接 node 运行（须先 SET 测试库；生产须经决策第0闸）
if (import.meta.url === `file://${process.argv[1]}`) {
  seedDemoProfile().then(() => { console.log('seeded demo tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
