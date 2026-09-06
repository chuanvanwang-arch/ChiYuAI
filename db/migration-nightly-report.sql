-- 2026-09-05 夜批三段全量日报：落库表（幂等；新表不受 CREATE IF NOT EXISTS 不补列陷阱影响）
CREATE TABLE IF NOT EXISTS crm.nightly_report (
  report_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_date        DATE NOT NULL UNIQUE,
  title           TEXT,
  file_path       TEXT,
  seg_retro_json  JSONB,
  seg_routing_json JSONB,
  seg_param_json  JSONB,
  total_tasks     INT,
  healthy         INT,
  drift           INT,
  patches_count   INT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE crm.nightly_report IS '每日夜批三段（复盘/路由/参数）全量日报落库；run_date 唯一→重跑幂等';
