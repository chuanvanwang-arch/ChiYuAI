// src/pages/S35.schema.js — 客户洞察页（workspace，数字化指标三段式）
// 设计输入：docs/2026-08-28-customer-360-insight-design.md §2.1 / §6.2
//           docs/2026-08-28-customer-insight-metrics-redesign.md §4 / §5 / §6（数字化指标重设计）
// 布局：指标带（交易金额四联）→ L2C 六段管道 → 进度卡×2 → 过程活跃度 → 决策与风险 → 明细（table×3）
// 说明：
//   - kpi-strip / pipeline / progress-card 为聚合型组件，dataBinding.source='aggregate'（§3.2 契约）
//   - 明细段保留在下区（决策 2：折叠为三组 collapsible，默认收起）
//   - 字段级权限走 permMetrics / permStages / permKey，由 applyFieldPerms 标记 + maskMetricsByPerm 抹除数据
import { validatePageSchema } from '../page/validator.js';

// 明细/表格类组件：粒子数据源（四护栏）
const ACC = { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] };
// 聚合型组件：跨粒子派生指标（sources[] 数组 + metrics[] 必填）
const AGG = (sources, metrics) => ({ source: 'aggregate', sources, metrics });

export const schema = {
  type: 'workspace',
  title: '客户洞察',
  navigation: { to: '/accounts/:id/insight' },
  layout: { columns: 1, theme: 'light' },
  components: [
    // ── ① 交易金额四联（大数字指标带）──
    {
      kind: 'kpi-strip', title: '交易金额四联',
      dataBinding: AGG(
        ['CRM_CONTRACT', 'CRM_PAYMENT_RECORD'],
        [
          { key: 'contractAmt', agg: 'sum', field: 'amount', label: '合同总额', unit: '¥' },
          { key: 'paidAmt', agg: 'sum', field: 'paid_amount', label: '已回款', unit: '¥' },
          { key: 'unpaidAmt', agg: 'sum', field: 'amount', label: '未回款', unit: '¥' },
          { key: 'payRate', agg: 'sum', field: 'amount', label: '回款率', unit: '%' },
        ]
      ),
      permMetrics: {
        payment_amount: ['paidAmt', 'unpaidAmt', 'payRate'],
        contract_amount: ['contractAmt'],
      },
    },

    // ── ② L2C 六段管道（数量 · 金额 · 段间转化率）──
    {
      kind: 'pipeline', title: 'L2C 六段管道',
      dataBinding: AGG(
        ['CRM_DEAL', 'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_ORDER', 'CRM_PAYMENT_RECORD', 'CRM_INVOICE'],
        [
          { key: 'count', agg: 'count', label: '单据数' },
          { key: 'amount', agg: 'sum', label: '金额', unit: '¥' },
        ]
      ),
      permStages: {
        contract_amount: ['contract'],
        payment_amount: ['payment'],
      },
    },

    // ── ③ 进度卡×2 ──
    {
      kind: 'progress-card', title: '回款进度',
      dataBinding: AGG(['CRM_CONTRACT', 'CRM_PAYMENT_RECORD'], [{ key: 'percent', agg: 'sum', label: '回款进度' }]),
      permKey: 'payment_amount',
    },
    {
      kind: 'progress-card', title: '客户健康度',
      dataBinding: AGG(
        ['CRM_ACCOUNT', 'CRM_CONTRACT', 'CRM_PAYMENT_RECORD'],
        [{ key: 'healthScore', agg: 'latest', label: '客户健康度' }]
      ),
    },

    // ── ④ 过程活跃度 ──
    {
      kind: 'kpi-strip', title: '过程活跃度',
      dataBinding: AGG(
        ['CRM_ACCOUNT'],
        [
          { key: 'interactions', agg: 'count', label: '互动次数' },
          { key: 'interactions30d', agg: 'count', label: '30 天互动' },
          { key: 'taskTotal', agg: 'count', label: '决策事件' },
          { key: 'lastFollowDays', agg: 'latest', label: '最近跟进', unit: '天前' },
        ]
      ),
    },

    // ── ⑤ 决策与风险 ──
    {
      kind: 'kpi-strip', title: '决策与风险',
      dataBinding: AGG(
        ['CRM_ACCOUNT'],
        [
          { key: 'decTotal', agg: 'count', label: '决策总数' },
          { key: 'decExc', agg: 'count', label: '例外数' },
          { key: 'excRate', agg: 'sum', label: '例外率', unit: '%' },
        ]
      ),
    },

    // ── ⑥ 明细（下区，决策2：折叠为三组 collapsible，默认收起）──
    {
      kind: 'collapse', title: '客户时间线', open: false,
      components: [
        {
          kind: 'table', title: '时间线',
          dataBinding: { ...ACC, columns: ['ts', 'type', 'title', 'source', 'actor'] },
          columns: ['ts', 'type', 'title', 'source', 'actor'],
        },
      ],
    },
    {
      kind: 'collapse', title: '决策执行足迹', open: false,
      components: [
        {
          kind: 'table', title: '执行足迹',
          dataBinding: { ...ACC, columns: ['ts', 'scenario', 'event', 'suggested', 'confidence', 'tier', 'actual'] },
          columns: ['ts', 'scenario', 'event', 'suggested', 'confidence', 'tier', 'actual'],
        },
      ],
    },
    {
      kind: 'collapse', title: '决策链与先例', open: false,
      components: [
        {
          kind: 'table', title: '决策链',
          dataBinding: { ...ACC, columns: ['decision', 'scenario', 'state', 'disposition', 'precedent'] },
          columns: ['decision', 'scenario', 'state', 'disposition', 'precedent'],
        },
      ],
    },

    { kind: 'attr-field', attrSlug: 'biz', attrType: 'text', label: '客户工商信息', perm: 'biz_info',
      attr: { data_origin: 'external', sourcedFrom: { source: '工商', relation_confidence: 0.92 } } },
    {
      kind: 'reasoning-trace', title: 'AI 洞察',
      steps: [
        { status: 'ok', label: '聚合四源数据' },
        { status: 'ok', label: '权限裁剪' },
        { status: 'ok', label: '生成下一步建议' },
      ],
      dataBinding: ACC,
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S35 schema 非法: ' + v.errors[0]);
