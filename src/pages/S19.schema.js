// src/pages/S19.schema.js — S19 销售决策场景配置（/config/decision-scenarios）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S19 + 计划 §4 Task29
// 端点：createConfigRouter key='decision-scenarios'（GET/PUT /api/config/decision-scenarios，routes.js 挂载）
// 组件：table(场景列表) + attr-field(场景名/触发/自主策略/方法论ids) + subtable(评估维度) + select(自主边界等级)
// 权限：manager 编辑 / presales 只读 / sysadmin
// 对齐：§6 决策主轴；methodology_ids 引用 S21 注册表
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '销售决策场景配置',
  navigation: { to: '/config/decision-scenarios' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '决策场景列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['scenario_name', 'trigger', 'auto_decision', 'methodology_ids'] },
    },
    { kind: 'attr-field', attrSlug: 'scenario_name', attrType: 'text', label: '场景名称', attr: { slug: 'scenario_name', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'trigger', attrType: 'text', label: '触发条件', attr: { slug: 'trigger', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'auto_decision', attrType: 'boolean', label: '自主决策', attr: { slug: 'auto_decision', data_origin: 'manual' } },
    {
      kind: 'select',
      label: '自主边界等级',
      name: 'autonomyLevel',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
    {
      kind: 'subtable',
      title: '评估维度',
      mainColumn: 'dimension',
      subColumns: ['weight', 'threshold'],
      subRows: 'dims',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S19 schema 非法: ' + v.errors[0]);