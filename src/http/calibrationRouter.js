// src/http/calibrationRouter.js — 决策质量校准端点（指标/归因/处方/重放）
// 设计依据：docs/2026-08-28-decision-quality-calibration-design.md §7
// 端点（全部 sysadmin 闸）：
//   GET  /api/calibration/metrics?scenario_id=&window_days=30
//   GET  /api/calibration/attribution?scenario_id=&window_days=30
//   GET  /api/calibration/patches?status=
//   GET  /api/calibration/replay?scenario_id=&threshold=&weight_method=...
//   POST /api/calibration/patches/:id/approve | reject | rollback
// 第0闸：approve/rollback 经 store.produceDecision（createDecision CALIBRATION_CHANGE 真实决策行）+ 事务原子
import { Router } from 'express';
import { query } from '../db.js';
import { loadDecisions } from '../calibration/sampleLoader.js';
import { enrichPatchesAndSave } from '../calibration/patchAssembler.js';
import { computeMetrics } from '../calibration/metrics.js';
import { attribute } from '../calibration/rules.js';
import { replayScenario } from '../calibration/replay.js';
import { replayDims } from '../calibration/replayDims.js';
import { readConf, savePatches } from '../calibration/store.js';
import * as store from '../calibration/store.js';
import { RequiredDimsStrategy } from '../calibration/knobs/requiredDims.js';
import { validateRequiredDimsPatch } from '../portal/sevenDimRender.js';
import { resolveMe as realResolveMe } from './auth.js';
import { normalizeRole } from './middleware/rbac.js';
// 决策质量稽核台：闸门归因交叉矩阵聚合（避免改 routes.js，复用本已挂载路由器；与 /api/monitor/gates 同口径、免鉴权）
import { getGateAttribution } from '../monitor/monitorStore.js';

function roleOk(role) {
  return role === 'admin' || role === 'sysadmin';
}

export function createCalibrationRouter(deps = {}) {
  const D = {
    loadDecisions,
    readConf,
    computeMetrics,
    attribute,
    replayScenario,
    query: (text, params) => query(text, params), // D6：query 入依赖面（todosHandler 可注入；其余端点保持顶层 query 不变）
    ...store, // createPatch/listPatches/getPatch/approvePatch/rejectPatch/rollbackPatch
    resolveMe: (req) => realResolveMe(req),
    ...deps,
  };
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

  // P3 手动发起 required_dims 处方（七维页调用）：校验 → 读当前 → 量化重放 → 幂等落库
  async function generateRequiredDims(req, res, me) {
    const scenario_id = req.body.scenario_id || null;
    if (!scenario_id) return res.status(400).json({ error: 'manual required_dims 处方须传 scenario_id' });
    const v = validateRequiredDimsPatch(req.body.required_dims_draft);
    if (!v.ok) return res.status(400).json({ error: v.errors.join('; ') });
    const cur = await query(`SELECT required_dims FROM crm.decision_scenario WHERE scenario_id=$1`, [scenario_id]);
    const from_value = cur.rows[0]?.required_dims || [];
    const to_value = v.normalized;
    const risk = new RequiredDimsStrategy('required_dims').riskLevel(from_value, to_value);
    const impact = await replayDims(scenario_id, to_value, Number(req.body.window_days) || 30);
    const dup = await query(
      `SELECT 1 FROM crm.calibration_patch WHERE scenario_id=$1 AND knob='required_dims' AND to_value=$2::jsonb AND status='PENDING' LIMIT 1`,
      [scenario_id, JSON.stringify(to_value)]
    );
    if (dup.rows.length) return res.json({ created: 0, skipped: 1, patch: null, risk, expected_impact: impact });
    const patch = await store.createPatch({
      scenario_id, knob: 'required_dims', target: null,
      from_value, to_value, evidence: { source: 'manual-seven-dim', by: me.username || 'sysadmin' },
      expected_impact: impact, risk,
    });
    return res.json({ created: 1, skipped: 0, patch, risk, expected_impact: impact });
  }

  router.get('/api/calibration/metrics', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const { scenario_id } = req.query || {};
      const window_days = Number(req.query?.window_days || 30);
      const decisions = await D.loadDecisions({ scenario_id, window_days });
      const metrics = D.computeMetrics(decisions);
      // P2：归因随 metrics 一起返回（R1-R6 后端单一事实源，前端不做规则镜像——设计 §5/§7）
      const attribution = D.attribute(metrics);
      res.json({ metrics, attribution, sample: decisions.length, scenario_id: scenario_id || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/calibration/patches', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const status = req.query?.status || null;
      const patches = await D.listPatches({ status });
      res.json({ patches });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 决策复盘报告：返回最新一份（追加式 decision_retro_report），供监控台/作战室读取复盘结论与草稿处方
  // sysadmin 闸（与校准其它端点同口径）；只读，无副作用；无报告返回 empty
  router.get('/api/calibration/retro/latest', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const r = await query(
        `SELECT * FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 1`
      );
      if (!r.rows.length) return res.json({ report: null });
      return res.json({ report: r.rows[0] });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 只读归因：服务端 attribute（rules.js 单一事实源）→ 前端展示，避免前端镜像 R1-R6 的漂移
  // GET 无副作用；归因结果与 generate 的 blocked_by/patches 同源（同一 attribute 调用）
  router.get('/api/calibration/attribution', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const { scenario_id } = req.query || {};
      const window_days = Number(req.query?.window_days || 30);
      const decisions = await D.loadDecisions({ scenario_id, window_days });
      const metrics = D.computeMetrics(decisions);
      const att = D.attribute(metrics);
      res.json({ metrics, sample: decisions.length, attribution: att, scenario_id: scenario_id || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/calibration/replay', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const { scenario_id } = req.query || {};
      const window_days = Number(req.query?.window_days || 30);
      const cur = await D.readConf();
      // 候选配置：以当前配置为底，允许 ?threshold=0.85&weight_method=0.25 覆盖（预览不落库）
      const candidate = { ...cur, weights: { ...cur.weights } };
      if (req.query?.threshold != null) candidate.threshold = Number(req.query.threshold);
      // 权重键从 store.WEIGHT_KEYS 派生（DEFAULT_CONF 的键集）——此处曾硬编码四键，
      //   F5 新增 evidence_coverage 后会被静默丢弃（?weight_evidence_coverage= 不生效）
      const weightKeys = Array.isArray(D.WEIGHT_KEYS) && D.WEIGHT_KEYS.length
        ? D.WEIGHT_KEYS
        : Object.keys(cur.weights || {});
      for (const k of weightKeys) {
        const v = req.query?.[`weight_${k}`];
        if (v != null) candidate.weights[k] = Number(v);
      }
      const decisions = await D.loadDecisions({ scenario_id, window_days });
      // 附上当前配置下的基础分布（重放输出的 base_autonomy）
      const replay = D.replayScenario(decisions, candidate);
      res.json({ candidate, replay, sample: decisions.length, scenario_id: scenario_id || null });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 决策质量稽核台：按闸门聚合归因交叉矩阵（4 类 + 2×2），供监控台右栏面板/下钻
  // 2026-09-03：随监控台收敛为仅 admin（页面 HTML 公开、数据面 admin 守卫），本端点同步收闸（原免鉴权）
  router.get('/api/monitor/gate-attribution', async (req, res, next) => {
    // 复用本路由器的 sysadmin/admin 闸（与 /api/calibration/* 同口径），守卫置前
    const me = await ensureAdmin(req, res);
    if (!me) return;
    next?.();
  }, async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      // T13 租户隔离（2026-09-04）：显式 ?tenant_id= 优先（admin 可指定）；否则 scopeTenant(me)
      //   （admin→'*' 全量，普通用户→自身租户）；缺省 '*'=全量，现状行为兼容
      const { tenantId } = req.query || {};
      const tt = (tenantId && String(tenantId).trim()) || (me && me.tenantId) || '*';
      const gates = await getGateAttribution(tt);
      res.json({ gates });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 生成处方：规则归因 → 影子重放算预期影响 → 幂等落库（写操作集中于此端点，GET 保持只读）
  // rules.attribute 输出 { patches:[{id,knob,delta,risk,label,evidence}], guards:[{id,reason,evidence}] }
  //   —— delta 是相对当前配置的增量（{threshold:+0.05} / {weights:{method:+0.05}}），此处推导 from/to/target
  router.post('/api/calibration/patches/generate', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      // P3 手动发起：七维页传入 required_dims_draft → 生成 required_dims 处方（不走自动归因）
      if (req.body?.required_dims_draft != null) {
        return await generateRequiredDims(req, res, me);
      }
      const scenario_id = req.body?.scenario_id || null;
      const windowDays = Number(req.body?.window_days) || 30;
      const decisions = await D.loadDecisions({ scenario_id, window_days: windowDays, limit: 500 });
      const metrics = D.computeMetrics(decisions);
      const conf = await D.readConf();
      const att = D.attribute(metrics);
      const r = await enrichPatchesAndSave({ decisions, metrics, att, conf, scenario_id, savePatches: D.savePatches, produceDecision: D.produceDecision });
      res.json({
        created: r.created,
        skipped_duplicates: r.skipped_duplicates,
        blocked_by: r.blocked_by,
        metrics, sample: decisions.length,
        patches: r.patches.filter((p) => p.to_value),
      });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/api/calibration/patches/:id/approve', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const r = await D.approvePatch(req.params.id, { resolved_by: me.username || 'sysadmin' });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/api/calibration/patches/:id/reject', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const patch = await D.rejectPatch(req.params.id, { resolved_by: me.username || 'sysadmin' });
      res.json({ ok: true, patch });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.post('/api/calibration/patches/:id/rollback', async (req, res) => {
    try {
      const me = await ensureAdmin(req, res);
      if (!me) return;
      const r = await D.rollbackPatch(req.params.id, { resolved_by: me.username || 'sysadmin' });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ADMIN 待办中心（§16.4 只读可见性 + §16.3 approve→生效由 store.approvePatch 既有端点完成）：
  //   tan_admin 仅见本租户（按 tenant_id 过滤，§16.4 限本租户语义）；
  //   admin / sysadmin 见全部；其他角色 403（fail-closed）。
  const todosHandler = async (req, res) => {
    try {
      const me = await D.resolveMe(req);
      if (!me?.ok) { res.status(401).json({ error: '未登录' }); return; }
      const role = normalizeRole(me.role);
      const allowedRoles = ['ADMIN', 'SYSADMIN', 'TAN_ADMIN'];
      if (!allowedRoles.includes(role)) {
        res.status(403).json({ error: '待办可见性需 tan_admin(本租户)/sysadmin/ADMIN 权限' });
        return;
      }
      const status = String(req.query?.status || 'PENDING');
      const assignee = req.query?.assignee ? String(req.query.assignee) : null;
      // D6：?escalated=true 仅看已升级（SLA 违约）待办；缺省/null → 全部（兼容既有调用）
      const escalatedQ = req.query?.escalated != null
        ? String(req.query.escalated).toLowerCase() === 'true'
        : null;
      // tan_admin → 自动限本租户；admin/sysadmin → null = 不限
      const tenantFilter = role === 'TAN_ADMIN' ? (me.tenantId || null) : null;
      const r = await D.query(
        `SELECT *,
           EXTRACT(EPOCH FROM (now()-created_at))/3600 AS age_hours,
           CASE WHEN sla_due_at IS NULL THEN NULL
                ELSE EXTRACT(EPOCH FROM (sla_due_at-now()))/3600 END AS sla_remaining_hours
         FROM crm.calibration_patch
          WHERE status=$1
            AND ($2::text IS NULL OR assignee=$2)
            AND ($3::text IS NULL OR tenant_id=$3)
            AND ($4::boolean IS NULL OR escalated=$4)
          ORDER BY created_at DESC LIMIT 50`,
        [status, assignee, tenantFilter, escalatedQ]
      );
      res.json({ todos: r.rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  };
  router.get('/api/admin/todos', todosHandler);

  router.handlers = {
    metrics: router.stack.find((l) => String(l.route?.path || '').includes('/metrics'))?.route?.handlers?.[0],
    todos: todosHandler,
  };
  return router;
}