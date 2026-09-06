// src/pages/S01.schema.js — S01 登录 + 系统状态墙（/）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S01
// 组件：goal-form(登录 POST /api/auth/login) + 4×metric-card(装配/计数/审批/最新) + table(最新粒子)
// 端点：POST /api/auth/login / GET /api/auth/me / GET /api/business/board
// 值域对齐：src/page/schema.js（PAGE_TYPES/COMPONENT_KINDS/PARTICLE_TYPES_ENUM）；组件统一带 dataBinding（validator 契约）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '系统状态墙',
  navigation: { to: '/home' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'goal-form',
      action: 'POST /api/auth/login',
      placeholder: 'username',
      label: '登录',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'metric-card',
      title: '装配校验',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '已装配' }] },
    },
    {
      kind: 'metric-card',
      title: '看板任务',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '计数' }] },
    },
    {
      kind: 'metric-card',
      title: '审批待处理',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '待办' }] },
    },
    {
      kind: 'table',
      title: '最新粒子活动',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['name', 'stage', 'amount'], metrics: [] },
    },
  ],
};

// 启动即校验（非法立即失败，不静默）
const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S01 schema 非法: ' + v.errors[0]);