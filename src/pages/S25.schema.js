// src/pages/S25.schema.js — S25 池配置（/config/pool）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S25
// 组件：attr-field(pick_rule/recycle_rule) + select(目标池)；端点 GET/PUT /api/pool-config(:133/:141)
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '池配置',
  navigation: { to: '/config/pool' },
  layout: { columns: 1, theme: 'light' },
  components: [
    { kind: 'attr-field', attrSlug: 'pick_rule', attrType: 'text', label: '拾取规则', attr: { slug: 'pick_rule', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'recycle_rule', attrType: 'text', label: '回收规则', attr: { slug: 'recycle_rule', data_origin: 'rule' } },
    {
      kind: 'select',
      label: '目标池',
      name: 'targetPool',
      action: '/api/pool-config',
      defaultValue: 'org-hq',
      // 契约：非 attr-field 组件必须带粒子 dataBinding（validator.js:39）；
      // dataBinding.options 语义 = 禁用列表（renderer.js:64 读它判 disabled），可选项由数据层经 data.options 注入
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S25 schema 非法: ' + v.errors[0]);