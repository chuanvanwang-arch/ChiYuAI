-- db/migration-routing-observability.sql
-- context-routing 自适应回路 P0（2026-09-05）：快照补 routing 列，解决「决策不留轨道」缺口 A。
--
-- 背景：assembleContextV2 已在内存 bundle 回带 routing（scene/tracks/mode/score），
--   但 crm.decision_context_snapshot 无对应列 → 快照落库即丢 → 事后无法回算
--   「这条决策当时注入叙事了吗」，A/B 反推在数学上不可能（设计 §1 缺口 A）。
--
-- 铁律：
--   1) 不得写进 schema.sql 的 CREATE TABLE 段 —— CREATE TABLE IF NOT EXISTS 对已存在的库不补列，
--      而后续依赖该列的索引会让整文件单事务迁移全量回滚。必须独立 ALTER（同 migration-*.sql 既有模式）。
--   2) 禁 DELETE：本文件只加列/加索引，不动任何数据。
--   3) 幂等：ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS。
--
-- 不加列到 crm.decision（避免宽表与兼容成本），经 assembly_id / decision_id → snapshot.routing 关联。

ALTER TABLE crm.decision_context_snapshot ADD COLUMN IF NOT EXISTS routing JSONB;

-- 按场景检索「某场景走了哪些轨」的样本（聚合 A/B 判据时按 scene 过滤）
CREATE INDEX IF NOT EXISTS ix_crm_dcs_routing_scene
  ON crm.decision_context_snapshot((routing->>'scene'));

-- 注释：便于 DBA 在 psql 里 \d+ 时看到列语义
COMMENT ON COLUMN crm.decision_context_snapshot.routing IS
  '场景路由回带（scene/tracks/mode/score/exp_*），P0 仅观测落库，不参与任何写入决策';
