// src/portal/skillRegistryRender.js — 方法论 SKILL 注册表 渲染纯函数子模块（第 16 项）
// 零服务端 import（浏览器 ESM 可加载；写经后端 skillRegistry Router 第0闸）。
// 契约：GET /api/config/skill-registry → {skills:[{skill_id,category,enabled,rbac_roles,methodology_id,source}],total}
export const SKILL_STATUS_BADGE = {
  ready: { icon: '✅', label: '已启用', cls: 'ok' },
  disabled: { icon: '⛔', label: '已停用', cls: 'off' },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 启停切换校验（对齐后端契约：{skill_id, enabled}；enabled 必须布尔）
export function validateSkillToggle(patch = {}) {
  if (!patch.skill_id || typeof patch.skill_id !== 'string') {
    return { ok: false, errors: ['skill_id 必填字符串'] };
  }
  if (typeof patch.enabled !== 'boolean') {
    return { ok: false, errors: ['enabled 必填布尔'] };
  }
  return { ok: true, errors: [] };
}

// 头部（总数 + 已启用计数）
export function renderSkillRegistryHeader({ total = 0, enabledCount = 0 } = {}) {
  return `<div class="sreg-head">
    <p>SKILL 总数 <b>${total}</b> · <span class="sreg-cnt">enabledCount=${enabledCount}</span> · 启停经决策第0闸+sysadmin，禁删只改 enabled</p>
  </div>`;
}

// 表格：skill_id/category/enabled 开关/rbac_roles/methodology_id/source
export function renderSkillRegistryTable(rows = []) {
  if (!rows.length) return '<div class="empty">SKILL 注册表为空（未种子）</div>';
  const trs = rows.map((r) => {
    const badge = r.enabled ? SKILL_STATUS_BADGE.ready : SKILL_STATUS_BADGE.disabled;
    return `<tr data-skill="${esc(r.skill_id)}">
      <td>${esc(r.skill_id)}</td>
      <td>${esc(r.category)}</td>
      <td>${badge?.['icon']} <span class="badge ${badge?.['cls']}">${badge?.['label']}</span></td>
      <td><label class="sreg-toggle"><input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''} /> 启用</label></td>
      <td>${esc((r.rbac_roles || []).join(','))}</td>
      <td>${esc(r.methodology_id || '—')}</td>
      <td>${r.source === 'db' ? 'DB' : 'SKILL'}</td>
    </tr>`;
  }).join('');
  return `<table class="sreg-table">
    <thead><tr><th>skill_id</th><th>category</th><th>状态</th><th>启停</th><th>rbac_roles</th><th>methodology_id</th><th>来源</th></tr></thead>
    <tbody>${trs}</tbody>
  </table>`;
}