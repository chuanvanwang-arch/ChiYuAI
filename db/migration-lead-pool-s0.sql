-- db/migration-lead-pool-s0.sql
-- 存量 lead 三分支迁移（2026-09-11）
-- 设计：docs/2026-09-11-lead-public-pool-tenant-design.md §6-T3（存量迁移）
-- 语义：无主 → S0 公海 / 有主且 BANT 达标 → S1 正式线索 / 有主未达标 → S0P 私海待校验
-- 三条互斥且覆盖全部存量（stage ∈ {lead, S1, S0}）；阈值读 config_store 不硬编码。
-- 铁律：仅 JSONB 字段变更，**禁 DELETE**。
-- 注：本文件为**数据迁移脚本**（文档留存 + 按需手工执行），不进 db/migrate.js 的 INCREMENTAL_SQL 清单
--     （schema.sql 是 DDL 单一事实源；此处只有 UPDATE，重复执行幂等——见文末守恒校验）。

-- ① 无主 → S0（公海）
UPDATE crm.particles p
   SET payload = p.payload || jsonb_build_object(
         'stage', 'S0',
         'pool_type', COALESCE(p.payload->>'pool_type', 'new'))
 WHERE type='CRM_DEAL'
   AND p.payload->>'stage' IN ('lead','S1','S0')
   AND COALESCE(p.payload->>'owner_id','') = '';

-- ② 有主 且 BANT 达标 → S1（正式线索），补 qualified_at
-- 达标判据：ai.bantcc_completeness.value ≥ config_store['sales-thresholds'].bantcc.pass（缺省 0.6）
--           或 bantcc.budget 与 bantcc.authority 均已填（等价于 B+A 双要素齐备）
WITH cfg AS (
  SELECT COALESCE(
    (SELECT (value #>> '{bantcc,pass}')::numeric
       FROM crm.config_store WHERE tenant_id='system' AND key='sales-thresholds'),
    0.6) AS bantcc_pass
)
UPDATE crm.particles p
   SET payload = p.payload || jsonb_build_object(
         'stage', 'S1',
         'qualified_at', COALESCE(p.payload->>'qualified_at', to_char(now(),'YYYY-MM-DD')),
         'pool_type', COALESCE(p.payload->>'pool_type', 'new'))
 WHERE type='CRM_DEAL'
   AND p.payload->>'stage' IN ('lead','S1')
   AND COALESCE(p.payload->>'owner_id','') <> ''
   AND ( COALESCE((p.payload->'ai'->'bantcc_completeness'->>'value')::numeric, 0) >= (SELECT bantcc_pass FROM cfg)
      OR (p.payload->'bantcc'->>'budget' IS NOT NULL AND p.payload->'bantcc'->>'authority' IS NOT NULL) );

-- ③ 有主 且 BANT 未达标 → S0P（私海待校验）
WITH cfg AS (
  SELECT COALESCE(
    (SELECT (value #>> '{bantcc,pass}')::numeric
       FROM crm.config_store WHERE tenant_id='system' AND key='sales-thresholds'),
    0.6) AS bantcc_pass
)
UPDATE crm.particles p
   SET payload = p.payload || jsonb_build_object(
         'stage', 'S0P',
         'pool_type', COALESCE(p.payload->>'pool_type', 'new'))
 WHERE type='CRM_DEAL'
   AND p.payload->>'stage' IN ('lead','S1')
   AND COALESCE(p.payload->>'owner_id','') <> ''
   AND NOT ( COALESCE((p.payload->'ai'->'bantcc_completeness'->>'value')::numeric, 0) >= (SELECT bantcc_pass FROM cfg)
          OR (p.payload->'bantcc'->>'budget' IS NOT NULL AND p.payload->'bantcc'->>'authority' IS NOT NULL) );

-- ── 守恒校验（执行后手工核对；期望：①=0，②三分支计数之和等于迁移前线索总数）──
-- 校验①：无残留 lead
SELECT count(*) AS residual_lead FROM crm.particles WHERE type='CRM_DEAL' AND payload->>'stage'='lead';
-- 校验②：三分支分布
SELECT payload->>'stage' AS stage, count(*) FROM crm.particles
 WHERE type='CRM_DEAL' AND payload->>'stage' IN ('S0','S0P','S1')
 GROUP BY 1 ORDER BY 1;
