// src/http/controlledConfigPages.js — 受控配置页工厂（33 面 schema → renderPage 唯一出口）
// 动机：S21 受控端点范式稳定后，剩余 config 类页结构同构（列表型 table + 少量 attr-field/select），
//       若逐面手写端点 ≈100 行/面 × N = 大量重复代码。工厂把差异收敛为声明：
//         { schema, sql|fetch, map } —— sql=表驱动；fetch=非 SQL 数据面（内存/配置存储/快照函数）
// 设计（对齐既有受控端点契约，参考 routes.js /api/page/skill-registry）：
//   GET /api/page/<id> → { schema, data, html, warnings }；html 为 renderPage 产物（pg-page 顶层）
//   data 按 renderer resolveDatum 契约：components[kind] 索引（同 kind 多组件按 comp.title 索引）
// 纪律：
//   · 只读（受控视图不写）；写经各自 Router 的决策第0闸（绝对禁删）
//   · SQL 必须 crm. schema 前缀（项目铁律；search_path 未含 crm 时不加前缀会静默查不到）
//   · fetch 型数据面必须自带 try/catch 降级（返回 [] 即可，页面渲染「暂无数据」而非 500）
//   · 与手写管理页并存（llm.html/skills.html 等提供编辑，受控页提供 schema 化只读视图）
import { Router } from 'express';
import { renderPage } from '../page/renderer.js';
import { buildReasoningSteps } from '../page/reasoningSteps.js';
import { query } from '../db.js';
import { agentSpecs } from '../agent/agentSpec.js';
import { listPages } from '../page/pageStore.js';
import { getPoolConfig } from '../sales/pool.js';
import { readConfig } from '../config/configStore.js';

import { schema as S16_SCHEMA } from '../pages/S16.schema.js';
import { schema as S17_SCHEMA } from '../pages/S17.schema.js';
import { schema as S18_SCHEMA } from '../pages/S18.schema.js';
import { schema as S19_SCHEMA } from '../pages/S19.schema.js';
import { schema as S20_SCHEMA } from '../pages/S20.schema.js';
import { schema as S22_SCHEMA } from '../pages/S22.schema.js';
import { schema as S23_SCHEMA } from '../pages/S23.schema.js';
import { schema as S24_SCHEMA } from '../pages/S24.schema.js';
import { schema as S25_SCHEMA } from '../pages/S25.schema.js';
import { schema as S26_SCHEMA } from '../pages/S26.schema.js';
import { schema as S27_SCHEMA } from '../pages/S27.schema.js';
import { schema as S28_SCHEMA } from '../pages/S28.schema.js';
import { schema as S29_SCHEMA } from '../pages/S29.schema.js';
import { schema as S30_SCHEMA } from '../pages/S30.schema.js';
import { schema as S31_SCHEMA } from '../pages/S31.schema.js';
import { schema as S32_SCHEMA } from '../pages/S32.schema.js';
import { schema as S01_SCHEMA } from '../pages/S01.schema.js';

// 单值计数（受控降级）：任一源故障返回 0，不阻断整墙
async function safeCount(sql) {
  try {
    const r = await query(sql);
    return Number(r.rows?.[0]?.n ?? 0);
  } catch {
    return 0;
  }
}
// 行集（受控降级）：任一源故障返回 []，页面渲染「暂无数据」而非 500
async function safeRows(sql) {
  try {
    const r = await query(sql);
    return r.rows || [];
  } catch {
    return [];
  }
}

// config_store 型（key-value JSONB）通用取数：返回 {value} 或 {}
// 多租户（枢轴 4）：受控配置展示页为平台级管理视图，读平台默认（tenantId='system'）；
// 租户级覆盖经对应 config GET 端点（scopeTenant(me)）暴露，不在展示墙呈现。
async function readConfigStore(key) {
  try {
    const r = await readConfig(key, { tenantId: 'system' });
    return r?.value || {};
  } catch {
    return {};
  }
}

// 受控页声明表
export const CONTROLLED_PAGES = {
  // ── 批1（已验证 4 面）──
  users: {
    schema: S17_SCHEMA,
    sql: `SELECT username, display_name, role FROM crm.crm_users ORDER BY username`,
    map: (r) => ({ username: r.username, display_name: r.display_name, role: r.role, status: 'active' }),
  },
  'decision-scenarios': {
    schema: S19_SCHEMA,
    sql: `SELECT scenario_id, stage, default_tier, autonomous_allowed, methodology_ids FROM crm.decision_scenario ORDER BY scenario_id`,
    map: (r) => ({
      scenario_name: r.scenario_id,
      trigger: r.stage,
      auto_decision: r.autonomous_allowed,
      methodology_ids: (r.methodology_ids || []).join(', '),
    }),
  },
  'business-tier': {
    schema: S23_SCHEMA,
    sql: `SELECT dimension, dimension_value, tier FROM crm.business_tier_config ORDER BY dimension, dimension_value`,
    map: (r) => ({
      tier: r.tier,
      customer_dim: r.dimension === 'customer' ? r.dimension_value : '',
      project_dim: r.dimension === 'project' ? r.dimension_value : '',
      autonomy_level: r.tier,
    }),
  },
  'meta-attr': {
    schema: S24_SCHEMA,
    sql: `SELECT particle_type, attr_slug, title, attr_type, semantic_tag FROM crm.meta_attr ORDER BY particle_type, attr_slug`,
    map: (r) => ({
      particle_type: r.particle_type,
      attr_count: 1,
      status: 'ready',
      attr_slug: r.attr_slug,
      title: r.title,
      attr_type: r.attr_type,
      semantic_tag: r.semantic_tag,
    }),
  },

  // ── 批2（表驱动 6 面）──
  llm: {
    // S16：config_store key='llm'（JSONB，可能是单对象或 providers 数组）
    schema: S16_SCHEMA,
    fetch: async () => {
      const v = await readConfigStore('llm');
      const list = Array.isArray(v?.providers) ? v.providers : v && Object.keys(v).length ? [v] : [];
      return list;
    },
    map: (r) => ({
      provider: r.provider || '',
      model: r.model || '',
      temperature: r.temperature ?? '',
      enabled: r.enabled ?? true,
    }),
  },
  rbac: {
    // S18：角色上下文画像（role_context_profile）
    schema: S18_SCHEMA,
    sql: `SELECT role, particle_type, action, allowed FROM crm.role_context_profile ORDER BY role, particle_type`,
    map: (r) => ({
      role: r.role,
      particle: r.particle_type,
      action: r.action,
      perm: r.allowed === false ? 'deny' : 'allow',
    }),
  },
  'seven-dim': {
    // S20：七维决策场景完整性校验（config_store key='seven-dim'）
    schema: S20_SCHEMA,
    fetch: async () => {
      const v = await readConfigStore('seven-dim');
      return Array.isArray(v?.scenarios) ? v.scenarios : v && Object.keys(v).length ? [v] : [];
    },
    map: (r) => ({
      scenario: r.scenario || r.scenario_id || '',
      identity: r.identity ?? '',
      structure: r.structure ?? '',
      semantics: r.semantics ?? '',
      time_config: r.time_config ?? r.time ?? '',
      decision_history: r.decision_history ?? '',
      operational_state: r.operational_state ?? '',
      governance: r.governance ?? '',
      strictness: r.strictness ?? '',
    }),
  },
  'approval-flows': {
    // S22：审批流（crm.approval_flow）
    schema: S22_SCHEMA,
    sql: `SELECT flow_id, name, enabled, stages FROM crm.approval_flow ORDER BY flow_id`,
    map: (r) => ({
      flow_id: r.flow_id,
      domain: Array.isArray(r.stages) ? `${r.stages.length} 阶段` : '',
      name: r.name,
      enabled: r.enabled,
    }),
  },
  'alert-rules': {
    // S26：预警规则（crm.alert_rule，主键 kind）
    schema: S26_SCHEMA,
    sql: `SELECT kind, match, check_params, severity, target_role, enabled FROM crm.alert_rule ORDER BY kind`,
    map: (r) => ({
      rule_id: r.kind,
      trigger: r.match?.event_type || r.kind,
      condition: Object.keys(r.check_params || {}).join(', ') || '',
      channel: r.target_role || 'ops',
      severity: r.severity || 'medium',
    }),
  },
  'mcp-identities': {
    // S32：连接器/MCP 身份（crm.mcp_identity；token_hash 绝不出页面，只出 actor/role_tag）
    schema: S32_SCHEMA,
    sql: `SELECT id, actor, role_tag, enabled FROM crm.mcp_identity ORDER BY actor`,
    map: (r) => ({
      connector_id: String(r.id).slice(0, 8),
      name: r.actor,
      endpoint: r.role_tag,
      enabled: r.enabled,
    }),
  },

  // ── 批3（函数/内存驱动 5 面）──
  'pool-config': {
    // S25：线索池配置（getPoolConfig(orgId)）
    // 注意：S25 是表单型页（attr-field pick_rule/recycle_rule + select），**无 table 组件**，
    //       故注入 attr-field（slug→{value}）而非 table（S21 契约同形）
    schema: S25_SCHEMA,
    inject: 'attr-field',
    fetch: async () => {
      try {
        const c = await getPoolConfig('org-hq');
        return c && Object.keys(c).length ? [c] : [];
      } catch {
        return [];
      }
    },
    map: (r) => ({
      pick_rule: { value: r.pick_rule ?? '' },
      recycle_rule: { value: r.recycle_after_days ?? '' },
    }),
  },
  vocabulary: {
    // S27：本体/词汇（词汇同源 CRM_KNOWLEDGE 粒子）
    schema: S27_SCHEMA,
    sql: `SELECT slug, title, payload FROM crm.particles WHERE type = 'CRM_KNOWLEDGE' ORDER BY slug`,
    map: (r) => ({
      term: r.payload?.term || r.title || r.slug,
      synonym: (r.payload?.synonyms || []).join(', '),
      particle_type: r.payload?.particle_type || '',
      embedding_ref: r.payload?.embedding_ref || '',
    }),
  },
  'agent-config': {
    // S28：智能体配置（agentSpecs 内存定义，配置态而非运行态）
    schema: S28_SCHEMA,
    fetch: async () => Object.entries(agentSpecs || {}).map(([id, s]) => ({ id, ...s })),
    map: (r) => ({
      agent_id: r.id || r.slug || '',
      name: r.name || r.title || '',
      role: r.role || '',
      status: 'defined',
    }),
  },
  'portal-pages': {
    // S29：门户/页面生成（pageStore 内存页清单）
    schema: S29_SCHEMA,
    fetch: async () => {
      try {
        return listPages() || [];
      } catch {
        return [];
      }
    },
    map: (r) => ({
      page_id: r.id || r.pageId || '',
      title: r.title || r.nl || '',
      type: r.type || 'nl-generated',
      status: r.published ? 'published' : 'draft',
    }),
  },
  'decision-quality': {
    // S30：决策质量监控（crm.decision 最近决策 + 七维覆盖由 payload 推导）
    // 活体化：reasoning-trace 按真实决策网络算状态（方案 B），与 routes 7 页同源 buildReasoningSteps
    schema: S30_SCHEMA,
    build: async () => {
      const r = await query(`SELECT decision_id, scenario_id, state, created_at FROM crm.decision ORDER BY created_at DESC LIMIT 50`).catch(() => ({ rows: [] }));
      const raw = r.rows || [];
      const rows = raw.map((dec) => ({
        decision_id: String(dec.decision_id).slice(0, 8),
        type: dec.scenario_id || '',
        stage: dec.state || '',
        coverage: dec.state === 'APPROVED' ? 'complete' : 'partial',
      }));
      const traceFacts = {
        page: 'S30',
        hasDecision: rows.length > 0,
        hasPrecedent: rows.some((x) => x.coverage === 'complete'),
        hasException: rows.some((x) => x.stage === 'EXCEPTION'),
      };
      return {
        components: {
          table: { rows },
          'reasoning-trace': { steps: buildReasoningSteps(S30_SCHEMA.components.find(c => c.kind === 'reasoning-trace')?.steps || [], traceFacts) },
        },
      };
    },
  },

  // ── S01 系统状态墙（多源聚合，非单表/单函数）──
  // 三指标卡（metric-card，按 comp.title 索引 value）+ 最新粒子活动表（table.rows）。
  // 登录表单（goal-form）由 renderer 静态产出，无需数据注入。
  // 纪律：纯只读聚合；任一源故障降级为 0/[]（safeCount/safeRows 已包 try/catch），墙不崩。
  'system-status': {
    schema: S01_SCHEMA,
    build: async () => {
      const [assembled, kanban, approval] = await Promise.all([
        safeCount(`SELECT count(*)::int AS n FROM crm.particles`),
        safeCount(`SELECT count(*)::int AS n FROM crm.tasks WHERE status NOT IN ('done','failed')`),
        safeCount(`SELECT count(*)::int AS n FROM crm.decision WHERE state <> 'APPROVED'`),
      ]);
      const partRows = await safeRows(
        `SELECT title, type, state FROM crm.particles ORDER BY created_at DESC LIMIT 8`
      );
      const rows = partRows.map((r) => ({
        name: r.title || '',
        stage: r.type || '',
        amount: '',
      }));
      return {
        components: {
          'metric-card': {
            '装配校验': { value: assembled },
            '看板任务': { value: kanban },
            '审批待处理': { value: approval },
          },
          table: { rows },
        },
      };
    },
  },
};

// 生成受控端点 Router（挂载在 routes.js，与手写管理页路由并存）
export function createControlledPagesRouter(deps = {}) {
  const D = { query, renderPage, pages: CONTROLLED_PAGES, ...deps };
  const router = Router();

  for (const [id, def] of Object.entries(D.pages)) {
    router.get(`/api/page/${id}`, async (req, res) => {
      try {
        let data;
        if (typeof def.build === 'function') {
          // 多源聚合页（如 S01 系统状态墙：metric-card 按 title 索引 + table.rows）
          data = (await def.build()) || { components: {} };
        } else {
          let raw = [];
          if (typeof def.fetch === 'function') {
            raw = (await def.fetch()) || [];
          } else {
            const r = await D.query(def.sql).catch(() => ({ rows: [] }));
            raw = r.rows || [];
          }
          const rows = raw.map(def.map);
          // 注入目标由 def.inject 决定：默认 table（列表型页）；attr-field 用于表单型页
          // （S25 这类无 table 组件的 schema，注入 table 无渲染目标 → 页面空白）
          data =
            def.inject === 'attr-field'
              ? { components: { 'attr-field': Object.assign({}, ...rows) } }
              : { components: { table: { rows } } };
        }
        const rendered = D.renderPage(def.schema, data);
        res.json({ schema: def.schema, data, html: rendered.html, warnings: rendered.warnings });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });
  }

  return router;
}
