// db/migrate-propagation.js — 参数传播中枢 DDL（幂等，禁 DELETE）
// 运行：PGDATABASE=crm_native_test node db/migrate-propagation.js   （生产库需用户本地授权后执行）
// 约定与 migrate-tenant.js 一致：queryWrite 来自 ../src/db.js；全部 ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS。
import { pathToFileURL } from 'node:url';
import { queryWrite } from '../src/db.js';

export async function migratePropagation() {
  // 1) memory_log 补 tenant_id（与 config_store 补列同模式；默认 system 平台级）
  await queryWrite(`ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system'`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_memory_log_tenant ON crm.memory_log(tenant_id)`);

  // 2) 租户级经验模板（task→tenant 推广落点，append-only 禁删）
  await queryWrite(`
    CREATE TABLE IF NOT EXISTS crm.tenant_precedent (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     TEXT NOT NULL,
      memory_id     UUID,                      -- 溯源到原 memory_log 条目（promoted_from）
      title         TEXT NOT NULL,
      payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
      source_kind   TEXT NOT NULL DEFAULT 'memory',  -- memory | skill | manual
      promoted_from UUID,                      -- 同源 skill_scope.id / memory_id 溯源
      decision_id   TEXT,                      -- 第0闸锚定
      created_by    TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_tenant_precedent_tenant ON crm.tenant_precedent(tenant_id)`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_tenant_precedent_memory ON crm.tenant_precedent(tenant_id, memory_id)`);

  // 3) skill_scope 补 tenant_id（支持 tenant 轴推广）
  await queryWrite(`ALTER TABLE crm.skill_scope ADD COLUMN IF NOT EXISTS tenant_id TEXT`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_skill_scope_tenant ON crm.skill_scope(skill, tenant_id)`);

  // 4) 传播动作留痕（accept/reject；不改 report，不删）
  await queryWrite(`
    CREATE TABLE IF NOT EXISTS crm.propagation_action (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      suggestion_ref  TEXT NOT NULL,           -- 候选标识：retro:<report_id>:<idx> | memory:<id> | skill:<id>
      kind            TEXT NOT NULL,           -- config_store | memory_promote | skill_promote | broadcast
      status          TEXT NOT NULL,          -- open | accepted | rejected
      decision_id     TEXT,
      by              TEXT,
      detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await queryWrite(`CREATE INDEX IF NOT EXISTS idx_propagation_action_ref ON crm.propagation_action(suggestion_ref)`);

  console.log('[migrate-propagation] done');
}

// 直接运行（Windows 下 process.argv[1] 为反斜杠路径，需用 pathToFileURL 统一）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  migratePropagation().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
