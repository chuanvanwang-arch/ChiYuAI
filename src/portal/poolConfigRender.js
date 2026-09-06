// poolConfigRender.js — 池配置（第 20 项）渲染纯函数子模块
// 零服务端 import。线索池/商机池 pick/recycle 规则（setPoolConfig 后端持久化）。
export const POOL_KEYS = ['pickRule', 'recycleAfterDays'];
const PICK_RULES = ['oldest', 'newest', 'random', 'priority'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function validatePoolPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !POOL_KEYS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${POOL_KEYS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('pickRule' in patch) {
    if (!PICK_RULES.includes(patch.pickRule)) errors.push(`pickRule 须为 ${PICK_RULES.join('/')}`);
    else n.pickRule = patch.pickRule;
  }
  if ('recycleAfterDays' in patch) {
    const d = patch.recycleAfterDays;
    if (!Number.isInteger(d) || d < 1 || d > 3650) errors.push('recycleAfterDays 须为 1–3650 的整数（天）');
    else n.recycleAfterDays = d;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

export function renderPoolForm(v = {}) {
  if (!v || !Object.keys(v).length) return '<div class="empty">池配置未设置（getPoolConfig 幂等补默认）</div>';
  const sel = (cur) => PICK_RULES.map((p) => `<option value="${p}" ${cur === p ? 'selected' : ''}>${p}</option>`).join('');
  return `<form id="poolf">
    <label>领取规则</label><select name="pickRule">${sel(v.pickRule)}</select>
    <label>回收天数</label><input name="recycleAfterDays" type="number" min="1" max="3650" value="${esc(v.recycleAfterDays ?? 30)}" />
    <button class="btn" type="submit">保存</button>
  </form>`;
}