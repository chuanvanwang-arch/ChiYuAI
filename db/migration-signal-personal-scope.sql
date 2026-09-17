-- migration-signal-personal-scope.sql — 行为巡检类信号「按人隔离」存量修正（2026-09-17）
--
-- 触发：用户实测（销售自动化页截图）「这里好像没有完全按照销售员进行隔离，很多信息是相同的」。
--
-- 真库取证（改前，crm.signal）：
--   · visit_shortfall  1013 open + 2 acked，owner_id 非空 = **0**
--   · info_collect_lag  506 open + 1 acked，owner_id 非空 = **0**
--   · dedup_key 全为 NULL → 每 30 分钟新增一批（截图里 21:06:31 与 20:36:33 两套同内容行即此）
--   · 1522 行去重后实际只有 18 个本质不同的快照（6 租户 × 3 指标形状），重复率 98.8%
--   · 全部 target_role='sales' 且 owner_id IS NULL → 命中 T21 读谓词
--     `owner_id=$me OR (owner_id IS NULL AND target_role=$myRole)` 的**广播分支**，
--     于是同租户每个销售员都看到这同一张表。
--
-- 根因不在读路径（T21 的 ownerScope 谓词工作正常），而在**写路径口径**：
--   salesDailyScan 只按租户全量账户聚合，不区分责任人，且产生点未传 owner →
--   这些"某人的拜访量"被当成"全员广播"。代码侧已修（见 src/scheduler/salesDailyScan.js
--   与 src/scheduler/timers.js），本迁移只负责**存量**。
--
-- 处置：关闭这批无主租户级聚合行（status → 'closed'），由改造后的巡检重新产出
--   **个人级**（owner_id=<销售员>, target_role='sales'）与**团队级**
--   （owner_id=NULL, target_role='manager', 稳定 dedup_key）信号接管。
--
-- 为什么是「关闭」而不是「改成 manager 保留」：
--   新巡检会在下一轮（≤30min）产出等价的团队级信号（带稳定 dedup_key）。
--   若保留这批旧行，经理视图会同时出现「旧租户快照」与「新团队快照」两份同内容行——
--   正是用户本次抱怨的重复问题在管理视角复现。且旧行数值是陈旧的（0 次），
--   继续以 open 呈现＝用陈旧快照冒充现状（假绿）。
--
-- 红线：
--   · **零 DELETE** —— 只改 status/closed_reason/evidence，行完整保留，可审计、可回溯；
--   · 不改租户、不改 owner、不动 payload 指标；
--   · 只覆盖本次个人化改造涉及的两个 kind，且仅限 dedup_key IS NULL 的存量行
--     （新逻辑产出的行均带 dedup_key，二次执行命中 0 行 → 幂等）；
--   · 不触碰 signal-observability（target_role='ops'，非销售广播面）。

UPDATE crm.signal
   SET status = 'closed',
       closed_at = COALESCE(closed_at, now()),
       closed_reason = COALESCE(closed_reason, 'superseded-by-personal-isolation'),
       evidence = COALESCE(evidence, '{}'::jsonb)
                  || '{"migration":"2026-09-17-personal-isolation","migrated_reason":"legacy tenant-level aggregate broadcast; superseded by per-owner scan"}'::jsonb
 WHERE kind IN ('visit_shortfall', 'info_collect_lag')
   AND owner_id IS NULL
   AND dedup_key IS NULL
   AND status IN ('open', 'acked');
