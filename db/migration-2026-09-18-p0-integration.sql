-- 2026-09-18 P0 集成借鉴落地（ROX/ATTIO）：幂等叠加备份（对齐 INCREMENTAL_SQL 惯例）
-- 主 DDL 事实源：db/schema.sql 尾部「外部数据接入（S2 入口）」段（新建库由 migrate.js 执行 schema.sql 自动建表）。
-- 本文件为旧库幂等叠加备份，与 schema.sql 内容一致。

-- P0-3：external_ref 新增 outbound_at（我方回写成功时间，last_direction='out' 时有效）
ALTER TABLE crm.external_ref ADD COLUMN IF NOT EXISTS outbound_at TIMESTAMPTZ;

-- P0-2：回写待写队列（写失败不丢意图，drain 重试 + 快照对账）
CREATE TABLE IF NOT EXISTS crm.sync_pending_write (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  provider        TEXT NOT NULL,
  external_object TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  particle_id     UUID,
  target          TEXT NOT NULL DEFAULT 'internal',
  args            JSONB NOT NULL,
  baseline_hash   TEXT,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','applied','skipped_stale','failed')),
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 5,
  last_error      TEXT,
  applied_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sync_pending_write_status
  ON crm.sync_pending_write(tenant_id, status, created_at);
