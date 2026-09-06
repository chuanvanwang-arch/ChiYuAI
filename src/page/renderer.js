// src/page/renderer.js — 运行时渲染器（唯一渲染出口，Schema 唯一输入，绝不执行任意代码）
// 设计输入：ai-portal-page-generation 三段式③；三层护栏③渲染层；AI 原生 UI 铁律 R5 四态 + R6 样式契约
//          + docs/2026-08-26-frontend-config-pages-master-blueprint.md §2.5.1（渲染期四查徽标）
// 输出 {html, warnings[]}；强制：动态值转义、交互仅 data-action 声明式、输出无 <script>
import { validatePageSchema } from './validator.js';
import { SOURCE_LABELS } from '../web/sourceClassify.js';

// 字段名 → 中文标签字典（受控面表格列头/属性键可读化；未知键原样回退，绝不丢信息）
// 设计输入：配置中心（S16–S33）表格 columns 原用技术 slug（provider/model/tier/...），
//           用户在页面市场预览/实际数据加载时看到的是机器可读键 → 统一在此映射为业务语言。
export const FIELD_LABELS = {
  // 通用
  id: 'ID', name: '名称', title: '标题', type: '类型', kind: '类型', status: '状态',
  role: '角色', stage: '阶段', amount: '金额', weight: '权重', version: '版本',
  // 2026-09-03：客户洞察页时间线表头原直出英文 slug「source」（FIELD_LABELS 缺该键 → 回退原文）
  source: '来源', ts: '时间', actor: '执行者', precedent: '先例', decision: '决策', task: '任务',
  // 2026-09-03：「决策执行足迹」新增列 — suggested/confidence/event/tier 直出英文时业务读者看不懂
  suggested: 'AI 建议', confidence: '置信度', event: '事件', scenario: '场景',
  // tier 上面 S23 已映射为「分级」，actual 上面已映射为「实际」，合并沿用
  deal: '事项', customer: '客户', contact: '联系人', due: '时限', action: '动作',
  category: '类别', domain: '领域', created_at: '创建时间', updated_at: '更新时间',
  // LLM 配置 S16
  provider: '提供商', model: '模型', temperature: '温度', enabled: '是否启用',
  api_key: 'API 密钥', max_tokens: '最大 Tokens',
  // 用户/智能体 S17/S28
  username: '用户名', display_name: '显示名', agent_id: '智能体ID',
  // 权限 S18
  particle: '粒子', action: '动作', perm: '权限',
  // 决策场景 S19
  scenario_name: '场景名称', scenario_id: '场景ID', scenario: '场景',
  trigger: '触发条件', auto_decision: '自主决策', methodology_ids: '方法论',
  // 自主决策治理 S20
  identity: '身份', structure: '结构', semantics: '语义', time_config: '时间配置',
  decision_history: '决策历史', operational_state: '运行状态', governance: '治理', strictness: '严格度',
  // 方法论 SKILL S21
  skill_id: '技能ID', rbac_roles: 'RBAC角色',
  // 审批流 S22
  flow_id: '流程ID',
  // 业务分级 S23
  tier: '分级', customer_dim: '客户维度', project_dim: '项目维度', autonomy_level: '自主级别',
  // 粒子元模型 S24
  particle_type: '粒子类型', attr_count: '属性数',
  // 预警规则 S26
  rule_id: '规则ID', channel: '渠道', severity: '严重度',
  // 本体词表 S27
  term: '术语', synonym: '同义词', embedding_ref: '向量引用',
  // 页面注册 S29
  page_id: '页面ID',
  // 决策网络 S30/S14
  decision_id: '决策ID', coverage: '覆盖率',
  // S14 决策清单列头中文化（原 disposition/outcome 直接暴露英文，违反「用户看得懂的语言」）
  // 注：decision/reason/precedent 在 62 行综合字典已有同值定义（保留此处防未来 S14 专用键漂移时隔离）
  disposition: '处置', outcome: '结果', checksum: '校验和',
  // 记忆 S31
  memory_id: '记忆ID',
  // 通用业务单据
  sign_date: '签署日期', quote_no: '报价单号', order_no: '订单号', order_amount: '订单金额',
  paid_amount: '已付金额', payment_no: '回款单号', password: '密码',
  profile_param: '画像参数', pick_rule: '领取规则', recycle_rule: '回收规则',
  reconciled: '已对账', semantic_tag: '语义标签', total_amount: '总金额',
  valid_until: '有效期至',
  // 渲染表/子表列头中文化（审计发现 16 页英文/技术列头回退，统一补映射）
  entity: '实体', task_id: '任务ID', agent: '智能体', level: '级别', message: '消息', ts: '时间', task: '任务', sla: 'SLA',
  state: '状态', product: '产品', qty: '数量', price: '单价', plan: '计划', actual: '实际', paid: '已付', gap: '差额',
  reason: '原因', precedent: '先例', threshold: '阈值', condition: '条件', attr_type: '属性类型', data_origin: '数据来源', permission: '权限',
  component: '组件', binding: '绑定', from: '来源', to: '去向', note: '备注', connector_id: '连接器ID', endpoint: '端点',
  approver: '审批人', opinion: '意见', seq: '序号', actor: '执行者', chain_id: '链路ID', submitter: '提交人', current_node_name: '当前节点', cc: '抄送',
  doc: '单据数', decision: '决策', scenario: '场景', precedent: '先例', rate: '回款率',
};

// 列头/键可读化：命中字典→中文，未命中→原值（绝不丢信息）
export function colLabel(key) {
  if (key == null) return '';
  return FIELD_LABELS[key] || String(key);
}

// 同 kind 多组件数据解析（向后兼容）：
// - data.components[kind] 为单值/数组/已成形对象 → 原样返回（旧用法，如 S02 聚合单值）。
// - data.components[kind] 为「按 comp.title 或 comp.attrSlug 索引的对象映射」→ 返回该组件专属值，
//   解决 S06 等 7×metric-card / 3×attr-field 同 kind 碰撞导致七卡同值/三字段同值的问题。
// 索引键优先级：comp.title（metric-card/reasoning-trace 常用）→ comp.attrSlug（attr-field 常用）。
function resolveDatum(comp, data) {
  const base = data?.components?.[comp.kind];
  if (base == null) return null;
  if (typeof base === 'object' && !Array.isArray(base)) {
    const key = comp.title || comp.attrSlug;
    if (key != null && Object.prototype.hasOwnProperty.call(base, key)) return base[key];
  }
  return base;
}

// HTML 转义（& < > " '）—— 所有动态值必须过此
export function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 四态渲染（R5）：loading/empty/error/partial 由 data 层注入
// 蓝图 §2.5.1 增量：partial = 数据部分可用（组件渲染+数据状态标记）；empty 作为独立状态块
function stateBlock(state, reason) {
  if (state === 'loading') return '<div class="pg-state" data-state="loading"><span class="pg-spinner"></span> 加载中…</div>';
  if (state === 'empty') return '<div class="pg-state" data-state="empty">暂无数据</div>';
  if (state === 'error') return `<div class="pg-state" data-state="error">加载失败：${escapeHtml(reason || '未知错误')}</div>`;
  return '';
}

// 指标卡渲染（highlight 高亮）
function renderMetricCard(comp, data) {
  const m = comp.dataBinding?.metrics?.[0] || {};
  const val = data?.value ?? data ?? null;
  const hl = comp.style?.highlight;
  const hlAttr = hl ? ` data-highlight="${hl.color}" data-highlight-op="${hl.when.op}" data-highlight-val="${escapeHtml(hl.when.value)}"` : '';
  const focusAttr = data?.highlight ? ' data-highlight="active"' : '';
  const valHtml = val === null || val === undefined
    ? '<span class="pg-value" data-state="partial">—</span>'
    : `<span class="pg-value">${escapeHtml(typeof val === 'number' ? val.toFixed(2) : val)}</span>`;
  const inner = `<h3>${escapeHtml(comp.title || '')}</h3>${valHtml}${m.label ? `<p>${escapeHtml(m.label)}</p>` : ''}`;
  const navTo = comp.navigation?.to;
  if (navTo) return `<a class="pg-metric-card" href="${escapeHtml(navTo)}"${hlAttr}${focusAttr}>${inner}</a>`;
  return `<div class="pg-metric-card"${hlAttr}${focusAttr}>${inner}</div>`;
}

// ── 数字化指标重设计（2026-08-28）：三类聚合型组件渲染 ──
// 契约见 docs/2026-08-28-customer-insight-metrics-redesign.md §4
// 数据形状：kpi-strip {items[]} / pipeline {stages[],conversions[]} / progress-card {percent,label,state}

// 千分位格式化：金额/计数可读化；非有限数字返回 null（交由调用方渲染 —）
function fmtNum(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString('zh-CN');
}

// 大数字指标带：items[] 每项 {key,label,value,unit,state,hint}
function renderKpiStrip(comp, data) {
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!items.length) return stateBlock('empty');
  const body = items.map((it) => {
    if (it.state === 'hidden') {
      return `<div class="pg-kpi" data-state="hidden"><div class="pg-kpi-label">${escapeHtml(it.label || '')}</div>` +
        '<div class="pg-kpi-value" data-state="partial">🔒</div>' +
        '<div class="pg-kpi-hint">字段对当前角色隐藏</div></div>';
    }
    const shown = fmtNum(it.value);
    const valHtml = shown === null
      ? '<div class="pg-kpi-value" data-state="partial">—</div>'
      : `<div class="pg-kpi-value">${escapeHtml(shown)}${it.unit ? `<span class="pg-kpi-unit">${escapeHtml(it.unit)}</span>` : ''}</div>`;
    return `<div class="pg-kpi" data-state="${escapeHtml(it.state || 'neutral')}">` +
      `<div class="pg-kpi-label">${escapeHtml(it.label || '')}</div>${valHtml}` +
      (it.hint ? `<div class="pg-kpi-hint">${escapeHtml(it.hint)}</div>` : '') + '</div>';
  }).join('');
  return `<div class="pg-kpi-strip">${body}</div>`;
}

// L2C / LTC 六段管道：stages[] 每项 {key,name,count,amount}；conversions[] 段间转化率（长度 stages-1）
function renderPipeline(comp, data) {
  const stages = Array.isArray(data?.stages) ? data.stages : [];
  if (!stages.length) return stateBlock('empty');
  const conv = Array.isArray(data?.conversions) ? data.conversions : [];
  // 隐藏段来自数据层（maskMetricsByPerm 写入 permHiddenStages），而非 schema 标记
  const hiddenStages = new Set(Array.isArray(data?.permHiddenStages) ? data.permHiddenStages : []);
  const grid = `grid-template-columns:repeat(${stages.length},minmax(0,1fr))`;
  const cells = stages.map((s) => {
    const amtRaw = fmtNum(s.amount);
    const amtHtml = hiddenStages.has(s.key)
      ? '<div class="pg-stage-amt" data-state="hidden">🔒</div>'
      : (amtRaw === null ? '' : `<div class="pg-stage-amt">¥${escapeHtml(amtRaw)}</div>`);
    return `<div class="pg-stage"><div class="pg-stage-n">${escapeHtml(fmtNum(s.count) ?? 0)}</div>` +
      `<div class="pg-stage-name">${escapeHtml(s.name || '')}</div>${amtHtml}</div>`;
  }).join('');
  const convRow = stages.map((s, i) => {
    if (i === 0) return '<div class="pg-stage-conv"></div>';
    const c = conv[i - 1];
    return `<div class="pg-stage-conv">${(c === null || c === undefined) ? '—' : escapeHtml(Math.round(c)) + '%'}</div>`;
  }).join('');
  return `<div class="pg-pipeline" style="${grid}">${cells}</div>` +
    `<div class="pg-pipeline-conv" style="${grid}">${convRow}</div>`;
}

// 进度条卡：{percent,label,state,hint}；state==='hidden' 时整卡替换为权限占位
function renderProgressCard(comp, data) {
  const label = data?.label || comp.title || '';
  if (data?.state === 'hidden') {
    return `<div class="pg-progress-card" data-state="hidden">` +
      `<div class="pg-progress-head"><span>${escapeHtml(label)}</span><span class="pg-progress-value">🔒</span></div>` +
      '<div class="pg-progress-hint">字段对当前角色隐藏</div></div>';
  }
  const pct = Number(data?.percent);
  const has = Number.isFinite(pct);
  const w = has ? Math.max(0, Math.min(100, Math.round(pct))) : 0;
  return `<div class="pg-progress-card" data-state="${escapeHtml(data?.state || 'neutral')}">` +
    `<div class="pg-progress-head"><span>${escapeHtml(label)}</span>` +
    `<span class="pg-progress-value">${has ? escapeHtml(String(w)) + '%' : '—'}</span></div>` +
    `<div class="pg-bar"><i style="width:${w}%"></i></div>` +
    (data?.hint ? `<div class="pg-progress-hint">${escapeHtml(data.hint)}</div>` : '') + '</div>';
}

// 表格渲染
function renderTable(comp, data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const cols = comp.dataBinding?.columns || [];
  const rowLink = comp.dataBinding?.rowLink; // 可选：{ textField, idField, href }
  const rowActions = comp.dataBinding?.rowActions;
  const hasActions = Array.isArray(rowActions) && rowActions.length > 0;
  const title = comp.title ? `<h3 class="pg-comp-title">${escapeHtml(comp.title)}</h3>` : '';
  if (!rows.length) {
    return `<div class="pg-table pg-table-empty">${title}<div class="pg-state" data-state="empty">暂无数据</div></div>`;
  }
  // 修复（S14 决策清单审计）：仅当数据面显式注入 data.title 时，非空态也渲染标题（data.title 是
  // 首组件「title 索引」数据面的一种——同 kind 多表（决策清单/邻居）需标题区分）。comp.title 保持
  // 非空态不渲染（既有受控页契约不变，仅空态渲染），杜绝波及其它页面。
  const dataTitle = data?.title != null
    ? `<h3 class="pg-comp-title">${escapeHtml(data.title)}</h3>`
    : '';
  const head = cols.map(c => `<th>${escapeHtml(colLabel(c))}</th>`).join('') + (hasActions ? '<th>操作</th>' : '');
  const body = rows.map(r => {
    const cells = cols.map(c => {
      let txt = escapeHtml(r?.[c] ?? '');
      if (rowLink && c === rowLink.textField && r?.[rowLink.idField] != null) {
        const href = rowLink.href.replace(/\{id\}/g, encodeURIComponent(String(r[rowLink.idField])));
        txt = `<a href="${escapeHtml(href)}">${txt}</a>`;
      }
      return `<td>${txt}</td>`;
    }).join('');
    const actionCell = hasActions
      ? `<td>${rowActions.map(a => {
          const confirmAttr = a.confirm ? ` data-confirm="${escapeHtml(a.confirm)}"` : '';
          return `<button class="btn pg-row-action" type="button" data-action="${escapeHtml(a.action)}" data-row-id="${escapeHtml(r?.id ?? '')}"${confirmAttr}>${escapeHtml(a.label || a.action)}</button>`;
        }).join(' ')}</td>`
      : '';
    return `<tr>${cells}${actionCell}</tr>`;
  }).join('');
  return (dataTitle || '') + `<table class="pg-table" data-state="partial"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// 子表格渲染（T3-12 H29：主行内嵌子明细，如合同详情 → 回款计划/发票列表）
function renderSubtable(comp, data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const subCols = comp.subColumns || [];
  if (!rows.length || !subCols.length) return stateBlock('empty');
  const body = rows.map(r => `<tr><td class="pg-sub-main">${escapeHtml(r[comp.mainColumn] ?? '')}</td><td>
    <table class="pg-subtable"><thead><tr>${subCols.map(c => `<th>${escapeHtml(colLabel(c))}</th>`).join('')}</tr></thead>
    <tbody>${(r[comp.subRows] || []).map(sr => `<tr>${subCols.map(c => `<td>${escapeHtml(sr?.[c] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table>
  </td></tr>`).join('');
  return `<table class="pg-table pg-subtable-wrap" data-state="partial"><tbody>${body}</tbody></table>`;
}

// 选择器渲染（T3-12 H29：人员/池选择器——离职/禁用仍展示；多池指定目标池）
function renderSelect(comp, data) {
  const options = Array.isArray(data?.options) ? data.options : [];
  const disabled = comp.dataBinding?.options || [];
  const optsHtml = options.map(o => {
    const dis = disabled.includes(o.value) ? ' disabled' : '';
    const sel = o.value === (data?.value ?? comp.defaultValue) ? ' selected' : '';
    return `<option value="${escapeHtml(o.value)}"${dis}${sel}>${escapeHtml(o.label ?? o.value)}</option>`;
  }).join('');
  return `<label class="pg-select">${escapeHtml(comp.label || '')}
    <select name="${escapeHtml(comp.name || '')}" data-select="${escapeHtml(comp.action || '')}">${optsHtml}</select></label>`;
}

// 四查徽标（蓝图 §2.5.1 渲染期四查）：**声明式直用** comp.attr.data_origin（上游 sourceClassify 已完成 ①/②/③/④ 判定），
// 徽标命名 data-origin-<kind>；孤儿/未声明 data_origin → data-origin-unverified + 控件 disabled。
// ② AI 置信度 <0.6 → needsReview（禁改）；③ 规则派生 → readonly（禁改）。
// 仅业务详情面（S06/S07/...）的 comp.attr 提供数据时启用；旧 attrSlug 形态（无 attr）→ 返回 null，无徽标（向后兼容）。
function renderSourceBadge(attr) {
  if (attr === undefined) return null; // 旧形态完全兼容：无徽标、无禁改
  const origin = attr?.data_origin;
  if (origin == null) {
    // 孤儿/未声明：unverified + 禁用控件
    return { kind: 'unverified', badge: '<span class="pg-source-badge" data-origin-unverified data-state="unverified">未验证</span>', disabled: ' disabled' };
  }
  const label = SOURCE_LABELS[origin] || origin;
  const conf = origin === 'ai' ? attr.ai?.confidence : (origin === 'external' ? attr.sourcedFrom?.relation_confidence : undefined);
  const needsReview = origin === 'ai' && conf != null && conf < 0.6;
  const kind = needsReview ? 'needsReview' : origin;
  const badge = `<span class="pg-source-badge" data-origin-${escapeHtml(origin)}${needsReview ? ' data-state="needsReview"' : ''}>${escapeHtml(label)}${conf != null ? `（${escapeHtml(String(conf))}）` : ''}</span>`;
  // ④ 外部采集 → 只读（待外部源接入，不可手填）；③ 规则派生 → 只读；② AI 低置信 → 禁改
  const disabled = (origin === 'rule' || origin === 'external' || needsReview) ? ' disabled' : '';
  return { kind, badge, disabled };
}

// 动作按钮（仅 data-action 声明式，无 onclick/inline JS）
function renderActions(comp) {
  const actions = comp.actions || [];
  if (!actions.length) return '';
  return `<div class="pg-actions">${actions.map(a =>
    `<button data-action="${escapeHtml(a.action)}" data-action-label="${escapeHtml(a.label || '')}">${escapeHtml(a.label || a.action)}</button>`
  ).join('')}</div>`;
}

// 决策2 折叠容器（2026-08-29 completion plan Task 1）：纯布局容器（无 dataBinding），
// 渲染 <details class="pg-collapse">，open 可选（默认 false），内部 components[] 子组件递归渲染。
// 数据契约：collapse 自身无 dataBinding，故由 renderPage 透传全量 data；内部子组件各自按 kind 重新
// resolveDatum（与顶层组件一致的取数路径），保证嵌套 table/kpi-strip 等拿到正确数据。
function renderCollapse(comp, data) {
  const openAttr = comp.open === true ? ' open' : '';
  const inner = Array.isArray(comp.components)
    ? comp.components.map((c) => renderComponent(c, resolveDatum(c, data)) + renderActions(c)).join('\n')
    : '';
  return `<details class="pg-collapse"${openAttr}>` +
    `<summary>${escapeHtml(comp.title || '')}</summary>` +
    `<div class="pg-collapse-body">${inner}</div>` +
    `</details>`;
}

// 契约合规矩阵渲染（Task 4）：data.rows[] 每项 {task,agent,skill_ok,memory_ok,success}
function renderContractMatrix(comp, data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const title = comp.title ? `<h3 class="pg-comp-title">${escapeHtml(comp.title)}</h3>` : '';
  if (!rows.length) return `<div class="pg-contract-matrix">${title}${stateBlock('empty')}</div>`;
  const body = rows.map((r) => {
    const ok = (v) => (v ? '<span class="pg-ok">✓</span>' : '<span class="pg-bad">✗</span>');
    const succ = r.success === 'pass' ? '<span class="pg-ok">✓</span>'
      : r.success === 'fail' ? '<span class="pg-bad">✗</span>'
      : '<span class="pg-pending">—</span>';
    return `<tr><td>${escapeHtml(r.task || '')}</td><td>${escapeHtml(r.agent || '')}</td>`
      + `<td>${ok(r.skill_ok)}</td><td>${ok(r.memory_ok)}</td><td>${succ}</td>`
      + `<td><button data-action="POST /api/agent-monitor/success" data-contract-task-id="${escapeHtml(r.task || '')}">标记</button></td></tr>`;
  }).join('');
  return `<div class="pg-contract-matrix">${title}`
    + `<table class="pg-table"><thead><tr>`
    + `<th>任务</th><th>智能体</th><th>SKILL</th><th>记忆/知识</th><th>成功</th><th>操作</th>`
    + `</tr></thead><tbody>${body}</tbody></table></div>`;
}

// 两 TAB 任务监控（2026-08-29）：tabs 布局容器（仿 collapse 递归渲染子组件，透传全量 data）
function renderTabs(comp, data) {
  const tabs = Array.isArray(comp.tabs) ? comp.tabs : [];
  const nav = tabs.map((t, i) =>
    `<button class="pg-tab-btn" type="button" data-tab-btn="${escapeHtml(t.key)}"${i === 0 ? ' data-active="true"' : ''}>${escapeHtml(t.label || t.key)}</button>`
  ).join('');
  const panels = tabs.map((t, i) => {
    const inner = Array.isArray(t.components)
      ? t.components.map((c) => renderComponent(c, resolveDatum(c, data)) + renderActions(c)).join('\n')
      : '';
    return `<div class="pg-tab-panel" data-tab-panel="${escapeHtml(t.key)}"${i === 0 ? '' : ' hidden'}>${inner}</div>`;
  }).join('');
  return `<div class="pg-tabs" style="grid-column:1/-1">
    <div class="pg-tab-nav">${nav}</div>${panels}</div>`;
}

// 任务监控清单（TAB1）：data.rows[] = {task_id,title,action,status,owner,updated_at}；行可点击进入 TAB2
function renderTaskMonitor(comp, data) {
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  const title = comp.title ? `<h3 class="pg-comp-title">${escapeHtml(comp.title)}</h3>` : '';
  if (!rows.length) return `<div class="pg-task-monitor">${title}${stateBlock('empty')}</div>`;
  const cols = ['task_id', 'title', 'action', 'status', 'owner', 'updated_at'];
  const head = cols.map((c) => `<th>${escapeHtml(colLabel(c))}</th>`).join('');
  const body = rows.map((r) =>
    `<tr data-task-id="${escapeHtml(r.task_id || '')}" class="pg-task-row" style="cursor:pointer">
      <td>${escapeHtml(r.task_id || '')}</td><td>${escapeHtml(r.title || '')}</td><td>${escapeHtml(r.action || '')}</td>
      <td data-status-cell>${escapeHtml(r.status || '')}</td><td>${escapeHtml(r.owner || '')}</td><td>${escapeHtml(r.updated_at || '')}</td>
    </tr>`
  ).join('');
  return `<div class="pg-task-monitor">${title}
    <table class="pg-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
    <div class="pg-hint">点击任务行查看执行详情</div></div>`;
}

// schema 组件 → HTML（按 kind 分派）
function renderComponent(comp, data) {
  switch (comp.kind) {
    case 'metric-card': return renderMetricCard(comp, data);
    case 'table': return renderTable(comp, data);
    case 'collapse': return renderCollapse(comp, data);
    case 'tabs': return renderTabs(comp, data);
    case 'task-monitor': return renderTaskMonitor(comp, data);
    case 'kpi-strip': return renderKpiStrip(comp, data);
    case 'pipeline': return renderPipeline(comp, data);
    case 'progress-card': return renderProgressCard(comp, data);
    case 'goal-form':
      return `<form class="pg-form" data-action="${comp.action || ''}"><input name="goal" placeholder="${escapeHtml(comp.placeholder || '输入目标')}"><button type="submit">提交</button></form>`;
    case 'reasoning-trace': {
      // T2：优先读服务端注入 steps（方案 B）。renderPage 主循环已 resolveDatum 一次（cd 即组件专属值，
      //     如 data.components['reasoning-trace']['AI 洞察'].steps），此处**禁止二次 resolveDatum**——
      //     二次解析会吃掉 data.components[kind] 层（工作记忆 T5 坑位），注入被吞回退 schema。
      //     直接读 renderComponent 的 data 参数（主循环解析后的 cd）：data.steps 注入优先，无则回退 comp.steps。
      const steps = data?.steps || comp.steps || [];
      if (comp.live) {
        const liveSteps = [
          { step: 'intent', label: steps?.[0]?.label || '意图解析' },
          { step: 'context', label: steps?.[1]?.label || '上下文装配' },
          { step: 'action', label: steps?.[2]?.label || '动作编排' },
        ];
        return `<div class="pg-trace-wrap" data-kind="reasoning-trace">
          <h3 class="pg-comp-title">${escapeHtml(comp.title || '思考链执行过程')}</h3>
          <ol class="pg-trace">${liveSteps.map((s) =>
            `<li data-trace-step data-step="${s.step}" data-status="idle">${escapeHtml(s.label)}<span class="pg-dot"></span><div class="pg-step-detail" data-step-detail="${s.step}"></div></li>`
          ).join('')}</ol>
          <div class="pg-trace-meta" data-task-id=""></div>
          <div class="pg-event-log" data-event-log></div>
        </div>`;
      }
      return `<ol class="pg-trace">${steps.map((s) => `<li data-trace-step="${escapeHtml(s.status || '')}">${escapeHtml(s.label || '')}</li>`).join('') || '<li>（空 trace）</li>'}</ol>`;
    }
    case 'subtable': // T3-12 H29 子表格：主行内嵌子明细（如合同详情回款计划/发票记录）
      return renderSubtable(comp, data);
    case 'contract-matrix': return renderContractMatrix(comp, data);
    case 'select': // T3-12 H29 人员/池选择器（离职/禁用仍展示；指定目标池多池实证）
      return renderSelect(comp, data);
    case 'attr-field': { // G1 T6 元模型抽屉：属性受控输入；消费角色权限 hidden/readonly（V3 渲染层隐藏）
      // 蓝图 §2.5.1：comp.attr 数据对象提供时启用渲染期四查（来源徽标/孤儿禁用）；旧 attrSlug 形态保持兼容
      const slug = comp.attrSlug;
      const label = escapeHtml(comp.label || slug);
      const sb = renderSourceBadge(comp.attr);
      const originExt = comp.attr ? ` data-origin="${escapeHtml(sb?.kind || '')}"` : '';
      if (comp.hidden === true) {
        return `<div class="pg-attr-field pg-perm" data-attr="${escapeHtml(slug)}" data-perm="hidden">
          <span class="pg-lock" aria-label="权限锁定">🔒</span> 字段对当前角色隐藏
        </div>`;
      }
      if (comp.readonly === true || sb?.kind === 'rule') {
        return `<div class="pg-attr-field pg-perm" data-attr="${escapeHtml(slug)}" data-attr-type="${escapeHtml(comp.attrType || 'text')}" data-perm="readonly"${originExt}>
          ${sb ? sb.badge : ''}
          <span class="pg-lock" aria-label="权限锁定">🔒</span>
          <label>${label}</label>
          <input name="${escapeHtml(slug)}" type="text" value="${escapeHtml(data?.value ?? '')}" placeholder="${escapeHtml(comp.placeholder || '')}" disabled />
        </div>`;
      }
      if (sb?.kind === 'unverified' || sb?.kind === 'needsReview') {
        return `<div class="pg-attr-field pg-perm" data-attr="${escapeHtml(slug)}" data-attr-type="${escapeHtml(comp.attrType || 'text')}" data-perm="${escapeHtml(sb.kind)}"${originExt}>
          ${sb.badge}
          <label>${label}</label>
          <input name="${escapeHtml(slug)}" type="text" value="${escapeHtml(data?.value ?? '')}" placeholder="${escapeHtml(comp.placeholder || '')}"${sb.disabled} />
        </div>`;
      }
      // 默认（向后兼容）：label + input；④ 外部采集 → disabled 只读 + 待接入提示（renderer T3：external 不再可填）
      const extHint = sb?.kind === 'external'
        ? `<span class="pg-origin-hint">${data?.value ? '外部源已同步（只读）' : '待外部源接入（只读）'}</span>`
        : '';
      return `<div class="pg-attr-field" data-attr="${escapeHtml(slug)}" data-attr-type="${escapeHtml(comp.attrType || 'text')}"${originExt}>
        ${sb ? sb.badge : ''}${extHint}
        <label>${label}</label>
        <input name="${escapeHtml(slug)}" type="text" value="${escapeHtml(data?.value ?? '')}" placeholder="${escapeHtml(comp.placeholder || '')}"${sb ? sb.disabled : ''} />
      </div>`;
    }

    case 'result-card': {
      // 最近动作结果卡：data.items（[{label,value}]）或 data.summary 单行
      const title = escapeHtml(comp.title || data?.title || '最近动作结果');
      const items = Array.isArray(data?.items) ? data.items : null;
      const body = items
        ? `<ul class="pg-result-items">${items.map(i => `<li><span class="pg-result-label">${escapeHtml(i.label || '')}</span><span class="pg-result-value">${escapeHtml(i.value ?? '')}</span></li>`).join('')}</ul>`
        : (data?.summary ? `<p class="pg-result-summary">${escapeHtml(data.summary)}</p>` : '');
      return `<div class="pg-result-card" data-kind="result-card"><h3>${title}</h3>${body}</div>`;
    }

    case 'target-card': {
      // S13 目标达标卡：主循环已 resolveDatum → data 为该目标卡数据对象（{tier,target,window,actual,pass}）
      // 注意：不在此再调 resolveDatum（双重解析导致 data.components[kind] 层丢失 → 空数据回退）
      const d = data || {};
      const tier = d.tier || '潜力';
      const target = d.target ?? 1;
      const windowLabel = { week: '周', month: '月', quarter: '季' }[d.window] || d.window || '月';
      const actual = d.actual ?? 0;
      const pass = !!d.pass;
      const mark = pass ? '✅ 达标' : '⚠️ 未达标';
      return `<div class="pg-target-card ${pass ? 'ok' : 'warn'}" data-kind="target-card">
        <h3 class="pg-comp-title">目标达标 · ${escapeHtml(tier)}</h3>
        <p class="pg-target-meta">目标频率：${escapeHtml(String(target))} 次/${escapeHtml(windowLabel)}｜实际：${escapeHtml(String(actual))} 次｜${mark}</p>
      </div>`;
    }

    default: return `<div class="pg-unknown">未知组件 ${escapeHtml(comp.kind)}</div>`;
  }
}

// 唯一渲染出口：Schema → HTML
export function renderPage(schema, data = {}) {
  const warnings = [];
  // 渲染前再校验（三层护栏③）
  const v = validatePageSchema(schema);
  if (!v.ok) {
    warnings.push('schema_invalid: ' + v.errors[0]);
    return { html: '', warnings };
  }
  // 四态（R5 + 蓝图 §2.5.1）：loading/error/empty 先出状态块；partial 注入状态标记继续渲染
  if (data.state === 'loading' || data.state === 'error') {
    return { html: stateBlock(data.state, data.reason), warnings };
  }
  const partial = data.state === 'partial';
  if (data.state === 'empty') {
    return { html: stateBlock('empty'), warnings };
  }
  const comps = schema.components.map(comp => {
    // collapse/tabs 无 dataBinding，resolveDatum 返回 null；透传全量 data，由 renderCollapse/renderTabs 内部分派各子组件数据
    const cd = (comp.kind === 'collapse' || comp.kind === 'tabs') ? data : resolveDatum(comp, data);
    const html = renderComponent(comp, cd);
    return html + renderActions(comp);
  }).join('\n');
  // 布局：columns 用 inline style（受控，仅 repeat 模板）；partial 注入数据状态标记（四态 R5）
  const cols = Math.min(Math.max(schema.layout?.columns || 1, 1), 4);
  const stateAttr = partial ? ' data-state="partial"' : '';
  // 决策1乙（2026-08-29 completion plan Task 3）：皮肤作用域仅作用于带 layout.skin 的页面（如 insight 浅色），不污染其余深色门户页
  const skinAttr = schema.layout?.skin ? ` data-skin="${escapeHtml(schema.layout.skin)}"` : '';
  // 列模板必须落在 .pg-grid（组件容器）上；pg-page 仅作块级容器（h2 整行 + 下方网格）。
  // 修复：原实现把 grid-template-columns 误置于 .pg-page，导致 h2 与 pg-grid 被塞进 1/3 宽度、组件塌成单列。
  const html = `<div class="pg-page" data-page-type="${escapeHtml(schema.type)}"${stateAttr}${skinAttr}>
  <h2>${escapeHtml(schema.title)}</h2>
  <div class="pg-grid" style="grid-template-columns: repeat(${cols}, 1fr);">${comps}</div>
</div>`;
  // 强制无 <script>：输出后检测，命中即剔除并告警（纵深防御末层）
  if (/<script/i.test(html)) {
    const cleaned = html.replace(/<script[\s\S]*?<\/script>/gi, '');
    warnings.push('script_stripped');
    return { html: cleaned, warnings };
  }
  return { html, warnings };
}