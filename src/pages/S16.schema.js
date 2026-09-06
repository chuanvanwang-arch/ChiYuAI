// src/pages/S16.schema.js — S16 LLM 配置（/config/llm）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S16 + 计划 §4 Task26
// 定位：provider/model/key/temperature 配置。api_key 经 pgcrypto 加密存储，明文不入日志。
// 端点：createConfigRouter key='llm'（GET/PUT /api/config/llm）——Task7 已挂载 src/http/routes.js
// 组件：attr-field(provider/model/api_key[secret]/temperature/max_tokens) + table(已配置列表) + select(启用默认)
// 权限：sysadmin 仅。
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: 'LLM 配置',
  navigation: { to: '/config/llm' },
  layout: { columns: 2, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'provider', attrType: 'text', label: '提供商', attr: { slug: 'provider', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'model', attrType: 'text', label: '模型', attr: { slug: 'model', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'api_key', attrType: 'text', label: 'API 密钥(加密存储)', attr: { slug: 'api_key', data_origin: 'external', sourcedFrom: { source: 'secret-vault', relation_confidence: 0.99 } } },
    { kind: 'attr-field', attrSlug: 'temperature', attrType: 'number', label: '温度', attr: { slug: 'temperature', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'max_tokens', attrType: 'number', label: '最大 Tokens', attr: { slug: 'max_tokens', data_origin: 'manual' } },
    {
      kind: 'select',
      label: '启用默认',
      name: 'activeProvider',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
    {
      kind: 'table',
      title: '已配置 LLM 列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['provider', 'model', 'temperature', 'enabled'] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S16 schema 非法: ' + v.errors[0]);