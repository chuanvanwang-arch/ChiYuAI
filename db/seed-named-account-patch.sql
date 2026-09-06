-- db/seed-named-account-patch.sql — 为现有演示客户补被指名销售信息（幂等 UPDATE）
-- 场景：seed.sql 已存在 CRM_ACCOUNT 但缺 named_owner/tier/state，导致 named-accounts 看板无数据
SET search_path TO crm, public;

UPDATE crm.particles
SET payload = jsonb_strip_nulls(payload)
  || jsonb_build_object(
       'named_owner', 'alice',
       'named_tier', '重点',
       'named_state', 'active',
       'visit_notes', jsonb_build_array(
         jsonb_build_object('at', '2026-08-28T10:00:00+08:00', 'type', 'visit', 'objective', '月度拜访', 'result', '确认 Q4 礼盒需求', 'next', '提供报价'),
         jsonb_build_object('at', '2026-08-29T14:00:00+08:00', 'type', 'call', 'objective', '电话跟进', 'result', '对方采购总监出差', 'next', '下周再约')
       )
     ),
    updated_at = now()
WHERE id = 'a1111111-1111-1111-1111-111111111101'
  AND type = 'CRM_ACCOUNT';
