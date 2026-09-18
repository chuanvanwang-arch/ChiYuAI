// db/seed/tenant-profile-manufacturing.js
// 新行业上线 Runbook · 制造业行业租户 `tenant-profile` 配置画像。
// 行业模型：厂商 → 经销商（渠道）→ 终端客户；关键对象：经销商 / 终端项目报备 / 提货订单 / 返利结算 / 渠道库存动销。
// 关键纪律：零粒子类型字面量、零新增代码——prototypes 全落 config_store（tenant_id=厂商租户），
//   其它租户天然不可见（按 tenant_id 隔离）；resolvePrototype 双源解析（代码基线 ∪ 租户画像）。
// 2026-09-18 扩展（经销商渠道门户 v2 §5/T5）：
//   - distributionModel 参数（'direct' 默认直营零联邦；'channel' 含经销商分销原型 + 冲突检测）
//   - MFG_DEALER 补 parent_vendor / dealer_tenant（1:N 联邦锚点）；MFG_PROJECT 补 dealer_tenant（报备回流归属）
//   - conflict_check 计算（对接 federation.detectTerritoryConflict，撞单/窜货检测，解 G3+G6）
import { pathToFileURL } from 'url';
import { writeConfig } from '../../src/config/configStore.js';

// 直营型制造业画像（不含任何经销商原型；纯直销租户零渠道模块干扰）
const DIRECT_PROTOTYPES = {
  MFG_PROJECT: {
    label: '终端项目',
    flow: ['reported', 'approved', 'quoted', 'won', 'delivered', 'lost'],
    attributes: ['end_customer', 'project_amount', 'expected_close'],
    approvalDomains: ['project_report', 'quote'],
  },
  MFG_ORDER: {
    label: '销售订单',
    flow: ['draft', 'confirmed', 'produced', 'shipped', 'received', 'closed'],
    attributes: ['amount', 'discount_rate', 'net_amount', 'delivery_date'],
    approvalDomains: ['order'],
    edgeTypes: ['ordered_by'],
  },
};

// 渠道分销型制造业画像（全量经销商原型 + 冲突检测）
const CHANNEL_PROTOTYPES = {
  MFG_DEALER: {
    label: '经销商',
    flow: ['candidate', 'onboarding', 'active', 'dormant', 'suspended'],
    attributes: ['region', 'dealer_level', 'channel_type', 'territory', 'discount_rate', 'credit_limit', 'rebate_rate', 'parent_vendor', 'dealer_tenant'],
    approvalDomains: ['dealer_onboarding'],
    edgeTypes: ['distributes'],
  },
  MFG_PROJECT: {
    label: '终端项目报备',
    flow: ['reported', 'approved', 'quoted', 'won', 'delivered', 'lost'],
    attributes: ['end_customer', 'dealer_name', 'dealer_tenant', 'project_amount', 'expected_close'],
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
};

export async function seedManufacturingProfile(tenantId, { distributionModel = 'direct' } = {}) {
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  const isChannel = distributionModel === 'channel';
  await writeConfig('tenant-profile', {
    tenantId,
    distributionModel, // 运行时开关：direct ⇄ channel（向后兼容既有 seed 租户 = direct）
    prototypes: isChannel ? CHANNEL_PROTOTYPES : DIRECT_PROTOTYPES,
    approvalDomains: isChannel
      ? ['quote', 'contract', 'dealer_onboarding', 'order', 'rebate', 'settlement']
      : ['quote', 'contract', 'order'],
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
      // 撞单/窜货检测（仅渠道型）：对同 territory 跨经销商的 MFG_PROJECT 报备做冲突比对。
      // 逻辑实现位于 src/federation/conflict.js:detectTerritoryConflict（报备回流 → 写 dealer-conflict-log），
      // 此处为声明式钩子（解 G3 显式窜货/撞单检测 + G6 渠道归属判定）。
      ...(isChannel ? [{
        id: 'conflict_check',
        target: 'config_store:dealer-conflict-log',
        expr: 'detectTerritoryConflict(vendor_tenant, reported_projects)',
        inputs: ['vendor_tenant', 'reported_projects'],
        trigger: 'on_reflow',
        hook: 'src/federation/conflict.js#detectTerritoryConflict',
      }] : []),
    ],
  }, { tenantId });
  return { ok: true, tenantId, distributionModel };
}

// Windows 适配（2026-09-09 实践实证）：win32 下 import.meta.url 与 process.argv[1]
// 在盘符大小写/路径分隔符上不一致，裸比较永不成立 → 直跑静默无操作。
// 归一化守卫范式：scripts/seed-tenant-master-data.mjs:116-118
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  const tenantId = process.argv[2];
  const distributionModel = process.argv[3] || 'direct';
  if (!tenantId) { console.error('Usage: node db/seed/tenant-profile-manufacturing.js <tenantId> [direct|channel]'); process.exit(1); }
  seedManufacturingProfile(tenantId, { distributionModel }).then(() => { console.log(`seeded manufacturing tenant-profile (model=${distributionModel})`); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
