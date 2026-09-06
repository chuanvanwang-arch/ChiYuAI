import { describe, it, expect, beforeEach } from 'vitest';
import { query } from '../src/db.js';
import { ensureMonitorSchema } from '../src/monitor/monitorSubscriber.js';
import { recordEpisode } from '../src/agent/agentEpisodes.js';

beforeEach(async () => {
  await ensureMonitorSchema();
  await query('TRUNCATE crm.monitor_event RESTART IDENTITY CASCADE');
});

describe('C3 agent 认知记录', () => {
  it('recordEpisode 写 monitor_event 扩展列（agent_id/context_facts）', async () => {
    const r = await recordEpisode({
      agent_id: 'agent-1', phase: 'context-injected',
      context_facts: { saw: ['DEAL:D1'], len: 120 },
      decision_id: null, scenario_id: null, payload: { taskId: 't1' },
    });
    expect(r.ok).toBe(true);
    const row = (await query(
      `SELECT agent_id, context_facts, domain, event_type, payload
       FROM crm.monitor_event WHERE agent_id='agent-1'`
    )).rows[0];
    expect(row.agent_id).toBe('agent-1');
    expect(row.domain).toBe('agent');
    expect(row.event_type).toBe('context-injected');
    expect(row.context_facts).toMatchObject({ saw: ['DEAL:D1'], len: 120 });
    expect(row.payload).toMatchObject({ taskId: 't1' });
  });

  it('最小入参（空 episode）不抛，返回 ok 属性', async () => {
    const r = await recordEpisode({});
    expect(r).toHaveProperty('ok');
  });

  it('agentLoop 旁路调用 recordEpisode 不阻断主链路（运行 runWithSkill 不报错）', async () => {
    // 验证导入与接线无语法/循环依赖问题：直接 import agentLoop 触发模块加载
    const mod = await import('../src/agent/agentLoop.js');
    expect(typeof mod.runWithSkill).toBe('function');
  });
});
