// src/pages/S28.schema.js — S28 智能体配置（/config/agents）
// 定位：agents + role_profiles 编排配置
// 端点：[新增] GET/PUT /api/config/agents（落 agents/role_profiles，复用 src/agent/）
// 组件：table(agent 列表) + subtable(绑定 SKILL) + attr-field(profile 参数) + select(role tag)
// 权限：sysadmin
// 对齐：§6.13 九引擎惰性编排
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '智能体配置',
  navigation: { to: '/config/agents' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '智能体列表',
      dataBinding: { source: 'particle', particleType: 'CRM_PERSON', filters: [], metrics: [], columns: ['agent_id', 'name', 'role', 'status'] },
    },
    {
      kind: 'subtable',
      title: '绑定 SKILL',
      mainColumn: 'agent',
      subColumns: ['skill_id', 'version'],
      subRows: 'skills',
      dataBinding: { source: 'particle', particleType: 'CRM_PERSON', filters: [], metrics: [] },
    },
    { kind: 'attr-field', attrSlug: 'profile_param', attrType: 'text', label: 'Profile 参数', attr: { slug: 'profile_param', data_origin: 'manual' } },
    {
      kind: 'select',
      label: '角色标签',
      name: 'roleTag',
      dataBinding: { source: 'particle', particleType: 'CRM_PERSON', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S28 schema 非法: ' + v.errors[0]);