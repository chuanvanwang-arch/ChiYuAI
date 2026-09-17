-- 日期规则补充：tender_deadline（投标截止，前瞻）+ report_due（汇报到期，周期）
-- 设计输入：docs/2026-09-16-signal-export-calendar-design.md §3.3（L3）
--
-- ⚠ 为什么不是「新建 config_store 键」：
--   `signal-schedule` 键**已存在**（system 模板 + 已克隆到 13 个业务租户，各 2 条旧规则）。
--   `WHERE NOT EXISTS (SELECT 1 ... WHERE key='signal-schedule')` 会因键已存在而整段跳过 →
--   新规则永远到不了存量租户（「播种了但没人拿到」的静默失败）。
--   故本迁移改为**键内数组追加**：仅当该租户 rules 中不存在同 id 规则时追加，逐租户逐规则幂等。
--
-- 幂等与边界（硬约束）：
--   ① 只追加、绝不删除、绝不覆盖既有规则（禁删铁律 + 不覆盖运营配置）——运营改过的阈值保留原样；
--   ② 判定依据是 rule->>'id'（规则 id 是规则集的稳定主键）；
--   ③ 不使用 ON CONFLICT (key)：复合 PK 下 (key) 无唯一约束，会报 no unique constraint；
--   ④ 不 seed 任何「字段映射」或占位 provider（P0 刚清掉的桩，不再制造）。
--
-- ⚠ 规则就绪 ≠ 提醒已发（数据面实测，2026-09-16 本地 crm_native）：
--   CRM_DEAL 的 33 个粒子中 `payload ? 'tender_deadline'` = **0**，
--   且其 payload.bidding 只有 {status,handler,redline,started_at,competitors,our_posture}，
--   其中 started_at 是**自由文本**（如 `"2026-11-04 前后"`）而非 ISO —— 即便绑它也会因
--   new Date() 得 NaN 而恒不命中。故 tender_deadline **当前零命中是正确的**，
--   其价值在于「录入该字段即自动生效」；本条已在交付说明中显式标注，不得叙述为"提醒已上线"。
--
-- 用户裁决（2026-09-16）：对当前所有既有租户统一采用（与 signal-delivery 同范式，不逐租户挑选取舍）。
-- 执行渠道：db/migrate.js 的启动链路（容器启动即跑）；测试库不播种（见 scripts/seed-test-config.mjs ⑱ 注）。

-- tender_deadline：截止日落在未来 7 天内 → high（前瞻型；提交标书有硬时限）
UPDATE crm.config_store c
   SET value = jsonb_set(
         c.value,
         '{rules}',
         (c.value->'rules') || '[
           {"id":"tender-deadline","kind":"tender_deadline","entity_type":"CRM_DEAL",
            "condition":{"op":"due_within_days","threshold_days":7},
            "ts_field":"tender_deadline","severity":"high","target_role":"sales",
            "enabled":true,"bucket":"day"}
         ]'::jsonb
       ),
       updated_by = 'migrate-seed',
       updated_at = now()
 WHERE c.key = 'signal-schedule'
   AND jsonb_typeof(c.value->'rules') = 'array'
   AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(c.value->'rules') rule WHERE rule->>'id' = 'tender-deadline'
       );

-- report_due：每周五 17 点 → 个人级提醒（周期型，不绑粒子；owner 逐用户展开）
UPDATE crm.config_store c
   SET value = jsonb_set(
         c.value,
         '{rules}',
         (c.value->'rules') || '[
           {"id":"report-due","kind":"report_due","entity_type":null,"schedule_kind":"periodic",
            "weekday":5,"hour":17,"severity":"low","target_role":"sales",
            "enabled":true,"bucket":"week"}
         ]'::jsonb
       ),
       updated_by = 'migrate-seed',
       updated_at = now()
 WHERE c.key = 'signal-schedule'
   AND jsonb_typeof(c.value->'rules') = 'array'
   AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(c.value->'rules') rule WHERE rule->>'id' = 'report-due'
       );
