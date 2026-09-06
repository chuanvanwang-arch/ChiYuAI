// db/seed/seed-all-tenants.mjs
// 一次性幂等种子入口（生产 / 测试皆可）：完整开通一个行业所需的两类落库 ——
//   ① tenant-profile 配置画像（落 config_store，供 resolvePrototype 双源解析 + on_write 公式 + 隔离生效）
//   ② 初始销售员账号（落 crm.crm_users，供 /users.html 可见 + 登录）
// 当前覆盖：化工（acme-chem）+ 讲师资源型渠道中介（acme-insmedi）+ 培训（acme-training）
// 对应"新行业上线 Runbook §2 + §10"的最终交付物真正落地到 UI / 运行时可见的库。
//
// 红线：
//   - 绝禁 DELETE
//   - 仅 INSERT / UPSERT 幂等（username 唯一 → 已存在跳过；config_store 走 upsert）
//   - 密码走 pgcrypto crypt + gen_salt('bf')，明文不落日志
//
// 用法：
//   生产：node db/seed/seed-all-tenants.mjs
//   测试：PGDATABASE=crm_native_test node db/seed/seed-all-tenants.mjs
import { seedChemicalProfile, CHEM_TENANT } from './tenant-profile-chemical.js';
import { seedChemicalSalesUser, CHEM_INITIAL_SALES_USERNAME } from './tenant-users-chemical.js';
import { seedInsMediProfile, INSMEDI_TENANT } from './tenant-profile-insmedi.js';
import { seedInsMediSalesUser, INSMEDI_INITIAL_SALES_USERNAME } from './tenant-users-insmedi.js';
import { seedTrainingProfile, TRAINING_TENANT } from './tenant-profile-training.js';
import { seedTrainingSalesUser, TRAINING_INITIAL_SALES_USERNAME } from './tenant-users-training.js';
import { seedTenantMasterData } from '../../scripts/seed-tenant-master-data.mjs';
import { ensureSystemTenant } from '../../src/tenant/tenantRepo.js';
import { seedTenantDefaults } from './tenantDefaults.js';

const t0 = Date.now();

// ① 平台默认租户注册（T9）：system 必须在 crm.tenants（巡检/派发循环的前置断言）
await ensureSystemTenant();

// ① 配置画像（tenant-profile）
await seedChemicalProfile(CHEM_TENANT);
await seedInsMediProfile(INSMEDI_TENANT);
await seedTrainingProfile(TRAINING_TENANT);

// ①B 通用租户默认播种（T10，2026-09-05 G6 升级）：all=true 播全量 8 租户级键（完全独立不共享）
//   现有行业种子已各自 writeConfig 差异化键（tenant-profile 等），此处补 8 键模板副本（幂等，不改 system 行）
await seedTenantDefaults(CHEM_TENANT, { all: true });
await seedTenantDefaults(INSMEDI_TENANT, { all: true });
await seedTenantDefaults(TRAINING_TENANT, { all: true });

// ①B 播种本租户主数据（system 模板复制，Plan B；幂等，依赖 system 已灌主数据）
await seedTenantMasterData(CHEM_TENANT);
await seedTenantMasterData(INSMEDI_TENANT);
await seedTenantMasterData(TRAINING_TENANT);

// ② 初始销售员
const chemInserted = await seedChemicalSalesUser();
const insmediInserted = await seedInsMediSalesUser();
const trainingInserted = await seedTrainingSalesUser();

const ms = Date.now() - t0;
const tenant = process.env.PGDATABASE || 'crm_native';
console.log(JSON.stringify({
  tenant,
  chem: { tenantId: CHEM_TENANT, username: CHEM_INITIAL_SALES_USERNAME, userInserted: chemInserted },
  insmedi: { tenantId: INSMEDI_TENANT, username: INSMEDI_INITIAL_SALES_USERNAME, userInserted: insmediInserted },
  training: { tenantId: TRAINING_TENANT, username: TRAINING_INITIAL_SALES_USERNAME, userInserted: trainingInserted },
  duration_ms: ms,
}, null, 2));
console.log(chemInserted > 0 ? '✅ 化工：用户已新增 1 行（生产可立即登录）' : 'ℹ 化工：用户已存在（幂等跳过，账号可继续登录）');
console.log(insmediInserted > 0 ? '✅ 讲师资源型渠道中介：用户已新增 1 行（生产可立即登录）' : 'ℹ 讲师资源型渠道中介：用户已存在（幂等跳过，账号可继续登录）');
console.log(trainingInserted > 0 ? '✅ 培训：用户已新增 1 行（生产可立即登录）' : 'ℹ 培训：用户已存在（幂等跳过，账号可继续登录）');
