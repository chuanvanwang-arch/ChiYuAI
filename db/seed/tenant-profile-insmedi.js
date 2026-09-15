// db/seed/tenant-profile-insmedi.js
// 验证样本：讲师资源型渠道中介行业租户 `tenant-profile` 配置画像。
// 目的：复用「新行业上线 Runbook」开通"讲师资源型渠道中介"行业 —— 零粒子类型字面量、零新增代码。
// 行业模型：中介机构撮合"讲师资源"（供应侧）与"企业客户/渠道伙伴"（需求侧），承接"培训项目"并结算。
// prototype 仅声明本行业自有对象（企业客户/渠道伙伴/讲师资源/培训项目/合同/结算）+ 阶段流水线 + 审批域 + 计算规则，
// 全落 config_store，其它租户天然不可见（按 tenant_id 隔离）。
import { pathToFileURL } from 'url';
import { writeConfig } from '../../src/config/configStore.js';
import { DISCOVERY_RULES_BY_INDUSTRY } from './discovery-rules-templates.js';


// §12.3 discovery 段：独立落 discovery-rules 键（绝不并入 tenant-profile，保 mergeProfile 三消费点零回归）
export async function seedInsMediDiscovery(tenantId) {
  if (!tenantId) throw new Error('tenantId is required');
  await writeConfig('discovery-rules', DISCOVERY_RULES_BY_INDUSTRY.insmedi, { tenantId });
  return { ok: true, tenantId, key: 'discovery-rules' };
}

export async function seedInsMediProfile(tenantId, opts = {}) {
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  if (!tenantId) throw new Error('tenantId is required (pass as argv[2] or argument)');
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {
      INSMEDI_CLIENT: {
        label: '企业客户',
        flow: ['lead', 'qualified', 'proposal', 'negotiation', 'signed', 'delivered', 'closed'],
        attributes: ['industry', 'scale', 'training_need', 'budget'],
      },
      INSMEDI_CHANNEL: {
        label: '渠道伙伴',
        flow: ['candidate', 'onboarded', 'active', 'suspended'],
        attributes: ['region', 'commission_rate'],
        edgeTypes: ['refers'],
      },
      INSMEDI_INSTRUCTOR: {
        label: '讲师资源',
        flow: ['candidate', 'screened', 'certified', 'active', 'unavailable'],
        attributes: ['domain', 'title', 'hourly_rate', 'rating'],
        edgeTypes: ['teaches'],
      },
      INSMEDI_PROJECT: {
        label: '培训项目',
        flow: ['lead', 'needs_diagnosed', 'matched', 'quoted', 'confirmed', 'delivering', 'closed'],
        approvalDomains: ['quote', 'deal'],
        attributes: ['subject', 'budget', 'target'],
      },
      INSMEDI_CONTRACT: {
        label: '合同',
        flow: ['draft', 'signed', 'active', 'fulfilled', 'terminated'],
        approvalDomains: ['contract'],
        attributes: ['mode', 'party_a', 'party_b', 'amount'],
      },
      INSMEDI_SETTLEMENT: {
        label: '结算',
        flow: ['pending', 'calculated', 'approved', 'paid'],
        approvalDomains: ['settlement'],
        attributes: ['project_revenue', 'instructor_fee', 'channel_commission_rate', 'channel_commission', 'gross_profit'],
      },
    },
    approvalDomains: ['quote', 'contract', 'settlement'],
    calculations: [
      {
        id: 'settlement_channel_commission',
        target: 'INSMEDI_SETTLEMENT.payload.channel_commission',
        expr: 'project_revenue * channel_commission_rate',
        inputs: ['project_revenue', 'channel_commission_rate'],
        trigger: 'on_write',
      },
    ],
  }, { tenantId });
  // §12.3：discovery 段落独立键（不并入 tenant-profile）
  // opts.withDiscovery === false ⇒ 跳过（仅供 tenant-profile-templates.mjs 的哨兵租户使用，避免残留）
  if (opts.withDiscovery !== false) await seedInsMediDiscovery(tenantId);
  return { ok: true, tenantId };
}

// 允许直接 node 运行（须先 SET 测试库；生产须经决策第0闸）
// Windows 适配（2026-09-09 实践实证）：win32 下 import.meta.url 与 process.argv[1]
// 在盘符大小写/路径分隔符上不一致，裸比较永不成立 → 直跑静默无操作。
// 归一化守卫范式：scripts/seed-tenant-master-data.mjs:116-118
const isMain = !!process.argv[1] && import.meta.url.toLowerCase() === pathToFileURL(process.argv[1]).href.toLowerCase();
if (isMain) {
  const tenantId = process.argv[2];
  if (!tenantId) { console.error('Usage: node db/seed/tenant-profile-insmedi.js <tenantId>'); process.exit(1); }
  seedInsMediProfile(tenantId).then(() => { console.log('seeded insmedi tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
