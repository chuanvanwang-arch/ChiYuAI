// src/pages/S23.schema.js — S23 业务分级配置（/config/business-tier）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S23 + 计划 §4 Task33
// 定位：DEAL = 客户维 × 项目维 分级（配置定义非硬编码，驱动自主边界）
// 端点：createConfigRouter key='business-tier'（GET/PUT /api/config/business-tier）
// 组件：table(分级矩阵) + attr-field(维度定义) + select(自主等级映射)
// 权限：manager/sysadmin
// 对齐：§6 业务分级驱动自主边界
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '业务分级配置',
  navigation: { to: '/config/business-tier' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '分级矩阵（客户维 × 项目维）',
      // tier_status / approved_by（2026-09-16 A2/A4）：配置面必须能看出"这条还生效吗 / 谁批的"——
      //   否则页面把已撤回的规则照旧显示成分级 = 配置面与执行面不一致（E1 类假绿）。
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['tier', 'tier_status', 'approved_by', 'customer_dim', 'project_dim', 'autonomy_level'] },
    },
    { kind: 'attr-field', attrSlug: 'customer_dim', attrType: 'text', label: '客户维定义', attr: { slug: 'customer_dim', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'project_dim', attrType: 'text', label: '项目维定义', attr: { slug: 'project_dim', data_origin: 'rule' } },
    {
      kind: 'select',
      label: '自主等级映射',
      name: 'autonomyLevel',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S23 schema 非法: ' + v.errors[0]);