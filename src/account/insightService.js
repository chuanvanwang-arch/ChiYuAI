// src/account/insightService.js — 客户洞察聚合 + 权限剔除（受控渲染数据面）
// 纯函数为主（可单测、无 DB）；薄封装 queryParticles/query 仅用于 handler 组装。
// 设计输入：docs/2026-08-28-customer-360-insight-design.md §2.1 / §4.2；施行计划 Task A。
import { query } from '../db.js';
import { loadProfile } from '../context/roleProfiles.js';
// T8(BG-01b/BG-08)：叙事时间线纯函数与四源检索收敛至 context 单一事实源，此处 re-export 保持既有调用方零改动
import { buildTimelineRows, retrieveTimeline, DECISION_TIME_BASIS } from '../context/timelineSource.js';
export { buildTimelineRows };

// —— 字段级权限矩阵（设计 §4.2）：vis ∈ {hidden, readonly, visible} ——
// 敏感字段：回款金额(payment_amount) / 成本(cost) / 合同金额(contract_amount) / 工商信息(biz_info)
export const FIELD_PERMS = {
  payment_amount: { sales: 'hidden', manager: 'readonly', exec: 'visible', finance: 'visible', presales: 'hidden', contract_admin: 'readonly' },
  cost:           { sales: 'hidden', manager: 'hidden',  exec: 'visible', finance: 'readonly', presales: 'hidden', contract_admin: 'hidden' },
  contract_amount:{ sales: 'readonly', manager: 'visible', exec: 'visible', finance: 'visible', presales: 'readonly', contract_admin: 'visible' },
  biz_info:       { sales: 'readonly', manager: 'visible', exec: 'visible', finance: 'visible', presales: 'readonly', contract_admin: 'visible' },
};

// 角色 data_scope.domain 短 token → 粒子类型映射（finance 用短 token、presales 用全名，统一展开）
const DOMAIN_TYPE_GROUPS = {
  payment: ['CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD'],
  contract: ['CRM_CONTRACT'],
  invoice: ['CRM_INVOICE'],
  CRM_DEAL: ['CRM_DEAL'],
  CRM_TECHNICAL_PROPOSAL: ['CRM_TECHNICAL_PROPOSAL'],
};

// 纯函数：按 data_scope 过滤关联粒子（self/domain 可纯推断；org_subtree/all 透传）
// 注意：handler 仅对 domain 模型实际调用本函数；self/org_subtree 由账户级 403 闸约束，避免误清整页。
export function applyScopeFilter(particles, profile, actor) {
  const m = profile?.data_scope?.model || 'all';
  if (m === 'all') return particles;
  if (m === 'self') return particles.filter(p => p?.payload?.owner_id === actor);
  if (m === 'domain') {
    const dom = profile.data_scope.domain || [];
    const types = new Set(dom.flatMap(d => DOMAIN_TYPE_GROUPS[d] || [d]));
    return particles.filter(p => types.has(p.type));
  }
  return particles; // org_subtree 需 DB 解析，handler 内单独处理
}

// 纯函数：克隆 schema 后按角色剔除隐藏字段 / 隐藏列（避免污染其它请求）
export function applyFieldPerms(schema, role) {
  const s = structuredClone(schema);
  for (const comp of s.components) {
    if (comp.kind === 'attr-field' && comp.perm && FIELD_PERMS[comp.perm]) {
      const vis = FIELD_PERMS[comp.perm][role] || 'visible';
      if (vis === 'hidden') comp.hidden = true;
      else if (vis === 'readonly') comp.readonly = true;
    }
    if ((comp.kind === 'subtable' || comp.kind === 'table') && comp.permColumns) {
      const hide = comp.permColumns[role] || [];
      if (hide.length && comp.subColumns) comp.subColumns = comp.subColumns.filter(c => !hide.includes(c));
      if (hide.length && comp.dataBinding?.columns) comp.dataBinding.columns = comp.dataBinding.columns.filter(c => !hide.includes(c));
    }
    // 数字化指标组件（重设计 §6）：仅在此「标记」隐藏，实际抹除由 maskMetricsByPerm 落到数据层
    if (comp.kind === 'kpi-strip' && comp.permMetrics) {
      const hiddenKeys = [];
      for (const [permKey, metricKeys] of Object.entries(comp.permMetrics)) {
        const vis = FIELD_PERMS[permKey]?.[role] || 'visible';
        if (vis === 'hidden') hiddenKeys.push(...(metricKeys || []));
      }
      if (hiddenKeys.length) comp.permHiddenKeys = hiddenKeys;
    }
    if (comp.kind === 'pipeline' && comp.permStages) {
      const hiddenStages = [];
      for (const [permKey, stageKeys] of Object.entries(comp.permStages)) {
        const vis = FIELD_PERMS[permKey]?.[role] || 'visible';
        if (vis === 'hidden') hiddenStages.push(...(stageKeys || []));
      }
      if (hiddenStages.length) comp.permStagesHiddenKeys = hiddenStages;
    }
    if (comp.kind === 'progress-card' && comp.permKey) {
      const vis = FIELD_PERMS[comp.permKey]?.[role] || 'visible';
      if (vis === 'hidden') comp.permHidden = true;
    }
  }
  return s;
}

// 纯函数：把 applyFieldPerms 打在 schema 上的隐藏标记落到数据层（渲染器只消费数据）
// kpi-strip → 命中项替换为 state:'hidden'；pipeline → 命中段 amount 置 null；progress-card → 整卡 hidden
export function maskMetricsByPerm(schema, data) {
  const out = structuredClone(data);
  for (const comp of schema.components || []) {
    const group = out.components?.[comp.kind];
    if (!group || typeof group !== 'object') continue;
    const key = comp.title;
    if (key == null || !Object.prototype.hasOwnProperty.call(group, key)) continue;
    const datum = group[key];
    if (comp.kind === 'kpi-strip' && comp.permHiddenKeys?.length && Array.isArray(datum.items)) {
      datum.items = datum.items.map((it) => (comp.permHiddenKeys.includes(it.key)
        ? { key: it.key, label: it.label, value: null, unit: '', state: 'hidden', hint: '' }
        : it));
    }
    if (comp.kind === 'pipeline' && comp.permStagesHiddenKeys?.length && Array.isArray(datum.stages)) {
      const hidden = new Set(comp.permStagesHiddenKeys);
      datum.stages = datum.stages.map((s) => (hidden.has(s.key) ? { ...s, amount: null } : s));
      datum.permHiddenStages = comp.permStagesHiddenKeys;
    }
    if (comp.kind === 'progress-card' && comp.permHidden) {
      group[key] = { label: datum.label || comp.title || '', percent: null, state: 'hidden' };
    }
  }
  return out;
}

// 纯函数：L2C 关联粒子 → 交易链行 + 汇总（金额/回款率）
export function buildTransactionRows(related) {
  const stages = [
    { stage: '商机', items: related.deals || [] },
    { stage: '报价', items: related.quotations || [] },
    { stage: '合同', items: related.contracts || [] },
    { stage: '订单', items: related.orders || [] },
    { stage: '回款', items: related.payments || [] },
    { stage: '发票', items: related.invoices || [] },
  ];
  const amountOf = (it) => Number(it?.payload?.amount || it?.payload?.expected_amount || it?.payload?.paid_amount || 0);
  const rows = stages.map(s => ({
    stage: s.stage,
    doc: s.items.length,
    amount: s.items.reduce((sum, it) => sum + amountOf(it), 0),
    status: s.items.length ? '有' : '无',
  }));
  const contractAmt = rows.find(r => r.stage === '合同')?.amount || 0;
  const paidAmt = rows.find(r => r.stage === '回款')?.amount || 0;
  const rate = contractAmt > 0 ? Math.round((paidAmt / contractAmt) * 100) : 0;
  return { rows, totals: { contractAmt, paidAmt, rate } };
}

// —— 数字化指标聚合（重设计 §5.1–5.4；docs/2026-08-28-customer-insight-metrics-redesign.md）——
// 纯函数，可单测。数据不足一律返回 null（渲染为「—」），不返回误导性 0（§10 缓解措施）。
const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v)));

export function buildMetrics(related, timelineSources = [], tasks = [], decisions = []) {
  const amountOf = (it) => {
    const n = Number(it?.payload?.amount ?? it?.payload?.expected_amount ?? it?.payload?.paid_amount ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const contracts = related.contracts || [];
  const payments = related.payments || [];

  // §5.1 交易金额四联
  const contractAmt = contracts.length ? contracts.reduce((s, it) => s + amountOf(it), 0) : null;
  const paidAmt = payments.length
    ? payments.reduce((s, it) => {
      const st = it?.payload?.status;
      if (st && st !== 'received') return s;   // 仅统计已到账回款
      return s + (Number(it?.payload?.paid_amount ?? it?.payload?.amount) || 0);
    }, 0)
    : null;
  const unpaidAmt = (contractAmt !== null && paidAmt !== null) ? Math.max(0, contractAmt - paidAmt) : null;
  const payRate = (contractAmt && contractAmt > 0 && paidAmt !== null)
    ? Math.round((paidAmt / contractAmt) * 1000) / 10
    : null;

  // §5.2 L2C 六段管道（线索口径：CRM_DEAL 中 stage='lead'）
  const pipeDefs = [
    { key: 'lead', name: '线索', items: (related.deals || []).filter(d => (d?.payload?.stage || 'lead') === 'lead') },
    { key: 'quote', name: '报价', items: related.quotations || [] },
    { key: 'contract', name: '合同', items: contracts },
    { key: 'order', name: '订单', items: related.orders || [] },
    { key: 'payment', name: '回款', items: payments },
    { key: 'invoice', name: '发票', items: related.invoices || [] },
  ];
  const stages = pipeDefs.map(s => ({
    key: s.key,
    name: s.name,
    count: s.items.length,
    amount: s.items.length ? s.items.reduce((a, it) => a + amountOf(it), 0) : null,
  }));
  const conversions = stages.slice(1).map((s, i) => {
    const prev = stages[i].count;
    return prev > 0 ? Math.round((s.count / prev) * 100) : null;
  });

  // §5.3 过程活跃度
  const now = Date.now();
  const events = (timelineSources || []).filter(e => e.type === 'event');
  const eventTs = events.map(e => Date.parse(e.ts)).filter(Number.isFinite);
  const interactions = events.length;
  const interactions30d = eventTs.filter(t => (now - t) <= 30 * 86400000).length;
  const taskTotal = tasks.length;
  // 逾期判定仅对「含 due 字段」的条目生效；若数据集整体无 due 覆盖（如决策事件源），
  // taskOverdue 返回 null（数据不足，不返回误导性 0；§5.3 边界 / 2026-09-03 死区修复：
  // 此前 crm.tasks 切到 decisionTrace 后无 due → 恒 0 → noOverdueScore 恒 100 虚占权重）。
  const tasksWithDue = tasks.filter(t => t?.due);
  const taskOverdue = tasksWithDue.length
    ? tasksWithDue.filter(t => { const d = Date.parse(t.due); return Number.isFinite(d) && d < now; }).length
    : null;
  const lastFollowDays = eventTs.length
    ? Math.floor((now - Math.max(...eventTs)) / 86400000)
    : null;

  // §5.4 决策与风险
  const decTotal = decisions.length;
  const decExc = decisions.filter(d => d?.disposition === 'EXCEPTION').length;
  const excRate = decTotal > 0 ? Math.round((decExc / decTotal) * 1000) / 10 : null;
  // 客户健康度：权重见 §5.4；决策总数为 0 时剔除决策维度重新归一（避免 0 分拉低总分）。
  // 逾期维度（noOverdueScore）仅在 taskOverdue 非 null（有 due 覆盖）时纳入；无到期字段则
  // 剔除该维并按剩余权重归一，杜绝「无数据却恒 100」的虚高（2026-09-03 死区修复）。
  let healthScore = null;
  if (contractAmt !== null || interactions > 0 || decTotal > 0) {
    const rateScore = clamp100(payRate ?? 0);
    const actScore = clamp100((interactions30d / 5) * 100);
    const noOverdueScore = taskOverdue === null ? null : (taskOverdue === 0 ? 100 : clamp100(100 - taskOverdue * 25));
    if (decTotal > 0) {
      const comps = [['rate', 0.3, rateScore], ['act', 0.3, actScore], ['exc', 0.2, 100 - (excRate ?? 0)]];
      if (noOverdueScore !== null) comps.push(['overdue', 0.2, noOverdueScore]);
      const wsum = comps.reduce((s, c) => s + c[1], 0);
      healthScore = Math.round(comps.reduce((s, c) => s + c[1] * c[2], 0) / wsum);
    } else {
      const comps = [['rate', 0.45, rateScore], ['act', 0.45, actScore]];
      if (noOverdueScore !== null) comps.push(['overdue', 0.1, noOverdueScore]);
      const wsum = comps.reduce((s, c) => s + c[1], 0);
      healthScore = Math.round(comps.reduce((s, c) => s + c[1] * c[2], 0) / wsum);
    }
  }
  const healthState = healthScore === null ? 'neutral' : (healthScore >= 70 ? 'good' : healthScore >= 40 ? 'warn' : 'bad');

  return {
    money: { contractAmt, paidAmt, unpaidAmt, payRate },
    pipeline: { stages, conversions },
    activity: { interactions, interactions30d, taskTotal, taskOverdue, lastFollowDays },
    decision: { decTotal, decExc, excRate, healthScore, healthState },
  };
}

// —— 薄封装：handler 用，按 accountId 并行拉取关联粒子（scope 由调用方先过滤）——
export async function loadRelatedParticles(accountId, dealIds = [], tenantId = 'system') {
  const types = ['CRM_CONTACT', 'CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_ORDER', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD', 'CRM_INVOICE', 'CRM_TECHNICAL_PROPOSAL'];
  const byType = {};
  for (const t of types) {
    const rows = await query(
      `SELECT id, type, slug, title, payload, state FROM crm.particles
       WHERE type=$1 AND tenant_id=$4
         AND (payload->>'account_id'=$2 OR payload->>'deal_id' = ANY($3::text[]))`,
      [t, accountId, dealIds, tenantId]
    );
    byType[t] = rows.rows;
  }
  return byType;
}

// 薄封装：时间线多源抽取（events / tasks / decision / memory_log）
// T8(BG-01b)：实现委托 context/timelineSource.retrieveTimeline（单一事实源），
//   决策时间基准随之统一为 COALESCE(decided_at, created_at)（BG-08），此处不再各自写 SQL
export async function loadTimelineSources(accountId, dealIds = [], tenantId = 'system') {
  return retrieveTimeline({ accountId, dealIds, tenantId });
}

// 决策执行足迹（2026-09-03）：crm.decision_event 是 crm.decision 主轴的执行日志
// （made/escalated/...），承载 AI suggested / confidence / 实际 disposition / 业务分级等"决策
// 是怎么走完的"细节。原页面「客户任务线」绑错源——crm.tasks 实测 0 行、是 kanban 调度队列，
// 与客户跟进无关。现把该折叠卡数据源改为本函数；语义最贴近业务实际「AI 决策路径」，且数据真实可查。
const DECISION_EVENT_LABEL = {
  made: 'AI 已决策',
  escalated: '已升级人工',
  executed: '已执行',
  blocked: '已阻塞',
};

export async function loadDecisionTrace(accountId, dealIds = []) {
  if (!accountId && !(Array.isArray(dealIds) && dealIds.length)) return [];
  const deals = Array.isArray(dealIds) ? dealIds : [];
  // 双形态兼容：involved_entities 既可能是 {account_id:..}，也可能是 [{id:..}, {id:..}, ...] 数组。
  // 销售决策通常只挂 CRM_DEAL，必须把 dealIds 一并传入——这是 loadDecisions 同款修复。
  const dr = await query(
    `SELECT decision_id::text AS id FROM crm.decision
     WHERE involved_entities @> $1::jsonb
        OR (jsonb_typeof(involved_entities) = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(involved_entities) e
                        WHERE e->>'id' = $2 OR e->>'id' = ANY($3::text[])))
        -- 2026-09-03 根因 fallback：involved_entities.id 被引擎写死 null（routes.js:502），
        --   改用 trigger_context.account_id 兜底反查，使本应可见的历史决策可见。
        OR trigger_context->>'account_id' = $2
        OR trigger_context->>'id' = ANY($3::text[])
     LIMIT 100`,
    [JSON.stringify({ account_id: accountId }), accountId, deals]
  );
  const decisionIds = dr.rows.map((r) => r.id);
  if (!decisionIds.length) return [];
  const er = await query(
    `SELECT event_id::text AS id, event_type, scenario_id, decision_id::text AS decision_id,
            payload, created_at::text AS ts
     FROM crm.decision_event
     WHERE decision_id = ANY($1::uuid[])
     ORDER BY created_at DESC LIMIT 100`,
    [decisionIds]
  );
  return er.rows.map((e) => {
    const p = e.payload || {};
    const conf = Number(p.confidence);
    return {
      ts: e.ts,
      scenario: e.scenario_id || '',
      event: DECISION_EVENT_LABEL[e.event_type] || e.event_type || '',
      suggested: p.suggested || '—',
      // 置信度统一为百分比文本，避免 0~1 小数对业务读者无感；同时应对 null
      confidence: Number.isFinite(conf) ? `${Math.round(conf * 100)}%` : '—',
      tier: p.business_tier || '—',
      actual: [p.state, p.disposition].filter(Boolean).join(' / ') || '—',
    };
  });
}

// 「决策链与先例」表格 precedent 列渲染辅助：referenced_precedents 是
// [{precedent_id, similarity}] 数组，直接落表会触发 renderTable 的 escapeHtml(obj)→'[object Object]'。
// 这里压扁为可读串（短码 + 相似度百分比），多条用顿号连接，空数组回退「无」，绝不丢信息。
function formatPrecedents(precs) {
  if (!Array.isArray(precs) || precs.length === 0) return '无';
  return precs.map((p) => {
    const pid = typeof p === 'string' ? p : (p?.precedent_id || '');
    const sim = p && p.similarity != null ? Math.round(Number(p.similarity) * 100) : null;
    const parts = [];
    if (pid) parts.push(pid.slice(0, 8));
    if (sim != null) parts.push(`${sim}%`);
    return parts.join('·') || '—';
  }).join('、');
}

export async function loadDecisions(accountId, dealIds = []) {
  // 缝修复 2026-09-02（与 timelineSource.js:78 同源）：involved_entities 以**数组**存储，
  // 原 ` @> '{"account_id":..}'::jsonb` 对数组恒 false → 客户洞察「决策」区恒空。
  // 双形态匹配：对象形态（含 account_id 键）∪ 数组形态（元素 id 命中）；jsonb_typeof 防非数组抛错。
  // 2026-09-03 修复：销售决策通常只关联 CRM_DEAL，未把 CRM_ACCOUNT 写入 involved_entities，
  //   导致按 accountId 查询恒空。现把该客户下的 dealIds 一并传入，命中 DEAL 关联的决策。
  const deals = Array.isArray(dealIds) ? dealIds : [];
  const r = await query(
    `SELECT d.decision_id::text AS id, d.scenario_id, d.disposition, d.state, d.rationale,
            COALESCE(d.referenced_precedents::text, '[]') AS precedents
     FROM crm.decision d
     WHERE d.involved_entities @> $1::jsonb
        OR (jsonb_typeof(d.involved_entities) = 'array'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.involved_entities) e
                        WHERE e->>'id' = $2
                           OR e->>'id' = ANY($3::text[])))
        -- 2026-09-03 根因 fallback：决策引擎(routes.js:502)写 involved_entities 时把 id 写死 null，
        --   上述按 e->>'id' 反查对 null 永远不匹配 → 决策/足迹/KPI 恒空（已确认 3 条 LEAD_FOLLOW_UP 全 null）。
        --   改用 trigger_context 兜底反查：account_id 真实有值 → 历史+未来决策立即可见。
        OR d.trigger_context->>'account_id' = $2
        OR d.trigger_context->>'id' = ANY($3::text[])
     ORDER BY ${DECISION_TIME_BASIS} DESC LIMIT 50`,
    [JSON.stringify({ account_id: accountId }), accountId, deals]
  );
  return r.rows.map(d => ({
    // 2026-09-03 修复标签/值错位：原 decision↦scenario_id、scenario↦disposition，
    // 导致「决策链」表格「决策」列显 scenario、「场景」列显 disposition。现对齐语义：
    // decision 列显真实 decision_id，scenario 列显 scenario_id，state/precedent 不变。
    decision: d.id,
    scenario: d.scenario_id,
    state: d.state,
    // 2026-09-04 修复：SELECT 已取 d.disposition（:330），但原 map 丢弃 → 决策链不显示处置结论（ESCALATE 等）。
    // 现补映射；renderer.js:223 按列取 r?.[c]，S35.schema.js 决策链 columns 已加 'disposition'。
    disposition: d.disposition,
    // 2026-09-03 修复 [object Object] 先例展示瑕疵：referenced_precedents 是对象数组，
    // 旧 `...[0] || '无'` 把对象直接交给渲染器 → '[object Object]'；现压扁为可读串，且保留全部先例（旧仅取首条）。
    precedent: formatPrecedents(JSON.parse(d.precedents || '[]')),
  }));
}

// 依据角色解析 actor（username → CRM_PERSON slug）；缺失则回退 null（self/org 透传）
export async function resolveActor(username) {
  if (!username) return null;
  const r = await query(`SELECT slug FROM crm.particles WHERE type='CRM_PERSON' AND payload->>'username'=$1 LIMIT 1`, [username]);
  return r.rows[0]?.slug || null;
}
