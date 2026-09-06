// src/http/sevenDimRouter.js — S20 场景×七维矩阵端点（配置面）
// 契约：
//   GET /api/config/seven-dim → {dims, scenarios, default_strictness}
//   PUT /api/config/seven-dim → {scenario_id, required_dims} | {default_strictness}
// 两闸：sysadmin 角色闸 + 写经第0闸（config_change 决策事件）
// 单一写入口：校验/决策/写库全部复用 src/portal/decisionScenario.js 内核，避免口径漂移
import { Router } from 'express';
import { query } from '../db.js';
import { SEVEN_DIMS } from '../sevenDimensions/constants.js';
import { validateScenarioPatch, scenarioDeps } from '../portal/decisionScenario.js';
import { resolveMe as realResolveMe } from './auth.js';
import { DEFAULT_EDGE_DIMENSION_SPEC, validateEdgeDimensionSpec } from '../decision/edgeDimensionSpec.js';
import { checkRequiredDimsWritable, WRITABLE_EDGES, PENDING_WRITABLE_EDGES } from '../decision/writableEdges.js'; // T4(BG-05a) 装弹自检
import { readConfig, writeConfig } from '../config/configStore.js';
import { scopeTenant, scopeOf } from './tenantScope.js';

const CONFIG_KEY = 'seven-dim';
export const STRICTNESS = ['warn', 'block'];

// T32 归因阈值默认值（对齐 rootCauseClassifier/traceRootCause 判定口径；可被 config_store 覆盖）
//   default_input_stale_ms：meta_attr 无 source_refresh_sla 时 INPUT_STALE 的全局兜底时效（设计 §1.2：商机 24h）
export const DEFAULT_ROOT_CAUSE_THRESHOLDS = {
  default_input_stale_ms: 24 * 3600 * 1000, // 24h
  field_mismatch_enabled: true,
  info_incomplete_enabled: true,
  input_stale_enabled: true,
};

// T32：归因阈值 PUT 校验——只接受已知键，值类型校验后归一化（缺省字段补默认）
export function validateRootCauseThresholds(input = {}) {
  const errors = [];
  const normalized = { ...DEFAULT_ROOT_CAUSE_THRESHOLDS };
  if (input == null || typeof input !== 'object') { errors.push('root_cause_thresholds 须为对象'); return { ok: false, normalized: null, errors }; }
  for (const [k, vDef] of Object.entries({
    default_input_stale_ms: { type: 'number', min: 0 },
    field_mismatch_enabled: { type: 'boolean' },
    info_incomplete_enabled: { type: 'boolean' },
    input_stale_enabled: { type: 'boolean' },
  })) {
    if (input[k] !== undefined) {
      const isNum = vDef.type === 'number' && typeof input[k] === 'number' && input[k] >= (vDef.min || 0);
      const isBool = vDef.type === 'boolean' && typeof input[k] === 'boolean';
      if (!isNum && !isBool) { errors.push(`${k} 须为 ${vDef.type}`); continue; }
      normalized[k] = input[k];
    }
  }
  return { ok: errors.length === 0, normalized, errors };
}

const defaultDeps = {
  listScenarios: async () =>
    (await query(
      `SELECT scenario_id, stage, default_tier, autonomous_allowed, required_dims
       FROM crm.decision_scenario ORDER BY stage, scenario_id`
    )).rows,
  readStrictness: async (tenantId = 'system') => {
    const r = await readConfig(CONFIG_KEY, { tenantId });
    const v = r?.value?.default_strictness;
    return STRICTNESS.includes(v) ? v : 'warn';
  },
  writeStrictness: async (v, decisionId, tenantId = 'system') => {
    await writeConfig(CONFIG_KEY, { default_strictness: v }, { tenantId, decisionId, updatedBy: 'system' });
  },
  // T32：边绑定（E1–E7 × 维度 × direction）——落 config_store['seven-dim'].edge_bindings
  //   与 default_strictness 同 key 不同键，读取兼容旧形态（旧库只有 default_strictness 时返回默认 spec）。
  readEdgeBindings: async (tenantId = 'system') => {
    const r = await readConfig(CONFIG_KEY, { tenantId });
    const eb = r?.value?.edge_bindings;
    return Array.isArray(eb) && eb.length ? eb : null;
  },
  // T32：归因阈值（root_cause_thresholds）——与 default_strictness/edge_bindings 同 key 不同键；缺省回退默认。
  readRootCauseThresholds: async (tenantId = 'system') => {
    const r = await readConfig(CONFIG_KEY, { tenantId });
    const v = r?.value?.root_cause_thresholds;
    return v && typeof v === 'object' ? { ...DEFAULT_ROOT_CAUSE_THRESHOLDS, ...v } : { ...DEFAULT_ROOT_CAUSE_THRESHOLDS };
  },
  writeRootCauseThresholds: async (thresholds, decisionId, tenantId = 'system') => {
    await writeConfig(CONFIG_KEY, { root_cause_thresholds: thresholds }, { tenantId, decisionId, updatedBy: 'system' });
  },
  writeEdgeBindings: async (bindings, decisionId, tenantId = 'system') => {
    await writeConfig(CONFIG_KEY, { edge_bindings: bindings }, { tenantId, decisionId, updatedBy: 'system' });
  },
  updateScenario: (id, patch, opts) => scenarioDeps.updateScenario(id, patch, opts),
  produceDecision: (ctx) => scenarioDeps.produceDecision(ctx),
  resolveMe: (req) => realResolveMe(req),
};

function roleOk(role) {
  return role === 'admin' || role === 'sysadmin';
}

export function createSevenDimRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  async function ensureAdmin(req, res) {
    let me = null;
    try { me = await D.resolveMe(req); } catch { me = { ok: false }; }
    if (!me?.ok || !roleOk(me.role)) {
      res.status(403).json({ error: '需要 sysadmin 权限' });
      return null;
    }
    return me;
  }

  const handlers = {
    get: async (req, res) => {
      try {
        const me = await ensureAdmin(req, res);
        if (!me) return;
        const tenantId = scopeTenant(me);
        const cfg = await D.readEdgeBindings(tenantId);
        res.json({
          dims: SEVEN_DIMS.map((d) => ({ key: d.key, label: d.label, desc: d.desc })),
          scenarios: await D.listScenarios(),
          default_strictness: await D.readStrictness(tenantId),
          edge_bindings: cfg || DEFAULT_EDGE_DIMENSION_SPEC,
          root_cause_thresholds: await D.readRootCauseThresholds(tenantId),
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const me = await ensureAdmin(req, res);
        if (!me) return;
        const tenantId = scopeOf(me);
        const { scenario_id, required_dims, default_strictness, edge_bindings, root_cause_thresholds } = req.body || {};

        // A'') 归因阈值（T32）：仅当 root_cause_thresholds 字段出现时处理；经第0闸 + 同 key 不同键
        if (root_cause_thresholds != null) {
          const v = validateRootCauseThresholds(root_cause_thresholds);
          if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
          const decision = await D.produceDecision({ scenario_id: null, fields: ['root_cause_thresholds'] });
          await D.writeRootCauseThresholds(v.normalized, decision?.decisionId || null, tenantId);
          return res.json({ root_cause_thresholds: v.normalized, decision: decision?.decisionId || null, updated: true });
        }

        // A') 全局边绑定（E1–E7 × 维度 × direction；T32）
        //  仅在出现 edge_bindings 字段时处理；与 default_strictness 可同批（各自独立落同 key 不同键）
        if (edge_bindings != null) {
          const v = validateEdgeDimensionSpec(edge_bindings);
          if (!v.valid) return res.status(400).json({ error: v.errors.join('; ') });
          // 规整：serves_dimension 统一为数组（与 DEFAULT_EDGE_DIMENSION_SPEC 形态一致）
          const spec = edge_bindings.map((r) => ({
            edge_type: r.edge_type,
            serves_dimension: Array.isArray(r.serves_dimension) ? r.serves_dimension : [r.serves_dimension],
            direction: r.direction || 'decision->entity',
          }));
          const decision = await D.produceDecision({ scenario_id: null, fields: ['edge_bindings'] });
          await D.writeEdgeBindings(spec, decision?.decisionId || null, tenantId);
          return res.json({ edge_bindings: spec, decision: decision?.decisionId || null, updated: true });
        }

        // A) 全局默认严格度（不传 scenario_id）
        if (scenario_id == null && default_strictness != null) {
          if (!STRICTNESS.includes(default_strictness)) {
            return res.status(400).json({ error: `default_strictness 须为 ${STRICTNESS.join('/')}` });
          }
          const decision = await D.produceDecision({ scenario_id: null, fields: ['default_strictness'] });
          await D.writeStrictness(default_strictness, decision?.decisionId || null, tenantId);
          return res.json({ default_strictness, decision: decision?.decisionId || null, updated: true });
        }

        // B) 单场景矩阵
        if (!scenario_id) return res.status(400).json({ error: 'scenario_id 必填（或仅传 default_strictness）' });
        if (!Array.isArray(required_dims)) return res.status(400).json({ error: 'required_dims 须为数组' });

        const v = validateScenarioPatch({ required_dims });
        if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });

        // T4(BG-05a)：装弹自检——若 required_dims 依赖的边当前不可写权威表（见 WRITABLE_EDGES / BG-03），
        //   拒绝保存并给可读提示，杜绝「配置要求系统交付不了的边」→ 巡检卡恒报 EDGE_MISSING 误报。
        const chk = checkRequiredDimsWritable(v.normalized);
        if (!chk.ok) {
          const hints = chk.unwritable.map(
            (u) => `维度「${u.dim}」依赖边 ${u.edges.join('/')} 当前不可写（待 BG-03 结构扩容后并入可写集）`
          );
          return res.status(422).json({
            error: 'required_dims 含不可写边，拒绝保存',
            detail: hints,
            writable_edges: WRITABLE_EDGES,
            pending_edges: PENDING_WRITABLE_EDGES,
            remediation: '请先修复 BG-03（决策边实体外键扩容），或将不可写维度改为可写维度兜底（如 decision_history/semantics/governance/time_config 对应的可写边）',
          });
        }

        const decision = await D.produceDecision({ scenario_id, fields: ['required_dims'] });
        const row = await D.updateScenario(scenario_id, v.normalized, { tenantId });
        if (!row) return res.status(404).json({ error: `未知 scenario_id: ${scenario_id}` });
        res.json({
          scenario_id,
          required_dims: row.required_dims,
          decision: decision?.decisionId || null,
          updated: true,
        });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/config/seven-dim', handlers.get);
  router.put('/api/config/seven-dim', handlers.put);
  router.handlers = handlers;
  return router;
}