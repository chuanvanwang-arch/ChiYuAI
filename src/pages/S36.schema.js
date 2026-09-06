// src/pages/S36.schema.js — S36 漏斗质量看板（/funnel-quality）受控页签
// 设计输入：docs/2026-08-30-sales-p0-p1-taoran-bantcc-swas-funnel-design.md §5.3
//   「新增 src/pages/S36.schema.js（漏斗质量看板）+ src/http/funnelRouter.js；受控渲染，不写自由 HTML」
// 受控契约：
//   - 与既有 S02/S15/S33 同构（type=dashboard + navigation.to + layout + components 带 dataBinding）
//   - 明细表走 source:'particle'（CRM_DEAL），受四护栏约束（状态字段 filter 仅 eq）
//   - 派生指标（健康性 KPI）由服务端注入，schema 只声明形（与 S33 同范式）
//   - 阈值/加权值/抖动/承诺带一律来自 config_store['sales-thresholds'].funnel，schema 不硬编码任何业务阈值
// 数据面（服务端注入，见 routes.js /api/page/funnel-quality）：
//   - kpi-strip「漏斗健康性」：销售潜力 / 年度目标 / 已签单 / 加权额 / 抖动率
//   - table「MANT 缺失清单」：真实性——M/A/N/T 四要素缺失的商机（来自 /api/funnel/quality.authenticity）
//   - table「商机明细」：按漏斗区域/预测分类列商机（来自 /api/funnel/deals）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '漏斗质量看板',
  navigation: { to: '/funnel-quality' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'kpi-strip',
      title: '漏斗健康性',
      dataBinding: {
        // 派生指标：跨 CRM_DEAL 聚合（加权额/销售潜力/抖动率/承诺兑现），单粒子类型无法诚实表达
        source: 'aggregate',
        sources: ['CRM_DEAL'],
        // 派生指标：值由服务端注入（routes.js /api/page/funnel-quality 按组件标题注入 items），
        // 此处仅声明形；契约要求 metrics 为对象数组且 key 必填（validator.js:86）
        metrics: [
          { key: 'salesPotential', label: '销售潜力' },
          { key: 'annualTarget', label: '年度目标' },
          { key: 'closedAmount', label: '已签单' },
          { key: 'weightedTotal', label: '加权额' },
          { key: 'jitterRate', label: '抖动率' },
        ],
      },
    },
    {
      kind: 'table',
      title: '漏斗区域分布',
      dataBinding: {
        source: 'particle',
        particleType: 'CRM_DEAL',
        filters: [],
        columns: ['zone', 'count'],
        metrics: [],
      },
    },
    {
      kind: 'table',
      title: '预测分类分布',
      dataBinding: {
        source: 'particle',
        particleType: 'CRM_DEAL',
        filters: [],
        columns: ['forecastClass', 'count'],
        metrics: [],
      },
    },
    {
      kind: 'table',
      title: 'MANT 缺失清单',
      dataBinding: {
        source: 'particle',
        particleType: 'CRM_DEAL',
        // 真实性：M(A/N/T) 四要素缺失由服务端按 funnelQuality.mantOk 计算后注入行，
        // 非状态字段过滤（stage 等状态字段若需过滤则仅 eq）
        filters: [],
        columns: ['title', 'missing', 'zone', 'forecastClass'],
        metrics: [],
      },
    },
    {
      kind: 'table',
      title: '承诺兑现',
      dataBinding: {
        // 承诺兑现：监控指标不考核——承诺金额 vs 实际（funnel.committed），评价带来自配置
        source: 'particle',
        particleType: 'CRM_DEAL',
        filters: [],
        columns: ['title', 'rate', 'level'],
        metrics: [],
      },
    },
    {
      kind: 'table',
      title: '商机明细',
      dataBinding: {
        source: 'particle',
        particleType: 'CRM_DEAL',
        filters: [],
        columns: ['title', 'stage', 'zone', 'forecastClass', 'weighted', 'mantOk', 'expectedAmount'],
        metrics: [],
      },
    },
  ],
};

// 启动即校验（非法立即失败，不静默）
const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S36 schema 非法: ' + v.errors[0]);
