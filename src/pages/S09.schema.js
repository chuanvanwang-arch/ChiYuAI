// src/pages/S09.schema.js — S09 合同详情（/contracts/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S09
// 组件：attr-field×N(条款/金额字段，四查) + subtable(回款计划/发票) + reasoning-trace(条款风险)
//       + goal-form(提交审批→crm-payment-plan-create)
// 端点：GET /api/particles/:id + crm-payment-plan-create(写白名单)
// 角色：contract_admin 主 / finance 看回款；SSE particle/approval 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '合同详情',
  navigation: { to: '/contracts/:id' },
  layout: { columns: 2, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'contract_no', attrType: 'text', label: '合同编号', attr: { slug: 'contract_no', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'contract_amount', attrType: 'currency', label: '合同金额', attr: { slug: 'contract_amount', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'sign_date', attrType: 'timestamp', label: '签订日期', attr: { slug: 'sign_date', data_origin: 'rule' } },
    {
      kind: 'subtable',
      title: '回款计划/发票',
      mainColumn: 'doc',
      subColumns: ['type', 'due', 'amount', 'status'],
      subRows: 'docs',
      dataBinding: { source: 'particle', particleType: 'CRM_CONTRACT', filters: [], metrics: [] },
    },
    {
      kind: 'reasoning-trace',
      steps: [
        { status: 'ok', label: '条款解析' },
        { status: 'warn', label: '回款风险' },
        { status: 'pending', label: '修订建议' },
      ],
      dataBinding: { source: 'particle', particleType: 'CRM_CONTRACT', filters: [], metrics: [] },
    },
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: '提交审批/创建回款计划',
      label: '合同动作',
      dataBinding: { source: 'particle', particleType: 'CRM_CONTRACT', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S09 schema 非法: ' + v.errors[0]);