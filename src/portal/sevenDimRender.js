// sevenDimRender.js — S20 七维矩阵渲染（浏览器 ESM；零服务端 import）
// 硬约束：/sevenDimensions/* 未被静态托管，禁止 import constants.js（会 404 致整页脚本不执行）。
// 维度定义由 GET /api/config/seven-dim 的 dims 字段下发；本地 SEVEN_KEYS 仅用于校验，
// 与引擎 constants.DIM_KEYS 的一致性由 test/portal/sevenDimRender.test.js parity 断言守卫。
export const SEVEN_KEYS = ['identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance'];
export const SEVEN_LABELS = {
  identity: '身份', structure: '结构', semantics: '语义',
  time_config: '时间', decision_history: '决策史', operational_state: '运行态', governance: '治理',
};
export const ON_MISSING = ['warn', 'block'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// required_dims([{dim,on_missing}]) → {dim: on_missing}；非法/缺失 on_missing 降级 'warn'
export function toDimMap(requiredDims) {
  const m = {};
  if (!Array.isArray(requiredDims)) return m;
  for (const d of requiredDims) {
    if (d && typeof d.dim === 'string') m[d.dim] = ON_MISSING.includes(d.on_missing) ? d.on_missing : 'warn';
  }
  return m;
}

// {dim: on_missing} → required_dims[]；空串/非法值视为「未要求」
export function toRequiredDims(map = {}) {
  return SEVEN_KEYS
    .filter((k) => ON_MISSING.includes(map[k]))
    .map((k) => ({ dim: k, on_missing: map[k] }));
}

export function validateRequiredDimsPatch(requiredDims) {
  if (!Array.isArray(requiredDims)) return { ok: false, errors: ['required_dims 须为数组'] };
  const seen = new Set();
  const errors = [];
  const normalized = [];
  for (const d of requiredDims) {
    if (!d || typeof d.dim !== 'string' || !SEVEN_KEYS.includes(d.dim)) {
      errors.push(`未知维度: ${d?.dim}（仅 ${SEVEN_KEYS.join('/')}）`);
      break;
    }
    if (seen.has(d.dim)) { errors.push(`维度重复: ${d.dim}`); break; }
    seen.add(d.dim);
    const om = d.on_missing || 'warn';
    if (!ON_MISSING.includes(om)) { errors.push(`${d.dim} 的 on_missing 须为 ${ON_MISSING.join('/')}`); break; }
    normalized.push({ dim: d.dim, on_missing: om });
  }
  return { ok: errors.length === 0, errors, normalized };
}

export function renderSevenDimMatrix({ dims = [], scenarios = [], default_strictness = 'warn' } = {}) {
  const cols = dims.length ? dims : SEVEN_KEYS.map((k) => ({ key: k, label: SEVEN_LABELS[k] || k, desc: '' }));
  const head = cols.map((d) => `<th title="${esc(d.desc || '')}">${esc(d.label || d.key)}</th>`).join('');

  const rows = (scenarios || []).map((s) => {
    const m = toDimMap(s.required_dims);
    const cells = cols.map((d) => {
      const cur = m[d.key] || '';
      const opts = [`<option value="">—</option>`]
        .concat(ON_MISSING.map((o) => `<option value="${o}" ${cur === o ? 'selected' : ''}>${o}</option>`))
        .join('');
      return `<td><select data-dim="${esc(d.key)}">${opts}</select></td>`;
    }).join('');
    const auto = s.autonomous_allowed ? '自主' : '人工';
    return `<tr data-id="${esc(s.scenario_id)}">
      <th scope="row">${esc(s.stage || s.scenario_id)} <span class="tier">${esc(s.default_tier || '')}</span> <span class="auto">${auto}</span></th>
      ${cells}
      <td><button class="btn save" data-id="${esc(s.scenario_id)}">保存</button></td>
    </tr>`;
  }).join('');

  const emptyHint = (scenarios || []).length ? '' : '<p class="empty">暂无决策场景</p>';
  const strictOpts = ON_MISSING
    .map((o) => `<option value="${o}" ${default_strictness === o ? 'selected' : ''}>${o}</option>`)
    .join('');

  return `<div class="sd7-global">
      <label>全局默认严格度</label>
      <select id="sd7-strict">${strictOpts}</select>
      <button class="btn" id="sd7-strict-save">保存</button>
    </div>
    ${emptyHint}
    <table id="sd7-matrix"><thead><tr><th>场景 / 阶段</th>${head}<th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

// T22 边绑定页签：E1–E7 × 维度 绑定矩阵（每条边选其服务的 1..n 个维度；direction 固定注释展示）
// 输入 edgeBindings: [{edge_type, serves_dimension:[...], direction}]；输出完整 HTML 段落（可内嵌于页签容器）
export function renderEdgeBindings({ edgeBindings = [], dims = [] } = {}) {
  const dimKeys = dims.length ? dims.map((d) => d.key) : SEVEN_KEYS;
  const dimLabels = {};
  for (const d of dims) dimLabels[d.key] = d.label || SEVEN_LABELS[d.key] || d.key;
  const rows = (edgeBindings || []).map((b) => {
    const dimOpts = dimKeys.map((k) => {
      const checked = Array.isArray(b.serves_dimension) && b.serves_dimension.includes(k) ? ' checked' : '';
      return `<label class="eb-dim"><input type="checkbox" data-edge="${esc(b.edge_type)}" data-dim="${esc(k)}"${checked}>${esc(dimLabels[k] || k)}</label>`;
    }).join('');
    return `<tr data-edge="${esc(b.edge_type)}"><th scope="row">${esc(b.edge_type)}</th><td class="eb-dims">${dimOpts}</td><td class="muted">${esc(b.direction || '')}</td></tr>`;
  }).join('');
  return `<section class="panel sd7-eb">
    <h3>边↔维度绑定（T22/T32）</h3>
    <p class="muted">E1–E7 决策边各服务 1..n 个维度；勾选后保存（经第0闸写 config_store['seven-dim'].edge_bindings）</p>
    <table id="sd7-eb-matrix"><thead><tr><th>决策边</th><th>服务维度</th><th>方向</th></tr></thead><tbody>${rows}</tbody></table>
    <button class="btn" id="sd7-eb-save">保存边绑定</button>
  </section>`;
}

// T22 归因阈值块：归因判定阈值可视化调整（default_input_stale_ms + 三开关）
// 输入 thresholds: { default_input_stale_ms, field_mismatch_enabled, info_incomplete_enabled, input_stale_enabled }
export function renderRootCauseThresholds({ thresholds = {} } = {}) {
  const ms = typeof thresholds.default_input_stale_ms === 'number' ? thresholds.default_input_stale_ms : 24 * 3600 * 1000;
  const hours = ms / 3600_000;
  const chk = (k) => (thresholds[k] === false ? '' : ' checked');
  return `<section class="panel sd7-rc">
    <h3>归因阈值（T22/T32）</h3>
    <p class="muted">全局兜底时效（粒子无 source_refresh_sla 时 INPUT_STALE 判定用）+ 三检开关</p>
    <div class="sd7-rc-row"><label>兜底时效（小时）</label><input id="sd7-rc-hours" type="number" min="0" step="0.5" value="${esc(hours)}"></div>
    <div class="sd7-rc-row"><label><input type="checkbox" id="sd7-rc-field"${chk('field_mismatch_enabled')}>字段不一致检</label></div>
    <div class="sd7-rc-row"><label><input type="checkbox" id="sd7-rc-info"${chk('info_incomplete_enabled')}>信息不完整检</label></div>
    <div class="sd7-rc-row"><label><input type="checkbox" id="sd7-rc-stale"${chk('input_stale_enabled')}>输入不及时检</label></div>
    <button class="btn" id="sd7-rc-save">保存归因阈值</button>
  </section>`;
}

// T22：从 DOM 收集边绑定勾选 → {edge_type, serves_dimension[], direction}（供 PUT）
export function collectEdgeBindingsFromDom(root) {
  const map = {};
  for (const cb of (root || document).querySelectorAll('#sd7-eb-matrix input[type=checkbox]')) {
    const edge = cb.dataset.edge;
    if (!edge) continue;
    if (!map[edge]) map[edge] = [];
    if (cb.checked) map[edge].push(cb.dataset.dim);
  }
  return Object.entries(map).map(([edge_type, serves_dimension]) => ({
    edge_type,
    serves_dimension: serves_dimension.length ? serves_dimension : ['identity'], // 空选 fallback 主维（validate 需每边≥1维）
    direction: 'decision->entity',
  }));
}

// T22：从 DOM 收集归因阈值 → {default_input_stale_ms, 三开关}（供 PUT）
export function collectRootCauseThresholdsFromDom(root) {
  const hoursEl = (root || document).querySelector('#sd7-rc-hours');
  const hours = hoursEl ? Number(hoursEl.value) : 24;
  const numH = Number.isFinite(hours) && hours >= 0 ? hours : 24;
  return {
    default_input_stale_ms: Math.round(numH * 3600_000),
    field_mismatch_enabled: (root || document).querySelector('#sd7-rc-field')?.checked !== false,
    info_incomplete_enabled: (root || document).querySelector('#sd7-rc-info')?.checked !== false,
    input_stale_enabled: (root || document).querySelector('#sd7-rc-stale')?.checked !== false,
  };
}