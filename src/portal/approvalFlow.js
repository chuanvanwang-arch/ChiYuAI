// src/portal/approvalFlow.js — 审批流配置（第 17 项）
// 渲染纯函数（浏览器 + vitest 共用）+ 表驱动 GET/PUT 端点（决策第0闸）
// 数据后端：CRM_APPROVAL_* 粒子（方案 A：配置页直写粒子，单一事实源；2026-08-31 接通运行态引擎，原 crm.approval_flow 表降级只读兼容）
import { Router } from 'express';
import { requireDecision } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';
import { getFlowByDomain, getFlowByDomainWithFallback, writeFlowFromStages } from '../approval/flow.js';
import { queryParticles } from '../particles/particleRepo.js';
import { resolveMe } from '../http/auth.js';
import { scopeTenant, scopeOf } from '../http/tenantScope.js';

// 业务域标签（flow_id 即域）
export const DOMAIN_LABELS = {
  deal: '商机',
  quote: '报价',
  contract: '合同',
  invoice: '发票',
};

export function domainLabel(d) {
  return DOMAIN_LABELS[d] || d;
}

// stages 校验：数组，且每项含 stage(数字串)/role(串)/action(串)
export function validateStages(stages) {
  if (!Array.isArray(stages)) return false;
  return stages.every(
    (s) => s && typeof s === 'object' && s.stage != null && typeof s.role === 'string' && typeof s.action === 'string'
  );
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderStages(stages = []) {
  if (!stages.length) return `<div class="stages empty">（无关卡）</div>`;
  const rows = stages
    .map((s, i) => {
      const checked = s.auto_allowed ? 'checked' : '';
      return `<div class="stage-row" data-idx="${i}">
        <span class="stg-no">${esc(s.stage)}</span>
        <input class="stg-role" value="${esc(s.role)}" placeholder="role" />
        <input class="stg-action" value="${esc(s.action)}" placeholder="action" />
        <label class="stg-auto"><input type="checkbox" class="stg-auto-chk" ${checked} /> 自动通过</label>
      </div>`;
    })
    .join('');
  return `<div class="stages">${rows}</div>`;
}

export function renderApprovalFlows(flows = []) {
  if (!flows.length) return `<div class="empty">尚未配置任何审批流（CRM_APPROVAL_* 粒子事实源）</div>`;
  const rows = flows
    .map((f) => {
      const enabledBadge = f.enabled
        ? `<span class="badge ok">已启用</span>`
        : `<span class="badge off">已停用</span>`;
      return `<tr class="flow-row" data-flow="${esc(f.flow_id)}">
        <td class="fid">${esc(f.flow_id)}</td>
        <td class="fname">${esc(f.name)}</td>
        <td class="fdomain">${esc(domainLabel(f.flow_id))}</td>
        <td class="fenabled">${enabledBadge}</td>
        <td class="fstages">${renderStages(f.stages)}</td>
      </tr>`;
    })
    .join('');
  return `<table class="flow-table"><thead><tr>
      <th>流ID</th><th>名称</th><th>域</th><th>状态</th><th>审批关卡</th>
    </tr></thead><tbody>${rows}</tbody></table>`;
}

export function approvalFlowSummary(flows = []) {
  const list = flows || [];
  const enabled = list.filter((f) => f.enabled).length;
  const stages = list.reduce((n, f) => n + (Array.isArray(f.stages) ? f.stages.length : 0), 0);
  return { count: list.length, enabled, stages };
}

// ---- 端点 ----
const defaultDeps = {
  // 方案 A 接线（2026-08-31）：存储后端从 crm.approval_flow SQL 改为 CRM_APPROVAL_* 粒子
  // 配置页 flow_id = 业务域字符串，统一经 getFlowByDomain / writeFlowFromStages 对齐运行态引擎
  listFlows: async (actor) => {
    const flows = await queryParticles({ type: 'CRM_APPROVAL_FLOW', tenantId: scopeTenant(actor) });
    return flows
      .filter((f) => f.payload && f.payload.domain)
      .map((f) => ({
        flow_id: f.payload.domain,
        name: f.payload.name,
        description: f.payload.description || '',
        stages: Array.isArray(f.payload.stages) ? f.payload.stages : [],
        enabled: f.payload.enabled !== false,
      }));
  },
  getFlow: async (id, actor) => {
    const f = await getFlowByDomainWithFallback(id, scopeOf(actor));
    if (!f) return null;
    return {
      flow_id: f.payload.domain,
      name: f.payload.name,
      description: f.payload.description || '',
      stages: Array.isArray(f.payload.stages) ? f.payload.stages : [],
      enabled: f.payload.enabled !== false,
    };
  },
  upsertFlow: async (flow, actor) => {
    return writeFlowFromStages(flow, scopeOf(actor));
  },
  produceDecision: async (ctx) => {
    try {
      const r = await requireDecision('config-change', ctx || {});
      return { decisionId: r.decision_id || null, ok: !!r.decision_id };
    } catch {
      await recordDecisionEvent('config_change', { trigger_context: ctx });
      return { decisionId: null, ok: true };
    }
  },
};

export function createApprovalFlowRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const handlers = {
    list: async (req, res) => {
      try {
        const me = resolveMe(req);
        const flows = await D.listFlows(me);
        res.json({ flows });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    get: async (req, res) => {
      try {
        const me = resolveMe(req);
        const flow = await D.getFlow(req.params.id, me);
        if (!flow) return res.status(404).json({ error: '审批流不存在' });
        res.json({ flow });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const me = resolveMe(req);
        const { flow_id, name, description, stages, enabled } = req.body || {};
        if (!flow_id || !name) return res.status(400).json({ error: 'flow_id / name 必填' });
        if (!validateStages(stages)) return res.status(400).json({ error: 'stages 必须为 [{stage,role,action}] 数组' });
        const decision = await D.produceDecision({ flow_id, name });
        const flow = await D.upsertFlow({ flow_id, name, description, stages, enabled }, me);
        res.json({ ok: true, flow, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/approval-flows', handlers.list);
  router.get('/api/approval-flows/:id', handlers.get);
  router.put('/api/approval-flows/:id', handlers.put);
  router.handlers = handlers; // 注入式测试（无 delete）
  return router;
}
