// test/http/agent-dispatch.test.js — POST /api/agent/dispatch 调度链路集成测
// 设计：src/http/routes.js 新增端点；src/agent/classify.js 分类；src/kanban/kanban.js 落库
// 注意：dispatch 创建任务后会显式 pumpReadyTasks（弥补无自动泵循环），真实会触发 agent_loop 执行（依赖 LLM）。
//   本集成测仅验证调度链路（鉴权/分类/落库/emit），stub pumpReadyTasks 为立即返回 0，避免重型 agent 执行干扰。
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

vi.mock('../../src/kanban/scheduler.js', () => ({ pumpReadyTasks: vi.fn(async () => 0) }));

let app;
let token;
beforeAll(() => {
  app = createApp();
  token = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice' });
});

beforeEach(async () => {
  await query('TRUNCATE crm.tasks RESTART IDENTITY CASCADE');
});

describe('POST /api/agent/dispatch', () => {
  it('无 token → 401 unauthorized', async () => {
    const res = await app.fetch('/api/agent/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requirement: '跟进本周逾期的商机' }),
    });
    expect(res.status).toBe(401);
  });

  it('需求过短 → 422 needs_clarification + 引导 notes', async () => {
    const res = await app.fetch('/api/agent/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ requirement: '报价' }),
    });
    expect(res.status).toBe(422);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.needsClarification).toBe(true);
    expect(Array.isArray(j.notes)).toBe(true);
  });

  it('合法需求 → 200 ok + taskId 真实落库（intent/level 经 classifyRequirement 分诊）', async () => {
    const res = await app.fetch('/api/agent/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ requirement: '跟进本周逾期的商机' }),
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.ok).toBe(true);
    expect(j.taskId).toBeTruthy();
    expect(j.intent).toBe('followup');
    expect(j.level).toBe('L1');
    // 任务真实落库，payload 含分诊结果
    const rows = (await query('SELECT payload FROM crm.tasks WHERE id=$1', [j.taskId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.intent).toBe('followup');
    expect(rows[0].payload.level).toBe('L1');
    expect(rows[0].payload.owner).toBe('alice');
  });
});
