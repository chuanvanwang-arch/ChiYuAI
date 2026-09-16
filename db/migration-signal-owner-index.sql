-- migration-signal-owner-index.sql — T21 信号个人隔离索引（2026-09-16）
--
-- 背景：crm.signal 的 owner_id（责任人）此前从未被写入（实测 204 行全 NULL，成因见
--   scheduleScanner/prospectScanner/researchScheduler 三处 create 调用点丢弃 owner）。
--   T21 起 owner_id 成为**读路径的过滤列**（普通用户只取自己负责的 + 无主同角色广播），
--   故按 (tenant_id, owner_id, created_at DESC) 建索引，避免按人取待办时全表扫描。
--
-- 幂等：IF NOT EXISTS，可重复执行。
-- ⚠ 只读性能索引，不改任何列语义（owner_id 列自 schema.sql:1035 即存在）。

CREATE INDEX IF NOT EXISTS idx_signal_owner
  ON crm.signal(tenant_id, owner_id, created_at DESC);
