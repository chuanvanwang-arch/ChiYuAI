// src/portal/rbacMatrix.js — RBAC 矩阵配置（第 13 项）
// 渲染纯函数（浏览器 + vitest 共用） + 表驱动 GET/PUT 端点（决策第0闸）
// 设计输入：docs/superpowers/plans/2026-08-27-rbac-matrix.md
// 载体：crm.role_context_profile.data_scope {model:'self'|'org_subtree'|'all'|'domain', domain?:[...]}
// 引擎 enforceScope(src/context/scope.js:81) 比对 data_scope.domain vs 粒子 type(全名 CRM_*)
import { Router } from 'express';
import { query } from '../db.js';
import { requireDecision, decisionIdOf } from '../decision/autonomyEngine.js';
import { recordDecisionEvent } from '../decision/decisionRepo.js';

// 业务可授权粒子（矩阵列，canonical CRM_* 名）
export const BUSINESS_PARTICLES = [
  'CRM_DEAL',
  'CRM_QUOTATION',
  'CRM_CONTRACT',
  'CRM_ORDER',
  'CRM_PAYMENT_PLAN',
  'CRM_PAYMENT_RECORD',
  'CRM_INVOICE',
  'CRM_TECHNICAL_PROPOSAL',
  'CRM_ACCOUNT',
  'CRM_CONTACT',
  'CRM_ORGANIZATION',
  'CRM_PERSON',
];

// 已知短别名 → canonical（修正种子历史不一致 payment/contract/invoice）
const DOMAIN_ALIAS = {
  payment: 'CRM_PAYMENT_RECORD',
  contract: 'CRM_CONTRACT',
  invoice: 'CRM_INVOICE',
  deal: 'CRM_DEAL',
  quotation: 'CRM_QUOTATION',
  order: 'CRM_ORDER',
  account: 'CRM_ACCOUNT',
  contact: 'CRM_CONTACT',
  organization: 'CRM_ORGANIZATION',
};

export function normalizeDomainEntry(s) {
  if (!s) return s;
  if (typeof s === 'string' && s.startsWith('CRM_')) return s;
  return DOMAIN_ALIAS[s.toLowerCase()] || s;
}

export function normalizeDomain(domain = []) {
  return (domain || []).map(normalizeDomainEntry);
}

export function scopeModelLabel(model) {
  switch (model) {
    case 'self': return '仅自身';
    case 'org_subtree': return '组织内';
    case 'all': return '全量';
    case 'domain': return '按域';
    default: return model || '—';
  }
}

// 返回单元格三态：'all'（全量禁用）| 'na'（不适用 self/org_subtree）| 'on'（domain 勾选）| 'off'（domain 未勾）
export function cellState(profile, particle) {
  const ds = profile?.data_scope || {};
  const model = ds.model;
  if (model === 'all') return 'all';
  if (model === 'self' || model === 'org_subtree') return 'na';
  if (model === 'domain') {
    const allowed = normalizeDomain(ds.domain);
    return allowed.includes(particle) ? 'on' : 'off';
  }
  return 'na';
}

function cellHtml(profile, particle) {
  const st = cellState(profile, particle);
  if (st === 'all') return `<td class="cell all"><span class="badge ok" title="全量可见可操作">✓</span></td>`;
  if (st === 'na') return `<td class="cell na"><span class="badge na" title="不适用于此范围模型">⚪</span></td>`;
  // domain：可勾选
  const checked = st === 'on' ? 'checked' : '';
  return `<td class="cell onoff">
    <input type="checkbox" class="domain-chk" data-particle="${particle}" ${checked}
      title="${st === 'on' ? '在授权域内' : '不在授权域内'}" />
  </td>`;
}

export function renderRbacMatrix(profiles = [], particles = BUSINESS_PARTICLES) {
  const list = profiles.length ? profiles : [];
  if (!list.length) {
    return `<div class="empty">尚未配置任何角色数据范围（role_context_profile.data_scope）</div>`;
  }
  const headCols = particles.map((p) => `<th class="pcol" title="${p}">${p.replace('CRM_', '')}</th>`).join('');
  const ths = `<thead><tr><th>角色</th><th>范围模型</th>${headCols}</tr></thead>`;
  const trs = list
    .map((p) => {
      const ds = p.data_scope || {};
      const model = ds.model || 'self';
      const cells = particles.map((pt) => cellHtml(p, pt)).join('');
      const disabledAttr = model === 'all' ? 'disabled' : '';
      return `<tr class="rbac-row" data-role="${p.role_tag}">
        <td class="role">${p.role_tag}</td>
        <td class="model">
          <select class="model-sel" data-role="${p.role_tag}" ${disabledAttr}>
            <option value="self" ${model === 'self' ? 'selected' : ''}>仅自身</option>
            <option value="org_subtree" ${model === 'org_subtree' ? 'selected' : ''}>组织内</option>
            <option value="all" ${model === 'all' ? 'selected' : ''}>全量</option>
            <option value="domain" ${model === 'domain' ? 'selected' : ''}>按域</option>
          </select>
        </td>
        ${cells}
      </tr>`;
    })
    .join('');
  return `<table class="rbac-table">${ths}<tbody>${trs}</tbody></table>`;
}

// ---- 端点 ----
const defaultDeps = {
  listProfiles: async () => {
    const r = await query(
      `SELECT role_tag, data_scope FROM crm.role_context_profile ORDER BY role_tag`
    );
    return r.rows;
  },
  upsertProfile: async (role_tag, data_scope) => {
    const r = await query(
      `INSERT INTO crm.role_context_profile (role_tag, seven_elements, data_scope, retrieval_cfg)
       VALUES ($1,
         COALESCE((SELECT seven_elements FROM crm.role_context_profile WHERE role_tag=$1), '{}'::jsonb),
         $2::jsonb,
         COALESCE((SELECT retrieval_cfg FROM crm.role_context_profile WHERE role_tag=$1), '{}'::jsonb))
       ON CONFLICT (role_tag) DO UPDATE SET data_scope=$2::jsonb, updated_at=now()
       RETURNING role_tag, data_scope`,
      [role_tag, JSON.stringify(data_scope)]
    );
    return r.rows[0];
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

export function createRbacRouter(deps = {}) {
  const D = { ...defaultDeps, ...deps };
  const router = Router();

  const handlers = {
    get: async (req, res) => {
      try {
        const profiles = await D.listProfiles();
        res.json({ profiles, particles: BUSINESS_PARTICLES });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    },
    put: async (req, res) => {
      try {
        const { role_tag, model, domain } = req.body || {};
        if (!role_tag || !model) {
          return res.status(400).json({ error: 'role_tag / model 必填' });
        }
        const models = ['self', 'org_subtree', 'all', 'domain'];
        if (!models.includes(model)) {
          return res.status(400).json({ error: `model 必须为 ${models.join(' / ')}` });
        }
        const data_scope =
          model === 'domain'
            ? { model, domain: normalizeDomain(domain || []) }
            : { model };
        const decision = await D.produceDecision({ role_tag, model });
        const row = await D.upsertProfile(role_tag, data_scope);
        res.json({ ok: true, row, decision: decision?.decisionId || null });
      } catch (e) {
        res.status(400).json({ error: e.message });
      }
    },
  };

  router.get('/api/rbac', handlers.get);
  router.put('/api/rbac', handlers.put);
  router.handlers = handlers; // 注入式测试
  return router;
}
