// src/pages/S12.schema.js — S12 发票详情（/invoices/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S12
// 组件：attr-field×N(发票字段，四查) + goal-form(对账→crm-invoice-reconcile)
// 端点：GET /api/particles/:id + crm-invoice-reconcile(写白名单)
// 角色：finance 主；SSE particle 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '发票详情',
  navigation: { to: '/invoices/:id' },
  layout: { columns: 2, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'invoice_no', attrType: 'text', label: '发票号', attr: { slug: 'invoice_no', data_origin: 'external', sourcedFrom: { source: '税务', relation_confidence: 0.98 } } },
    { kind: 'attr-field', attrSlug: 'invoice_amount', attrType: 'currency', label: '发票金额', attr: { slug: 'invoice_amount', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'reconciled', attrType: 'boolean', label: '已对账', attr: { slug: 'reconciled', data_origin: 'rule' } },
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: '执行发票对账',
      label: '对账',
      dataBinding: { source: 'particle', particleType: 'CRM_INVOICE', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S12 schema 非法: ' + v.errors[0]);