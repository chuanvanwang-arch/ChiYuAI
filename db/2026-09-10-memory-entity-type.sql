-- 2026-09-10 客户记忆写回（C1/C2）：memory_log 补 entity_type 列
-- 背景：多租户改造补了 tenant_id（2026-09-03）、客户锚点补了 entity_id（2026-09-02），
--   但锚点「类型」缺失 —— 单看 entity_id 无法判断该 id 是客户、商机还是联系人，
--   按实体聚合时可能跨类型串扰。本迁移只加列，不改既有数据（禁 DELETE / 禁 UPDATE）。
-- 单一事实源：db/schema.sql 已同步声明，新库从零建表无需跑本迁移。

ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_type TEXT;
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_entity ON crm.memory_log(entity_type, entity_id);
