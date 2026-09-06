// src/pages/S26.schema.js — S26 预警规则配置（/config/alerts）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S26 + 计划 §4 Task35
// 定位：五类告警（§3.10）+ 自定义规则
// 端点：createConfigRouter key='alerts'（GET/PUT /api/config/alerts，落 alert_registry，复用 alertRegistry.js+timers.js）
// 组件：table(规则列表) + attr-field(trigger/condition/channel) + select(severity)
// 权限：manager/sysadmin
// 对齐：阶段3 lead_overdue 等已落地预警
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'form',
  title: '预警规则配置',
  navigation: { to: '/config/alerts' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'table',
      title: '预警规则列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], columns: ['rule_id', 'trigger', 'condition', 'channel', 'severity'] },
    },
    { kind: 'attr-field', attrSlug: 'trigger', attrType: 'text', label: '触发', attr: { slug: 'trigger', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'condition', attrType: 'text', label: '条件', attr: { slug: 'condition', data_origin: 'rule' } },
    { kind: 'attr-field', attrSlug: 'channel', attrType: 'select', label: '渠道', attr: { slug: 'channel', data_origin: 'rule' } },
    {
      kind: 'select',
      label: '严重度',
      name: 'severity',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [], options: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S26 schema 非法: ' + v.errors[0]);