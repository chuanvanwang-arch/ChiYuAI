-- 2026-09-16 建议落库（E3）：crm.advice_record 运行态表（幂等叠加）
-- 主 DDL 事实源：db/schema.sql 尾部「建议运行态」段（新建库由 migrate.js 执行 schema.sql 自动建表）
-- 本文件为旧库幂等叠加备份（对齐 INCREMENTAL_SQL 惯例），与 schema.sql 内容一致
--
-- ⚠ 为什么是独立表而非 crm.decision + state='ADVISED'（原设计 docs/2026-09-08-dialog-driven-decision-advice-design.md §5）：
--   2026-09-16 源码级盘点发现 crm.decision 有 15 个读取点，其中 8 个是聚合/统计面
--   （dailyOps 日报 / retro 复盘 / calibration 样本 / auditability 抽检 / assembler L2 决策史 …），
--   且 createDecision 的 decided_at 硬写 now()（无 NULL 免疫）+ sevenDimensionsCheck 拦截会在
--   「证据不足」时直接抛错——而建议恰恰产生于证据不足时。故 state='ADVISED' 路线会：
--     ① 永久污染 ~8 个统计面（每个未来新查询都是一个新污染点）；② 在最该记录时写不进去。
--   改用独立运行态表：零读取点改动、零内核改动，与 proactive 的 signal/external_ref 同范式。
--   先例检索硬前置（AI 推测不得混入人的决策先例）由「crm.decision 无 ADVISED 行」结构性满足，
--   并以 test/decision/advice-precedent-guard.test.js 机械化锁死。
--
-- 铁律：不落对话原文（只存结构化摘要 + 关键词 hits）；禁删（观测留痕表，绝不物理删）。
CREATE TABLE IF NOT EXISTS crm.advice_record (
  advice_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        TEXT NOT NULL DEFAULT 'system',
  scenario_id      TEXT,                            -- 定位到的场景（null 时不落库，见 adviceRecord.js）
  stage            TEXT,                            -- 对话坐标阶段（S1..S8 / null）
  advice_tier      TEXT,                            -- 建议档（轴=ADVICE_MATURITY, A/B/C），**非业务分级**
  disposition      TEXT,                            -- 建议处置（APPROVE/ESCALATE/COLLECT…）
  coverage         NUMERIC(6,4),                    -- 证据充分度 0..1
  card_confidence  TEXT,                            -- 建议卡置信档位（'high'/'medium'/'low'，字符串枚举非数值）
  headline         TEXT,                            -- 建议卡抬头（结构化，非原文）
  summary          TEXT,                            -- 结构化诉求摘要：场景@阶段｜诉求关键词（≤120，禁原文）
  hits             JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 诉求关键词（结构化）
  conditions       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 命中条件（satisfied + gaps + redlines 的 cond/label）
  risk_flags       JSONB NOT NULL DEFAULT '[]'::jsonb,  -- 红线 cond 清单（只存标识，不存对话）
  actor_id         TEXT,                            -- 发起人标识（username 优先，可重名的 display_name 不优先）
  actor_role       TEXT,                            -- 角色（sales/manager/…）
  source           TEXT NOT NULL DEFAULT 'dialog-advisor',
  linked_decision_id TEXT,                          -- 采纳配对（后置回填：该建议最终落成的决策锚点）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 轴约束（E2/E3）：建议档只能是 ADVICE_MATURITY 轴的 A/B/C。
  -- 本表**刻意不含**任何业务分级列（business_tier / LEAD|NORMAL|HIGH）——两轴枚举同名反向，
  -- 一旦同表出现即会诱发"按字面同值搬运"的语义反转（历史实坑见 test/advice-tier-axis.test.js）。
  CONSTRAINT ck_advice_record_tier_axis CHECK (advice_tier IS NULL OR advice_tier IN ('A','B','C'))
);
CREATE INDEX IF NOT EXISTS idx_advice_record_tenant_time
  ON crm.advice_record(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_advice_record_scenario
  ON crm.advice_record(tenant_id, scenario_id, created_at DESC);
-- 采纳率统计用：未配对（尚未落成决策）的建议
CREATE INDEX IF NOT EXISTS idx_advice_record_unlinked
  ON crm.advice_record(tenant_id, created_at DESC) WHERE linked_decision_id IS NULL;
