// src/pages/S14.schema.js — S14 决策图谱（/decision-graph）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §3 S14
// 组件：table/subtable(邻居/溯源) + reasoning-trace(因果链)；已有 decision-graph.html
// 端点：GET /api/graph/neighbors(:302) / trace(:323) / impact(:331) / provenance(:339)
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'dashboard',
  title: '决策图谱',
  navigation: { to: '/decision-graph' },
  layout: { columns: 2, theme: 'light' },
  components: [
    // 决策清单（首个组件，数据面 data.components['table']['决策清单']，title 索引防同 kind 碰撞）
    // 契约：全网决策概览，行链接 rowLink 切换决策 → 下方「决策邻居/溯源链」随 ?decisionId= 联动刷新
    {
      kind: 'table',
      title: '决策清单',
      dataBinding: {
        source: 'particle',
        particleType: 'CRM_DEAL',
        filters: [],
        columns: ['decision_id', 'scenario', 'disposition', 'state', 'outcome', 'created_at'],
        rowLink: { textField: 'decision_id', idField: 'decision_id', href: '/decision-graph-board.html?decisionId={id}' },
        metrics: [],
      },
    },
    {
      kind: 'table',
      title: '决策邻居',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], columns: ['decision_id', 'type', 'stage'], metrics: [] },
    },
    {
      kind: 'subtable',
      title: '溯源链',
      mainColumn: 'decision',
      subColumns: ['reason', 'precedent'],
      subRows: 'trace',
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
    {
      kind: 'reasoning-trace',
      steps: [
        { status: 'ok', label: '决策加载' },
        { status: 'ok', label: '关联展开' },
        { status: 'ok', label: '因果链' },
      ],
      // 契约：非 attr-field 组件必须带粒子 dataBinding（validator.js:39，对齐 S02:52）
      dataBinding: { source: 'particle', particleType: 'CRM_DEAL', filters: [], metrics: [] },
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S14 schema 非法: ' + v.errors[0]);