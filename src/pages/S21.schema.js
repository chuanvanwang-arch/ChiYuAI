// src/pages/S21.schema.js — S21 方法论 SKILL 注册表（/config/skills）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S21 + 计划 §4 Task31
// 端点：createConfigRouter key='skill-registry'（GET/PUT /api/config/skill-registry，落 skill_registry）
// 组件：table(skill_id/category/enabled/version/rbac_roles) + select(enabled 开关) + select(rbac_roles)
// 权限：sysadmin
// 对齐：§6.6 Skills-as-a-Service（停用→引擎不装载、市场不暴露）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '方法论 SKILL 注册表',
  navigation: { to: '/config/skills' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: 'SKILL 列表',
      dataBinding: { source: 'particle', particleType: 'CRM_KNOWLEDGE', filters: [], metrics: [], columns: ['skill_id', 'category', 'enabled', 'version', 'rbac_roles'] },
    },
    {
      kind: 'select',
      label: '启用开关',
      name: 'enabled',
      dataBinding: { source: 'particle', particleType: 'CRM_KNOWLEDGE', filters: [], metrics: [], options: [] },
    },
    {
      kind: 'select',
      label: 'RBAC 角色',
      name: 'rbac_roles',
      dataBinding: { source: 'particle', particleType: 'CRM_KNOWLEDGE', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S21 schema 非法: ' + v.errors[0]);