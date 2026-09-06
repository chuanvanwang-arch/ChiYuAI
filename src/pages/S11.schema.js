// src/pages/S11.schema.js — S11 回款计划/回款记录（/payments/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S11
// 组件：attr-field×N(回款字段，四查多为③规则派生只读) + subtable(计划vs实收)
//       + goal-form(登记回款→crm-payment-record-create)
// 端点：GET /api/particles/:id + crm-payment-record-create(写白名单)
// 角色：finance 主；SSE particle/approval 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '回款详情',
  navigation: { to: '/payments/:id' },
  layout: { columns: 2, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'payment_no', attrType: 'text', label: '回款编号', attr: { slug: 'payment_no', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'due_amount', attrType: 'currency', label: '计划金额', attr: { slug: 'due_amount', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'paid_amount', attrType: 'currency', label: '实收金额', attr: { slug: 'paid_amount', data_origin: 'manual' } },
    {
      kind: 'subtable',
      title: '计划 vs 实收',
      mainColumn: 'plan',
      subColumns: ['paid', 'gap', 'status'],
      subRows: 'records',
      dataBinding: { source: 'particle', particleType: 'CRM_PAYMENT_PLAN', filters: [], metrics: [] },
    },
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: '登记本次回款',
      label: '登记回款',
      dataBinding: { source: 'particle', particleType: 'CRM_PAYMENT_RECORD', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S11 schema 非法: ' + v.errors[0]);