// db/seed/tenant-profile-consult2.js
// 新行业上线 Runbook · 企业管理咨询行业 · 第二家公司独立租户（acme-consult2）。
// 与 acme-consult 同行业模型（企业客户/顾问资源/咨询项目/交付物/结算），但按 tenant_id 完全隔离：
// 配置、主数据、知识、账号、粒子互不可见；类型名复用 CONSULT_*（租户内解析，无跨租户冲突）。
import { pathToFileURL } from 'url';
import { writeConfig } from '../../src/config/configStore.js';


export async function seedConsult2Profile(tenantId) {
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
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
  const tenantId = process.argv[2];
  if (!tenantId) { console.error('Usage: node db/seed/tenant-profile-consult2.js <tenantId>'); process.exit(1); }
  seedConsult2Profile(tenantId).then(() => { console.log('seeded consult2 tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
