// db/seed/tenant-profile-consult.js
// 新行业上线 Runbook · 企业管理咨询行业租户 `tenant-profile` 配置画像。
// 行业模型：咨询公司 →（自有顾问/外部专家）→ 企业客户；关键对象：企业客户/顾问资源/咨询项目/交付物/结算。
// 关键纪律：零粒子类型字面量、零新增代码——prototypes 全落 config_store（tenant_id=acme-consult），
// 其它租户天然不可见（按 tenant_id 隔离）；resolvePrototype 双源解析（代码基线 ∪ 租户画像）。
import { pathToFileURL } from 'url';
import { writeConfig } from '../../src/config/configStore.js';

export const CONSULT_TENANT = 'acme-consult';

export async function seedConsultProfile(tenantId = CONSULT_TENANT) {
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {
      CONSULT_CLIENT: {
        label: '企业客户',
        flow: ['lead', 'diagnosed', 'proposal', 'negotiation', 'signed', 'delivering', 'closed'],
        attributes: ['industry', 'scale', 'consulting_need', 'budget'],
      },
      CONSULT_CONSULTANT: {
        label: '顾问资源',
        flow: ['candidate', 'screened', 'engaged', 'active', 'released'],
        attributes: ['domain', 'title', 'daily_rate', 'rating'],
        edgeTypes: ['serves'],
      },
      CONSULT_PROJECT: {
        label: '咨询项目',
        flow: ['lead', 'diagnosed', 'proposed', 'contracted', 'delivering', 'reviewed', 'closed'],
        approvalDomains: ['quote', 'deal'],
        attributes: ['scope', 'budget', 'duration_months'],
      },
      CONSULT_DELIVERABLE: {
        label: '交付物',
        flow: ['draft', 'reviewed', 'accepted', 'archived'],
        approvalDomains: ['deal'],
        attributes: ['phase', 'doc_type', 'reviewer'],
      },
      CONSULT_SETTLEMENT: {
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
        target: 'CONSULT_SETTLEMENT.payload.commission',
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
  seedConsultProfile().then(() => { console.log('seeded consult tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
