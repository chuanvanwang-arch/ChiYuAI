-- db/migration-routing-experiment.sql
-- context-routing 自适应回路 P1（2026-09-05）：时间片 A/B 轮换实验表。
--
-- 背景（设计 §1 缺口 C）：routing 是确定性配置 —— 场景 tracks 不含 narrative 就**永远**不注入，
--   于是「注入叙事 vs 不注入」的对照组恒空，反推在数学上不可能。
-- 解法：时间片 A/B 轮换。关键约束 —— **实验臂绝不写 config_store['context-routing']**（红线 §0），
--   只在装配时做运行时覆盖，配置原值一字不动；结论只出 PENDING 处方，人工批准才写配置。
--
-- 铁律：
--   1) 禁 DELETE —— 实验表 append-only，收口改 status（planned→running→done/aborted），不删行。
--   2) arm <> baseline —— 若实验臂等于配置原值，则无对照价值（"假实验"假绿）。DB 层 CHECK 兜底，
--      应用层创建时亦显式拒绝（routingExperiment.createExperiment）。
--   3) baseline 记录**创建时**的配置原值，供回滚与「是否真反转」校验。
--   4) 幂等：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS。

CREATE TABLE IF NOT EXISTS crm.routing_experiment (
  experiment_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  scenario_id   TEXT NOT NULL,
  track         TEXT NOT NULL,                 -- 'narrative' | 'graph_decision' | 'graph_entity' | 'structured'
  arm           TEXT NOT NULL CHECK (arm IN ('on','off')),      -- 本期实验臂
  baseline      TEXT NOT NULL CHECK (baseline IN ('on','off')), -- 配置原值（是否含该 track）
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  status        TEXT NOT NULL DEFAULT 'planned'
                CHECK (status IN ('planned','running','done','aborted')),
  decision_id   UUID REFERENCES crm.decision(decision_id),      -- 第0闸锚定：建实验即留决策产证
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 硬约束：实验臂必须与配置原值相反，否则无对照价值（防"假实验"假绿）
  CONSTRAINT ck_rexp_arm_differs CHECK (arm <> baseline),
  CONSTRAINT ck_rexp_window_valid CHECK (window_end > window_start)
);

-- 取「当前生效实验」的热查询：(scenario, track) + 状态 + 窗口
CREATE INDEX IF NOT EXISTS ix_crm_rexp_active
  ON crm.routing_experiment(tenant_id, scenario_id, track, status, window_end);

-- 收口扫描：找 window_end <= now 且仍在跑的实验（每日复盘 pass）
CREATE INDEX IF NOT EXISTS ix_crm_rexp_due
  ON crm.routing_experiment(status, window_end)
  WHERE status IN ('planned','running');

COMMENT ON TABLE crm.routing_experiment IS
  '场景路由时间片 A/B 实验（append-only，禁 DELETE）。实验臂只在装配期运行时覆盖，绝不写 config_store["context-routing"]';
