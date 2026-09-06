// src/portal/approvalFlowRender.js — approvalFlowRender.js 渲染纯函数子模块（浏览器 ESM 可加载）
// 根因修复（2026-08-27）：源 approvalFlow.js 顶层含 Node-only import
// （express / ../db.js / ../decision/* / ../alerts/*）→ 浏览器原生 ESM 加载报
// "Failed to resolve module specifier 'express'" → 页面脚本崩溃（列表不渲染/按钮不绑定）。
// 本文件仅含渲染纯函数（零服务端 import），浏览器与 vitest 均可直接 import。
// 服务端 router 仍保留在 approvalFlow.js（routes.js 继续 import 它）；页面 import 改指向本文件。

// src/portal/approvalFlow.js — 审批流配置（第 17 项）
// 渲染纯函数（浏览器 + vitest 共用）+ 表驱动 GET/PUT 端点（决策第0闸）
// 数据后端：crm.approval_flow（db/migrate-config.sql:26）；与引擎粒子模型（CRM_APPROVAL_*）脱节属已知限制（spec §0.3/§10）

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
  if (!flows.length) return `<div class="empty">尚未配置任何审批流（crm.approval_flow）</div>`;
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
