// scripts/seed-test-config.mjs — 测试库 crm_native_test 配置/种子前置（幂等；专治决策/身份/配置域全量失败）
// 背景（2026-08-26 决策域转红归因）：
//   vitest.config.js 只切 PGDATABASE=crm_native_test，但测试库从不灌「配置种子」——
//   业务库 crm_native 的 methodology_template/role_context_profile/business_tier_config/memory_note
//   靠历史迁移+代码幂等注入累积；crm_native_test 缺这些前置 → 全量回归 4 文件 7 失败：
//     ① migrateConfig.test.js 3：config_store/skill_registry/approval_flow/connectors/system_config 表
//         + decision_scenario.required_dims 列（db/migrate-config.sql 未在测试库执行）
//     ② decision.test.js 2：methodology_template=0（SKILL 同步未跑）+ business_tier_config 缺 strategic/pilot
//     ③ memory.test.js 1：memory_note.ui:import-export-pref（L-User 层种子）缺失
//     ④ portal-pipeline.test.js 1：CRM_DEAL 粒子缺失（/api/business/board 聚合断言）
//  收敛策略：最小侵入补「测试库前置脚本」，不改业务代码；幂等（重复执行安全）。
//  用法：node scripts/seed-test-config.mjs   （默认连 crm_native_test；PGDATABASE 可覆盖）
import { readFileSync } from 'node:fs';

// 【安全铁律·生产库护栏】本脚本是**测试库专用前置**，绝不允许写生产库。
// 背景（2026-09-02 事故前兆）：src/db.js:17 的默认库是**生产库 crm_native**；而 ESM 静态 import
//   会在模块顶层立即建池——若在 import 之后才设置 PGDATABASE，env 兜底完全无效，脚本会静默写生产库
//   （本次「元模型基线复位」因此曾在生产库执行；幸而生产库 meta_attr 为 0 行，实际影响为零）。
// 对策：① 在 import src/db.js **之前**钉死 PGDATABASE；② 显式拒绝疑似生产库名（crm_native/plm）。
const FORCED_DB = 'crm_native_test';
const PGDATABASE = process.env.PGDATABASE || FORCED_DB;
if (PGDATABASE === 'crm_native' || PGDATABASE === 'plm') {
  console.error(
    `[seed-test-config] 拒绝执行：PGDATABASE=${PGDATABASE} 为生产库；本脚本仅服务测试库 ${FORCED_DB}。`
  );
  process.exit(1);
}
process.env.PGDATABASE = PGDATABASE;
// 动态 import：确保上面的 env 在 src/db.js 建池之前生效
const { pool } = await import('../src/db.js');

/**
 * 【并发守卫】禁止两个 vitest 同时跑同一个测试库。
 * 背景（2026-09-02）：并行会话与我方各跑一次全量，共用 crm_native_test —— 表现为
 *   `meta_attr` 在无人操作时仍持续增长（实测 140→173→176，particles 0→2），
 *   两边互 TRUNCATE / 互改基线，产生**伪失败**（本次 rrf、decision-gate 两个失败均属此类，
 *   单独跑全绿）。这是环境噪音，不是代码缺陷——先确认无并发再判定任何红。
 * 检测：静默采样 2.5 秒，对多张高频表（particles/decision/decision_event/edges/meta_attr）
 *   取计数指纹，任一变化即认定有活跃写入者。**必须多表联合**——实测单看 meta_attr 会漏判：
 *   并行会话跑测试时 meta_attr 稳定在 185，而 particles 在 4→5→4、decision 在 3→2 变化。
 * 逃生阀：确认无并发（或有意并发）时设 SKIP_CONCURRENCY_CHECK=1。
 */
async function guardNoConcurrentRun() {
  if (process.env.SKIP_CONCURRENCY_CHECK === '1') return;
  // 多表联合指纹（表缺失不影响其它表计数）
  const PROBE_TABLES = ['particles', 'decision', 'decision_event', 'edges', 'events', 'meta_attr'];
  const snap = async () => {
    const parts = [];
    for (const t of PROBE_TABLES) {
      try {
        const r = await pool.query(`SELECT count(*)::int AS n FROM crm.${t}`);
        parts.push(`${t}=${r.rows[0].n}`);
      } catch {
        parts.push(`${t}=n/a`);
      }
    }
    return parts.join(' ');
  };
  try {
    const a = await snap();
    await new Promise((r) => setTimeout(r, 2500));
    const b = await snap();
    if (a !== b) {
      console.error('[seed-test-config] ⚠ 检测到并发写入：静默 2.5 秒内测试库仍在变化');
      console.error(`                     前：${a}`);
      console.error(`                     后：${b}`);
      console.error('                     极可能有另一个 vitest 正在跑同一测试库 —— 并发两 vitest 会互 TRUNCATE，产生伪失败。');
      console.error('                     请等其结束后再跑；确需跳过请设 SKIP_CONCURRENCY_CHECK=1。');
      process.exit(1);
    }
  } catch {
    /* 探测失败不阻断主流程（表不存在等），交由后续步骤报错 */
  }
}
await guardNoConcurrentRun();

// 【AGE 图清理｜测试隔离 2026-09-02】AGE 决策网络图（crm_decision_network）是**长期累积残留源**：
//   http.test.js 前 6 个不碰 AGE 的测试通过，但 trace/audit 决策网络端点每次全图扫描
//   （逐类型变长关系 5 类 × 深度）→ 1965 Decision 顶点 + 1075 边累积后单次 ~20s → 5s 超时。
//   根因是测试只 TRUNCATE 关系表（particles/edges/events），**从不清理 AGE 图** —— 违反
//   「测试对全局写入净效果为 0」铁律。对策：pretest 整图重建（drop_graph cascade 幂等，
//   等价 TRUNCATE 图；不产生锁竞争，无并发写问题）。
async function resetAgeGraph() {
  const r = await run(`SELECT ag_catalog.drop_graph('crm_decision_network', true)`);
  if (!r.ok && !/does not exist/.test(r.err)) return r;
  return { ok: true };
}
const ageReset = await resetAgeGraph();
if (!ageReset.ok) console.error(`[seed-test-config] ⚠ AGE 图重建失败（不影响关系表种子，但决策网络端点会慢）：${ageReset.err}`);

async function run(sql) {
  try { await pool.query(sql); return { ok: true }; }
  catch (e) { return { ok: false, err: String(e?.message || e).slice(0, 120) }; }
}

// ① 配置中心表（migrate-config.sql 幂等建表 + required_dims 列）
async function ensureConfigSchema() {
  const sql = readFileSync(new URL('../db/migrate-config.sql', import.meta.url), 'utf8');
  return run(sql);
}

// ② 决策场景 required_dims 列（migrate-config.sql 已含 ALTER ADD COLUMN IF NOT EXISTS；防旧库直接补）
async function ensureRequiredDims() {
  return run(`ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS required_dims JSONB NOT NULL DEFAULT '[]'`);
}

// ②b skill_registry.methodology_id 列（漂移根治：migrate-config.sql DDL 已补列对齐 schema.sql；
//     但已存在的测试库 CREATE TABLE IF NOT EXISTS 不改既有表 → 幂等补列，使 skillRegistry.js
//     seed/list/update 的 methodology_id 契约列立即可用，杜绝「seed fail: column does not exist」）
async function ensureSkillRegistryMethodologyId() {
  return run(`ALTER TABLE crm.skill_registry ADD COLUMN IF NOT EXISTS methodology_id TEXT`);
}

// ③ 方法论镜像（methodologySync 从 SKILL 幂等同步；§6.6 单一事实源）
async function ensureMethodology() {
  // STOP_LOSS 镜像修正：旧同步把 CB 归一键误写为 probability（与标签「投入预算上限 Cost Budget」自相矛盾）。
  // 重种前先 RENAME 清理孤儿键，使镜像与 SKILL 事实源（methodology.json STOP_LOSS.CB）对齐。
  await run(`UPDATE crm.methodology_dimension SET dim_key='cost_budget'
             WHERE methodology_id='STOP_LOSS' AND dim_key='probability'`);
  const { syncAllMethodologies } = await import('../src/skills/methodologySync.js');
  const results = await syncAllMethodologies({});
  const ok = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok);
  if (fail.length) console.warn('[seed-test-config] methodology 同步失败:', JSON.stringify(fail));
  return { ok: results.length > 0 && fail.length === 0, added: results.reduce((a, r) => a + (r.added || 0), 0), total: results.length };
}

// ④ 角色上下文 profile（roleProfiles.js 代码级幂等注入 6 角色；mcp_identity.role_tag 外键目标）
async function ensureRoleProfiles() {
  const { seedProfiles } = await import('../src/context/roleProfiles.js');
  const n = await seedProfiles();
  return { ok: n >= 6, count: n };
}

// ⑤ 业务分级配置（computeBusinessTier 两维：customer×project）
// 权威基线 = 业务库 plm 实际配置（customer: strategic=HIGH/key=NORMAL/normal=LEAD；
// project: critical=HIGH/standard=NORMAL/pilot=LEAD）——测试库必须与之对齐，不得自造凑数版本
// （历史教训：手写版曾把 pilot=HIGH/customer.normal=NORMAL 灌入，使 normal×pilot 被判 HIGH
//   → autonomyEngine tier==HIGH 强升级 → decision.test LEAD 自主用例假性转红）
// 先全量 DELETE 再插权威 6 行（幂等：不再残留凑数行如 flagship）
async function ensureBusinessTierConfig() {
  const rows = [
    // dimension, dimension_value, tier —— 与 plm 权威一致，勿自造
    ['customer', 'strategic', 'HIGH'], ['customer', 'key', 'NORMAL'], ['customer', 'normal', 'LEAD'],
    ['project', 'critical', 'HIGH'], ['project', 'standard', 'NORMAL'], ['project', 'pilot', 'LEAD'],
  ];
  try {
    // Phase 1 #1：business_tier_config PK 已复合化 (tenant_id, dimension, dimension_value)；
    // 本步骤仅维护 system 模板基线，不动各租户克隆行（DELETE 限定 tenant_id='system'）。
    await pool.query(`DELETE FROM crm.business_tier_config WHERE tenant_id='system' AND NOT (
      (dimension='customer' AND dimension_value IN ('strategic','key','normal'))
      OR (dimension='project' AND dimension_value IN ('critical','standard','pilot')))`);
    for (const [dimension, dimension_value, tier] of rows) {
      await pool.query(
        `INSERT INTO crm.business_tier_config (tenant_id, dimension, dimension_value, tier)
         VALUES ('system',$1,$2,$3)
         ON CONFLICT (tenant_id, dimension, dimension_value) DO UPDATE SET tier=EXCLUDED.tier`,
        [dimension, dimension_value, tier]
      );
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, err: String(e?.message || e).slice(0, 120) };
  }
}

// ⑥ memory_note L-User 种子（T1/T5 依赖；业务库 plm 有，测试库补）
async function ensureMemoryNoteSeed() {
  return run(
    `INSERT INTO crm.memory_note (layer, topic, content, updated_at)
     SELECT 'L-User','ui:import-export-pref','{"fields":["name","amount"],"sort":"updated_at"}', now()
     WHERE NOT EXISTS (SELECT 1 FROM crm.memory_note WHERE topic='ui:import-export-pref')`
  );
}

// ⑦ CRM_DEAL 最小粒子（portal-pipeline：/api/business/board 聚合含 CRM_DEAL 键；幂等固定 UUID）
async function ensureDealSeed() {
  return run(
    `INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at)
     VALUES ('99999999-9999-9999-9999-999999999999','system','CRM_DEAL','seed-test-deal','测试商机(前置)','ACTIVE',
             '{"name":"测试商机(前置)","stage":"leads","expected_amount":100000,"probability":0.1}', now(), now())
     ON CONFLICT (id) DO NOTHING`
  );
}

// ⑧ 决策校准 P0 列（db/schema.sql 用 CREATE TABLE IF NOT EXISTS 不补既有测试库列 → 幂等补）
// 决策表 4 列（human_disposition 等） + tasks.decision_id 关联列（打通 HITL 处置链路）
async function ensureCalibrationP0Columns() {
  return run(`
    ALTER TABLE crm.decision
      ADD COLUMN IF NOT EXISTS human_disposition    TEXT,
      ADD COLUMN IF NOT EXISTS human_decided_at     TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS human_decider_id     TEXT,
      ADD COLUMN IF NOT EXISTS human_decider_role   TEXT;
    ALTER TABLE crm.tasks
      ADD COLUMN IF NOT EXISTS decision_id UUID REFERENCES crm.decision(decision_id);
    CREATE INDEX IF NOT EXISTS idx_crm_decision_human_disp
      ON crm.decision(human_disposition) WHERE human_disposition IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_crm_tasks_decision ON crm.tasks(decision_id);
  `);
}

// ⑧b 记忆客户锚点列（A2 / 2026-09-02）
//   db/schema.sql 用独立 ALTER 段声明，但既有测试库不会重跑 schema.sql 的 ALTER
//   （且 CREATE TABLE IF NOT EXISTS 不补列）→ 此处幂等补，与 ⑧ 同模式。
//   缺此列时 memoryLog.rrfSearch / timelineSource 的按客户聚合会直接报列不存在。
async function ensureMemoryEntityAnchor() {
  return run(`
    ALTER TABLE crm.memory_log ADD COLUMN IF NOT EXISTS entity_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_crm_memory_log_entity
      ON crm.memory_log(entity_id, created_at);
  `);
}

// ⑧c 快照装配阶段列（F4 单轨 / 2026-09-02）
//   decision_context_snapshot.phase：'pre'=事前装配（决策落库前）/ 'post'=事后退回装配。
//   同 ⑧b：schema.sql 用独立 ALTER 声明，但既有测试库不会重跑 → 此处幂等补。
async function ensureSnapshotPhaseColumn() {
  return run(`
    ALTER TABLE crm.decision_context_snapshot
      ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'pre';
    CREATE INDEX IF NOT EXISTS idx_crm_dcs_phase
      ON crm.decision_context_snapshot(phase);
  `);
}

// ⑨ 决策校准处方表 + CALIBRATION_CHANGE 场景（P1：处方落库 + 校准变更作为治理决策）
async function ensureCalibrationPatch() {
  return run(`
    CREATE TABLE IF NOT EXISTS crm.calibration_patch (
      patch_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      scenario_id TEXT REFERENCES crm.decision_scenario(scenario_id),
      knob TEXT NOT NULL CHECK (knob IN ('threshold','weight','required_dims')),
      target TEXT,
      from_value JSONB NOT NULL, to_value JSONB NOT NULL,
      evidence JSONB NOT NULL, expected_impact JSONB,
      risk TEXT NOT NULL CHECK (risk IN ('LOW','MEDIUM','HIGH')),
      status TEXT NOT NULL DEFAULT 'PENDING'
        CHECK (status IN ('PENDING','APPROVED','REJECTED','APPLIED','ROLLED_BACK')),
      decision_id UUID REFERENCES crm.decision(decision_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ, resolved_by TEXT
    );
    INSERT INTO crm.decision_scenario
      (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
    VALUES ('CALIBRATION_CHANGE','meta','决策引擎校准参数变更（阈值/权重）',
      '{"action":["calibration-patch-apply"]}'::jsonb, ARRAY[]::TEXT[], '[]'::jsonb, 'HIGH', FALSE)
    ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
  `);
}

// ⑫ 线索发现场景（T6）：LEAD_FIT 场景行幂等补齐。
//   测试库场景字典来自 db/test-setup.sql（TRUNCATE 后重建）；本步骤让 `npx vitest run`（不经 pretest）
//   也能自足——与 ensureCalibrationPatch 同构（ON CONFLICT DO NOTHING；禁 DELETE、禁 UPDATE 覆盖）。
async function ensureDiscoveryScenario() {
  return run(`
    INSERT INTO crm.decision_scenario
      (scenario_id, stage, description, trigger, methodology_ids, eval_dimensions, default_tier, autonomous_allowed)
    VALUES ('LEAD_FIT','一、线索','线索 ICP 适配度评分（发现引擎：industry/headcount/geo/hiring/funding）',
      '{"cond":{"event":"created","stage":"lead"},"entity":"ACCOUNT","source":"particle_event"}'::jsonb,
      ARRAY['BANT','MEDDICC','OPP_MATRIX'],
      '[{"cond":"industry","label":"行业匹配","weight":0.25},{"cond":"headcount","label":"规模匹配","weight":0.2},{"cond":"geo","label":"地域匹配","weight":0.15},{"cond":"hiring_icp_role","label":"招聘信号","weight":0.2},{"cond":"funding_round","label":"融资信号","weight":0.2}]'::jsonb,
      'LEAD', TRUE)
    ON CONFLICT (scenario_id, tenant_id) DO NOTHING;
  `);
}

// ⑪ 决策边/结果表（T-D2/T-D3）：schema.sql:490-520 已定义，但测试库若为旧版建库则缺表
//    → 幂等补建，杜绝 "relation crm.decision_relation does not exist" 假性转红
async function ensureDecisionRelationTables() {
  return run(`
    CREATE TABLE IF NOT EXISTS crm.decision_relation (
      rel_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_id          UUID NOT NULL REFERENCES crm.decision(decision_id),
      -- to_id 放宽为 TEXT（BG-03 方案 B）：异常等非决策实体（如 'EX-1'）亦可作为边终点，
      -- 与 db/schema.sql / db/migrate.js 保持一致（否则新建库会被建成 UUID → DERIVED_FROM_EXCEPTION 落库失败）
      to_id            TEXT NOT NULL,
      rel_type         TEXT NOT NULL CHECK (rel_type IN
        ('DECIDED_ON','REFERENCED_PRECEDENT','DERIVED_FROM_EXCEPTION','ESTABLISHES_FRAME','OVERRIDES','CAUSED','INFLUENCED')),
      serves_dimension TEXT NOT NULL,
      props            JSONB,
      source           TEXT NOT NULL DEFAULT 'engine',
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (from_id, to_id, rel_type)
    );
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
  `);
}

// ⑬ 决策规则门（G2）：decision_rule + rule_hit 幂等建表（对齐 schema.sql 决策质量闭环 DDL 段）
async function ensureDecisionRuleTables() {
  return run(`
    CREATE TABLE IF NOT EXISTS crm.decision_rule (
      id            BIGSERIAL PRIMARY KEY,
      code          TEXT UNIQUE NOT NULL,
      match_type    TEXT NOT NULL,
      match_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      check_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled       BOOLEAN NOT NULL DEFAULT true,
      decision_id   UUID REFERENCES crm.decision(decision_id),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS crm.rule_hit (
      id          BIGSERIAL PRIMARY KEY,
      rule_code   TEXT NOT NULL,
      decision_id UUID,
      blocked     BOOLEAN NOT NULL,
      reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// ⑫ 决策上下文守卫配置默认值（T-D5 配置化：默认 warn 不阻断；置 block 收紧为拒写）
async function ensureContextGuardConfig() {
  // 兼容两种主键：单 key 主键（旧）与 (tenant_id, key) 复合主键（migrate-tenant 升级后）
  // ON CONFLICT 须匹配唯一约束——复合主键下 ON CONFLICT (key) 会报 no unique constraint，
  // 故改为 WHERE NOT EXISTS 幂等（两代主键下均成立）。
  return run(
    `INSERT INTO crm.config_store (tenant_id, key, value)
     SELECT 'system', 'decision-context-guard', '{"mode":"warn"}'::jsonb
     WHERE NOT EXISTS (
       SELECT 1 FROM crm.config_store WHERE key='decision-context-guard'
     )`
  );
}

// ⑭ 元模型基线复位：清除「测试裸 INSERT」遗留的强制必填行，杜绝全量串行序跨域毒化
// 背景（2026-09-02 #13 残留污染根治）：
//   部分测试用裸 INSERT 往 crm.meta_attr 写行且置 required=true（如 normalizeFacts.test.js 历史版
//   写 CRM_DEAL.amount/due_date），afterEach 未清干净时残留行会让后续**任何不带该字段的粒子写入**
//   抛「required 属性缺失: amount」——表现为「单独跑绿、全量跑红」的诡异回归。
// 判据（精准且保守）：created_by IS NULL —— src 全部写入路径均显式指定 created_by
//   （种子='seed'、自适应登记=actor||'system'），故 created_by IS NULL 只可能是测试/脚本裸 INSERT；
//   再叠加 required=true（出厂 coreAttributes 与自适应登记均不会置必填）→ 命中即污染，可安全清除。
//   不删 required=false 的行（无害，且可能是测试自身前置数据，避免误伤）。
async function ensureMetaAttrBaseline() {
  return run(
    `DELETE FROM crm.meta_attr WHERE created_by IS NULL AND required = true`
  );
}

// ⑮ 套餐基线播种（2026-09-06 三源对齐）：测试库 billing-plans 长期无 quote、权益/Token 参数与现网漂移，
//    导致「先跑的测试重播旧 seed（token=-1 / mode=none）→ 后跑的测试读到被关闸的配置」这类
//    「单独跑绿、全量跑红」污染。现由 pretest 每次把测试库拉回唯一真相源 db/seed-billing-config.sql。
async function ensureBillingPlans() {
  const sql = readFileSync(new URL('../db/seed-billing-config.sql', import.meta.url), 'utf8');
  return run(sql);
}

async function main() {
  console.log(`[seed-test-config] 前置执行 @ ${PGDATABASE}`);
  const steps = [
    ['config_store 等配置表', ensureConfigSchema],
    ['skill_registry.methodology_id 列（漂移根治）', ensureSkillRegistryMethodologyId],
    ['decision_scenario.required_dims 列', ensureRequiredDims],
    ['methodology 镜像(8 模板)', ensureMethodology],
    ['role_context_profile(6 角色)', ensureRoleProfiles],
    ['business_tier_config(6 行)', ensureBusinessTierConfig],
    ['memory_note.ui:import-export-pref', ensureMemoryNoteSeed],
    ['CRM_DEAL 测试粒子', ensureDealSeed],
    ['决策校准 P0 列', ensureCalibrationP0Columns],
    ['记忆客户锚点列（memory_log.entity_id）', ensureMemoryEntityAnchor],
    ['快照装配阶段列（snapshot.phase，F4 单轨）', ensureSnapshotPhaseColumn],
    ['决策校准处方表+场景', ensureCalibrationPatch],
    ['决策边/结果表（decision_relation/outcome）', ensureDecisionRelationTables],
    ['决策规则门（decision_rule/rule_hit）', ensureDecisionRuleTables],
    ['决策上下文守卫配置默认值', ensureContextGuardConfig],
    ['元模型基线复位（清测试裸插入的强制必填行）', ensureMetaAttrBaseline],
    ['套餐基线（billing-plans 5 档 + billing-settings）', ensureBillingPlans],
    ['线索发现场景（LEAD_FIT）', ensureDiscoveryScenario],
  ];
  let fail = 0;
  for (const [name, fn] of steps) {
    try {
      const r = await fn();
      if (!r.ok) { fail++; console.error(` ✗ ${name}:`, r.err || 'failed'); }
      else console.log(` ✓ ${name}`);
    } catch (e) { fail++; console.error(` ✗ ${name}:`, String(e?.message || e).slice(0, 150)); }
  }
  console.log(fail ? `[seed-test-config] 完成，${fail} 步失败` : '[seed-test-config] 全部就绪（幂等）');
  await pool.end();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error('[seed-test-config] 终止:', e); process.exit(1); });