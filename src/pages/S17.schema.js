// src/pages/S17.schema.js — S17 用户管理（/config/users）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S17 + 计划 §4 Task27
// 定位：crm_users 增删改 + 角色绑定；写端点 POST/PUT /api/config/users（落 crm.crm_users）
// 页面类型：table + form
// 组件：table(用户列表) + attr-field(username/display_name/role/password[secret]) + select(role∈六角色)
// 权限：sysadmin
// 备注：表结构见 stage3-portal-home-design.md §5
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '用户管理',
  navigation: { to: '/config/users' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '用户列表',
      dataBinding: { source: 'particle', particleType: 'CRM_PERSON', filters: [], metrics: [], columns: ['username', 'display_name', 'role', 'status'] },
    },
    { kind: 'attr-field', attrSlug: 'username', attrType: 'text', label: '用户名', attr: { slug: 'username', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'display_name', attrType: 'text', label: '显示名', attr: { slug: 'display_name', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'role', attrType: 'select', label: '角色', attr: { slug: 'role', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'password', attrType: 'text', label: '密码(secret)', attr: { slug: 'password', data_origin: 'manual' } },
    {
      kind: 'select',
      label: '角色绑定',
      name: 'roleBind',
      dataBinding: { source: 'particle', particleType: 'CRM_PERSON', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S17 schema 非法: ' + v.errors[0]);