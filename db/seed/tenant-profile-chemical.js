// db/seed/tenant-profile-chemical.js
// 验证样本：化工行业租户 `tenant-profile` 配置画像。
// 目的：验证「新行业上线 Runbook」对化工行业的可用性 —— 零粒子类型字面量、零新增代码。
// prototype 仅声明化工自有对象（客户/供应商/产品/项目/合同/结算）+ 阶段流水线 + 审批域 + 计算规则，
// 全落 config_store，其它租户天然不可见（按 tenant_id 隔离）。
import { pathToFileURL } from 'url';
import { writeConfig } from '../../src/config/configStore.js';


export async function seedChemicalProfile(tenantId) {
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {
      CHEM_CLIENT: {
        label: '化工客户',
        flow: ['lead', 'qualified', 'proposal', 'negotiation', 'signed', 'delivered', 'closed'],
        attributes: ['industry_segment', 'safety_cert', 'annual_volume'],
      },
      CHEM_SUPPLIER: {
        label: '化工供应商',
        flow: ['candidate', 'qualified', 'partnered', 'active', 'suspended'],
        attributes: ['qualification', 'region'],
        edgeTypes: ['supplies', 'distributes'],
      },
      CHEM_PRODUCT: {
        label: '化工产品',
        flow: ['development', 'registered', 'listed', 'discontinued'],
        attributes: ['cas_number', 'hazard_class', 'unit_price', 'msds_url'],
      },
      CHEM_PROJECT: {
        label: '化工项目',
        flow: ['lead', 'need_diagnosed', 'matched', 'quoted', 'confirmed', 'delivering', 'closed'],
        approvalDomains: ['quote', 'deal'],
        attributes: ['subject', 'budget', 'target'],
      },
      CHEM_CONTRACT: {
        label: '化工合同',
        flow: ['draft', 'signed', 'active', 'fulfilled', 'terminated'],
        approvalDomains: ['contract'],
        attributes: ['mode', 'party_a', 'party_b', 'amount'],
      },
      CHEM_SETTLEMENT: {
        label: '化工结算',
        flow: ['pending', 'calculated', 'approved', 'paid'],
        approvalDomains: ['settlement'],
        attributes: ['unit_price', 'quantity', 'tax_rate', 'tax_amount'],
      },
    },
    approvalDomains: ['quote', 'contract', 'settlement'],
    calculations: [
      {
        id: 'settlement_tax',
        target: 'CHEM_SETTLEMENT.payload.tax_amount',
        expr: 'unit_price * quantity * tax_rate',
        inputs: ['unit_price', 'quantity', 'tax_rate'],
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
  const tenantId = process.argv[2];
  if (!tenantId) { console.error('Usage: node db/seed/tenant-profile-chemical.js <tenantId>'); process.exit(1); }
  seedChemicalProfile(tenantId).then(() => { console.log('seeded chemical tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
