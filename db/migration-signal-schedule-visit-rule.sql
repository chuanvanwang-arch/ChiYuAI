-- 日期规则补充：visit-remind（拜访提醒，前瞻型）
-- 设计输入：需求③「日期驱动的自动化：到点自动运行……同时建立日历（汇报/投标/拜访/逾期等）」
--
-- ⚠ 为什么不是「新建 config_store 键」（与 migration-signal-schedule-rules.sql 同因）：
--   `signal-schedule` 键**早已存在**（system 模板 + 已克隆到全部业务租户）。
--   整键播种（WHERE NOT EXISTS ... key='signal-schedule'）会因键存在而整段跳过 →
--   新规则永远到不了存量租户（「播种了但没人拿到」的静默失败）。
--   故本迁移同样采用**键内数组按 rule.id 追加**：仅当 rules 中不存在同 id 时追加，
--   逐租户逐规则幂等。
--
-- 缺口背景（2026-09-17 盘点）：
--   既有 4 条规则覆盖 报价审批超时 / 阶段静默（age 型） + 投标截止 / 汇报到期（前瞻/周期），
--   而需求③显式点名的**拜访**无任何规则承载 ⇒「拜访提醒」在配置面零命中。
--
-- 规则设计（每项都对齐既有铁律）：
--   · condition.op = 'due_within_days' —— 与 tender-deadline 同族（**前瞻**型：洽谈要在约定日之前提醒，
--     用 age 语义会得到「拜访过去 3 天后才提醒」，时机反了）。
--   · ts_field = 'visit_at' —— **必须显式声明**（scheduleScanner 铁律：回退 updated_at 会把
--     「最近改过」当成约定日 → 假提醒；ts_field 缺失时该规则直接恒不命中，宁可不出也不误报）。
--   · threshold_days = 3 —— 拜访前 3 天进入提醒窗；这是**业务旋钮**，运营可在配置中心改，
--     阈值一律配置化（零代码字面量）。
--   · severity='high' + target_role='sales' —— 拜访是硬约定，漏掉直接损失一次面谈机会。
--   · bucket='day' —— 同一约定日每日最多提醒一次（跨日不重复轰炸）。
--
-- 幂等与边界（硬约束，与既有 rules 迁移逐条一致）：
--   ① 只追加、绝不删除、绝不覆盖既有规则（禁删铁律 + 不覆盖运营配置）；
--   ② 判定依据是 rule->>'id'（规则 id 是规则集的稳定主键）；
--   ③ 不使用 ON CONFLICT (key)：复合 PK 下 (key) 无唯一约束，会报 no unique constraint；
--   ④ 只作用于**已有该键**的租户（jsonb_typeof(value->'rules')='array' 守卫）；
--      无该键的租户由 autoSeed 从 system 模板克隆时获得（本文件同时向 system 模板追加）。
--
-- ⚠ 规则就绪 ≠ 提醒已发：命中还要求粒子 payload 里**真的有 visit_at**。
--   若某租户 CRM_DEAL 无该字段 → 命中数恒 0，这是**正确行为**（缺口在数据录入侧，不在规则侧）。
--   不得把「零命中」叙述为「提醒已上线」。

UPDATE crm.config_store c
   SET value = jsonb_set(
         c.value,
         '{rules}',
         (c.value->'rules') || '[
           {"id":"visit-remind","kind":"visit_remind","entity_type":"CRM_DEAL",
            "condition":{"op":"due_within_days","threshold_days":3},
            "ts_field":"visit_at","severity":"high","target_role":"sales",
            "enabled":true,"bucket":"day"}
         ]'::jsonb
       ),
       updated_by = 'migrate-seed',
       updated_at = now()
 WHERE c.key = 'signal-schedule'
   AND jsonb_typeof(c.value->'rules') = 'array'
   AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(c.value->'rules') rule WHERE rule->>'id' = 'visit-remind'
       );
