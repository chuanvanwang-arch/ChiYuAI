-- 2026-09-14 T4：存量公海（S0）线索补 pooled_at
-- 背景：pooled_at 字段此前无写入源（只有 picked_at/returned_at），入池天数只能退化用 created_at。
--   本迁移幂等回填：仅对缺 pooled_at 的 S0 线索写入（以 updated_at 作为入池近似时刻）。
-- 幂等：重复执行无副作用（已填的 WHERE 条件排除）；失败不阻断主迁移（migrate.js 包 try/catch）。
UPDATE crm.particles
SET payload = payload || jsonb_build_object('pooled_at', to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
WHERE type = 'CRM_DEAL'
  AND payload->>'stage' = 'S0'
  AND payload->>'pooled_at' IS NULL;
