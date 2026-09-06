// src/pages/S06.schema.js — S06 客户 360（含七维画像）（/accounts/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S06
// 组件：attr-field×N(账户属性，四查①/②/③/④徽标) + subtable(关联 DEAL/CONTACT)
//       + metric-card×7(七维画像 identity/structure/semantics/time_config/decision_history/operational_state/governance)
//       + reasoning-trace(AI 客户洞察)
// 端点：GET /api/particles/:id(routes.js:89) + crm-account-360(读白名单) + GET /api/graph/neighbors(routes.js:344)
// 七维：本页画像卡直接消费 sevenDimensionsCheck(accountId, ctx)，缺失维标红
// 角色：sales 只读+部分写 / manager 全 / finance 看回款
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '客户 360',
  navigation: { to: '/accounts/:id' },
  layout: { columns: 3, theme: 'light' },
  components: [
    // 四查示范：name=①人工 / industry=④外部 / status=③规则派生
    { kind: 'attr-field', attrSlug: 'name', attrType: 'text', label: '客户名称', attr: { slug: 'name', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'industry', attrType: 'text', label: '所属行业', attr: { slug: 'industry', data_origin: 'external', sourcedFrom: { source: '工商', relation_confidence: 0.92 } } },
    { kind: 'attr-field', attrSlug: 'status', attrType: 'select', label: '客户状态', attr: { slug: 'status', data_origin: 'rule' } },
    // 最新动态（设计：摘要页展示最近事件 3 条，替代原关联 subtable）
    {
      kind: 'table',
      title: '最新动态',
      dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [], columns: ['ts', 'type', 'title'] },
      columns: ['ts', 'type', 'title'],
    },
    // AI 建议（设计：下一步建议）
    {
      kind: 'result-card',
      title: 'AI 下一步建议',
      dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] },
    },
    // 七维画像 metric-card×7（identity 缺失→标红，由运行时 sevenDimensionsCheck 注入）
    { kind: 'metric-card', title: '身份', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
    { kind: 'metric-card', title: '结构', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
    { kind: 'metric-card', title: '语义', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
    { kind: 'metric-card', title: '时间与配置', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
    { kind: 'metric-card', title: '决策历史', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
    { kind: 'metric-card', title: '运营状态', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
    { kind: 'metric-card', title: '治理', dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] } },
    {
      kind: 'reasoning-trace',
      steps: [
        { status: 'ok', label: '画像装配' },
        { status: 'ok', label: '七维校验' },
        { status: 'ok', label: '洞察建议' },
      ],
      dataBinding: { source: 'particle', particleType: 'CRM_ACCOUNT', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S06 schema 非法: ' + v.errors[0]);