// src/pages/S08.schema.js — S08 报价详情（/quotations/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S08
// 组件：attr-field×N(报价行/金额字段，四查) + subtable(明细行) + table(历史版本)
//       + goal-form(生成/刷新技术方案/报价)
// 端点：GET /api/particles/:id + QUOTATION 写白名单
// 角色：sales/presales 写；SSE particle 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '报价详情',
  navigation: { to: '/quotations/:id' },
  layout: { columns: 2, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'quote_no', attrType: 'text', label: '报价单号', attr: { slug: 'quote_no', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'total_amount', attrType: 'currency', label: '总金额', attr: { slug: 'total_amount', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'valid_until', attrType: 'timestamp', label: '有效期至', attr: { slug: 'valid_until', data_origin: 'rule' } },
    {
      kind: 'subtable',
      title: '报价明细行',
      mainColumn: 'line',
      subColumns: ['product', 'qty', 'price', 'amount'],
      subRows: 'lines',
      dataBinding: { source: 'particle', particleType: 'CRM_QUOTATION', filters: [], metrics: [] },
    },
    {
      kind: 'table',
      title: '历史版本',
      dataBinding: { source: 'particle', particleType: 'CRM_QUOTATION', filters: [], columns: ['version', 'amount', 'updated_at'], metrics: [] },
    },
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: '重新生成技术方案/报价',
      label: '生成/刷新',
      dataBinding: { source: 'particle', particleType: 'CRM_QUOTATION', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S08 schema 非法: ' + v.errors[0]);