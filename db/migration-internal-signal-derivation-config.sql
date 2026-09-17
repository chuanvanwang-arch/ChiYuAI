-- 内部可观测客户异动派生配置（2026-09-16）
-- 设计输入：docs/2026-09-16-internal-signal-derivation-design.md §3.2
-- 消费方：src/signal/activityDerivation.js（阈值/窗口/启停零代码字面量）
--
-- ⚠ 本键与 signal-schedule 的关键差别：这是一个**新键**（全库零行），故可直接用「整键播种 +
--   WHERE NOT EXISTS」范式（对齐 migration-sync-config.sql）。若将来本键已存在而需加规则，
--   必须改用「键内数组按 rule.id 追加」（见 db/migration-signal-schedule-rules.sql 头注），
--   否则存量租户永远拿不到新规则。
--
-- 口径边界（不得宣传为"招聘/新战略情报"）：
--   本配置只声明平台**内部可观测**的两类客户异动：
--     contact-ledger-change —— 客户侧联系人台账变动（CRM_CONTACT 近 14 天内被更新）= 「关键人变动」的**弱代理**
--     relation-cooling      —— 客户/商机关系冷却（CRM_ACCOUNT 停滞超 30 天）
--   「人员招聘」「新战略」在本平台**无数据源**（无 HR / 无战略情报面），本文件**刻意不含**其任何字段，
--   也绝不为其写占位映射（P0 刚清掉的桩，不再制造）。
--   relation-cooling 的判据**只**用粒子 updated_at 停滞：平台内无互动流水表（interactionIndex 枚举
--   全仓零消费者），故不宣称"无近期互动"。
--
-- 权重口径：派生信号在 discoveryRules 中权重**低于**实测情报（见 src/config/discoveryRules.js 的 coverage 标注）。
-- 幂等：WHERE NOT EXISTS（两代主键下均成立）；仅 INSERT，不删不改既有行。
-- 执行渠道：db/migrate.js 的 INCREMENTAL_SQL（容器启动即跑）。
--   **刻意不加入 scripts/seed-test-config.mjs**：派生器测试全部走注入式替身（零 DB），
--   测试库无需该键；而在测试库凭空多一个键会制造"配置已存在"的隐式前提（与 ⑱ signal-delivery 注解同源纪律）。
INSERT INTO crm.config_store (tenant_id, key, value, updated_by, updated_at)
SELECT 'system', 'internal-signal-derivation', '{
  "version": 1,
  "enabled": true,
  "rules": [
    {"id":"contact-ledger-change","kind":"contact_change","entity_type":"CRM_CONTACT","window_days":14,
     "severity":"low","target_role":"sales","enabled":true,"bucket":"day"},
    {"id":"relation-cooling","kind":"relation_cooling","entity_type":"CRM_ACCOUNT","threshold_days":30,
     "severity":"medium","target_role":"sales","enabled":true,"bucket":"week"}
  ]
}'::jsonb, 'system', now()
WHERE NOT EXISTS (SELECT 1 FROM crm.config_store WHERE key='internal-signal-derivation');
