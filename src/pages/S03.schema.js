// src/pages/S03.schema.js — S03 智能体工作台（/workspace）
// 2026-08-29 重构：两 TAB（任务监控台 / 任务执行详情）；详见 docs/2026-08-29-agent-workbench-twotab-trace-design.md
// TAB1 任务监控台：goal-form(需求→/api/agent/dispatch) + task-monitor(运行中任务) + contract-matrix(合规) + result-card + attr-field
// TAB2 任务执行详情：reasoning-trace(live，按 taskId 订阅 SSE trace + 回放端点)
import { validatePageSchema } from '../page/validator.js';

export const schema = {
  type: 'workspace',
  title: '智能体工作台',
  navigation: { to: '/workspace' },
  layout: { columns: 1, theme: 'light' },
  components: [
    {
      kind: 'tabs',
      tabs: [
        {
          key: 'monitor',
          label: '任务监控台',
          components: [
            {
              kind: 'goal-form',
              action: 'POST /api/agent/dispatch',
              placeholder: '描述任务需求（如：跟进本周逾期商机 / 给蒙电100台做报价测算）',
              label: '任务需求',
            },
            {
              kind: 'task-monitor',
              title: '运行中的任务',
              dataBinding: { source: 'task' },
            },
            {
              kind: 'contract-matrix',
              title: '契约合规矩阵',
              dataBinding: { source: 'contract', columns: ['task', 'agent', 'skill_ok', 'memory_ok', 'success', 'op'] },
            },
            {
              kind: 'result-card',
              title: '最近动作结果',
            },
            {
              kind: 'attr-field',
              attrSlug: 'deal_note',
              attrType: 'text',
              label: '商机备注（表单注入）',
              attr: { slug: 'deal_note', data_origin: 'manual' },
            },
          ],
        },
        {
          key: 'detail',
          label: '任务执行详情',
          components: [
            {
              kind: 'reasoning-trace',
              live: true,
              title: '思考链执行过程',
              steps: [
                { label: '意图解析' },
                { label: '上下文装配' },
                { label: '动作编排' },
              ],
            },
          ],
        },
      ],
    },
  ],
};

const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S03 schema 非法: ' + v.errors[0]);
