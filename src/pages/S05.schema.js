// src/pages/S05.schema.js — S05 待办工作台（四角色视角）（/my-todo）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S05
// + docs/2026-08-28-my-todo-merge-plan.md（导航改名 /todo→/my-todo，schema 同步对齐 CANONICAL_NAV）
// 组件：select(角色视角切换：销售/经理/财务/合同) + table(待办行：类型/客户/L2C阶段/CTA)
// 端点：GET /api/business/board 筛 status + GET /api/monitor/decisions 待决
// 权限：各角色见自己视角；SSE /events approval 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'table',
  title: '待办工作台',
  navigation: { to: '/my-todo' },
  layout: { columns: 1, theme: 'light' },
  components: [
    {
      kind: 'select',
      label: '角色视角',
      name: 'roleView',
      action: '/api/business/board',
      defaultValue: 'sales',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'table',
      title: '待办列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['deal', 'customer', 'stage', 'due', 'action'], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S05 schema 非法: ' + v.errors[0]);