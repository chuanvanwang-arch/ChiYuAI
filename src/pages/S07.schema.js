// src/pages/S07.schema.js — S07 商机/线索详情（/deals/:id）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S07
// 组件：attr-field×N(商机字段，四查孤儿标 unverified) + subtable(报价/合同/回款)
//       + metric-card(金额/赢率) + reasoning-trace(MEDDICC 评估) + goal-form(推进→crm-deal-advance)
// 端点：GET /api/particles/:id + crm-deal-advance(写白名单) + GET /api/monitor/decisions
// 七维：推进到 quoted/contracted 前触发 S20 场景 sevenDimensionsCheck，缺失→missing_context 拦
// 角色：sales 写 / manager 审；SSE particle/approval 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'detail',
  title: '商机详情',
  navigation: { to: '/deals/:id' },
  layout: { columns: 2, theme: 'light' },
  components: [
    // 四查：孤儿字段演示——attr 对象存在但缺 data_origin → 渲染期 unverified + 禁用（renderer.js:81-84）
    { kind: 'attr-field', attrSlug: 'deal_name', attrType: 'text', label: '商机名称', attr: { slug: 'deal_name' } },
    { kind: 'attr-field', attrSlug: 'amount', attrType: 'currency', label: '金额', attr: { slug: 'amount', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'stage', attrType: 'select', label: '阶段', attr: { slug: 'stage', data_origin: 'rule' } },
    {
      kind: 'subtable',
      title: '报价/合同/回款',
      mainColumn: 'doc',
      subColumns: ['type', 'state', 'amount'],
      subRows: 'docs',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'metric-card',
      title: '赢率',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'avg', label: 'MEDDICC' }] },
    },
    {
      kind: 'reasoning-trace',
      steps: [
        { status: 'ok', label: 'MEDDICC 评估' },
        { status: 'warn', label: '决策历史' },
        { status: 'pending', label: '推进建议' },
      ],
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'goal-form',
      action: 'POST /api/page/from-nl',
      placeholder: '推进到下一阶段（quoted/contracted）',
      label: '阶段推进',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S07 schema 非法: ' + v.errors[0]);