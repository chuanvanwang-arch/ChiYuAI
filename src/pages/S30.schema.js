// src/pages/S30.schema.js — S30 决策质量监控（/config/decision-quality）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S30 + 计划 §4 Task39
// 定位：决策质量指标 / 覆盖度看板
// 页面类型：dashboard（对齐蓝图「决策质量监控」）
// 组件：metric-card(覆盖度/先例命中) + table(决策列表) + reasoning-trace(偏差分析)
// 端点：GET /api/monitor/coverage(routes.js:244) + /decisions(234) + /gates(220)
// 权限：manager/sysadmin
// 对齐：§6.4 决策质量监控
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '决策质量监控',
  navigation: { to: '/config/decision-quality' },
  layout: { columns: 2, theme: 'light' },
  components: [
    { kind: 'metric-card', title: '覆盖率', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '场景覆盖' }] } },
    { kind: 'metric-card', title: '先例命中率', dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: 'precedent hits' }] } },
    {
      kind: 'table',
      title: '决策列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['decision_id', 'type', 'stage', 'coverage'], metrics: [] },
    },
    {
      kind: 'reasoning-trace',
      steps: [
        { status: 'ok', label: '覆盖度加载' },
        { status: 'ok', label: '先例匹配' },
        { status: 'pending', label: '偏差分析' },
      ],
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S30 schema 非法: ' + v.errors[0]);