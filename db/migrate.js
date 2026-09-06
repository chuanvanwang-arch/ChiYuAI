// db/migrate.js — 幂等迁移执行器（crm schema 建表 + 可选种子）
import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';

const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
// 配置面迁移（approval_flow/config_store/connectors/system_config/alert_rule/skill_registry 种子等）。
// 与 schema.sql 并列的独立子迁移：旧库（已存在）幂等叠加；新库（crm_native）从零建库必需，
// 否则 seed.sql 对 approval_flow 的 INSERT 报 relation does not exist。
const configSql = readFileSync(new URL('./migrate-config.sql', import.meta.url), 'utf8');
// 增量迁移清单（幂等；从零建库必需——旧库 plm 是 schema.sql+这些文件逐步叠加的产物，
// 新库只跑 schema+config 会缺 decision_provenance/role_context_profile/decision_rule 等表 → 测试/运行报 relation does not exist）
export const INCREMENTAL_SQL = [
  'migration-confirm-audit.sql',   // crm.tasks 角色确认审计列 + status CHECK 扩展
  'migration-conflict.sql',        // crm.assertions（P4 冲突保留模型）
  'migration-decision-rule.sql',   // crm.decision_rule + rule_hit（G2 规则 DB 化）
  'migration-particle-meta.sql',   // 粒子元数据补列
  'migrate-agent-contract-feedback.sql', // agent 契约反馈表
  'migrate-monitor-event-agent.sql',     // 监控 agent 事件
  'migrate-named-owner-backfill.sql',    // 命名客户 owner 回填
  'migrate-tenant.js',             // crm_users.tenant_id（mcpLogin 依赖）
  'migration-decision-integrity.sql', // C2 决策完整性（provenance 哈希代次 + 巡检封印）
  'migration-decision-display-name.sql', // crm.decision.display_name（C方案 2026-09-03 决策可读名称列；此前未入清单→仅跑 migrate 的环境缺列）
  '2026-09-03-crm-tenants.sql',   // T9 租户注册表（crm.tenants + 存量灌入 + system 种子；幂等）
  'migration-meta-attr-tenant-pk.sql', // 2026-09-04 meta_attr PK 纳入 tenant_id（跨租户隔离缺口修复）
  'migration-billing-token-tenant.sql', // 计费域：token_accounting 补 tenant_id（按租户统计 LLM Token）
  'migration-billing-tables.sql',      // 计费域：billing_statement + billing_payment（平台内缴费记录流）
  'migrate-activation.sql',            // 2026-09-04 自助注册激活闭环：crm_users.activated 列 + crm.activation_code 表
  'migration-login-email-column.sql',  // 登录：crm_users 新增 email 列，支持用户名或邮箱验证
  'migration-subscription-tables.sql', // 2026-09-04 订阅史 tenant_subscription + 模块用量 module_usage
  '2026-09-04-tenant-created-by.sql',   // T3 责任 sysadmin 归属（crm.tenants.created_by_*）
  '2026-09-04-skill-registry-rbac-fix.sql', // T2 命名收口（rbac_roles 修正，Task 2 创建）
  'migration-routing-observability.sql', // 2026-09-05 context-routing 自适应回路 P0：快照补 routing 列（补「决策不留轨道」缺口），禁写进 schema.sql 段
  'migration-param-inspection.sql',    // 2026-09-05 参数闭环 P0：夜批报告补 param_inspection 列（22 项算法参数体检结果，JSONB，旧行兼容空）
  'migration-nightly-report.sql',      // 2026-09-05 夜批三段全量日报落库表（run_date 唯一 upsert）
  'migration-alert-tenant.sql',        // 2026-09-05 alert_rule 租户化：补 tenant_id + PK 复合化（G3 跨租户隔离缺口修复）
  'migration-business-tier-tenant.sql', // 2026-09-06 business_tier_config 租户化：补 tenant_id + PK 复合化（Phase 1 #1 跨租户隔离缺口修复）
  'migration-decision-scenario-tenant-pk.sql', // 2026-09-05 decision_scenario PK 复合化 (scenario_id, tenant_id)（G5 方案a）+ 引用 FK 复合化 + 引用对齐前移
  'migrate-billing-features-array.sql',  // 2026-09-06 计费域：billing-plans features string→string[]（landing 卡片项目动态化前置）
  'migrate-sysadmin-write-scope.sql',    // 2026-09-06 F4（方案 C）：sysadmin 写范围收敛（data_scope.write_scope=governance）
];
const incrementalSqls = INCREMENTAL_SQL.map(f =>
  f.endsWith('.js') ? null : readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')
);

async function main() {
  const seed = process.argv.includes('--seed');
  await pool.query(sql);
  console.log('[migrate] crm schema 就绪（幂等）');
  await pool.query(configSql);
  console.log('[migrate] 配置面（approval_flow/config_store/connectors/system_config/alert_rule/skill_registry）就绪（幂等）');
  // 增量迁移串行执行（幂等；依赖顺序：schema→config→增量→seed）
  for (const [i, f] of INCREMENTAL_SQL.entries()) {
    if (!incrementalSqls[i]) continue; // .js 迁移（migrate-tenant.js）单独处理
    try {
      await pool.query(incrementalSqls[i]);
    } catch (e) {
      if (!/42P01|42703/.test(e.code)) { console.error(`[migrate] 增量迁移失败 ${f}:`, e.message); throw e; }
      console.log(`[migrate] 增量迁移跳过 ${f}（${e.code} 目标不存在，幂等容忍）`);
    }
  }
  // migrate-tenant.js 单独执行（.js 迁移；模块导出 migrateTenant()，此处显式调用）
  try {
    const { migrateTenant } = await import('../db/migrate-tenant.js');
    await migrateTenant();
    console.log('[migrate] 租户列（crm_users.tenant_id）就绪');
  } catch (e) {
    console.log(`[migrate] 租户迁移跳过（${e.message}）`);
  }
  // 注：传播中枢迁移块（PROPAGATION_MIGRATIONS）已移至下方 skill_scope 建表之后执行——
  //   原因：migrate-propagation.js 内 ALTER TABLE crm.skill_scope ADD COLUMN tenant_id，
  //   而 skill_scope 表在本文件后段（P3-D2）才创建；旧库因表早已存在而不报错（故长期未被发现），
  //   全新库必然 42P01 → 被此处「幂等容忍」静默跳过 → tenant 轴推广与 propagation_action 留痕缺失。
  //   详见 docs/2026-09-05-param-hub-implementation-audit.md §7 N5。
  // 向后兼容：半迁移库（decision 表建于 updated_at 列补入前）补齐列，保证 confirm/reverse 不报错
  await pool.query(
    `ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  ).catch(() => {});
  // skill_registry 向后兼容：早期迁移建的表缺 updated_by 列（CREATE TABLE IF NOT EXISTS 不补列），
  // 而 setSkillEnabled 写该列会触发 400；此处幂等补列对齐 schema.sql §item16 DDL
  await pool.query(
    `ALTER TABLE crm.skill_registry
       ADD COLUMN IF NOT EXISTS updated_by TEXT NOT NULL DEFAULT 'system',
       ADD COLUMN IF NOT EXISTS methodology_id TEXT`
  ).catch(() => {});
  // particles.stable_key 向后兼容（2026-08-30 实测踩坑）：6.7 确定性标识列在 schema.sql L21
  //   CREATE TABLE IF NOT EXISTS 段内声明——旧库该表已存在时 CREATE IF NOT EXISTS 不补列，
  //   但 L28 CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_particles_stable_key 会因列缺失直接报错，
  //   导致 db/migrate.js 全量迁移在整文件单事务中整体失败（生产库实测 column "stable_key" does not exist）。
  //   此处幂等补列 + 重建唯一索引（后续 CREATE INDEX IF NOT EXISTS 幂等跳过），根治迁移器缺陷。
  await pool.query(
    `ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS stable_key TEXT`
  ).catch(() => {});
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_crm_particles_stable_key ON crm.particles(stable_key)`
  ).catch(() => {});
  // 待办②（2026-09-03）：particles.decision_id 深度防御列（新库走 schema.sql CREATE 段，旧库/生产走此 ALTER）
  //   业务写经第0闸 mint 的 decision_id 持久化；系统写豁免为 NULL。历史行 decision_id=NULL 永久兼容，不行回填。
  //   幂等 ADD COLUMN IF NOT EXISTS，避免重复迁移报错（遵循 §4.5 双轨落点铁律）。
  await pool.query(
    `ALTER TABLE crm.particles ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id)`
  ).catch((e) => { console.error('[migrate] particles.decision_id 补列失败:', e.message); throw e; });
  // A2 memory_log.entity_id 向后兼容（2026-09-02，Lightfield 落地方案 §7.2）：
  //   客户锚点从 topic 字符串前缀改为独立列。旧库表已存在，CREATE TABLE IF NOT EXISTS 不补列，
  //   必须独立 ALTER；索引一并幂等建（后续 CREATE INDEX IF NOT EXISTS 幂等跳过）。
  //   用途：故事线按客户聚合（timelineSource）、记忆检索按实体过滤（memoryLog.rrfSearch）。
  await pool.query(
    `ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_id TEXT`
  ).catch((e) => { console.error('[migrate] memory_log.entity_id 补列失败:', e.message); throw e; });
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_crm_memory_log_entity ON crm.memory_log(entity_id, created_at)`
  ).catch(() => {});
  // F4 单轨（2026-09-02）：decision_context_snapshot.phase 装配阶段标记
  //   'pre'=事前装配（决策落库前，快照即决策依据）/ 'post'=事后装配（事前装配失败退回）。
  //   旧库表已存在 → CREATE TABLE IF NOT EXISTS 不补列，必须独立 ALTER（同 stable_key 踩坑）。
  await pool.query(
    `ALTER TABLE crm.decision_context_snapshot ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'pre'`
  ).catch((e) => { console.error('[migrate] decision_context_snapshot.phase 补列失败:', e.message); throw e; });
  // BG-03 方案 B（2026-09-01 用户裁决）：放宽 decision_relation.to_id 外键，
  //   允许 DECIDED_ON / DERIVED_FROM_EXCEPTION 的 to_id 指向业务实体/异常（非 decision UUID）。
  //   from_id 外键保留（决策边起点恒为决策）。幂等：DROP CONSTRAINT IF EXISTS，旧库/新库一致生效。
  await pool.query(
    `ALTER TABLE crm.decision_relation DROP CONSTRAINT IF EXISTS decision_relation_to_id_fkey`
  ).catch((e) => { console.error('[migrate] decision_relation to_id 外键放宽失败:', e.message); throw e; });
  // BG-03 方案 B（2026-09-01 补全）：to_id 外键放宽后**列类型仍为 UUID**，异常 id（EX-1 等非 UUID）
  //   落库报 string_to_uuid 失败 → DERIVED_FROM_EXCEPTION 权威边写不进（镜像也随之跳过）。
  //   此处幂等把列类型放宽为 TEXT（USING to_id::text 自然转换；旧库/新库一致生效）。
  await pool.query(
    `ALTER TABLE crm.decision_relation ALTER COLUMN to_id TYPE TEXT USING to_id::text`
  ).catch((e) => { console.error('[migrate] decision_relation to_id 列类型放宽失败:', e.message); throw e; });
  // agent_sla 可审计性 SLA 事实表（2026-08-31 物化设计 §5）：CREATE TABLE IF NOT EXISTS 幂等建表
  //   （新表不受「CREATE IF NOT EXISTS 不补列」陷阱影响；ADD COLUMN 才受影响，此处为全新建表）
  //   定时器⑦ auditability-sla-snapshot 每 6h 写一行；90d 软轮转由物化函数内 DELETE（事实表自身轮转）
  await pool.query(
    `CREATE TABLE IF NOT EXISTS crm.agent_sla (
       id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       measured_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
       window_size       INT NOT NULL,
       auditability_pct  NUMERIC(5,2) NOT NULL,
       full_count        INT NOT NULL DEFAULT 0,
       with_conflict_count INT NOT NULL DEFAULT 0,
       tampered_count    INT NOT NULL DEFAULT 0,
       q1_pass INT NOT NULL DEFAULT 0, q1_warn INT NOT NULL DEFAULT 0, q1_fail INT NOT NULL DEFAULT 0,
       q2_pass INT NOT NULL DEFAULT 0, q2_warn INT NOT NULL DEFAULT 0, q2_fail INT NOT NULL DEFAULT 0,
       q3_pass INT NOT NULL DEFAULT 0, q3_warn INT NOT NULL DEFAULT 0, q3_fail INT NOT NULL DEFAULT 0,
       q4_pass INT NOT NULL DEFAULT 0, q4_warn INT NOT NULL DEFAULT 0, q4_fail INT NOT NULL DEFAULT 0,
       raw_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
       created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  ).catch((e) => { console.error('[migrate] agent_sla 建表失败:', e.message); throw e; });
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ix_crm_agent_sla_measured ON crm.agent_sla(measured_at DESC)`
  ).catch((e) => { console.error('[migrate] agent_sla 索引失败:', e.message); throw e; });
  if (seed) {
    // seed.sql 在 Task 10（种子注入）落地；当前不存在时给友好提示而非崩溃
    try {
      const seedSql = readFileSync(new URL('./seed.sql', import.meta.url), 'utf8');
      await pool.query(seedSql);
      console.log('[migrate] 种子已注入（幂等）');
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log('[migrate] 提示：seed.sql 尚未生成（Task 10 落地），跳过种子注入');
      } else {
        throw e;
      }
    }
    // ─── 用户种子（引导账号）：db/seed-users.sql 插 admin/alice（enabled/tenant_id 由 schema 默认填充）───
    try {
      const userSql = readFileSync(new URL('./seed-users.sql', import.meta.url), 'utf8');
      await pool.query(userSql);
      console.log('[migrate] 用户种子已注入（幂等）');
    } catch (e) {
      if (e.code === 'ENOENT') {
        console.log('[migrate] 提示：seed-users.sql 尚未生成，跳过用户种子注入');
      } else {
        throw e;
      }
    }
    // ─── seed 根治：seed.sql 直 INSERT 绕过 createParticle，建库后补跑 AI 评估器使种子粒子落 payload.ai
    //     （与 createParticle:36 同款逻辑；runRiskScan 现直写 payload.ai，绕开 F18 本体校验）───
    const { runRiskScan } = await import('../src/scheduler/riskScanner.js');
    const rb = await runRiskScan({ llm: null });
    console.log(`[migrate] 种子 AI 属性回填 scanned=${rb.scanned} changed=${rb.changed}`);
  }
  // ─── 套餐基线（2026-09-06）：**仅在缺失时**初始化播种，绝不覆盖运营配置 ───
  // 背景：此前 migrate/seed 链路完全不含 billing-plans，全新环境（生产重建 / 新库）config_store 无该键
  //   → getPlan() 回退 pricing.DEFAULT_PLAN（included_tokens=0、entitlements=[]）
  //   → 表现为「所有权益门禁全拦 + Token 闸立即封死」，且现象极难归因。
  //   语义=初始化（WHERE NOT EXISTS），改价/改权益仍以配置中心现网为准。
  try {
    const has = await pool.query(`SELECT 1 FROM crm.config_store WHERE tenant_id='system' AND key='billing-plans' LIMIT 1`);
    if (!has.rowCount) {
      const billingSql = readFileSync(new URL('./seed-billing-config.sql', import.meta.url), 'utf8');
      await pool.query(billingSql);
      console.log('[migrate] 套餐基线已播种（billing-plans 5 档 + billing-settings）');
    } else {
      console.log('[migrate] 套餐基线已存在，跳过（不覆盖现网配置）');
    }
    // billing_intro 默认配置：仅在 billing-settings 已存在但缺 billing_intro 子键时补；现网已有则跳过
    //   单一事实源 = pricing.billing_intro_defaults（与 billingRoutes.BILLING_INTRO_DEFAULTS 完全一致，前端 landing 兜底同源）
    const settingsExists = await pool.query(`SELECT value FROM crm.config_store WHERE tenant_id='system' AND key='billing-settings' LIMIT 1`);
    if (settingsExists.rowCount) {
      const sv = settingsExists.rows[0].value || {};
      if (!sv.billing_intro) {
        await pool.query(
          `UPDATE crm.config_store SET value = value || $1::jsonb WHERE tenant_id='system' AND key='billing-settings'`,
          [JSON.stringify({
            billing_intro: {
              headline: '套餐',
              subtitle: '档位与价格均由后台配置驱动（配置中心 · 套餐管理），改配置即改页面。',
              legend: [
                '档位与价格均由后台配置（配置中心 · 套餐管理）驱动',
                '功能权益按档解锁，不为「AI 加价」单独收费',
                '私有化与定制需求请联系我们另行报价',
              ],
            },
          })]
        );
        console.log('[migrate] billing-settings.billing_intro 已补默认配置（不覆盖其他字段）');
      } else {
        console.log('[migrate] billing-settings.billing_intro 已存在，跳过');
      }
    }
  } catch (e) {
    console.log('[migrate] 套餐基线播种跳过：', String(e.message || e).slice(0, 100));
  }
  // ─── AGE 决策网络（C1；superuser 直启，无 DBA 阻塞）───
  if (process.argv.includes('--age')) {
    const { ensureGraph } = await import('../src/decision/ageGraph.js');
    const g = await ensureGraph();
    console.log('[migrate] AGE 决策网络:', g.ok ? '就绪' : '启用失败（降级 CTE 生效）');
  }
  if (process.argv.includes('--age-backfill')) {
    const { ensureGraph, addDecision, addEdge } = await import('../src/decision/ageGraph.js');
    await ensureGraph();
    const { rows } = await pool.query(
      `SELECT d.*, dp.precedent_id AS prec
       FROM crm.decision d
       LEFT JOIN crm.decision_precedent_rel dp ON dp.decision_id = d.decision_id`
    );
    // 去重决策顶点（多先例决策会展开多行），逐先例加 REFERENCED_PRECEDENT 边
    const seen = new Set();
    for (const d of rows) {
      if (!seen.has(d.decision_id)) { await addDecision(d).catch(() => {}); seen.add(d.decision_id); }
      if (d.prec) await addEdge('REFERENCED_PRECEDENT', String(d.decision_id), String(d.prec), {}).catch(() => {});
    }
    console.log(`[migrate] AGE 回填 ${seen.size} 条决策顶点 / ${rows.length} 条先例边`);
  }
  // ─── P1-B1 认知决策子系统 · D 层 9 列 + 九尺子评分表（2026-09-02 统一设计 §4）───
  // 设计铁律（§4.5）：禁止把新列写进 schema.sql 的 CREATE TABLE IF NOT EXISTS 段（旧库不补列，
  // 后续依赖该列的索引会让整文件单事务迁移全量回滚）。必须走独立 ALTER ADD COLUMN IF NOT EXISTS。
  await pool.query(
    `ALTER TABLE crm.decision
       ADD COLUMN IF NOT EXISTS intent         JSONB,
       ADD COLUMN IF NOT EXISTS assumptions     JSONB,
       ADD COLUMN IF NOT EXISTS inference       JSONB,
       ADD COLUMN IF NOT EXISTS viewpoints      JSONB,
       ADD COLUMN IF NOT EXISTS implications    JSONB,
       ADD COLUMN IF NOT EXISTS risk_register    JSONB,
       ADD COLUMN IF NOT EXISTS stop_loss        JSONB,
       ADD COLUMN IF NOT EXISTS concept_refs     JSONB,
       ADD COLUMN IF NOT EXISTS rubric           JSONB`
  ).catch((e) => { console.error('[migrate] decision 9 列补列失败:', e.message); throw e; });
  await pool.query(
    `ALTER TABLE crm.decision_scenario
       ADD COLUMN IF NOT EXISTS stage_code       TEXT,
       ADD COLUMN IF NOT EXISTS focus_elements   JSONB,
       ADD COLUMN IF NOT EXISTS focus_rulers     JSONB,
       ADD COLUMN IF NOT EXISTS rubric_pass_line REAL,
       ADD COLUMN IF NOT EXISTS enabled_rulers   JSONB,
       ADD COLUMN IF NOT EXISTS retro_required    BOOLEAN NOT NULL DEFAULT false`
  ).catch((e) => { console.error('[migrate] decision_scenario 5 列补列失败:', e.message); throw e; });
  // 新表 decision_rubric_score（append-only，§4.3）：九尺子逐尺子评分明细，监控台真实化数据源
  await pool.query(
    `CREATE TABLE IF NOT EXISTS crm.decision_rubric_score (
       id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
       decision_id  UUID NOT NULL,
       rubric_key   TEXT NOT NULL,
       score        SMALLINT NOT NULL,
       max_score    SMALLINT NOT NULL DEFAULT 4,
       level        TEXT NOT NULL,
       weight       NUMERIC(4,2) NOT NULL DEFAULT 1.0,
       evidence     JSONB,
       scorer       TEXT NOT NULL,          -- 'rule' | 'llm'
       degraded     BOOLEAN NOT NULL DEFAULT false,
       scored_at    TIMESTAMPTZ NOT NULL DEFAULT now()
     )`
  ).catch((e) => { console.error('[migrate] decision_rubric_score 建表失败:', e.message); throw e; });
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ix_crm_rubric_score_decision ON crm.decision_rubric_score(decision_id, rubric_key)`
  ).catch(() => {});
  // 反面先例登记（C2 通道，§4.4）：negative_precedent 标记，供公平性尺子判定「检索到且被消费」
  await pool.query(
    `ALTER TABLE crm.decision_precedent_rel ADD COLUMN IF NOT EXISTS negative_precedent BOOLEAN NOT NULL DEFAULT false`
  ).catch((e) => { console.error('[migrate] decision_precedent_rel.negative_precedent 补列失败:', e.message); throw e; });
  // 阈值配置化铁律（§4.4）：rubric / retro 阈值走 config_store，禁硬编码。
  // 注意：生产库 crm_native.config_store 早期 DDL 无主键（CREATE IF NOT EXISTS 不补约束陷阱），
  // ON CONFLICT (key) 会报「no unique constraint」→ 改用逐行 WHERE NOT EXISTS 幂等写入（仅插缺失键）。
  await pool.query(
    `INSERT INTO crm.config_store (key, value)
     SELECT v.key, v.value FROM (VALUES
       ('rubric-thresholds', '{"good":0.75,"warn":0.5}'::jsonb),
       ('rubric-weights',    '{}'::jsonb),
       ('rubric-llm',        '"off"'::jsonb),
       ('retro-config',      '{"required_for_tiers":["HIGH","LEAD"],"window_days":30}'::jsonb),
       ('decision-retro',    '{"min_sample":20,"llm_timeout_ms":180000,"window_extend_enabled":true,"window_extend_hours":168,"total_deadline_ms":600000,"llm_fail_circuit":3}'::jsonb)
     ) AS v(key,value)
     WHERE NOT EXISTS (SELECT 1 FROM crm.config_store c WHERE c.key = v.key)`
  ).catch((e) => { console.error('[migrate] config_store rubric/retro 键写入失败:', e.message); throw e; });
  // 配置中心缺失种子补齐（2026-09-05 审计：#28/#35/#39/#44 路由已挂载但 config_store 缺键 → 页面显示「未配置」）。
  // 幂等（WHERE NOT EXISTS），tenant_id 走列默认 'system'。形状对齐各消费端出厂默认（fail-open 兜底）。
  await pool.query(
    `INSERT INTO crm.config_store (key, value)
     SELECT v.key, v.value FROM (VALUES
       ('system', '{"site_name":"CRM AI Native","default_theme":"light","session_timeout":120,"security_policy":{"password_min_len":8,"mfa_required":false,"allow_external_login":false}}'::jsonb),
       ('event-retro', '{"enabled":true,"min_tier":"HIGH","cooldown_hours":24,"auto_pump":true}'::jsonb),
       ('agent-event-trigger', '{"enabled":true,"cooldown_ms":300000,"matrix":[{"domain":"ontology","type":"ontology-sync","entity_type":"CRM_DEAL","intent":"stage-progression","agent":"quote-engine","skill_slug":"method-stage-progression","dedup_field":"payload.stage"},{"domain":"ontology","type":"ontology-sync","entity_type":"CRM_ACCOUNT","intent":"funnel-classification","agent":"followup-agent","skill_slug":"method-funnel-classification","dedup_field":"payload.tier"},{"domain":"ontology","type":"ontology-sync","entity_type":"CRM_KNOWLEDGE","intent":"decision-enrich","agent":"decision-agent","skill_slug":"method-decision-enrich","dedup_field":null}]}'::jsonb),
       ('routing-explore', '{"window_days":14,"max_running":2,"blacklist":["QUOTE_PRICING","SIGN_RISK"],"min_arm_sample":20}'::jsonb)
     ) AS v(key,value)
     WHERE NOT EXISTS (SELECT 1 FROM crm.config_store c WHERE c.key = v.key)`
  ).catch((e) => { console.error('[migrate] config_store 配置中心缺失种子写入失败:', e.message); throw e; });
  // 业务分级配置出厂种子（2026-09-05 建表，2026-09-06 补 tenant_id 复合 PK）：
  // crm.business_tier_config 表已建但缺种子，导致 computeBusinessTier 永远回退 scenario.default_tier。
  // 实际 dimension_value 来自 deal.payload.customer_tier / project_tier（pipeline.html 下拉：
  //   客户维 = STRATEGIC / KEY / NORMAL；项目维 = A / B / C），非行业中文名。
  // 复合 PK (tenant_id, dimension, dimension_value) 幂等：已存在则 DO NOTHING（不覆盖用户后续人工调整）。
  // tenant_id='system' 作为平台模板（与审批参/七维旋钮一致），运行态经 ensureTenantBusinessTiers 懒克隆到租户。
  await pool.query(
    `INSERT INTO crm.business_tier_config (tenant_id, dimension, dimension_value, tier) VALUES
       ('system', 'customer', 'STRATEGIC', 'HIGH'),
       ('system', 'customer', 'KEY',       'HIGH'),
       ('system', 'customer', 'NORMAL',    'NORMAL'),
       ('system', 'project',  'A',         'HIGH'),
       ('system', 'project',  'B',         'NORMAL'),
       ('system', 'project',  'C',         'LEAD')
     ON CONFLICT (tenant_id, dimension, dimension_value) DO NOTHING`
  ).catch((e) => { console.error('[migrate] business_tier_config 出厂种子失败:', e.message); throw e; });
  // P2 闭环回流（§9.5 复合效应测量）：decision_skill_quality 时间序列表（每 Skill 每场景采样一次）。
  await pool.query(
    `CREATE TABLE IF NOT EXISTS crm.decision_skill_quality (
       scenario_id   TEXT NOT NULL,
       skill         TEXT NOT NULL,
       sampled_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
       quality_score NUMERIC(6,3) NOT NULL,
       decision_id   UUID REFERENCES crm.decision(decision_id),
       PRIMARY KEY (scenario_id, skill, sampled_at)
     )`
  ).catch((e) => { console.error('[migrate] decision_skill_quality 建表失败:', e.message); throw e; });
  await pool.query(
    `CREATE INDEX IF NOT EXISTS ix_crm_skill_quality_window ON crm.decision_skill_quality(scenario_id, skill, sampled_at)`
  ).catch(() => {});
  // P2 证实性偏差校验阈值（§9.4）：阈值配置化铁律，走 config_store['hindsight-deviation']，禁硬编码。
  await pool.query(
    `INSERT INTO crm.config_store (key, value)
     SELECT 'hindsight-deviation', '{"threshold":0.3,"rate_alarm":0.3}'::jsonb
     WHERE NOT EXISTS (SELECT 1 FROM crm.config_store c WHERE c.key = 'hindsight-deviation')`
  ).catch((e) => { console.error('[migrate] config_store hindsight-deviation 写入失败:', e.message); throw e; });
  console.log('[migrate] P1-B1 D 层 9 列 + decision_rubric_score + P2 decision_skill_quality + config_store 就绪（幂等）');

  // ── P3 D2 Skill 三层作用域表（system/workspace/user + 推广溯源）──
  await pool.query(
    `CREATE TABLE IF NOT EXISTS crm.skill_scope (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       skill text NOT NULL,
       scope_level text NOT NULL CHECK (scope_level IN ('system','workspace','user')),
       owner text,
       enabled boolean NOT NULL DEFAULT true,
       promoted_from text,
       note text,
       created_at timestamptz NOT NULL DEFAULT now()
     )`
  ).catch((e) => { console.error('[migrate] skill_scope 建表失败:', e.message); throw e; });
  await pool.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS uq_skill_scope ON crm.skill_scope (skill, scope_level, COALESCE(owner,''))`
  ).catch((e) => { console.error('[migrate] skill_scope 唯一索引失败:', e.message); throw e; });
  console.log('[migrate] P3-D2 skill_scope 表 + 唯一索引就绪（幂等）');

  // P3 D2 system 层 skill 基线（展示基线，真实配置事实；取自 agentSpec skillCalls 并集；ON CONFLICT 幂等）
  await pool.query(
    `INSERT INTO crm.skill_scope (skill, scope_level, owner, enabled, promoted_from) VALUES
      ('data-particle-read','system',NULL,true,NULL),
      ('method-intake-routing','system',NULL,true,NULL),
      ('method-quote-engine','system',NULL,true,NULL),
      ('method-stage-progression','system',NULL,true,NULL),
      ('data-particle-create','system',NULL,true,NULL),
      ('crm-asset-attach','system',NULL,true,NULL),
      ('method-followup-engine','system',NULL,true,NULL),
      ('method-funnel-classification','system',NULL,true,NULL),
      ('method-behavior-standard','system',NULL,true,NULL),
      ('method-review-gate','system',NULL,true,NULL),
      ('decision-retrospective','system',NULL,true,NULL)
     ON CONFLICT (skill, scope_level, COALESCE(owner,'')) DO NOTHING`
  ).catch((e) => { console.error('[migrate] skill_scope system 种子失败:', e.message); throw e; });
  console.log('[migrate] P3-D2 system 层 skill 基线种子就绪（幂等）');

  // ── 传播中枢 JS 迁移（2026-09-04 落地；2026-09-05 移至本位置）────────────────────────────
  //   memory_log.tenant_id + tenant_precedent 表 + skill_scope.tenant_id 列 +
  //   propagation_action 审计表 + decision_retro_report 补列
  //   （+ 2026-09-05 Task 11：rectification 整改报告三段落列）。
  //   ⚠ 位置铁律：必须晚于上方 P3-D2 skill_scope 建表——migrate-propagation.js 内
  //     ALTER TABLE crm.skill_scope ADD COLUMN tenant_id 依赖该表存在（N5 新库建库缺陷修复）。
  //     与 migrate-tenant.js 同模式：显式 import + 调用；内部幂等（ADD COLUMN IF NOT EXISTS / IF NOT EXISTS）。
  const PROPAGATION_MIGRATIONS = [
    { mod: '../db/migrate-propagation.js', fn: 'migratePropagation' },
    { mod: '../db/migrate-propagation-metrics.js', fn: 'migratePropagationMetrics' },
    { mod: '../db/migrate-propagation-rectification.js', fn: 'migratePropagationRectification' },
    { mod: '../db/migrate-propagation-todo.js', fn: 'migratePropagationTodo' },
  ];
  for (const { mod, fn } of PROPAGATION_MIGRATIONS) {
    try {
      const m = await import(mod);
      await m[fn]();
      console.log(`[migrate] ${fn} 就绪（幂等）`);
    } catch (e) {
      if (!/42P01|42703/.test(e.code ?? '')) { console.error(`[migrate] ${mod} 失败:`, e.message); throw e; }
      // 不静默：N5 教训——42P01 曾被静默跳过，导致新库传播中枢表缺失而无人察觉。
      console.warn(`[migrate] ⚠ ${mod} 跳过（${e.code} 目标不存在）——传播中枢相关能力可能不可用，请核查依赖表是否已建`);
    }
  }

  // ── 用户有效期字段（2026-09-03 用户管理成批操作）：crm_users.expires_at ──
  // 新库走 schema.sql CREATE 段（已含该列）；旧库/生产库 CREATE TABLE IF NOT EXISTS 不补列，
  // 必须独立 ALTER（同 stable_key/decision_display_name 踩坑）。NULL=永久，登录闸校验。
  await pool.query(
    `ALTER TABLE crm.crm_users ADD COLUMN IF NOT EXISTS expires_at timestamptz`
  ).catch((e) => { console.error('[migrate] crm_users.expires_at 补列失败:', e.message); throw e; });
  console.log('[migrate] crm_users.expires_at 就绪（幂等）');

  // ── 决策先例真向量持久化（方案 B，2026-09-03）：embedding vector(384) → vector(1024) ──
  // 设计铁律（同 §4.5）：改列类型不能塞 schema.sql 的 CREATE TABLE IF NOT EXISTS 段（旧库不补列/
  //   已存在表不重跑），必须走独立 ALTER。此处先 DROP 现有 ivfflat 索引（否则 ALTER TYPE 因索引
  //   依赖 vector 类型而失败），再改维度并 USING NULL 丢弃无区分度的 hash 基线（真模型 1024 维），
  //   最后重建 ivfflat 索引（半回填后加速向量召回）。旧库/新库一致生效。
  await pool.query(`DROP INDEX IF EXISTS crm.idx_crm_decision_embedding`).catch(() => {});
  await pool.query(
    `ALTER TABLE crm.decision ALTER COLUMN embedding TYPE vector(1024) USING NULL`
  ).catch((e) => { console.error('[migrate] decision.embedding 列迁移失败:', e.message); throw e; });
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_crm_decision_embedding
       ON crm.decision USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)`
  ).catch((e) => { console.error('[migrate] decision.embedding 索引重建失败:', e.message); throw e; });
  console.log('[migrate] 决策先例向量列 embedding→vector(1024) + ivfflat 索引就绪（幂等）');

  await pool.end();
}

main().catch((e) => { console.error('[migrate] 失败:', e.message); process.exit(1); });