// src/pages/S22.schema.js — S22 审批流配置（/config/approvals）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S22 + 计划 §4 Task32
// 端点：createConfigRouter key='approvals'（GET/PUT /api/config/approvals，复用 seed 4 流）
// 组件：table(审批流列表) + subtable(节点:角色/条件) + select(域:deal/quotation/contract/invoice)
// 权限：manager/sysadmin
// 对齐：G21 四审批域（deal/quote/contract/invoice 四流）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '审批流配置',
  navigation: { to: '/config/approvals' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '审批流列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['flow_id', 'domain', 'name', 'enabled'] },
    },
    {
      kind: 'subtable',
      title: '节点(角色/条件)',
      mainColumn: 'node',
      subColumns: ['role', 'condition'],
      subRows: 'nodes',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'select',
      label: '审批域',
      name: 'approvalDomain',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S22 schema 非法: ' + v.errors[0]);