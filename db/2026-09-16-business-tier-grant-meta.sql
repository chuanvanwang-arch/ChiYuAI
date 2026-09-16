-- db/2026-09-16-business-tier-grant-meta.sql
-- 2026-09-16 T21 A1（用户批准）：crm.business_tier_config 补授权元数据列。
--
-- 背景（设计 §2.4 D1/D2/D4）：分级表此前仅 4 列，能回答"分级是什么"，
--   答不出"谁批的、何时批的、是否已撤回、何时到期"——"事后审计 + 可撤回"缺载体。
--
-- 列语义（全部为状态字段，**零 DELETE**；撤回 = 状态变更，行保留可审计）：
--   approved_by / approved_at / decision_id      授权溯源（decision_id 与 config_store.decision_id 同构：TEXT 无 FK，
--                                                保持 migration-business-tier-tenant.sql:4 声明的"纯配置叶表"定性）
--   expires_at                                   到期自动失效（NULL = 永不过期）
--   revoked_at / revoked_reason                  显式撤回（NULL = 未撤回）
--
-- 刻意**不引入 status 列**：状态由 revoked_at / expires_at 派生（active / revoked / expired），
--   单一事实源——status 与 revoked_at 双写必然漂移，且漂移方向恰好是"显示生效但实际失效"的不安全侧。
--
-- 幂等：ADD COLUMN IF NOT EXISTS；回填带 WHERE 守卫。

ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS approved_by    TEXT;
ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMPTZ;
ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS decision_id    TEXT;
ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS expires_at     TIMESTAMPTZ;
ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS revoked_at     TIMESTAMPTZ;
ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS revoked_reason TEXT;

-- 存量回填（仅一次，WHERE approved_by IS NULL 守卫）：
--   approved_by='system-seed' 是**事实**——这些行确由 db/migrate.js 出厂种子写入（migrate.js:392-399）。
--   approved_at 刻意**留 NULL**：种子写入时刻不可考，写 now() 等于虚构"批准时间"，
--   而审计列一旦被虚构就失去证据价值（宁可显示"—"）。两列语义不同，不得为了"好看"填平。
UPDATE crm.business_tier_config
   SET approved_by = 'system-seed'
 WHERE approved_by IS NULL;

-- 撤回/到期过滤是 computeBusinessTier 的热路径条件（每次决策一次），给部分索引兜住。
CREATE INDEX IF NOT EXISTS idx_business_tier_active
  ON crm.business_tier_config(tenant_id)
  WHERE revoked_at IS NULL;

DO $$ BEGIN
  RAISE NOTICE '[migrate] business_tier_config 授权元数据列就绪（A1：approved_by/approved_at/decision_id/expires_at/revoked_at/revoked_reason）';
END $$;
