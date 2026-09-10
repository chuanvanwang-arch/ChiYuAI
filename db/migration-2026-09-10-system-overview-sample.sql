-- 30 日趋势采样表（system-overview 概览页真实 sparkline 数据源）
-- additive：新表，不改动任何既有表结构
CREATE TABLE IF NOT EXISTS crm.system_overview_sample (
  tenant_id    TEXT    NOT NULL DEFAULT 'system',
  sample_date  DATE    NOT NULL DEFAULT CURRENT_DATE,
  metric       TEXT    NOT NULL,
  value        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, sample_date, metric)
);
CREATE INDEX IF NOT EXISTS idx_crm_so_sample_lookup
  ON crm.system_overview_sample (metric, tenant_id, sample_date);
