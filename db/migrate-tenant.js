// db/migrate-tenant.js — 多租户幂等加列迁移（禁删铁律：全部 ADD COLUMN IF NOT EXISTS / 软停）
// 运行：PGDATABASE=crm_native_test node db/migrate-tenant.js   （生产库需用户本地授权后执行）
import { pathToFileURL } from 'node:url';
import { queryWrite } from '../src/db.js';

export async function migrateTenant() {
  // 1) 用户表绑租户（种子租户 system）
  await queryWrite(`ALTER TABLE crm.crm_users ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_crm_users_tenant_username ON crm.crm_users (tenant_id, username)`);
  // 2) mcp_identity 绑租户
  await queryWrite(`ALTER TABLE crm.mcp_identity ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  // 3) 决策域（T5 先建，此处一并幂等）
  await queryWrite(`ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`ALTER TABLE crm.audit_event ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  // 3b) 决策 L2 事件流（decision_event）绑定租户（与 decision 同级隔离；默认 system 平台级）
  await queryWrite(`ALTER TABLE crm.decision_event ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  // 4) config_store：加 tenant_id 并重建 PK 为 (tenant_id, key)
  await queryWrite(`ALTER TABLE crm.config_store ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`UPDATE crm.config_store SET tenant_id='system' WHERE tenant_id IS NULL`);
  await queryWrite(`ALTER TABLE crm.config_store ALTER COLUMN tenant_id SET NOT NULL`);
  await queryWrite(`ALTER TABLE crm.config_store DROP CONSTRAINT IF EXISTS config_store_pkey`);
  await queryWrite(`ALTER TABLE crm.config_store ADD PRIMARY KEY (tenant_id, key)`);
  // 5) 决策域查询隔离索引
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_decision_tenant ON crm.decision (tenant_id)`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_audit_event_tenant ON crm.audit_event (tenant_id)`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_decision_event_tenant ON crm.decision_event (tenant_id)`);
  // 6) 老 token 软迁移：mcp_identity.tenant_id IS NULL 的行按 actor→crm_users.username 关联补齐（幂等 UPDATE，禁删）
  await queryWrite(`
    UPDATE crm.mcp_identity mi
    SET    tenant_id = cu.tenant_id
    FROM   crm.crm_users cu
    WHERE  mi.actor  = cu.username
      AND  mi.tenant_id IS NULL
      AND  cu.tenant_id IS NOT NULL
  `);
  console.log('[migrate-tenant] OK');
}

// 直接运行（Windows 下 process.argv[1] 为反斜杠路径，需用 pathToFileURL 统一）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateTenant().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
