-- db/seed-outcome-event-map.sql
-- P0-2（2026-09-10）：播种业务事件 → 决策结果 映射规则。
-- 背景：outcome_event_map 全库 0 行（探针 D4 实测），即便注册了 outcomeIngester 订阅器，
--   ⑤ 边仍收不到任何结果（规则空集 → handleBusinessEvent 直接 return）。本文件补齐首条规则。
-- 策略（保守起步，见设计文档 §8 第2问）：先只映射「合同签署 → 赢单(won)」一条，
--   观察 3 天无异常再逐步扩到回款/流单/审批驳回。
-- 幂等：WHERE NOT EXISTS 防止重复播种。
-- 注意：需先 SET search_path TO crm,public。本文件由 scripts/seed-db.mjs 统一加载，
--   或经 crm-prod-release 发布到生产后由迁移流程执行。

INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
SELECT
  'decision.contract_sign',
  'won',
  NULL,                                   -- 全场景适用（不限定 scenario）
  '{"deal_id_field":"deal_id"}'::jsonb,   -- 事件 payload 带 deal_id，经 lookupDecisionByDeal 反查最近决策
  true
WHERE NOT EXISTS (
  SELECT 1 FROM crm.outcome_event_map
  WHERE event_type = 'decision.contract_sign' AND outcome_type = 'won'
);
