-- db/cleanup-methodology-skew.sql — 方法论镜像脏维清理（2026-08-26 审计）
-- 问题：methodologySync 旧版 DIM_KEY_NORMALIZE 把 OPPORTUNITY_MATRIX 的 P1 臆造映射为 win_prob2，
--      首次真实同步后在 OPP_MATRIX 镜像下留下孤儿维 win_prob2（SKILL 事实源无此键）。
-- 处置：删除该孤儿维（其 PK 行是旧同步产物；SKILL 事实源无对应，既不破坏 decision_scenario 引用
--      ——scenario 引用的是 methodology_ids（模板级）而非维键——也不属于任何断言目标）。
DELETE FROM crm.methodology_dimension
WHERE methodology_id = 'OPP_MATRIX' AND dim_key = 'win_prob2';

-- 校验：OPP_MATRIX 镜像应回到 3 维（value / win_prob / competitive_position，与 SKILL V1/F1/P1 归一后一致）
-- SELECT methodology_id, dim_key FROM crm.methodology_dimension WHERE methodology_id='OPP_MATRIX' ORDER BY dim_key;

-- STOP_LOSS 镜像：CB 归一键误为 probability（与 SKILL 事实源 methodology.json STOP_LOSS.CB
--   标签「投入预算上限 Cost Budget」自相矛盾，且使审计两侧同口径归一报 dim_skew=false 假绿）。
-- 修正为 cost_budget（RENAME 保留既有 label/weight，非删除），与 SKILL 事实源对齐。
UPDATE crm.methodology_dimension
SET dim_key = 'cost_budget'
WHERE methodology_id = 'STOP_LOSS' AND dim_key = 'probability';

-- 校验：STOP_LOSS 镜像应回到 3 维（burn / cost_budget / exit_guard，与 SKILL NV/CB/EG 归一后一致）
-- SELECT methodology_id, dim_key, label FROM crm.methodology_dimension WHERE methodology_id='STOP_LOSS' ORDER BY dim_key;