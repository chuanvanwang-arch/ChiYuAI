-- D6 校准审批流 SLA + 超时升级（2026-09-14）
-- 单一事实源 = 本文件；注册于 db/migrate.js INCREMENTAL_SQL（幂等）。
-- 设计：docs/2026-09-14-d6-calibration-approval-flow-plan.md Task A。
-- 铁律：仅加列 + 追加式日志表 + 存量回填（补 NULL 的 sla_due_at）；不删列、不改状态机、不触 apply。

-- ① 升级标记 + SLA 到期时点（两列均幂等 ADD COLUMN IF NOT EXISTS）
ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS sla_due_at TIMESTAMPTZ;
ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS escalated BOOLEAN NOT NULL DEFAULT false;

-- ② 存量回填：sla_due_at = created_at + 风险对应 SLA 窗口
--    SLA 矩阵单一事实源 = src/calibration/store.js SLA_HOURS (HIGH24/MED72/LOW168)，此处 CASE 与其同源。
UPDATE crm.calibration_patch
   SET sla_due_at = created_at + make_interval(hours => CASE risk WHEN 'HIGH' THEN 24 WHEN 'MEDIUM' THEN 72 ELSE 168 END)
 WHERE sla_due_at IS NULL;

-- ③ 升级日志（追加式，禁 DELETE；仅记录 SLA 违约事件，供人工看板路由/升级）
CREATE TABLE IF NOT EXISTS crm.calibration_escalation_log (
  log_id     BIGSERIAL PRIMARY KEY,
  patch_id   UUID NOT NULL REFERENCES crm.calibration_patch(patch_id),
  risk       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note       TEXT
);
CREATE INDEX IF NOT EXISTS idx_calibration_escalation_log_patch
  ON crm.calibration_escalation_log(patch_id);
