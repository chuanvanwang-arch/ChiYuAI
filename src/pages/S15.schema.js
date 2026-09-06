// src/pages/S15.schema.js — S15 业务看板（L2C 全链路）（/business-board）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S15
// 组件：metric-card×N(L2C 六段) + table(grouped by stage)；端点 GET /api/business/board(:154)
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '业务看板 · L2C 全链路',
  navigation: { to: '/business-board' },
  layout: { columns: 3, theme: 'light' },
  components: [
    { kind: 'metric-card', title: '线索', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: 'leads' }] } },
    { kind: 'metric-card', title: '商机', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: 'opportunities' }] } },
    { kind: 'metric-card', title: '报价', dataBinding: { source: 'particle', particleType: 'CRM_QUOTATION', filters: [], metrics: [{ field: null, agg: 'count', label: 'quotations' }] } },
    { kind: 'metric-card', title: '合同', dataBinding: { source: 'particle', particleType: 'CRM_CONTRACT', filters: [], metrics: [{ field: null, agg: 'count', label: 'contracts' }] } },
    { kind: 'metric-card', title: '订单', dataBinding: { source: 'particle', particleType: 'CRM_ORDER', filters: [], metrics: [{ field: null, agg: 'count', label: 'orders' }] } },
    { kind: 'metric-card', title: '回款', dataBinding: { source: 'particle', particleType: 'CRM_PAYMENT_RECORD', filters: [], metrics: [{ field: null, agg: 'count', label: 'payments' }] } },
    {
      kind: 'table',
      title: 'L2C 阶段分布',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['stage', 'name', 'amount'], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S15 schema 非法: ' + v.errors[0]);