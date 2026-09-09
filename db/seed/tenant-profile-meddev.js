// db/seed/tenant-profile-meddev.js
// 新行业上线 Runbook · 医疗器械行业租户 `tenant-profile` 配置画像。
// 行业模型：厂商 →（直销/经销商）→ 医院终端；关键对象：医院客户/经销商/临床试用/招标项目/结算。
// 关键纪律：零粒子类型字面量、零新增代码——prototypes 全落 config_store（tenant_id=acme-meddev），
// 其它租户天然不可见（按 tenant_id 隔离）；resolvePrototype 双源解析（代码基线 ∪ 租户画像）。
import { pathToFileURL } from 'url';
import { writeConfig } from '../../src/config/configStore.js';

export const MEDDEV_TENANT = 'acme-meddev';

export async function seedMeddevProfile(tenantId = MEDDEV_TENANT) {
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {
      MEDDEV_HOSPITAL: {
        label: '医院客户',
        flow: ['lead', 'qualified', 'trial', 'tender', 'contracted', 'deployed', 'closed'],
        attributes: ['hospital_grade', 'department', 'procurement_budget'],
      },
      MEDDEV_DEALER: {
        label: '经销商',
        flow: ['candidate', 'onboarded', 'active', 'suspended'],
        attributes: ['region', 'cooperation_mode', 'discount_rate'],
        edgeTypes: ['distributes'],
      },
      MEDDEV_TRIAL: {
        label: '临床试用',
        flow: ['applied', 'approved', 'deploying', 'evaluating', 'converted', 'terminated'],
        approvalDomains: ['deal'],
        attributes: ['device_model', 'department', 'trial_period'],
      },
      MEDDEV_TENDER: {
        label: '招标项目',
        flow: ['preparing', 'published', 'bidding', 'awarded', 'contracted', 'lost'],
        approvalDomains: ['quote', 'contract'],
        attributes: ['tender_no', 'bid_amount', 'close_date'],
      },
      MEDDEV_SETTLEMENT: {
        label: '结算',
        flow: ['pending', 'calculated', 'approved', 'paid'],
        approvalDomains: ['settlement'],
        attributes: ['revenue', 'cost', 'commission_rate', 'commission'],
      },
    },
    approvalDomains: ['quote', 'contract', 'settlement'],
    calculations: [
      {
        id: 'settlement_commission',
        target: 'MEDDEV_SETTLEMENT.payload.commission',
        expr: 'revenue * commission_rate',
        inputs: ['revenue', 'commission_rate'],
        trigger: 'on_write',
      },
    ],
  }, { tenantId });
  return { ok: true, tenantId };
}

// 允许直接 node 运行（须先 SET 测试库；生产须经决策第0闸）
// Windows 适配（2026-09-09 实践实证）：win32 下 import.meta.url 与 process.argv[1]
// 在盘符大小写/路径分隔符上不一致，裸比较永不成立 → 直跑静默无操作。
// 归一化守卫范式：scripts/seed-tenant-master-data.mjs:116-118
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  seedMeddevProfile().then(() => { console.log('seeded meddev tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
