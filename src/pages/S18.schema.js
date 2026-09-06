// src/pages/S18.schema.js — S18 权限/RBAC 矩阵（/config/rbac）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S18 + 计划 §4 Task28
// 定位：角色 × 粒子 × Action 权限矩阵（六角色）
// 端点：GET/PUT /api/config/rbac（复用 createConfigRouter key='rbac'，落 field_permission 类表）
// 组件：table(矩阵) + select(批量赋权)
// 权限：sysadmin
// 对齐：modeFor 引擎（fieldPermission.js）共用
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '权限 / RBAC 矩阵',
  navigation: { to: '/config/rbac' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '角色×粒子×Action 矩阵',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['role', 'particle', 'action', 'perm'] },
    },
    {
      kind: 'select',
      label: '批量赋权',
      name: 'batchAssign',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
    {
      kind: 'select',
      label: '权限模式',
      name: 'permMode',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S18 schema 非法: ' + v.errors[0]);