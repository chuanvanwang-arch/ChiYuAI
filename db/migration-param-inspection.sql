-- 2026-09-05 参数闭环：夜批报告补「参数体检」段（JSONB，旧行兼容空）
-- 设计：docs/2026-09-05-param-closedloop-adaptive-design.md §2.2（报告段落用新列方式）
-- 铁律：ALTER 独立迁移文件（禁写进 schema.sql CREATE TABLE IF NOT EXISTS 段——旧库不补列）；
--       幂等可重跑（ADD COLUMN IF NOT EXISTS）。
ALTER TABLE crm.decision_retro_report ADD COLUMN IF NOT EXISTS param_inspection JSONB;
COMMENT ON COLUMN crm.decision_retro_report.param_inspection IS
  '22 项算法参数每夜体检结果（health/verdict/suggested/evidence）；NULL=该次夜批未跑参数体检（旧行兼容）';
