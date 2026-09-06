// src/portal/ontologyConfigRender.js — 粒子模型/本体/词汇配置（22 项）渲染纯函数子模块
// QA 根因 A（混合模块浏览器 ESM 崩溃）教训：本文件零服务端 import，浏览器可原生加载。
// 服务端 Router/依赖在 ontologyConfig.js（defaultDeps+createOntologyRouter），渲染与路由严格分文件。
//
// 修复（2026-08-29 ontology 卡死根因）：
//   历史版本第 5 行 `import { PARTICLE_TYPES, SEMANTIC_TAGS, ATTRIBUTE_TYPE_SET } from '../particles/particleModel.js'`
//   在浏览器 ESM 解析时把相对路径解析为 http://localhost:3000/particles/particleModel.js，
//   该路径无路由 → 404 → 整个 module 加载失败 → ontology.html 内联 <script type="module">
//   顶层抛错阻断后续代码 → 页面永远停留在 HTML 初始 fallback「加载中…」。
//   现版本：所有服务端事实源由调用方（ontologyConfig.js）经 API / model 参数注入，
//   本文件**零 import**，浏览器可原生加载。事实源粒子模型仍唯一在 `src/particles/particleModel.js`。

// 词汇写入/编辑 payload 校验（白名单字段；term 必填、≤120；state 枚举；未知字段拒绝）
export const VOCAB_EDITABLE_FIELDS = ['term', 'type', 'layer', 'state'];
export const VOCAB_STATES = ['ACTIVE', 'INACTIVE'];

export function validateVocabularyPatch(patch = {}) {
  const keys = Object.keys(patch || {});
  const unknown = keys.filter((k) => !VOCAB_EDITABLE_FIELDS.includes(k));
  if (unknown.length) {
    return { ok: false, errors: [`不可编辑字段: ${unknown.join(', ')}（仅 ${VOCAB_EDITABLE_FIELDS.join('/')} 可改）`] };
  }
  if (!keys.length) return { ok: false, errors: ['无有效编辑字段'] };
  const errors = [];
  const n = {};
  if ('term' in patch) {
    if (typeof patch.term !== 'string' || !patch.term.trim()) errors.push('term 必填非空字符串');
    else if (patch.term.length > 120) errors.push('term 须为 ≤120 字字符串');
    else n.term = patch.term.trim();
  }
  if ('type' in patch) {
    if (typeof patch.type !== 'string' || !patch.type.trim()) errors.push('type 须为非空字符串');
    else if (patch.type.length > 64) errors.push('type 须为 ≤64 字字符串');
    else n.type = patch.type.trim();
  }
  if ('layer' in patch) {
    if (typeof patch.layer !== 'string' || !patch.layer.trim()) errors.push('layer 须为非空字符串');
    else n.layer = patch.layer.trim();
  }
  if ('state' in patch) {
    if (!VOCAB_STATES.includes(patch.state)) errors.push(`state 须为 ${VOCAB_STATES.join('/')}`);
    else n.state = patch.state;
  }
  return { ok: errors.length === 0, errors, normalized: n };
}

// —— 纯函数：renderVocabulary ——
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderVocabulary(vocab = []) {
  if (!vocab.length) return '<div class="empty">无词汇</div>';
  const sorted = [...vocab].sort((a, b) => {
    const sa = a.state === 'ACTIVE' ? 0 : 1;
    const sb = b.state === 'ACTIVE' ? 0 : 1;
    return sa - sb || String(a.term || '').localeCompare(String(b.term || ''), 'zh');
  });
  const rows = sorted
    .map(
      (v) => `<tr data-id="${esc(v.id || '')}">
        <td>${esc(v.term || '')}</td>
        <td>${esc(v.type || '业务术语')}</td>
        <td>${esc(v.layer || 'L1')}</td>
        <td><span class="badge ${v.state === 'ACTIVE' ? 'ok' : 'off'}">${esc(v.state === 'ACTIVE' ? '启用' : '停用')}</span></td>
        <td><button class="btn edit" data-id="${esc(v.id || '')}">编辑</button></td>
      </tr>`
    )
    .join('');
  return `<table class="vocab-tbl"><thead><tr><th>词汇</th><th>类型</th><th>分层</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${rows}</tbody></table>`;
}

// —— 纯函数：renderModelSnapshot ——
// 9 真粒子 + 6 语义标签 + 19 属性类型（模型只读快照渲染，事实由 model 入参注入）
// 9 真粒子主集（C0-C4 收敛的业务主粒子）；其余为商机链/审批流/方法论证据衍生粒子（同表全量 29，事实源 = particleModel.js）
// view-only 常量：标识"真粒子"高亮标签用，与服务端事实源解耦（事实源 = particleModel.js）
export const CORE_PARTICLE_IDS = [
  'CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT', 'CRM_PRODUCT', 'CRM_PRICE_LIST',
  'CRM_PERSON', 'CRM_ORGANIZATION', 'CRM_KNOWLEDGE', 'CRM_UNSTRUCTURED_ASSET',
];

// PARTICLE_MODEL 的服务端组装迁至 ontologyConfig.js（事实源唯一，由服务端 import 粒子后注入 API）
// 浏览器侧 render 函数：所有事实由调用方 model 入参注入，不再依赖任何 import。

export function renderModelSnapshot(model = PARTICLE_MODEL) {
  const types = Object.entries(model.particleTypes || {});
  const cards = types
    .map(
      ([t, def]) => {
        const core = (model.coreParticleIds || []).includes(t);
        return `<article class="model-card${core ? ' core' : ''}" data-type="${esc(t)}">
          <h4>${esc(t)}${core ? ' <span class="badge ok">真粒子</span>' : ''}</h4>
          <p class="model-meta">${esc(def.title || '')} · 态流 ${esc((def.states?.flow || []).join('→') || '—')}</p>
          <p class="model-attrs">${esc(Object.keys(def.coreAttributes || {}).join(', ') || '（无核心属性）')}</p>
        </article>`;
      }
    )
    .join('');
  const tags = Object.entries(model.semanticTags || {})
    .map(([tag, attrs]) => `<span class="tag">${esc(tag)}(${attrs.length})</span>`)
    .join('');
  return `<section class="model-panel">
    <h3>粒子模型（9 真粒子）</h3>
    <div class="model-grid">${cards}</div>
    <h3>语义标签（${Object.keys(model.semanticTags || {}).length} 组）</h3>
    <div class="model-tags">${tags}</div>
    <h3>属性类型集（${model.attributeTypeSet?.length || 0} 种）</h3>
    <p class="model-attrs">${esc((model.attributeTypeSet || []).join(' · '))}</p>
  </section>`;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'vocab';
}
