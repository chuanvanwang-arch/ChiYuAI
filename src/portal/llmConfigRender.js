// llmConfigRender.js — LLM 配置（第 11 项）渲染纯函数子模块
// 零服务端 import（浏览器 ESM 可加载）。写经 configRouter 第0闸（后端）。
export const LLM_FIELDS = ['provider', 'model', 'temp', 'api_key'];
const PROVIDERS = ['siliconflow', 'deepseek', 'openai', 'azure'];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function validateLlmPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !LLM_FIELDS.includes(k));
  if (unknown.length) return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${LLM_FIELDS.join('/')}）`] };
  if (!keys.length) return { ok: false, errors: ['无有效字段'] };
  const errors = [];
  const n = {};
  if ('provider' in patch) {
    if (!PROVIDERS.includes(patch.provider)) errors.push(`provider 须为 ${PROVIDERS.join('/')}`);
    else n.provider = patch.provider;
  }
  if ('model' in patch) {
    if (typeof patch.model !== 'string' || !patch.model.trim() || patch.model.length > 128) errors.push('model 须为 1–128 字字符串');
    else n.model = patch.model.trim();
  }
  if ('temp' in patch) {
    const t = patch.temp;
    if (typeof t !== 'number' || !isFinite(t) || t < 0 || t > 2) errors.push('temp 须为 0–2 的数值');
    else n.temp = t;
  }
  // api_key：可选（不填则保留既有）；填写则须非空、不过长（明文不回显，仅服务端加密）
  if ('api_key' in patch) {
    if (patch.api_key === '' || patch.api_key == null) {
      // 空 → 不更新（保留既有，由后端 secretFields 逻辑处理）
    } else if (typeof patch.api_key !== 'string' || patch.api_key.length > 512) {
      errors.push('api_key 须为不超过 512 字字符串');
    } else {
      n.api_key = patch.api_key;
    }
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

export function renderLlmForm(v) {
  if (!v) return '<div class="empty">LLM 配置未配置（首次 PUT 后生效）</div>';
  const sel = (cur) => PROVIDERS.map((p) => `<option value="${p}" ${cur === p ? 'selected' : ''}>${p}</option>`).join('');
  const hasKey = !!v.api_key;
  return `<form id="llmf">
    <div class="status">状态：<b>已启用</b>（provider=${esc(v.provider || '?')} model=${esc(v.model || '?')}）</div>
    <label>Provider</label><select name="provider">${sel(v.provider)}</select>
    <label>Model</label><input name="model" value="${esc(v.model || '')}" maxlength="128" />
    <label>Temperature</label><input name="temp" type="number" step="0.1" min="0" max="2" value="${esc(v.temp ?? 0.7)}" />
    <label>API 密钥${hasKey ? '（已配置，留空保留）' : '（加密存储）'}</label><input name="api_key" type="password" autocomplete="off" placeholder="${hasKey ? '********' : 'sk-...'}" />
    <button class="btn" type="submit">保存</button>
  </form>`;
}