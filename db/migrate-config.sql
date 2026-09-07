-- db/migrate-config.sql — 配置中心表迁移（幂等；Task 9）
-- 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 配置面（S16–S33）
-- 全部 CREATE TABLE IF NOT EXISTS / ALTER ADD COLUMN IF NOT EXISTS，可重复执行
-- 与 crm.schema.sql（主表）+ 各 migration-*.sql（增量）并列
-- 说明：config_store 等用户配置「无种子」（由配置面首次 PUT 产生）；
--      但 skill_registry 是「方法论 SKILL 注册表」（§6.6 后台启停镜像），须从权威 method-* SKILL 种子化，
--      否则 decision_scenario.methodology_ids 引用目标缺失 → 决策场景配置（第14项）methodology_ids 编辑恒 400。

-- 配置存储（configRouter 通用端点读写；write 经第0闸 required_dims 决策）
CREATE TABLE IF NOT EXISTS crm.config_store (
  key          TEXT PRIMARY KEY,
  value        JSONB NOT NULL,
  decision_id  TEXT,              -- 第0闸决策锚定（无决策不写）
  updated_by   TEXT NOT NULL DEFAULT 'system',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 方法论 SKILL 注册表（§6.6 skill_registry：后台启停开关）
-- 列集 = schema.sql 版 ⊕ migrate-config 版 的超集（methodology_id + version 双列齐全），
-- 消除双定义漂移：skillRegistry.js（seed/list/update）契约读 methodology_id，两版 DDL 必须都含。
CREATE TABLE IF NOT EXISTS crm.skill_registry (
  skill_id       TEXT PRIMARY KEY,
  category       TEXT NOT NULL DEFAULT 'methodology',
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  version        TEXT NOT NULL DEFAULT 'v1',
  rbac_roles     TEXT[] NOT NULL DEFAULT '{}',
  methodology_id TEXT,                          -- 方法论镜像 id（method-* 才有；skillRegistry.js 契约列）
  updated_by     TEXT NOT NULL DEFAULT 'system',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 方法论 SKILL 种子（§6.6 单一事实源纪律：skill_registry 为 method-* SKILL 的启停镜像）
-- skill_id 用 DB 大写别名（与 decision_scenario.methodology_ids / methodologySync.MIRROR_ID 对齐），
-- 非 method-* slug —— 否则决策场景配置（第14项）methodology_ids 校验恒失败。
-- rbac_roles 对齐 src/skills/seed.js 的 METHOD_SKILLS；ON CONFLICT DO NOTHING 重跑安全。
INSERT INTO crm.skill_registry (skill_id, category, enabled, version, rbac_roles) VALUES
  ('BANT',               'methodology', TRUE, 'v1', ARRAY['sales']),
  ('MEDDICC',            'methodology', TRUE, 'v1', ARRAY['sales','manager']),
  ('OPP_MATRIX',         'methodology', TRUE, 'v1', ARRAY['sales','manager']),
  ('ROLE_MAP',           'methodology', TRUE, 'v1', ARRAY['presales','sales']),
  ('RISK_TRADEOFF',      'methodology', TRUE, 'v1', ARRAY['sales','manager']),
  ('STOP_LOSS',          'methodology', TRUE, 'v1', ARRAY['exec','manager']),
  ('FACT_VS_TALK',       'methodology', TRUE, 'v1', ARRAY['sales','presales']),
  ('PRESALES_SOLUTION',  'methodology', TRUE, 'v1', ARRAY['presales'])
ON CONFLICT (skill_id) DO NOTHING;

-- 审批流配置（S22 审批流：approval_flow 定义 + 关卡）
-- ⚠️ DEPRECATED（2026-09-07 方案 1，docs/2026-09-07-approval-flow-legacy-retire-design.md）：
--    审批流真源已迁移 CRM_APPROVAL_* 粒子（tenant_id + 懒克隆隔离）；本表零写路径，仅作只读兼容保留
--    （禁 DELETE 铁律不 DROP）；守卫测试 test/http/approvalFlowLegacyGuard.test.js 防重新接线。
CREATE TABLE IF NOT EXISTS crm.approval_flow (
  flow_id       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  stages        JSONB NOT NULL,    -- [{stage, role, action, auto_allowed}]
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 业务分级配置（S23：客户维×项目维，dimension 键值 → tier）—— 与既有 business_tier_config 语义一致，
-- 但按蓝图统一升级为维度 JSON（dimension/dimension_value/tier）；既有表继续兼容
ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS dimension_value TEXT;
ALTER TABLE crm.business_tier_config ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'deal';

-- 连接器 / MCP 配置（S32：connector 联通清单）
CREATE TABLE IF NOT EXISTS crm.connectors (
  connector_id  TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'mcp',
  status        TEXT NOT NULL DEFAULT 'disconnected',  -- connected|disconnected|error
  config        JSONB NOT NULL DEFAULT '{}',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 系统设置（S33：theme/语言/时区/通知等）
CREATE TABLE IF NOT EXISTS crm.system_config (
  config_id   TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  TEXT NOT NULL DEFAULT 'system',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 决策场景七维校验列（D3；Task 4 引擎消费 required_dims）
ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS required_dims JSONB NOT NULL DEFAULT '[]';

-- 幂等索引
CREATE INDEX IF NOT EXISTS idx_config_store_updated ON crm.config_store(updated_at);
CREATE INDEX IF NOT EXISTS idx_connectors_status     ON crm.connectors(status);

-- 用户管理配置（第 12 项）：crm_users 增 enabled 列（禁用软标记，绝对物理删除；变更时间由 config_change 决策事件承载）
ALTER TABLE crm.crm_users ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE;
-- 预警规则配置（第 21 项；内存 alertRegistry 的持久源，启动 hydrate 回填）
-- 引擎热路径同步读缓存；本表为持久源，异步落库
CREATE TABLE IF NOT EXISTS crm.alert_rule (
  kind          TEXT PRIMARY KEY,
  match         JSONB NOT NULL DEFAULT '{}',
  check_params  JSONB NOT NULL DEFAULT '{}',
  severity      TEXT,                       -- low|medium|high|NULL(引擎默认 medium)
  target_role   TEXT,                       -- sales|manager|finance|contract_admin|presales|ops|NULL(引擎默认 ops)
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  version       INT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
