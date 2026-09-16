-- T20（S7 链路观测与信任校准）：crm.standing_grant 补暂停时间戳/原因两列
-- 背景：S6 的 pauseGrant 仅置 status='paused'，无时间戳/原因 → 「降级事件可在追溯链中查到」不可窗口化查询。
-- 幂等：ADD COLUMN IF NOT EXISTS，可重复跑。建表单一事实源为 db/schema.sql（同列已追加）。
ALTER TABLE crm.standing_grant
  ADD COLUMN IF NOT EXISTS paused_at     TIMESTAMPTZ;
ALTER TABLE crm.standing_grant
  ADD COLUMN IF NOT EXISTS paused_reason TEXT;
