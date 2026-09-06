// src/pages/S10.schema.js — S10 订单详情（/orders/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S10
// 组件：attr-field×N(订单行字段，四查) + subtable(履约节点) + goal-form(推进→crm-order-advance)
// 端点：GET /api/particles/:id + crm-order-advance(写白名单)
// 角色：sales/contract_admin；SSE particle 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '订单详情',
  navigation: { to: '/orders/:id' },
  layout: { columns: 2, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'order_no', attrType: 'text', label: '订单号', attr: { slug: 'order_no', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'order_amount', attrType: 'currency', label: '订单金额', attr: { slug: 'order_amount', data_origin: 'manual' } },
    {
      kind: 'subtable',
      title: '履约节点',
      mainColumn: 'node',
      subColumns: ['plan', 'actual', 'status'],
      subRows: 'nodes',
      dataBinding: { source: 'particle', particleType: 'CRM_ORDER', filters: [], metrics: [] },
    },
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: '推进订单到下一履约节点',
      label: '订单推进',
      dataBinding: { source: 'particle', particleType: 'CRM_ORDER', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S10 schema 非法: ' + v.errors[0]);