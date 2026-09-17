// src/portal/alertRuleConfig.js — 预警规则配置（第 21 项）
// 渲染纯函数（浏览器 + vitest 共用）。预警引擎实时事实源 = alertRegistry 内存缓存；
// DB（crm.alert_rule）为持久源，异步落库 + 启动水合（见 createAlertRuleConfigRouter / hydrateAlertRules）
export const KIND_LABELS = {
  deal_stuck: '商机停滞',
  lead_overdue: '线索逾期',
  forecast_breach: '预测缺口',
  approval_bottleneck: '审批瓶颈',
  payment_due: '回款到期',
  named_visit_overdue: '指名应访逾期',
};

export function kindLabel(k) {
  return KIND_LABELS[k] || k;
}

// check_params 阈值编辑（按 kind 渲染对应字段，通用遍历对象键）
export function renderCheckParams(kind, check_params = {}) {
  const cp = check_params || {};
  const keys = Object.keys(cp);
  if (!keys.length) return `<div class="cp empty">（无阈值）</div>`;
  const rows = keys
    .map((key) => `<label class="cp-row"><span class="cp-key">${esc(key)}</span><input type="number" class="cp-val" data-key="${esc(key)}" value="${esc(cp[key])}" /></label>`)
    .join('');
  return `<div class="cp" data-kind="${esc(kind)}">${rows}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderAlertRules(rules = []) {
  if (!rules.length) return `<div class="empty">尚未配置任何预警规则（crm.alert_rule）</div>`;
  const rows = rules
    .map((r) => {
      const enabledChk = r.enabled ? 'checked' : '';
      return `<tr class="rule-row" data-kind="${esc(r.kind)}">
        <td class="rkind">${esc(r.kind)}</td>
        <td class="rlabel">${esc(kindLabel(r.kind))}</td>
        <td class="renabled"><label><input type="checkbox" class="r-enabled" ${enabledChk} /> 启用</label></td>
        <td class="rcp">${renderCheckParams(r.kind, r.check_params)}</td>
        <td class="rsev"><select class="r-severity">
          <option value="">默认</option>
          <option value="low"${r.severity === 'low' ? ' selected' : ''}>低</option>
          <option value="medium"${r.severity === 'medium' ? ' selected' : ''}>中</option>
          <option value="high"${r.severity === 'high' ? ' selected' : ''}>高</option>
        </select></td>
        <td class="rrole"><select class="r-target_role">
          <option value="">默认</option>
          <option value="sales"${r.target_role === 'sales' ? ' selected' : ''}>sales</option>
          <option value="manager"${r.target_role === 'manager' ? ' selected' : ''}>manager</option>
          <option value="finance"${r.target_role === 'finance' ? ' selected' : ''}>finance</option>
          <option value="contract_admin"${r.target_role === 'contract_admin' ? ' selected' : ''}>contract_admin</option>
          <option value="presales"${r.target_role === 'presales' ? ' selected' : ''}>presales</option>
          <option value="ops"${r.target_role === 'ops' ? ' selected' : ''}>ops</option>
        </select></td>
      </tr>`;
    })
    .join('');
  return `<table class="rule-table"><thead><tr>
    <th>规则</th><th>名称</th><th>启用</th><th>阈值(check_params)</th><th>严重度</th><th>目标角色</th>
  </tr></thead><tbody>${rows}</tbody></table>`;
}

export function alertRuleSummary(rules = []) {
  const list = rules || [];
  const enabled = list.filter((r) => r.enabled).length;
  return { count: list.length, enabled };
}

// check_params 校验：必须为非空普通对象（非数组、非 null）
export function validateCheckParams(cp) {
  return !!(cp && typeof cp === 'object' && !Array.isArray(cp));
}

// ---- Router 工厂（精确镜像 approvalFlow.js 决策第0闸；绝对禁 DELETE） ----
// 2026-09-05 G3：读按 scopeTenant(me)（admin '*' → system），写按 scopeOf(me)（永不通配）；persist 走写池
import { Router } from 'express';
import { query, queryWrite } from '../db.js';
import { requireDecision, decisionIdOf } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { listAlertRules, updateAlertRule } from '../alerts/alertRegistry.js';
import { resolveMe } from '../http/auth.js';
import { scopeTenant, scopeOf } from '../http/tenantScope.js';

const defaultDeps = {
  resolveMe: (req) => resolveMe(req),
  listRules: ({ tenantId = 'system' } = {}) => listAlertRules({ tenantId }),
  updateCache: (kind, patch, tenantId) => updateAlertRule(kind, patch, { tenantId }),
  persist: async (kind, patch, { tenantId = 'system' } = {}) => {
    try {
      // 2026-09-06 W2：租户首写先克隆 system 模板（含 match/severity/target_role 列）到本租户，
      //   避免 UPDATE 命中 0 行（修复伪绿 / 重启即丢）。仅非 system 租户触发；system 自身直接 UPDATE。
      if (tenantId && tenantId !== 'system') {
        await queryWrite(
          `INSERT INTO crm.alert_rule (kind, match, check_params, severity, target_role, enabled, version, tenant_id)
           SELECT kind, match, check_params, severity, target_role, enabled, version, $2
           FROM crm.alert_rule WHERE kind=$1 AND tenant_id='system'
           ON CONFLICT (kind, tenant_id) DO NOTHING`,
          [kind, tenantId]
        );
      }
      // 写池（query 是读池，UPDATE 必须经写池——以实际源码为准修正既有实现）
      const r = await queryWrite(
        `UPDATE crm.alert_rule SET enabled=$3, check_params=$4::jsonb, severity=$5, target_role=$6, version=COALESCE(version,1)+1, updated_at=now() WHERE kind=$1 AND tenant_id=$2 RETURNING kind`,
        [kind, tenantId, patch.enabled !== undefined ? !!patch.enabled : null, JSON.stringify(patch.check_params || {}), patch.severity || null, patch.target_role || null]
      );
      return { ok: r.rows.length > 0 };
    } catch {
      return { ok: false };
    }
  },
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      const did = decisionIdOf(r);
      return { decisionId: did, ok: !!did };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

export function createAlertRuleConfigRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();
  const handlers = {
    list: async (req, res) => {
      try {
        // 读按 scopeTenant(me)：admin 通配 '*' → system 视界；普通用户 → 自身租户
        const me = D.resolveMe(req);
        const tenantId = scopeTenant(me);
        const rules = await D.listRules({ tenantId });
        res.json({ rules, tenantId });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const { kind } = req.params;
        const { enabled, check_params, severity, target_role } = req.body || {};
        if (check_params !== undefined && !validateCheckParams(check_params))
          return res.status(400).json({ error: 'check_params 必须为对象' });
        const patch = {};
        if (enabled !== undefined) patch.enabled = enabled;
        if (check_params !== undefined) patch.check_params = check_params;
        if (severity !== undefined) patch.severity = severity;
        if (target_role !== undefined) patch.target_role = target_role;
        // 写按 scopeOf(me)：永不通配（admin 写自身所属租户 system）
        const me = D.resolveMe(req);
        const tenantId = scopeOf(me);
        const cached = D.updateCache(kind, patch, tenantId);
        if (!cached.ok) return res.status(404).json({ error: cached.error });
        const decision = await D.produceDecision({ kind, patch, tenantId });
        await D.persist(kind, patch, { tenantId });
        res.json({ ok: true, rule: cached.rule, decision: decision?.decisionId || null, tenantId });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };
  router.get('/api/alert-rules', handlers.list);
  router.put('/api/alert-rules/:kind', handlers.put);
  router.handlers = handlers; // 无 delete
  return router;
}

// 启动水合：从 crm.alert_rule 回填内存缓存（PG 不可用则静默回退 DEFAULT_RULES）
// 2026-09-05 G3：按 tenant_id 分组回填（租户行 → 租户副本；system 行 → system）；
//   租户未拥有行 → 保持继承视图（回退 system 模板，对齐 configStore autoSeed 语义）
export async function hydrateAlertRules() {
  try {
    const r = await query(
      `SELECT tenant_id, kind, enabled, check_params, severity, target_role FROM crm.alert_rule`
    );
    for (const row of r.rows) {
      updateAlertRule(row.kind, {
        enabled: row.enabled,
        check_params: row.check_params || {},
        severity: row.severity,
        target_role: row.target_role,
      }, { tenantId: row.tenant_id });
    }
  } catch {
    /* 未建表 → 保持 DEFAULT_RULES 内存镜像，评估照常 */
  }
}

// 供 alert-rule 租户化测试 / 未来端点复用「校验 + 第0闸 + 写库」单一内核，避免口径漂移
export { defaultDeps as alertRuleDeps };
