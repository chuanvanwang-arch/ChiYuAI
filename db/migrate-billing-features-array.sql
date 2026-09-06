-- db/migrate-billing-features-array.sql
-- 2026-09-06：config_store['billing-plans'] features 字段 string → string[]（landing 卡片项目动态化前置）
-- 切分规则：` / ` 或 ` + `（两侧带空格，避免误切「核心 CRM（客户/商机/...）」括号内不带空格的斜杠）
-- 幂等：features 已是数组则跳过；多次执行不报错
-- DB 形态：value 是裸数组（API 在路由层包成 {plans: value}），不是 {plans:[...]} 对象
UPDATE crm.config_store
SET value = (
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(plan->'features') = 'string' THEN
        plan || jsonb_build_object(
          'features',
          regexp_split_to_array(plan->>'features', E'\\s+[+/]\\s+')
        )
      ELSE plan  -- 'array' / null / 其他：原样保留
    END
  )
  FROM jsonb_array_elements(value) AS plan
),
updated_at = now()
WHERE tenant_id = 'system' AND key = 'billing-plans';