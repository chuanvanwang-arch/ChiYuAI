// poolConfigRender.js — 池配置（第 20 项）渲染纯函数子模块
// 零服务端 import。三类池（new/nurture/lost）每租户一套，字段与引擎消费键严格对齐。
// 2026-09-11 修复：原 POOL_KEYS = ['pickRule','recycleAfterDays'] 与引擎实际消费的
//   daily_limit/pick_interval_hours/prev_owner_only/new_data_only 完全不对齐 → 页面改的键引擎不认。

// 引擎消费键（src/sales/pool.js checkPickRule / checkRecycleRule）——页面只能用这些键
export const POOL_KEYS = [
  'daily_limit', 'pick_interval_hours', 'prev_owner_only', 'new_data_only', 'recycle_days',
];

const POOL_LABEL = { new: '新线索公海', nurture: '培育公海', lost: '战败回收公海' };

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 校验并归一化单池规则补丁（纯函数）
export function validatePoolPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !POOL_KEYS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${POOL_KEYS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('daily_limit' in patch) {
    const v = Number(patch.daily_limit);
    if (!Number.isInteger(v) || v < 1 || v > 999) errors.push('daily_limit 须为 1–999 的整数');
    else n.daily_limit = v;
  }
  if ('pick_interval_hours' in patch) {
    const v = Number(patch.pick_interval_hours);
    if (!Number.isInteger(v) || v < 0 || v > 720) errors.push('pick_interval_hours 须为 0–720 的整数（小时）');
    else n.pick_interval_hours = v;
  }
  if ('prev_owner_only' in patch) {
    if (typeof patch.prev_owner_only !== 'boolean') errors.push('prev_owner_only 须为布尔');
    else n.prev_owner_only = patch.prev_owner_only;
  }
  if ('new_data_only' in patch) {
    if (typeof patch.new_data_only !== 'boolean') errors.push('new_data_only 须为布尔');
    else n.new_data_only = patch.new_data_only;
  }
  if ('recycle_days' in patch) {
    const v = Number(patch.recycle_days);
    if (!Number.isInteger(v) || v < 1 || v > 3650) errors.push('recycle_days 须为 1–3650 的整数（天）');
    else n.recycle_days = v;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// 三池 TAB（纯函数）：每个 TAB 一组规则输入，data-pool 供前端取池 id 回写
export function renderPoolTabs(v = {}) {
  const pools = Array.isArray(v.pools) ? v.pools : [];
  const badge = v._seeded
    ? '<span class="badge" title="该配置克隆自平台模板，保存后由本租户自持">继承自平台模板</span>'
    : '';
  if (!pools.length) return `<div class="empty">池配置未设置（readPoolConfig 兜底默认三池）</div>${badge}`;
  const tabs = pools.map((p, i) => {
    const pr = p.pick_rule || {};
    const rr = p.recycle_rule || {};
    return `<section class="pool-tab" data-pool="${esc(p.id)}" data-type="${esc(p.type)}" ${i === 0 ? '' : 'hidden'}>
      <h4>${esc(p.label || POOL_LABEL[p.type] || p.id)} <code>${esc(p.id)}</code></h4>
      <label>每日领取上限</label>
      <input name="daily_limit" type="number" min="1" max="999" value="${esc(pr.daily_limit ?? 10)}" />
      <label>领取间隔（小时）</label>
      <input name="pick_interval_hours" type="number" min="0" max="720" value="${esc(pr.pick_interval_hours ?? 0)}" />
      <label>限前归属人领取</label>
      <input name="prev_owner_only" type="checkbox" ${pr.prev_owner_only ? 'checked' : ''} />
      <label>限新数据</label>
      <input name="new_data_only" type="checkbox" ${pr.new_data_only ? 'checked' : ''} />
      <label>超期回收天数</label>
      <input name="recycle_days" type="number" min="1" max="3650" value="${esc(rr.recycle_days ?? 30)}" />
      <button class="btn" type="button" data-save="${esc(p.id)}">保存本池</button>
    </section>`;
  }).join('');
  const nav = pools.map((p, i) =>
    `<button class="tab-btn${i === 0 ? ' active' : ''}" data-target="${esc(p.id)}">${esc(p.label || POOL_LABEL[p.type] || p.id)}</button>`
  ).join('');
  return `<div class="pool-cfg">${badge}<nav class="tabs">${nav}</nav>${tabs}</div>`;
}
