-- db/schema.sql — 阶段1 单库底座（crm schema）
-- 环境：现有 PG16@5433（agent2b 用户）+ plm 库内独立 crm schema（与 PDM 表隔离）
-- 设计输入：总体架构 §1 L1/L2/L3；01 粒子设计 §4 受控谓词；03 编排设计 §状态机
CREATE SCHEMA IF NOT EXISTS crm AUTHORIZATION agent2b;
SET search_path TO crm, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- ===== 粒子平面 L1 =====
CREATE TABLE IF NOT EXISTS crm.particles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'system',
  type TEXT NOT NULL,                       -- 粒子类型（自由 TEXT，非枚举）：CRM_DEAL/CRM_ACCOUNT/CRM_CONTACT/CRM_PRODUCT/CRM_PRICE_LIST/CRM_PERSON/CRM_ORGANIZATION/CRM_KNOWLEDGE/CRM_UNSTRUCTURED_ASSET/CRM_TECHNICAL_PROPOSAL(售前技术方案)
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE',
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(384),                    -- L0 整实体向量（写时构建）
  content_hash TEXT,                        -- 幂等判变（内容没变不重算）
  stable_key TEXT,                          -- 6.7 确定性标识：sha256(tenant|type|slug)，幂等定址（见 src/particles/mintId.js）
  fts TSVECTOR,                             -- FTS 通道（ensureTsVector 双写）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 待办②(2026-09-03) 深度防御：业务写经第0闸 mint 的 decision_id 持久化；系统写豁免为 NULL，历史行 NULL 兼容不回填。
  -- ⚠ 此处只建列、不加内联外键：crm.decision 在本文件第 155 行才创建，内联 REFERENCES 会造成前向引用，
  --   导致**从零建库时整文件（单事务）回滚、0 张表**（2026-09-04 云上部署实测踩坑）。
  --   外键约束在 crm.decision 建好后由下方「fk_crm_particles_decision」幂等补建（见本文件 decision 表之后）。
  decision_id UUID
);
CREATE INDEX IF NOT EXISTS idx_crm_particles_type ON crm.particles(type, tenant_id);
CREATE INDEX IF NOT EXISTS idx_crm_particles_slug ON crm.particles(slug, tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_particles_stable_key ON crm.particles(stable_key);
CREATE INDEX IF NOT EXISTS idx_crm_particles_payload ON crm.particles USING gin (payload);
CREATE INDEX IF NOT EXISTS idx_crm_particles_embedding ON crm.particles USING hnsw (embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS idx_crm_particles_fts ON crm.particles USING gin (fts);

CREATE TABLE IF NOT EXISTS crm.edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'system',
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  edge_type TEXT NOT NULL,                  -- 受控谓词（belongs_to/owned_by/part_of/...）
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_edges_source ON crm.edges(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_crm_edges_target ON crm.edges(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_crm_edges_type ON crm.edges(edge_type);

-- 2026-09-03 多行业配置化（G3）：edges 加 cardinality（HAS_ONE/HAS_MANY 约束）
ALTER TABLE crm.edges ADD COLUMN IF NOT EXISTS cardinality TEXT NOT NULL DEFAULT 'many'
  CHECK (cardinality IN ('one','many'));

-- ===== 编排平面 L3（03 编排设计：极简四态 + 熔断 + 审计） =====
CREATE TABLE IF NOT EXISTS crm.tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL DEFAULT 'system',
  chain_id TEXT,
  step TEXT NOT NULL,
  title TEXT NOT NULL,
  action_name TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('ready','running','done','failed','blocked')),
  worker_pid INT,
  worker_host TEXT,
  consecutive_failures INT NOT NULL DEFAULT 0,
  block_kind TEXT,
  result JSONB,
  result_path TEXT,
  depends_on UUID[] NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_chain ON crm.tasks(tenant_id, chain_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_status ON crm.tasks(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_depends ON crm.tasks USING gin (depends_on);

CREATE TABLE IF NOT EXISTS crm.task_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES crm.tasks(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  by_actor TEXT NOT NULL DEFAULT 'system',
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_task_audit_task ON crm.task_audit(task_id);

CREATE TABLE IF NOT EXISTS crm.scheduler_lock (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pid INT NOT NULL,
  host TEXT,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ===== 事件平面 L2（事件持久化 + 审计；SSE 5 域雏形） =====
CREATE TABLE IF NOT EXISTS crm.events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,                     -- task/trace/approval/particle/payment
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  actor TEXT NOT NULL DEFAULT 'system',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_events_domain ON crm.events(domain, created_at);

-- ATTIO C 桶：交互事件渠道索引（channel ∈ email/calendar/call/meeting/general，见 11 增量设计 §3.4）
CREATE INDEX IF NOT EXISTS idx_crm_events_payload_channel
  ON crm.events USING gin ((payload->'channel'));

-- ===== 决策事件主轴（§6 顶层逻辑；D1 落地；向量维度对齐底座 vector(384)）=====
-- 注：阶段1 本体走 edges 表 + pgvector，未引入 Apache AGE（与 §1 表述偏差，见总体设计 §8.3-②）
CREATE TABLE IF NOT EXISTS crm.decision_scenario (
  scenario_id        TEXT PRIMARY KEY,
  stage              TEXT NOT NULL,
  description        TEXT,
  trigger            JSONB NOT NULL,
  methodology_ids    TEXT[] NOT NULL DEFAULT '{}',
  eval_dimensions    JSONB NOT NULL,
  default_tier       TEXT NOT NULL DEFAULT 'NORMAL',   -- LEAD/NORMAL/HIGH
  autonomous_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  dispositions       TEXT[] NOT NULL DEFAULT '{APPROVE,REJECT,ESCALATE,OVERRIDE,EXCEPTION}',
  -- 差异化评分配置（2026-09-04 B 落地；与 migrate.js 单一事实源一致）：
  -- focus_rulers  聚焦尺子 ×1.5 加权；rubric_pass_line 场景及格线；enabled_rulers 非空时只跑列出的尺子（真子集），NULL=跑全 9 尺子。
  focus_rulers       JSONB,
  rubric_pass_line   REAL,
  enabled_rulers     JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS crm.methodology_template (
  methodology_id     TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  structure         JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS crm.methodology_dimension (
  methodology_id    TEXT NOT NULL REFERENCES crm.methodology_template,
  dim_key          TEXT NOT NULL,
  label            TEXT NOT NULL,
  weight           REAL NOT NULL DEFAULT 1.0,
  required         BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (methodology_id, dim_key)
);

-- 政策版本（不可变快照；决策锚定当时版本，禁止 UPDATE snapshot）
CREATE TABLE IF NOT EXISTS crm.policy_version (
  policy_version_id TEXT PRIMARY KEY,
  policy_id        TEXT NOT NULL,
  version          INT NOT NULL,
  effective_from   TIMESTAMPTZ NOT NULL,
  effective_to     TIMESTAMPTZ,
  snapshot         JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 决策事件本体（7 点全物化；append-only 风格，state 推进）
CREATE TABLE IF NOT EXISTS crm.decision (
  decision_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id           TEXT NOT NULL REFERENCES crm.decision_scenario,
  trigger_context       JSONB NOT NULL,
  involved_entities     JSONB NOT NULL,
  conditions_evaluated  JSONB NOT NULL,
  effective_policy_version TEXT REFERENCES crm.policy_version,
  disposition           TEXT NOT NULL,
  decider_type          TEXT NOT NULL,
  decider_id            TEXT,
  decider_role          TEXT,
  rationale             TEXT NOT NULL,
  display_name          TEXT,            -- 【C 方案 2026-09-03】决策可读名称（根治「名称」列空白：单一事实源，trigger_context.name 仅为兼容）
  referenced_precedents JSONB,
  business_tier         TEXT NOT NULL,
  outcome               TEXT,
  feedback_link         UUID,
  state                 TEXT NOT NULL DEFAULT 'REQUIRED',
  embedding             vector(1024),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at           TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 决策校准 P0：人工处置回写列（设计 2026-08-28 §2.1）
-- 铁律：human_* 与 decider_type/decider_id/decider_role 严格分离——后者是「引擎当初把决策判给谁」的溯源凭据，
--   P1 的 autonomy_override_rate 靠 decider_type 筛自主样本；人工信息一律只写 human_* 四列。
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS human_disposition    TEXT,
  ADD COLUMN IF NOT EXISTS human_decided_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS human_decider_id     TEXT,
  ADD COLUMN IF NOT EXISTS human_decider_role   TEXT;
CREATE INDEX IF NOT EXISTS idx_crm_decision_human_disp
  ON crm.decision(human_disposition) WHERE human_disposition IS NOT NULL;

-- 决策质量稽核台（2026-08-29）：写时物化归因标签（必填齐缺/初判类/准确率信号/业务结果反证）
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS attribution JSONB;

-- 【C 方案 2026-09-03】决策可读名称列（根治「名称」列空白）
-- 单一事实源：创建决策时由 deriveDisplayName 写入，trigger_context.name 仅作历史兼容读源。
-- 存量库幂等补齐（schema.sql CREATE 段已含该列，此处保证已存在库不报错）。
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS display_name TEXT;
CREATE INDEX IF NOT EXISTS idx_crm_decision_display_name ON crm.decision(display_name) WHERE display_name IS NOT NULL;

-- 决策校准 P0：决策 → 待办 关联（打通 HITL 处置链路）
-- 位置依赖：crm.decision 须已建（上移会导致新库从零建表时前向引用失败）
ALTER TABLE crm.tasks
  ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_decision ON crm.tasks(decision_id);

-- 【外键补建·2026-09-04】crm.particles.decision_id → crm.decision.decision_id
-- 背景：crm.particles 在本文件靠前（第 11 行）定义，而 crm.decision 在下方才创建。
--   内联 REFERENCES 属前向引用，会导致**从零建库时整文件（单事务）回滚、建出 0 张表**
--   （2026-09-04 腾讯云部署实测：migrate 报 relation "crm.decision" does not exist，crm schema 表数=0）。
-- 方案：粒子表只建列（decision_id UUID），外键在 decision 已建之后于此处幂等补建。
-- 容错：约束已存在则跳过；若存在孤儿 decision_id（值在 decision 表无对应行）则跳过并告警，不阻断迁移。
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_crm_particles_decision') THEN
    IF NOT EXISTS (
      SELECT 1 FROM crm.particles p
      WHERE p.decision_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM crm.decision d WHERE d.decision_id = p.decision_id)
    ) THEN
      ALTER TABLE crm.particles
        ADD CONSTRAINT fk_crm_particles_decision FOREIGN KEY (decision_id)
        REFERENCES crm.decision(decision_id);
    ELSE
      RAISE NOTICE '跳过外键 fk_crm_particles_decision：crm.particles 存在孤儿 decision_id，需先清洗数据';
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS crm.decision_precedent_rel (
  decision_id   UUID NOT NULL REFERENCES crm.decision,
  precedent_id  UUID NOT NULL REFERENCES crm.decision,
  similarity    REAL,
  PRIMARY KEY (decision_id, precedent_id)
);

-- 业务分级配置（DEAL = 客户维 × 项目维，配置定义非硬编码）
-- 2026-09-06 Phase 1 #1：tenant_id 列 + 复合 PK（system=平台模板，租户经 ensureTenantBusinessTiers 懒克隆覆盖）
CREATE TABLE IF NOT EXISTS crm.business_tier_config (
  tenant_id       TEXT NOT NULL DEFAULT 'system',
  dimension       TEXT NOT NULL,
  dimension_value TEXT NOT NULL,
  tier            TEXT NOT NULL,
  PRIMARY KEY (tenant_id, dimension, dimension_value)
);

-- L2 决策事件持久化（decision 事件域）
CREATE TABLE IF NOT EXISTS crm.decision_event (
  event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL,
  decision_id UUID REFERENCES crm.decision,
  scenario_id TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 记忆沉淀（append-only，topic=decision:<id>，L-Workspace 层，供跨会话引用）
CREATE TABLE IF NOT EXISTS crm.memory_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic       TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'decision',
  payload     JSONB NOT NULL,
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_crm_decision_scenario   ON crm.decision(scenario_id);
CREATE INDEX IF NOT EXISTS idx_crm_decision_tier       ON crm.decision(business_tier);
CREATE INDEX IF NOT EXISTS idx_crm_decision_state      ON crm.decision(state);
CREATE INDEX IF NOT EXISTS idx_crm_decision_policy     ON crm.decision(effective_policy_version);
CREATE INDEX IF NOT EXISTS idx_crm_decision_event_type ON crm.decision_event(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_decision_precedent  ON crm.decision_precedent_rel(precedent_id);
CREATE INDEX IF NOT EXISTS idx_crm_decision_embedding  ON crm.decision USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_topic    ON crm.memory_log(topic, created_at);

-- 2026-09-03 多行业配置化：memory_log 加 tenant_id（客户记忆按租户隔离，零污染）
-- 注意：本 ALTER 与 db/migrations/2026-09-03-tenant-isolation.sql:7 同源，schema.sql 为单一事实源
ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
-- A2 客户锚点列（2026-09-02）：本应在 CREATE TABLE 段声明，但旧库表已存在
--   （CREATE TABLE IF NOT EXISTS 不补列），故在此幂等补列。
--   ⚠ 位置必须在下方复合索引之前：新库从零建表时若缺此列，
--   idx_crm_memory_log_tenant(tenant_id, entity_id) 会报 column "entity_id" does not exist
--   （2026-09-04 腾讯云部署实测踩坑）。
ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_tenant ON crm.memory_log(tenant_id, entity_id);

-- ============ 阶段 2 上下文分层：角色上下文 profile ============
-- 角色 = 上下文配置（七要素 + 数据范围 + 检索配置），config 驱动非硬编码
CREATE TABLE IF NOT EXISTS crm.role_context_profile (
  role_tag       TEXT PRIMARY KEY,
  seven_elements JSONB NOT NULL,   -- 七要素: core_focus/default_query_pref/l2c_workflow/kpi_baseline/cross_role_collab/permission_boundary/role_subtype
  data_scope     JSONB NOT NULL,   -- {model:'self'|'org_subtree'|'all'|'domain', domain?:[...]}
  retrieval_cfg  JSONB NOT NULL,   -- {l1:{enabled,topk},l2:{enabled,topk},l3:{enabled},l4:{enabled}}
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_role_profile_scope
  ON crm.role_context_profile USING gin (data_scope);

-- ============ 阶段 2 记忆治理底座：memory_log 扩展 + 快照 + 常驻笔记 ============
ALTER TABLE crm.memory_log
  ADD COLUMN IF NOT EXISTS layer      TEXT    NOT NULL DEFAULT 'L-Workspace',
  ADD COLUMN IF NOT EXISTS actor      TEXT,
  ADD COLUMN IF NOT EXISTS event_type TEXT,
  ADD COLUMN IF NOT EXISTS distilled  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived   BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ttl_days   INTEGER NOT NULL DEFAULT 30;
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_layer_topic ON crm.memory_log(layer, topic, created_at);

-- A2 客户锚点列（2026-09-02，Lightfield 落地方案 §7.2）
--   背景：故事线（src/context/timelineSource.js）与记忆检索（src/memory/memoryLog.js rrfSearch）
--   对「按客户聚合」的约定互相矛盾且都与实际数据不符：
--     rrfSearch        → topic = 'entity:<id>'
--     timelineSource   → topic = 'account:<id>'
--     生产实际数据      → topic = 'event:*' / 'decision:*'（无任何客户锚点）
--   → 结论：锚点不该编码进 topic 字符串。topic 回归业务分类语义，锚点由独立列承载。
--   纪律：必须走独立 ALTER 段（CREATE TABLE IF NOT EXISTS 对已存在的表不补列）。
ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_id TEXT;
CREATE INDEX IF NOT EXISTS idx_crm_memory_log_entity ON crm.memory_log(entity_id, created_at);

-- 不可变快照（审批/凭证/报价版本，禁 update/delete）
CREATE TABLE IF NOT EXISTS crm.memory_snapshot (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic      TEXT NOT NULL,
  ref_id     TEXT,
  snapshot   JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_memory_snapshot_ref ON crm.memory_snapshot(ref_id, created_at);

-- 2026-09-03 多行业配置化：memory_snapshot 加 tenant_id（客户记忆按租户隔离）
ALTER TABLE crm.memory_snapshot ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';

-- L-User 常驻笔记（唯一键 upsert 重写，防膨胀）
CREATE TABLE IF NOT EXISTS crm.memory_note (
  layer     TEXT NOT NULL DEFAULT 'L-User',
  topic     TEXT NOT NULL,
  content   JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ttl_days  INTEGER NOT NULL DEFAULT 365,
  archived  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (layer, topic)
);

-- 2026-09-03 多行业配置化：memory_note 加 tenant_id（客户记忆按租户隔离）
ALTER TABLE crm.memory_note ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
-- ============ 阶段 2 审批域（六层粒子结构，走通用粒子底座，无独立表） ============
-- 借鉴实证（§5bis C9/G21）：审批流六层 = FLOW→VERSION→NODE→APPROVER→CONDITION→LINK
-- 运行态：CRM_APPROVAL_INSTANCE / CRM_APPROVAL_TASK（同样走 particles 底座）
-- 说明：审批流是「可配置的一等公民」，配置本身即粒子（可被 AI 检索/生成/审计）
--       回滚补偿快照落 crm.memory_snapshot（见上 memory_snapshot 表，禁 update/delete）

-- ============ 10-能力审计底座：audit_event 审计事件流（V2 12 域 / V3 价格+审批留痕 / V5 写通道单点必经）============
-- 纪律：append-only（无 updated_at 列，禁 update/delete）；SHA-256 链式校验和（previous_checksum 全链串联，防篡改可 verify）
-- 与 task_audit（kanban 状态机）区分：audit_event 是「写通道必经」的全局审计单点，task_audit 是任务状态机审计
CREATE TABLE IF NOT EXISTS crm.audit_event (
  id BIGSERIAL PRIMARY KEY,
  target_particle_type TEXT NOT NULL,      -- LEAD→ORDER 12 业务域 + approval/price 治理域
  source TEXT NOT NULL,                    -- particle / particle-edge / action / approval / price
  action TEXT NOT NULL,                    -- 写动作名（create/update/edge-create/<action>:requested|executed|failed/rollback/price_change…）
  actor TEXT DEFAULT 'system',             -- 执行者（人/Agent/自动）
  decision_id UUID,                        -- 写第0闸强制携带的决策 id（无决策不写 → 审计同源）
  payload JSONB,                           -- 当时全字段（含 price_change_reason / approval_instance_id）
  checksum TEXT NOT NULL,                  -- SHA-256（previous_checksum + payload 规范串）
  previous_checksum TEXT,                  -- 前一条校验和（链式防篡改）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_audit_event_type    ON crm.audit_event(target_particle_type, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_audit_event_source  ON crm.audit_event(source, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_audit_event_decision ON crm.audit_event(decision_id);

-- ============ 阶段 2 销售决策监控：monitor_event 持久化表（任务 3 埋点落库）============
CREATE TABLE IF NOT EXISTS crm.monitor_event (
  id          BIGSERIAL PRIMARY KEY,
  domain      TEXT NOT NULL,
  event_type  TEXT,
  agent_id    TEXT,
  context_facts JSONB,
  decision_id UUID,
  scenario_id TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_monitor_event_domain_scen
  ON crm.monitor_event(domain, scenario_id, created_at);
CREATE INDEX IF NOT EXISTS idx_crm_monitor_event_agent
  ON crm.monitor_event(agent_id, created_at);

-- ============ 粒子属性元模型（设计 2026-08-26 §4；19 类型集纪律 + 决策锚定）============
-- coreAttributes（particleModel.js）物化为 seed 事实源；config 变更走 ATTR_SCHEMA_CHANGE 决策事件
CREATE TABLE IF NOT EXISTS crm.meta_attr (
  particle_type TEXT NOT NULL,
  attr_slug     TEXT NOT NULL,
  -- 2026-09-05 fresh-install 修复：PK(423 行) 引用 tenant_id，但该列原仅在文件后段 ALTER 补建，
  --   而 schema.sql 整体单事务执行 → 新库从零迁移必失败（42703 column "tenant_id" does not exist，
  --   连带整文件回滚、crm schema 表数=0）。此处在 CREATE 段直接定义；后段 ADD COLUMN IF NOT EXISTS 保留供旧库幂等。
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  title         TEXT NOT NULL,
  attr_type     TEXT NOT NULL
    CHECK (attr_type IN ('text','personal-name','email-address','phone-number','domain','location',
                         'number','currency','percent','date','timestamp','select','multi-select',
                         'boolean','rating','url','record-reference','actor-reference','interaction')),
  semantic_tag  TEXT NOT NULL DEFAULT 'legacy',
  required      BOOLEAN NOT NULL DEFAULT false,
  "unique"      BOOLEAN NOT NULL DEFAULT false,
  description   TEXT,
  options       JSONB,
  source        TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai','enrich','automatic')),
  display       JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation    JSONB NOT NULL DEFAULT '{}'::jsonb,
  permission    JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  version       INTEGER NOT NULL DEFAULT 1,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 2026-09-04 修复跨租户隔离缺口：tenant_id 必须进 PK。原 PK 仅 (particle_type, attr_slug)，
  -- 导致不同租户登记同类型同属性时撞 PK（与 configCenter id19 声明 tenant 隔离矛盾）。
  -- 旧库走 migration-meta-attr-tenant-pk.sql 幂等重建；新库此处直接建对。
  PRIMARY KEY (particle_type, attr_slug, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_type_tag ON crm.meta_attr(particle_type, semantic_tag);

-- 2026-09-03 多行业配置化：meta_attr 加 tenant_id（行业差异化属性按租户隔离，零污染）
ALTER TABLE crm.meta_attr ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_crm_meta_attr_enabled ON crm.meta_attr(particle_type, enabled);

-- 门户登录账号（v2 双页：Home.html → token → index.html）
CREATE TABLE IF NOT EXISTS crm.crm_users (
  user_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL,
  display_name text NOT NULL,
  org_id text,
  enabled boolean NOT NULL DEFAULT true,
  activated boolean NOT NULL DEFAULT true,      -- 自助注册激活态（DEFAULT true=存量/种子账号已激活；自助注册显式置 false，未激活禁止登录）
  tenant_id text NOT NULL DEFAULT 'system',
  expires_at timestamptz,                       -- 有效期（NULL=永久）；批量/单用户可设置；登录闸校验
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ============ 自助注册激活码（2026-09-04：注册→手机/邮箱激活→登录闭环）============
-- 纪律：验证码为临时鉴权产物，软核销（consumed_at）遵守"绝对禁 DELETE"；过期由激活逻辑判定，不依赖定时清理
-- 送达：channel=email 走 SMTP（SMTP_* 配置即真发，provider 无关：Brevo/MailerSend/QQ/163/腾讯云均可）；
--       channel=phone 需接短信网关（腾讯云/阿里云短信），未配置则日志回显兜底；devCode 仅开发环境回显
CREATE TABLE IF NOT EXISTS crm.activation_code (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email', 'phone')),
  target text NOT NULL,                         -- 邮箱地址或手机号（脱敏后展示用原始值匹配）
  code_hash text NOT NULL,                      -- crypt($1, gen_salt('bf'))，明文不出 node
  purpose text NOT NULL DEFAULT 'activate',
  consumed_at timestamptz,                      -- 软核销（NULL=未用）
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_activation_code_username ON crm.activation_code(username, purpose, consumed_at, expires_at);

-- ============ 09-V6 Token-业务因果对账：token_accounting（G4 最小闭环）============
-- 纪律：append-only（无 updated_at 列，禁 update/delete）；与 audit_event 同纪律（fail-open 计量不阻断主写）
-- 对账：reconcileTokenToBusiness(actor, since) → {tokens:{in,out,total}, business:{productivity,audit_events}}
--      业务产出 = 该 actor 该时段 audit_event「写 Action :executed」成功数（与 G1 audit_event 联动）
CREATE TABLE IF NOT EXISTS crm.token_accounting (
  id BIGSERIAL PRIMARY KEY,
  actor TEXT NOT NULL DEFAULT 'system',      -- 执行者（人/Agent）→ 对账分组键
  action TEXT NOT NULL,                       -- 触发动作（crm-deal-advance…）
  tokens_in INT NOT NULL DEFAULT 0,           -- 输入 token（LLM 请求；无则 0 不伪造）
  tokens_out INT NOT NULL DEFAULT 0,          -- 输出 token（LLM 响应；无则 0 不伪造）
  source TEXT NOT NULL DEFAULT 'llm',         -- 计量来源（llm/evaluator/rule…）
  decision_id UUID,                           -- 关联决策（写第0闸同源；与 audit_event 可 JOIN）
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_actor ON crm.token_accounting(actor, created_at);

-- ============ MCP 身份持久绑定（2026-08-26 设计：身份基线 + 意图校正）============
-- token 仅存哈希（pgcrypto crypt），明文永不出 node 进程到日志；吊销用 revoked_at 软标记，绝对禁删
CREATE TABLE IF NOT EXISTS crm.mcp_identity (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   text UNIQUE NOT NULL,
  actor        text NOT NULL,
  person_id    uuid,                         -- 真实身份（CRM_PERSON 粒子 id / crm_users.user_id），可空=外部接入方；不强制 FK 避免引用不存在表
  role_tag     text NOT NULL,
  scopes       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- 可选域级收窄 {deny_domains:[...]}
  expires_at   timestamptz,
  enabled      boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at   timestamptz,
  CONSTRAINT fk_mcp_identity_role FOREIGN KEY (role_tag) REFERENCES crm.role_context_profile(role_tag)
);
CREATE INDEX IF NOT EXISTS idx_mcp_identity_token ON crm.mcp_identity(token_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_identity_actor ON crm.mcp_identity(actor);

-- ============ 方法论 SKILL 注册表（2026-08-28 设计：§6.6 后台启停持久化）============
-- DB=启停权威源；SKILL 目录 registry.json=出厂默认（首启幂等灌入）。禁删：只改 enabled，物理行保留。
CREATE TABLE IF NOT EXISTS crm.skill_registry (
  skill_id       TEXT PRIMARY KEY,            -- skills/ 目录名（method-bant / crm-native …）
  category       TEXT NOT NULL DEFAULT 'methodology',  -- methodology | action
  enabled        BOOLEAN NOT NULL DEFAULT true,        -- 后台开关（false=引擎禁装载/市场不暴露）
  rbac_roles     TEXT[] NOT NULL DEFAULT '{}',
  methodology_id TEXT,                        -- 方法论镜像 id（method-* 才有）
  version        TEXT NOT NULL DEFAULT 'v1',  -- 版本（对齐 migrate-config.sql 版；双向超集收敛）
  updated_by     TEXT NOT NULL DEFAULT 'system',
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_skill_registry_enabled ON crm.skill_registry(enabled);

-- ============ 决策校准处方（2026-08-28 设计 §2.2；校准闭环「调整」环节落库）============
-- knob 枚举含 required_dims 是 P3 预留（7×7 落地后实现），本期 rules 只产出 threshold/weight。
-- 每条处方自带预期影响（expected_impact=影子重放结果）；status 全生命周期：起草→批准→应用/驳回→回滚。
CREATE TABLE IF NOT EXISTS crm.calibration_patch (
  patch_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id     TEXT REFERENCES crm.decision_scenario(scenario_id),
  knob            TEXT NOT NULL CHECK (knob IN ('threshold', 'weight', 'required_dims')),
  target          TEXT,
  from_value      JSONB NOT NULL,
  to_value        JSONB NOT NULL,
  evidence        JSONB NOT NULL,
  expected_impact JSONB,
  risk            TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH')),
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED','ROLLED_BACK')),
  decision_id     UUID REFERENCES crm.decision(decision_id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  resolved_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_calibration_patch_status
  ON crm.calibration_patch(status, created_at DESC);

-- ============ 契约消费反馈（living contract 运行态；2026-08-29 监控台消费计划）============
-- 双轨契约的「轨二」：记录每个 (doc_path, task, gap_type) 的观测/严重度/处置状态。
-- 绝对禁删：仅 upsert/状态迁移（ON CONFLICT 由写入层处理），无 DELETE 端点。
CREATE TABLE IF NOT EXISTS crm.contract_feedback (
  id          BIGSERIAL PRIMARY KEY,
  doc_path    TEXT NOT NULL,
  task        TEXT NOT NULL,
  gap_type    TEXT NOT NULL,   -- success | skill | memory | knowledge_scope | other
  observed    TEXT,
  expected    TEXT,
  severity    TEXT DEFAULT 'warn',  -- info | warn | error
  status      TEXT DEFAULT 'open',  -- open | resolved | wontfix
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now(),
  UNIQUE (doc_path, task, gap_type)
);
CREATE INDEX IF NOT EXISTS idx_contract_feedback_doc
  ON crm.contract_feedback(doc_path, task);

-- ============ 智能体契约消费反馈（living contract 轨二回写；2026-08-29 Task3）============
-- 与 contract_feedback（按 doc_path,task,gap_type）并列：此处按 contract_task_id,gap_type 维度。
-- 绝对禁删：仅 upsert/状态迁移（ON CONFLICT 由写入层处理）。
CREATE TABLE IF NOT EXISTS crm.agent_contract_feedback (
  id               BIGSERIAL PRIMARY KEY,
  contract_task_id text NOT NULL,
  agent           text,
  gap_type        text NOT NULL,
  observed        text,
  expected        text,
  severity        text DEFAULT 'medium',
  ts              timestamptz DEFAULT now(),
  resolved        bool DEFAULT false,
  UNIQUE (contract_task_id, gap_type)
);

-- ============ 决策复盘报告（2026-08-30 决策复盘智能体夜间批量产物）============
-- 追加式分析日志：复盘智能体每日全量扫描决策 → 聚类归因 → LLM 深度分析 → 产出方案草稿。
-- 绝不 DELETE（仅 INSERT）；草稿不写 calibration_patch、不经第0闸，交由管理员审批流另行落地。
-- decision_retro_report 与 calibration_patch 解耦：本表是「分析产物」，calibration_patch 是「已审批处方」。
CREATE TABLE IF NOT EXISTS crm.decision_retro_report (
  report_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  window_start      TIMESTAMPTZ NOT NULL,
  window_end        TIMESTAMPTZ NOT NULL,
  decisions_scanned INT NOT NULL DEFAULT 0,
  clusters          JSONB NOT NULL DEFAULT '[]'::jsonb,   -- 每闸门聚类 + 根因 + 草稿
  draft_patches     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- 跨聚类展平的草稿处方（未审批）
  summary           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 根因分布 / 草稿数 / llm 是否启用
  llm_enabled       BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_retro_report_run ON crm.decision_retro_report(run_at DESC);

-- R4 复盘主查询索引（2026-09-05）：原 decision.decided_at / tasks.updated_at 两条查询走 Seq Scan，
--   规模化线性劣化。补幂等索引（与 src/decision/retro.js loadWindowDecisions 收敛 SELECT 列配套）。
CREATE INDEX IF NOT EXISTS idx_crm_decision_decided_at ON crm.decision (decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_crm_tasks_updated_at ON crm.tasks (updated_at DESC);

-- ============ 决策质量闭环（2026-08-30 落地）DDL 迁移 ============
-- 全部幂等（IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DROP+ADD CHECK），可重跑。
-- 关联任务：T2 decision_relation / T5 decision_outcome+outcome_event_map / T8 confidence+outcome_verified+feedback+root_cause
--          / T19+T28 calibration_patch.knob 扩枚举 / T31 meta_attr.source_refresh_sla

-- T2 决策边权威表（7 类边枚举；AGE 降级为镜像，PG 为权威）
CREATE TABLE IF NOT EXISTS crm.decision_relation (
  rel_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id          UUID NOT NULL REFERENCES crm.decision(decision_id),
  -- BG-03 方案 B（2026-09-01）：to_id 外键已放宽（异常/粒子 id 可为非 UUID 的 EX-1 等），
  -- 列类型同放宽为 TEXT（原 UUID 使 DERIVED_FROM_EXCEPTION 落库报 string_to_uuid 失败，权威边写不进去）。
  to_id            TEXT NOT NULL,
  rel_type         TEXT NOT NULL CHECK (rel_type IN
    ('DECIDED_ON','REFERENCED_PRECEDENT','DERIVED_FROM_EXCEPTION','ESTABLISHES_FRAME','OVERRIDES','CAUSED','INFLUENCED')),
  serves_dimension TEXT NOT NULL,
  props            JSONB,
  source           TEXT NOT NULL DEFAULT 'engine',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_id, to_id, rel_type)
);
CREATE INDEX IF NOT EXISTS idx_crm_dr_from ON crm.decision_relation(from_id);
CREATE INDEX IF NOT EXISTS idx_crm_dr_to   ON crm.decision_relation(to_id);
CREATE INDEX IF NOT EXISTS idx_crm_dr_type ON crm.decision_relation(rel_type);

-- 决策上下文供给快照（BG-04 根治：supplied_dims 来自运行时真实供给，非 seed 边；平台级问责资产）
CREATE TABLE IF NOT EXISTS crm.decision_context_snapshot (
  snapshot_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assembly_id    UUID NOT NULL,
  decision_id    UUID REFERENCES crm.decision(decision_id),
  tenant_id      TEXT NOT NULL DEFAULT 'system',
  actor          TEXT,
  scenario_id    TEXT,
  query_text     TEXT,
  ops            JSONB NOT NULL,         -- S1–S7 操作信封数组
  dim_coverage   JSONB NOT NULL,         -- 7 维 × status（供给侧视图）
  supplied_dims  INT NOT NULL DEFAULT 0,
  degraded       BOOLEAN NOT NULL DEFAULT FALSE,
  prompt_block   TEXT,
  prompt_hash    TEXT,
  token_est      INT,
  cost_ms        INT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_dcs_decision ON crm.decision_context_snapshot(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_dcs_assembly ON crm.decision_context_snapshot(assembly_id);

-- F4 单轨（2026-09-02）：装配阶段标记。
--   'pre'  = 决策落库**之前**装配（事前驱动，快照即决策依据）；
--   'post' = 事前装配失败退回事后装配（事后解释，不冒充事前驱动）。
-- 铁律（2026-08-30 实测）：**不得**写进上面的 CREATE TABLE IF NOT EXISTS 段——
--   旧库该表已存在时 CREATE IF NOT EXISTS 不补列，会连带让后续依赖该列的语句报错，
--   而 db/migrate.js 是整文件单事务，一处报错即全量迁移回滚。新增列必须走独立 ALTER。
ALTER TABLE crm.decision_context_snapshot ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'pre';

-- 决策主记录回指最近一次上下文供给快照（装配即审计闭环）
ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS context_snapshot_id UUID;

-- T5 业务结果回写（L2 反馈回路）
CREATE TABLE IF NOT EXISTS crm.decision_outcome (
  outcome_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   UUID NOT NULL REFERENCES crm.decision(decision_id),
  outcome_type  TEXT NOT NULL CHECK (outcome_type IN ('won','lost','paid','stalled','partial','other')),
  source        TEXT NOT NULL,
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence    REAL,
  verified_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (decision_id, outcome_type, source)
);
CREATE INDEX IF NOT EXISTS idx_crm_do_dec  ON crm.decision_outcome(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_do_type ON crm.decision_outcome(outcome_type);

CREATE TABLE IF NOT EXISTS crm.outcome_event_map (
  map_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   TEXT NOT NULL,
  outcome_type TEXT NOT NULL,
  scenario_id  TEXT REFERENCES crm.decision_scenario(scenario_id),
  matcher      JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled      BOOLEAN NOT NULL DEFAULT true
);

-- T8 decision.confidence / outcome_verified / feedback / root_cause 提列（G5 + 全链路溯源）
ALTER TABLE crm.decision
  ADD COLUMN IF NOT EXISTS confidence        REAL,
  ADD COLUMN IF NOT EXISTS confidence_source TEXT,
  ADD COLUMN IF NOT EXISTS confidence_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS outcome_verified  TEXT CHECK (outcome_verified IN ('won','lost','paid','stalled','partial',NULL)),
  ADD COLUMN IF NOT EXISTS feedback          JSONB,
  ADD COLUMN IF NOT EXISTS root_cause        JSONB;

-- T31 meta_attr 加 source_refresh_sla（支撑「输入不及时」检测；required 列已存在）
ALTER TABLE crm.meta_attr
  ADD COLUMN IF NOT EXISTS source_refresh_sla INTERVAL;

-- T12 参数传播（2026-09-05）：ADMIN 待办闭环——knob 扩 config_store + assignee/tenant_id 列（§16.1/16.4）
-- 【2026-09-05 缺陷修复】此处原有一条 T19+T28 的 13 类 DROP+ADD 块，与本块连续执行：
--   单事务内先 ADD 13 类 CHECK 时，库里已存在的 knob='config_store' 行会立即违反（23514），
--   导致整个 schema.sql 回滚 —— 表现为「migrate 失败：check constraint ... violated by some row」。
--   13 类已被本块 14 类取代，故删除冗余块（对已有库无副作用，对新库只建一次宽枚举）。
-- 2026-09-05 P1：追加 routing_tracks/routing_weight/routing_threshold（场景路由反推三旋钮）→ 17 类。
-- 计划缺陷修正：①CHECK 在 13 类上追加而非收窄（收窄会破坏既有旋钮 createPatch）；②补 tenant_id 列（无租户列 tan_admin 限本租户与租户级写入均无从落地）。
ALTER TABLE crm.calibration_patch DROP CONSTRAINT IF EXISTS calibration_patch_knob_check;
ALTER TABLE crm.calibration_patch
  ADD CONSTRAINT calibration_patch_knob_check
  CHECK (knob IN ('threshold','weight','required_dims','confidence','edge_binding',
                  'outcome_threshold','strictness','meta_attr_map','particle_attr_add',
                  'k_edge_add','source_refresh','dim_order','precedent_distill','config_store',
                  'routing_tracks','routing_weight','routing_threshold'));
ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS assignee TEXT NOT NULL DEFAULT 'ADMIN';
ALTER TABLE crm.calibration_patch ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_calibration_patch_todo
  ON crm.calibration_patch(status, assignee, tenant_id, created_at DESC);

-- G2 规则 DB 化（T2 决策规则门：decision_rule 表驱动 + rule_hit 留痕）
CREATE TABLE IF NOT EXISTS crm.decision_rule (
  id           BIGSERIAL PRIMARY KEY,
  code         TEXT UNIQUE NOT NULL,
  match_type   TEXT NOT NULL,                -- 'CRM_DEAL.advance'（粒子.动作）
  match_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  check_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled      BOOLEAN NOT NULL DEFAULT true,
  decision_id  UUID REFERENCES crm.decision(decision_id),  -- 规则经第0闸产生
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_decision_rule_enabled ON crm.decision_rule(enabled);

CREATE TABLE IF NOT EXISTS crm.rule_hit (
  id           BIGSERIAL PRIMARY KEY,
  rule_code    TEXT NOT NULL,
  decision_id  UUID,
  blocked      BOOLEAN NOT NULL,
  reasons      JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_rule_hit_rule ON crm.rule_hit(rule_code);
CREATE INDEX IF NOT EXISTS idx_crm_rule_hit_blocked ON crm.rule_hit(blocked);

-- C4/S7 审计链与 PROV-O 溯源（2026-09-02 补齐）
--   缺陷背景：decision_provenance 此前仅有 provenance.js 内的 ensureProvenanceSchema() 定义，
--   且**只被测试调用** → 生产库从未建表 → 4 处 trackEntry（assembleContextV2.js:196/200、
--   decisionRepo.js:155 等）全部抛 relation does not exist 并被 .catch(()=>{}) 静默吞掉，
--   溯源留痕 100% 丢失且无人知晓。DDL 回归 schema.sql 单一事实源，由 migrate 统一建表。
CREATE TABLE IF NOT EXISTS crm.decision_provenance (
  id                BIGSERIAL PRIMARY KEY,
  decision_id       UUID NOT NULL REFERENCES crm.decision(decision_id),
  entry_type        TEXT NOT NULL,        -- context_supply / entity / decision / relationship / property
  payload           JSONB NOT NULL,       -- 当时全字段（决策 7 点/边/来源/装配操作状态）
  source            TEXT,                 -- 来源（粒子/事件/Agent）
  activity_id       TEXT,                 -- 产生它的流程
  checksum          TEXT NOT NULL,        -- SHA-256（含 previous_checksum 链式）
  previous_checksum TEXT,                 -- 前一条校验和（链式防篡改）
  invalidated       BOOLEAN DEFAULT false, -- 墓碑标记（擦除不物理删除）
  archived          BOOLEAN DEFAULT false, -- 软归档标记（超保留期仅标记；此处显式建列，避免依赖运行时 ALTER）
  hash_version      INT NOT NULL DEFAULT 1, -- 哈希代次：1=仅 payload（历史行）/ 2=白名单（decision_id/entry_type/payload/source/activity_id/invalidated/archived）
                                           -- 分代原因：算法升级不得让历史行失效，校验时按本列分派（provenance.js hashOf）
  created_at        TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_decision_provenance_decision ON crm.decision_provenance(decision_id);
CREATE INDEX IF NOT EXISTS idx_crm_decision_provenance_hv ON crm.decision_provenance(hash_version);

-- C2 审计链巡检封印（2026-09-03 T2）：哈希链的固有盲区是「删链尾不可检出」——
--   删掉链尾后剩余部分依旧自洽，重算全链仍 OK。故以封印快照记录上次巡检的 (head_checksum, entry_count)，
--   比对规则：count 减少 → HEAD_LOST（截尾）；count 不变但 head 变 → TAMPERED。
--   注：本表的 DDL 在 db/migration-decision-integrity.sql 首次落地，此处回归单一事实源。
CREATE TABLE IF NOT EXISTS crm.provenance_seal (
  decision_id    UUID PRIMARY KEY,
  head_checksum  TEXT,
  entry_count    INT NOT NULL DEFAULT 0,
  sealed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status    TEXT
);

-- LLM 多实例配置（2026-09-02）：多条 provider/model/key，唯一默认标记，软删
CREATE TABLE IF NOT EXISTS crm.llm_config (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT UNIQUE NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  base_url    TEXT,
  api_key     TEXT,
  temp        REAL DEFAULT 0.7,
  max_tokens  INT DEFAULT 1024,
  is_default  BOOLEAN DEFAULT false,
  is_deleted  BOOLEAN DEFAULT false,
  tenant_id   TEXT NOT NULL DEFAULT 'system',
  updated_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_llm_config_default
  ON crm.llm_config (tenant_id) WHERE is_default AND NOT is_deleted;
CREATE INDEX IF NOT EXISTS idx_crm_decision_provenance_type ON crm.decision_provenance(entry_type);

-- ============ 租户订阅史（2026-09-04 订阅 + 模块用量计费域）============
-- ============ 计费域表（2026-09-05 并入 schema.sql 单一事实源）============
-- 来源：db/migration-billing-tables.sql（billing 线增量迁移，保留供旧库；新库由本段直接建对）
-- 铁律：tenant 隔离（tenant_id NOT NULL）+ 状态枚举 CHECK + 绝对禁 DELETE（缴费=插记录+状态机流转；逾期=读时幂等翻转）
-- 2026-09-05 fresh-install 修复 N3：下方 tenant_subscription.payment_ref 外键引用 crm.billing_payment(id)，
--   而该表原仅存于独立迁移文件、未并入 schema.sql → 新库从零执行必 42P01，且整文件单事务回滚（crm 表数=0）。
--   故在此前置建表（顺序必须在 tenant_subscription 之前）。
CREATE TABLE IF NOT EXISTS crm.billing_statement (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'system',
  period      TEXT NOT NULL,                                   -- 账期（YYYY-MM）
  cycle       TEXT NOT NULL DEFAULT 'monthly' CHECK (cycle IN ('monthly','quarterly')),
  token_in    INT NOT NULL DEFAULT 0,
  token_out   INT NOT NULL DEFAULT 0,
  token_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  seat_count  INT NOT NULL DEFAULT 0,
  seat_fee    NUMERIC(12,2) NOT NULL DEFAULT 0,
  total_fee   NUMERIC(12,2) NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','paid','overdue')),
  issued_at   TIMESTAMPTZ,
  due_at      TIMESTAMPTZ,
  paid_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period, cycle)
);
CREATE TABLE IF NOT EXISTS crm.billing_payment (
  id           BIGSERIAL PRIMARY KEY,
  tenant_id    TEXT NOT NULL,
  statement_id BIGINT NOT NULL REFERENCES crm.billing_statement(id),
  amount       NUMERIC(12,2) NOT NULL,
  method       TEXT NOT NULL CHECK (method IN ('bank_transfer','wechat','alipay','other')),
  status       TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('pending','paid','failed')),
  paid_at      TIMESTAMPTZ,
  txn_ref      TEXT,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_crm_billing_statement_tenant_period
  ON crm.billing_statement(tenant_id, period, cycle);
CREATE INDEX IF NOT EXISTS idx_crm_billing_payment_statement
  ON crm.billing_payment(statement_id);

-- 纪律：append-only（订阅=插记录+状态机流转，绝禁 DELETE）；租户隔离 tenant_id NOT NULL；
--       status 枚举 CHECK；UNIQUE(tenant_id,plan_id,started_at) 防重复订阅提交
-- 状态机：pending（待缴费开通）→ active（缴费即开通）→ expired（到期停服）/ canceled（自助取消）/ grace（宽限期）
CREATE TABLE IF NOT EXISTS crm.tenant_subscription (
  id             BIGSERIAL PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  plan_id        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','pending','expired','canceled','grace')),
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  grace_until    TIMESTAMPTZ,
  payment_ref    BIGINT REFERENCES crm.billing_payment(id),
  online_order_no TEXT,                        -- 在线支付锚点（微信/支付宝 out_trade_no），独立于 payment_ref(线下)
  upgraded_from  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plan_id, started_at)
);
CREATE INDEX IF NOT EXISTS idx_tenant_subscription_tenant
  ON crm.tenant_subscription(tenant_id, status, expires_at);

-- ============ 支付订单（2026-09-05：在线支付幂等中枢，独立于线下 billing_payment）============
-- 说明：tenant_subscription.payment_ref 是 FK→crm.billing_payment(id)（线下缴费流），不可破坏；
--       在线支付另起 online_order_no TEXT 锚点列（见上方 tenant_subscription 定义）。
CREATE TABLE IF NOT EXISTS crm.payment_order (
  id            BIGSERIAL PRIMARY KEY,
  order_id      TEXT NOT NULL UNIQUE,            -- 平台内部订单号
  out_trade_no  TEXT NOT NULL UNIQUE,            -- 微信/支付宝交易号（幂等锚点）
  tenant_id     TEXT NOT NULL,
  plan_id       TEXT NOT NULL,
  cycle         TEXT NOT NULL DEFAULT 'monthly',
  mode          TEXT NOT NULL DEFAULT 'upgrade', -- create/renew/upgrade
  provider      TEXT NOT NULL,                   -- wechat/alipay
  amount        NUMERIC(12,2) NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','paid','refunded','failed','closed')),
  qr_url        TEXT,
  redirect_url  TEXT,
  paid_at       TIMESTAMPTZ,
  refund_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payment_order_tenant ON crm.payment_order(tenant_id, status);

-- ============ 支付对账差异（2026-09-05：网关账单 vs 本地 payment_order 比对）============
CREATE TABLE IF NOT EXISTS crm.billing_reconcile_diff (
  id BIGSERIAL PRIMARY KEY,
  period TEXT NOT NULL,
  out_trade_no TEXT,
  kind TEXT NOT NULL,           -- missing_local / missing_gateway / amount_mismatch
  amount NUMERIC(12,2),
  detail JSONB,
  resolved BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 模块用量（2026-09-04：模块开关 + 按 (tenant_id,module,period) 计量）============
-- 纪律：enabled=模块开关（dispatch 闸消费）；calls/tokens_in/tokens_out 为周期累计值，
--       ON CONFLICT (tenant_id,module,period) DO UPDATE 增量累加（append-only，绝禁 DELETE）
CREATE TABLE IF NOT EXISTS crm.module_usage (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'system',
  module        TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  calls         INT NOT NULL DEFAULT 0,
  tokens_in     BIGINT NOT NULL DEFAULT 0,
  tokens_out    BIGINT NOT NULL DEFAULT 0,
  period        TEXT NOT NULL DEFAULT 'YYYY-MM',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, module, period)
);
CREATE INDEX IF NOT EXISTS idx_module_usage_tenant ON crm.module_usage(tenant_id, module, period);

-- ============ token_accounting 补 tenant_id（2026-09-04 按租户统计 LLM Token 用量）============
-- 铁律：CREATE TABLE IF NOT EXISTS 不补列（旧库该表已存在时跳过），必须独立 ALTER 幂等补列 + 索引。
--       与 db/migration-billing-token-tenant.sql 同款，此处回归单一事实源。
ALTER TABLE crm.token_accounting
  ADD COLUMN IF NOT EXISTS tenant_id TEXT NOT NULL DEFAULT 'system';
CREATE INDEX IF NOT EXISTS idx_crm_token_accounting_tenant
  ON crm.token_accounting(tenant_id, created_at);
