// src/pages/S04.schema.js — S04 治理视图·智能体监控台（/agents）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S04
// 组件：metric-card×3(健康/审批/覆盖) + table(agent 告警) + subtable(单 agent 任务流)
// 端点：/api/agents + /api/monitor/*(gates/decisions/coverage) + [新增]/api/monitor/sla
// 角色：manager/sysadmin；SSE /events task/trace/approval 域
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '智能体监控台',
  navigation: { to: '/agents' },
  layout: { columns: 2, theme: 'light' },
  components: [
    {
      kind: 'metric-card',
      title: 'Agent 健康',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '在线' }] },
    },
    {
      kind: 'metric-card',
      title: '待审批',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '闸门' }] },
    },
    {
      kind: 'metric-card',
      title: '决策覆盖',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [{ field: null, agg: 'count', label: '场景' }] },
    },
    {
      kind: 'table',
      title: '告警列表',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['agent', 'level', 'message', 'ts'], metrics: [] },
    },
    {
      kind: 'subtable',
      title: '单 Agent 任务流',
      mainColumn: 'agent',
      subColumns: ['task', 'status', 'sla'],
      subRows: 'tasks',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S04 schema 非法: ' + v.errors[0]);