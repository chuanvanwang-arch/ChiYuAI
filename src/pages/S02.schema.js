// src/pages/S02.schema.js — S02 AI 作战室（/）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S02 + stage3-portal-home-design.md
// 组件：goal-form(copilot ⌘K → POST /api/page/from-nl) + metric-card×3(今日优先) + table×2(L2C/审批) + reasoning-trace + subtable(SSE)
// 值域对齐：src/page/validator.js（dataBinding.source='particle' 强制；kind ∈ COMPONENT_KINDS；navigation ∈ CANONICAL_NAV）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: 'AI 作战室',
  navigation: { to: '/dashboard' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: '⌘K 输入目标（如：给我商机看板）',
      label: 'Copilot',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'metric-card',
      title: '今日优先 · FIT',
      navigation: { to: '/today-priority.html?dim=FIT' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '赢率≥60% 的高匹配商机' }] },
    },
    {
      kind: 'metric-card',
      title: '今日优先 · TIMING',
      navigation: { to: '/business-board.html?focus=quoted' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '报价阶段待跟进' }] },
    },
    {
      kind: 'metric-card',
      title: '今日优先 · CONN',
      navigation: { to: '/business-board.html?focus=contracted' },
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '合同阶段待接触' }] },
    },
    {
      kind: 'table',
      title: 'L2C 管线',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['name', 'stage', 'amount'], metrics: [] },
    },
    {
      kind: 'table',
      title: '审批收件箱',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['name', 'stage', 'amount'], metrics: [] },
    },
    // ── 工作台业务作战面板（2026-08-30 重构：聚合管道/客户/行为三页核心指标）──
    // 三个 collapse 区：管道总览 / 客户跟踪 / 销售行为达标；子组件 dataBinding 仅过 schema 校验，
    // 真实数据由 /api/page/home handler 注入 data.components[<kind>][<title>]。
    {
      kind: 'collapse',
      title: '管道总览 · Pipeline',
      open: true,
      components: [
        {
          kind: 'kpi-strip',
          title: '管道 KPI-A',
          dataBinding: { source: 'aggregate', sources: ['CRM_DEAL'], metrics: [{ key: 'inPipelineCount', agg: 'count' }] },
        },
        {
          kind: 'kpi-strip',
          title: '管道 KPI-B',
          dataBinding: { source: 'aggregate', sources: ['CRM_DEAL'], metrics: [{ key: 'staleCount', agg: 'count' }] },
        },
        {
          kind: 'pipeline',
          title: '管道六段',
          dataBinding: { source: 'aggregate', sources: ['CRM_DEAL'], metrics: [{ key: 'pipeline', agg: 'count' }] },
        },
      ],
    },
    {
      kind: 'collapse',
      title: '客户跟踪 · Named Accounts',
      open: true,
      components: [
        {
          kind: 'kpi-strip',
          title: '客户 KPI',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'targetCustomers', agg: 'count' }] },
        },
        {
          kind: 'table',
          title: '指名客户 Top N',
          dataBinding: {
            source: 'particle', particleType: 'CRM_ACCOUNT', filters: [],
            columns: ['name', 'tier', 'visits', 'behavior', 'leads', 'opps', 'contracts', 'gaps'], metrics: [],
            rowLink: { textField: 'name', idField: 'id', href: '/account-360.html?id={id}' },
          },
        },
      ],
    },
    {
      kind: 'collapse',
      title: '销售行为达标 · My Behavior',
      open: false,
      components: [
        {
          kind: 'progress-card',
          title: '今日拜访',
          dataBinding: { source: 'aggregate', sources: ['CRM_DEAL'], metrics: [{ key: 'todayVisits', agg: 'count' }] },
        },
        {
          kind: 'progress-card',
          title: '今日电话',
          dataBinding: { source: 'aggregate', sources: ['CRM_DEAL'], metrics: [{ key: 'todayCalls', agg: 'count' }] },
        },
        {
          kind: 'progress-card',
          title: '本周拜访客户',
          dataBinding: { source: 'aggregate', sources: ['CRM_DEAL'], metrics: [{ key: 'weekVisitCustomers', agg: 'count' }] },
        },
        {
          kind: 'progress-card',
          title: '本周新客户',
          dataBinding: { source: 'aggregate', sources: ['CRM_DEAL'], metrics: [{ key: 'weekNewCustomers', agg: 'count' }] },
        },
        // ── 标准达标区（2026-08-30 三分类 B 类展示）──
        // 数据源：/api/page/home handler 注入 boardSummary 的 cov* 六键（走 sales-thresholds 出厂标准，
        // 非 id31 个人目标——两者互补：id31 是「个人目标」，coverage 是「方法标准」）
        {
          kind: 'progress-card',
          title: '标准 · 客户数下限',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covCustomerCountMin', agg: 'value' }] },
        },
        {
          kind: 'progress-card',
          title: '标准 · 日均拜访',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covDailyVisitTarget', agg: 'value' }] },
        },
        {
          kind: 'progress-card',
          title: '标准 · 周拜访数',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covWeeklyVisitTarget', agg: 'value' }] },
        },
        {
          kind: 'progress-card',
          title: '标准 · 信息收集/周',
          dataBinding: { source: 'aggregate', sources: ['CRM_ACCOUNT'], metrics: [{ key: 'covInfoCollectWeekly', agg: 'value' }] },
        },
      ],
    },
    {
      kind: 'reasoning-trace',
      steps: [
        { status: 'ok', label: '意图解析' },
        { status: 'ok', label: '上下文装配' },
        { status: 'pending', label: '切入建议' },
      ],
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'subtable',
      title: 'SSE 最新事件',
      mainColumn: 'event',
      subColumns: ['type', 'entity'],
      subRows: 'events',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

// 启动即校验（骨架非法立即失败，不静默）
const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S02 schema 非法: ' + v.errors[0]);