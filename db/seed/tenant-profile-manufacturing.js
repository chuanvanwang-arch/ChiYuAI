// db/seed/tenant-profile-manufacturing.js
// 新行业上线 Runbook · 制造业（经销商为主 / 渠道分销）行业租户 `tenant-profile` 配置画像。
// 行业模型：厂商 → 经销商（渠道）→ 终端客户；关键对象：经销商 / 终端项目报备 / 提货订单 / 返利结算 / 渠道库存动销。
// 关键纪律：零粒子类型字面量、零新增代码——prototypes 全落 config_store（tenant_id=acme-mfg），
// 其它租户天然不可见（按 tenant_id 隔离）；resolvePrototype 双源解析（代码基线 ∪ 租户画像）。
import { pathToFileURL } from 'url';
import { writeConfig } from '../../src/config/configStore.js';

export async function seedManufacturingProfile(tenantId) {
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {
      MFG_DEALER: {
        label: '经销商',
        flow: ['candidate', 'onboarding', 'active', 'dormant', 'suspended'],
        attributes: ['region', 'dealer_level', 'channel_type', 'territory', 'discount_rate', 'credit_limit', 'rebate_rate'],
        approvalDomains: ['dealer_onboarding'],
        edgeTypes: ['distributes'],
      },
      MFG_PROJECT: {
        label: '终端项目报备',
        flow: ['reported', 'approved', 'quoted', 'won', 'delivered', 'lost'],
        attributes: ['end_customer', 'dealer_name', 'project_amount', 'expected_close'],
        approvalDomains: ['project_report', 'quote'],
      },
      MFG_ORDER: {
        label: '提货订单',
        flow: ['draft', 'confirmed', 'produced', 'shipped', 'received', 'closed'],
        attributes: ['amount', 'discount_rate', 'net_amount', 'delivery_date'],
        approvalDomains: ['order'],
        edgeTypes: ['ordered_by'],
      },
      MFG_REBATE: {
        label: '返利结算',
        flow: ['pending', 'calculated', 'approved', 'paid'],
        attributes: ['period', 'sales_amount', 'rebate_rate', 'rebate_amount'],
        approvalDomains: ['rebate', 'settlement'],
      },
      MFG_CHANNEL_STOCK: {
        label: '渠道库存动销',
        flow: ['normal', 'overstock', 'stockout'],
        attributes: ['sku', 'qty', 'month', 'sell_through'],
      },
    },
    approvalDomains: ['quote', 'contract', 'dealer_onboarding', 'order', 'rebate', 'settlement'],
    calculations: [
      {
        id: 'order_net_amount',
        target: 'MFG_ORDER.payload.net_amount',
        expr: 'amount * (1 - discount_rate)',
        inputs: ['amount', 'discount_rate'],
        trigger: 'on_write',
      },
      {
        id: 'rebate_amount',
        target: 'MFG_REBATE.payload.rebate_amount',
        expr: 'sales_amount * rebate_rate',
        inputs: ['sales_amount', 'rebate_rate'],
        trigger: 'on_write',
      },
    ],
  }, { tenantId });
  return { ok: true, tenantId };
}

// Windows 适配（2026-09-09 实践实证）：win32 下 import.meta.url 与 process.argv[1]
// 在盘符大小写/路径分隔符上不一致，裸比较永不成立 → 直跑静默无操作。
// 归一化守卫范式：scripts/seed-tenant-master-data.mjs:116-118
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  const tenantId = process.argv[2];
  if (!tenantId) { console.error('Usage: node db/seed/tenant-profile-manufacturing.js <tenantId>'); process.exit(1); }
  seedManufacturingProfile(tenantId).then(() => { console.log('seeded manufacturing tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
