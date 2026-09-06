-- 幂等迁移：crm.tasks 加角色确认审计列 + 扩展 status CHECK（Task 4）
-- 设计输入：docs/2026-08-26-crm-role-confirm-permission-design.md §8（审计字段改挂 crm.tasks）
-- 应用：psql $CRM_DATABASE_URL -f db/migration-confirm-audit.sql   （或 migrate 流程自动加载）

ALTER TABLE crm.tasks
  ADD COLUMN IF NOT EXISTS awaiting_confirm_at timestamptz,
  ADD COLUMN IF NOT EXISTS awaiting_confirm_reason text,
  ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS confirmed_role text,
  ADD COLUMN IF NOT EXISTS switched_from_role text;

ALTER TABLE crm.tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE crm.tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('ready','running','done','failed','blocked','awaiting_confirm'));
