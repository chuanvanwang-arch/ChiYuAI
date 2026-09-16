// scripts/seed-tenant-demo-data.mjs — DEMO 演示租户端到端种子（生产 / 测试皆可）
// 落地：注册租户 → 写 tenant-profile（主数据复制声明）→ 复制 system 主数据 → 建初始用户 → 建业务演示数据
// 纪律：仅 INSERT/UPSERT 幂等；禁 DELETE；per-tenant 隔离（tenant_id=acme-demo）；零粒子类型字面量（复用 CRM 基线 9 粒子）
// 业务数据 slug 用业务语义，经 upsertParticleByStableKey（stable_key 幂等锚点，与 seedTenantMasterData 同范式）
// 用法：
//   生产：node scripts/seed-tenant-demo-data.mjs
//   测试：PGDATABASE=crm_native_test node scripts/seed-tenant-demo-data.mjs
import { pool, queryWrite, query } from '../src/db.js';
import { ensureSystemTenant } from '../src/tenant/tenantRepo.js';
import { seedDemoProfile } from '../db/seed/tenant-profile-demo.js';
import { seedDemoUsers } from '../db/seed/tenant-users-demo.js';
import { seedTenantMasterData } from './seed-tenant-master-data.mjs';
import { upsertParticleByStableKey } from '../src/particles/mintId.js';

// DEMO 演示租户 id（与本文档 §3 注释、db/seed/tenant-users-demo.js 的 acme-demo 同源隔离）
// ⚠ 2026-09-16 修复：db/seed/tenant-profile-demo.js 只导出 seedDemoDiscovery / seedDemoProfile，
//   从未导出 DEMO_TENANT。原写法 `import { seedDemoProfile, DEMO_TENANT }` 在原生 ESM 下是
//   加载期 SyntaxError（does not provide an export named 'DEMO_TENANT'）→ 本脚本从未能运行。
//   此处本地定义常量；不改动已稳定的 seed 模块（保持其与 tenant-profile-training.js 的同构约定）。
const DEMO_TENANT = 'acme-demo';
const T = DEMO_TENANT;
const SALES = 'acme_demo_sales01';

// 业务粒子 upsert（统一 tenant_id + 默认生命周期；账户自动归 named_owner 使指名看板可见）
async function up(type, slug, title, payload, state = 'ACTIVE') {
  const p = { ...payload };
  if (type === 'CRM_ACCOUNT' && !p.named_owner) { p.named_owner = SALES; p.owner = SALES; p.owner_id = SALES; }
  return upsertParticleByStableKey({ type, slug, title, payload: p, state, tenantId: T });
}

async function main() {
  const t0 = Date.now();

  // ① 平台默认租户（巡检循环前置）
  await ensureSystemTenant();

  // ① 注册 DEMO 租户（幂等；T9 注册表）
  await queryWrite(
    `INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,'DEMO 演示租户','active')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [T]
  );

  // ① 写 tenant-profile（声明主数据复制；零行业字面量）
  await seedDemoProfile(T);

  // ① 复制 system 模板主数据（产品/价格/政策/字典）
  const md = await seedTenantMasterData(T);

  // ② 初始用户（admin/sales/manager）
  const userInserted = await seedDemoUsers(T);

  // ③ 业务演示数据（tenant=acme-demo）
  // —— 客户（3） ——
  const a1 = await up('CRM_ACCOUNT', 'account-yuntu', '上海云图数字科技有限公司', {
    name: '上海云图数字科技有限公司', industry: '软件/SaaS', region: '华东', rating: 'A',
    size: '中型企业', source: '官网询盘', named_state: 'active',
  });
  const a2 = await up('CRM_ACCOUNT', 'account-jinggong', '苏州精工智能制造有限公司', {
    name: '苏州精工智能制造有限公司', industry: '装备制造', region: '华东', rating: 'B',
    size: '大型企业', source: '展会采集', named_state: 'active',
  });
  const a3 = await up('CRM_ACCOUNT', 'account-hailian', '广州海联食品有限公司', {
    name: '广州海联食品有限公司', industry: '食品饮料', region: '华南', rating: 'A',
    size: '中型企业', source: '客户转介绍', named_state: 'active',
  });

  // —— 联系人（2） ——
  await up('CRM_CONTACT', 'contact-zhanglei', '张磊', {
    name: '张磊', email: 'zhanglei@yuntu-demo.com', phone: '13800002001',
    title: '采购总监', department: '采购', decision_power: 'high', relationship_strength: 'strong',
    account_id: a1.id,
  });
  await up('CRM_CONTACT', 'contact-chenjing', '陈静', {
    name: '陈静', email: 'chenjing@jinggong-demo.com', phone: '13800002002',
    title: '技术总监', department: '技术', decision_power: 'medium', relationship_strength: 'medium',
    account_id: a2.id,
  });

  // —— 商机（3，S2–S4 阶段） ——
  const d1 = await up('CRM_DEAL', 'deal-yuntu-crm', '云图 CRM 年度订阅', {
    name: '云图 CRM 年度订阅', owner: SALES, stage: 'S3', account_id: a1.id,
    probability: 0.6, expected_amount: 298000, stage_changed_at: '2026-08-10T09:00:00+08:00',
  });
  const d2 = await up('CRM_DEAL', 'deal-jinggong-digital', '精工产线数字化', {
    name: '精工产线数字化', owner: SALES, stage: 'S4', account_id: a2.id,
    probability: 0.85, expected_amount: 860000, stage_changed_at: '2026-08-22T09:00:00+08:00',
  });
  const d3 = await up('CRM_DEAL', 'deal-hailian-membership', '海联会员营销系统', {
    name: '海联会员营销系统', owner: SALES, stage: 'S2', account_id: a3.id,
    probability: 0.4, expected_amount: 150000, stage_changed_at: '2026-08-30T09:00:00+08:00',
  });

  // —— 线索（2，S1 阶段 = 正式线索） ——
  await up('CRM_DEAL', 'deal-yuntu-lead', '云图子公司 CRM 咨询', {
    name: '云图子公司 CRM 咨询', owner: SALES, stage: 'S1', account_id: a1.id,
    probability: 0.2, expected_amount: 60000, stage_changed_at: '2026-09-01T09:00:00+08:00',
  });
  await up('CRM_DEAL', 'deal-hailian-lead', '海联新厂扩建意向', {
    name: '海联新厂扩建意向', owner: SALES, stage: 'S1', account_id: a3.id,
    probability: 0.15, expected_amount: 90000, stage_changed_at: '2026-09-02T09:00:00+08:00',
  });

  // —— 价格表（1，DEMO 专享价，区别于 system 复制的模板） ——
  await up('CRM_PRICE_LIST', 'pricelist-demo-vip', 'DEMO 演示专享价', {
    name: 'DEMO 演示专享价', products: ['CRM 标准版（SaaS 年费）', '实施服务', '彩盒印制服务'],
    valid_from: '2026-01-01', valid_to: '2026-12-31', permission: 'internal',
    change_log: 'DEMO 租户演示专享价',
  }, 'active');

  // —— 报价（2） ——
  const q1 = await up('CRM_QUOTATION', 'quote-yuntu', '云图 CRM 报价', {
    name: '云图 CRM 报价', deal_id: d1.id, amount: 298000,
    items: [{ qty: 1, tax: 0.13, discount: 0, product_id: 'p-crm-standard', unit_price: 298000 }],
    valid_until: '2026-12-31', approval_status: 'approved', invalid: false,
  });
  const q2 = await up('CRM_QUOTATION', 'quote-jinggong', '精工数字化报价', {
    name: '精工数字化报价', deal_id: d2.id, amount: 860000,
    items: [{ qty: 1, tax: 0.13, discount: 0.05, product_id: 'p-implement', unit_price: 905263 }],
    valid_until: '2026-12-31', approval_status: 'approved', invalid: false,
  });

  // —— 合同（1，关联精工商机 + 报价，已生效） ——
  await up('CRM_CONTRACT', 'contract-demo-001', '精工产线数字化合同', {
    contract_no: 'HT-DEMO-001', deal_id: d2.id, quotation_id: q2.id, amount: 860000,
    start_date: '2026-09-01', end_date: '2027-08-31', approval_status: 'effective',
  }, 'effective');

  const ms = Date.now() - t0;
  const tenant = process.env.PGDATABASE || 'crm_native';
  console.log(JSON.stringify({
    tenant,
    demoTenant: T,
    masterData: md.types,
    userInserted,
    duration_ms: ms,
  }, null, 2));
  console.log(userInserted > 0 ? '✅ DEMO 用户已新增' : 'ℹ DEMO 用户已存在（幂等跳过）');
  console.log('✅ DEMO 租户 + 主数据 + 业务演示数据已就绪（tenant=acme-demo）');

  await pool.end();
  process.exit(0);
}

main().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
