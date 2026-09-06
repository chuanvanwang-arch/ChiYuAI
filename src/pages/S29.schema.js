// src/pages/S29.schema.js — S29 门户/页面生成配置（/config/portal-pages）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S29 + 计划 §4 Task38
// 定位：page schema / NL 模板管理（配置界面与 AI 生成共用渲染器）
// 端点：GET /api/pages(routes.js:179) + POST /api/page/from-nl(routes.js:171) + publish/revert/preview(:184/:191/:198)
// 组件：table(已生成页面) + goal-form(NL 生成) + subtable(schema 预览) + select(publish/revert)
// 权限：sysadmin（页面发布）
// 对齐：§8.3.6；本蓝图全部 33 面均可经此由 NL 生成临时页
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '门户/页面生成配置',
  navigation: { to: '/config/portal-pages' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '已生成页面',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['page_id', 'title', 'type', 'status'] },
    },
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: 'NL 生成页面（如：给我商机看板）',
      label: 'NL 生成',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'subtable',
      title: 'Schema 预览',
      mainColumn: 'page',
      subColumns: ['component', 'kind', 'binding'],
      subRows: 'schema',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'select',
      label: '发布操作',
      name: 'publishAction',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S29 schema 非法: ' + v.errors[0]);