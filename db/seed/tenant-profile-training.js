// db/seed/tenant-profile-training.js
// P2(T10) 端到端示例：培训中介租户 `tenant-profile` 配置画像。
// 关键纪律：新行业上线 = 写一份后台配置画像，**零粒子类型字面量、零新增代码**。
// prototype 仅声明行业自有对象（客户/讲师/机构/项目/合同/结算）+ 各自阶段流水线 + 审批域 + 计算规则，
// 全落 config_store，其它租户天然不可见（按 tenant_id 隔离）。
import { writeConfig } from '../../src/config/configStore.js';

export const TRAINING_TENANT = 'acme-training';

export async function seedTrainingProfile(tenantId = TRAINING_TENANT) {
  await writeConfig('tenant-profile', {
    tenantId,
    prototypes: {
      TRAINING_CLIENT: {
        label: '企业客户',
        flow: ['lead', 'diagnosed', 'proposal', 'negotiation', 'signed', 'delivered', 'closed'],
        attributes: ['training_budget', 'training_goal', 'headcount'],
      },
      TRAINER: {
        label: '讲师',
        flow: ['prospect', 'onboarded', 'active', 'retired'],
        attributes: ['expertise_domain', 'daily_rate', 'available_from', 'rating'],
      },
      TRAINING_PROVIDER: {
        label: '培训机构',
        flow: ['candidate', 'partnered', 'active', 'suspended'],
        attributes: ['qualification', 'cooperation_mode'],
        edgeTypes: ['supplies'],
      },
      TRAINING_PROJECT: {
        label: '培训项目',
        flow: ['lead', 'need_diagnosed', 'matched', 'quoted', 'confirmed', 'delivering', 'closed'],
        approvalDomains: ['quote', 'deal'],
        attributes: ['subject', 'duration', 'budget', 'target'],
      },
      TRAINING_CONTRACT: {
        label: '合同',
        flow: ['draft', 'signed', 'active', 'fulfilled', 'terminated'],
        approvalDomains: ['contract'],
        attributes: ['mode', 'party_a', 'party_b', 'amount'],
      },
      TRAINING_SETTLEMENT: {
        label: '结算',
        flow: ['pending', 'calculated', 'approved', 'paid'],
        approvalDomains: ['settlement'],
        attributes: ['revenue', 'cost', 'commission', 'mode'],
      },
    },
    approvalDomains: ['quote', 'contract', 'settlement'],
    calculations: [
      {
        id: 'settlement_commission',
        target: 'TRAINING_SETTLEMENT.payload.commission',
        expr: '(revenue - cost) * commission_rate',
        inputs: ['revenue', 'cost', 'commission_rate'],
        trigger: 'on_write',
      },
    ],
  }, { tenantId });
  return { ok: true, tenantId };
}

// 允许直接 node 运行（须先 SET 测试库；生产须经决策第0闸）
if (import.meta.url === `file://${process.argv[1]}`) {
  seedTrainingProfile().then(() => { console.log('seeded training tenant-profile'); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
