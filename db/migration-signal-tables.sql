-- 2026-09-16 主动运行时 S1：crm.signal + crm.signal_delivery 运行态表（幂等叠加）
-- 主 DDL 事实源：db/schema.sql 尾部「主动运行时」段（新建库由 migrate.js 执行 schema.sql 自动建表）
-- 本文件为旧库幂等叠加备份（对齐 INCREMENTAL_SQL 惯例），与 schema.sql 内容一致

-- 信号统一收口（替换 src/alerts/alertStore.js 内存 Map 为 DB 持久化）
CREATE TABLE IF NOT EXISTS crm.signal (
  signal_id     TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  source        TEXT NOT NULL,                      -- rule-scan | event-trigger | agent-research | external
  kind          TEXT NOT NULL,                      -- 告警 kind + 新增 kind
  severity      TEXT NOT NULL,                      -- low | medium | high
  target_role   TEXT NOT NULL,                      -- sales | finance | exec | ops
  owner_id      TEXT NULL,
  l2c_stage     TEXT NULL,
  particle_id   TEXT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence      JSONB NOT NULL DEFAULT '{}'::jsonb,
  suggestion    JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'open',       -- open | acked | closed | acted
  dedup_key     TEXT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  acked_at      TIMESTAMPTZ NULL,
  closed_at     TIMESTAMPTZ NULL,
  acted_at      TIMESTAMPTZ NULL
);
CREATE INDEX IF NOT EXISTS idx_signal_open
  ON crm.signal(tenant_id, status, severity, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_kind
  ON crm.signal(tenant_id, kind, created_at DESC);
-- 去重索引：谓词与 store.findOpenByDedup 逐字一致（2026-09-16 修正，见 db/migration-signal-dedup-index.sql）
CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_dedup
  ON crm.signal(tenant_id, dedup_key) WHERE dedup_key IS NOT NULL AND status IN ('open','acked');

-- 投递流水（防假绿核心：send 被调用 ≠ 已送达）
CREATE TABLE IF NOT EXISTS crm.signal_delivery (
  delivery_id     TEXT PRIMARY KEY,
  signal_id       TEXT NOT NULL,
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  channel         TEXT NOT NULL,                    -- inbox | email | im | webhook
  provider        TEXT NULL,                        -- smtp | dingtalk | wecom | feishu | custom
  recipient       TEXT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',  -- pending | sent | failed | skipped
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT NULL,
  provider_msg_id TEXT NULL,
  delivered_at    TIMESTAMPTZ NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_delivery_signal ON crm.signal_delivery(signal_id);
CREATE INDEX IF NOT EXISTS idx_delivery_fail
  ON crm.signal_delivery(tenant_id, status, created_at DESC);
