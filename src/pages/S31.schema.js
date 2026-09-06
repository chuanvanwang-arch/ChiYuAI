// src/pages/S31.schema.js — S31 记忆/先例管理（/config/memory）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S31 + 计划 §4 Task40
// 定位：记忆三构件（流水→经验→先例）蒸馏与治理
// 端点：POST /api/memory/distill(routes.js:205)（触发蒸馏）
// 组件：table(记忆条目) + subtable(蒸馏版本) + goal-form(触发蒸馏)
// 权限：sysadmin
// 对齐：§6.8 记忆生命周期（30 天蒸馏降权）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '记忆/先例管理',
  navigation: { to: '/config/memory' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '记忆条目',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['memory_id', 'kind', 'created_at', 'weight'] },
    },
    {
      kind: 'subtable',
      title: '蒸馏版本',
      mainColumn: 'version',
      subColumns: ['from', 'to', 'note'],
      subRows: 'versions',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'goal-form',
      action: 'POST /api/memory/distill',
      placeholder: '触发蒸馏（流水→经验→先例）',
      label: '蒸馏',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S31 schema 非法: ' + v.errors[0]);