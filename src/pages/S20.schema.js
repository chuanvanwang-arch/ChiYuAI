// src/pages/S20.schema.js — S20 七维设计（决策场景级完整性校验）  /config/seven-dim  ★D3
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S20
// 端点：createSevenDimRouter（routes.js 挂 /api/config/seven-dim；sysadmin 闸 + 写经第0闸）
//       GET → {dims, scenarios, default_strictness}；PUT → {scenario_id, required_dims} | {default_strictness}
//       落点：按场景写 decision_scenario.required_dims(JSONB [{dim,on_missing}])；
//       全局默认严格度落 config_store['seven-dim'].default_strictness
// 组件：table(场景×七维矩阵) + select(默认严格度) + form(新增场景行：scenario_id + 七维严格度×7 + strictness)
// 七维常量：identity/structure/semantics/time_config/decision_history/operational_state/governance
//          （唯一源 src/sevenDimensions/constants.js SEVEN_DIMS）
// 权限：sysadmin 编辑 / presales 只读；S06/S07 直接消费本面配置
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '七维设计 · 决策场景完整性校验',
  navigation: { to: '/config/seven-dim' },
  layout: { columns: 3, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '场景×七维校验矩阵',
      dataBinding: {
        source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [],
        columns: ['scenario', 'identity', 'structure', 'semantics', 'time_config', 'decision_history', 'operational_state', 'governance', 'strictness'],
      },
    },
    {
      kind: 'select',
      label: '默认严格度',
      name: 'default_strictness',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
    { kind: 'attr-field', attrSlug: 'scenario_id', attrType: 'text', label: '场景 ID', attr: { slug: 'scenario_id', data_origin: 'manual' } },
    { kind: 'attr-field', attrSlug: 'identity', attrType: 'select', label: '身份维(未要求/warn/block)', attr: { slug: 'identity', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'structure', attrType: 'select', label: '结构维(未要求/warn/block)', attr: { slug: 'structure', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'semantics', attrType: 'select', label: '语义维(未要求/warn/block)', attr: { slug: 'semantics', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'time_config', attrType: 'select', label: '时间与配置维(未要求/warn/block)', attr: { slug: 'time_config', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'decision_history', attrType: 'select', label: '决策历史维(未要求/warn/block)', attr: { slug: 'decision_history', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'operational_state', attrType: 'select', label: '运行状态维(未要求/warn/block)', attr: { slug: 'operational_state', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'governance', attrType: 'select', label: '治理维(未要求/warn/block)', attr: { slug: 'governance', data_origin: 'rule', options: ['', 'warn', 'block'] } },
    { kind: 'attr-field', attrSlug: 'strictness', attrType: 'select', label: '严格度(未要求/warn/block)', attr: { slug: 'strictness', data_origin: 'manual', options: ['', 'warn', 'block'] } },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S20 schema 非法: ' + v.errors[0]);