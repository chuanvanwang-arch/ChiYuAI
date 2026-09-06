// test/http/graph-auth.test.js — G7 溯源端点鉴权
// 契约：C-DAI 决策问责闭环（归属 decision-retro 智能体；knowledgeScope L1–L3）
// 测试计划 §5.6：/api/graph/* 未授权 401；DEPRECATED /api/monitor/{trace,impact,audit} 同为
// 只读溯源面，必须等价鉴权（杜绝匿名旁路）。以代码事实为准：T11 已修 graph/*，monitor 薄转发是残留缺口。
import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';

let app;

beforeAll(async () => {
  app = await createApp();
});

describe('G7 溯源端点鉴权', () => {
  it('未授权访问 /api/graph/trace 返回 401', async () => {
    const res = await app.fetch('/api/graph/trace?id=x', { headers: {} });
    expect(res.statusCode).toBe(401);
  });

  it('DEPRECATED /api/monitor/trace/:id 未授权也返回 403（杜绝匿名旁路，与 requireAdminRole 全站一致）', async () => {
    const res = await app.fetch('/api/monitor/trace/x', { headers: {} });
    expect(res.statusCode).toBe(403);
  });

  it('DEPRECATED /api/monitor/audit 未授权返回 403', async () => {
    const res = await app.fetch('/api/monitor/audit', { headers: {} });
    expect(res.statusCode).toBe(403);
  });
});