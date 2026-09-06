// src/pages/S13.schema.js — S13 粒子详情（通用）（/particles/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S13
// 定位：任意粒子通用详情（particle-detail.html）；schema 由 /api/particles/:id/schema 动态组装
// 此静态 schema 为「默认骨架」：运行时以动态组装 schema 覆盖（attr-field 四查徽标 + subtable 关联）
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '粒子详情',
  navigation: { to: '/particles/:id' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'metric-card',
      title: '粒子信息',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S13 schema 非法: ' + v.errors[0]);