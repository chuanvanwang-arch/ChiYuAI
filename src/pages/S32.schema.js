// src/pages/S32.schema.js — S32 连接器 / MCP 配置（/config/connectors）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S32 + 计划 §4 Task41
// 定位：外部连接器 / MCP Server 引用管理；credential_ref 加密存储。
// 端点：createConfigRouter key='connectors'（GET/PUT /api/config/connectors，落 connectors 表，Task9 迁移已建）
// 组件：table(连接器列表) + attr-field(endpoint/credential_ref[secret]) + select(enable)
// 权限：sysadmin
// 对齐：§6.13 无头设计 + MCP Server 暴露（3001 /mcp）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '连接器 / MCP 配置',
  navigation: { to: '/config/connectors' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '连接器列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['connector_id', 'name', 'endpoint', 'enabled'] },
    },
    { kind: 'attr-field', attrSlug: 'endpoint', attrType: 'text', label: '端点', attr: { slug: 'endpoint', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'credential_ref', attrType: 'text', label: '凭证引用(加密存储)', attr: { slug: 'credential_ref', data_origin: 'external', sourcedFrom: { source: 'secret-vault', relation_confidence: 0.99 } } },
    {
      kind: 'select',
      label: '启用',
      name: 'enabled',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S32 schema 非法: ' + v.errors[0]);