import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { queryWrite } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// 自包含：dashboard 的告警表(pg-table) + 单 Agent 任务流(pg-subtable) 由 assertAgentAssembly()/listTasks()
// 的运行时态驱动；全量跑时前面测试会清空 crm.tasks → 两表为空被 renderPage 省略 → 断言缺 pg-table。
// 此处种入 1 条 failed 任务（同时喂饱告警表与任务流），使组件确定渲染，消除顺序依赖。
beforeEach(async () => {
  await queryWrite('DELETE FROM crm.tasks');
  await queryWrite(
    `INSERT INTO crm.tasks (tenant_id, step, title, action_name, status)
     VALUES ('system', 'seed', '自包含种子任务', 'crm-deal-advance', 'failed')`
  );
});

describe('S04 智能体监控台 受控渲染（/api/page/agent-dashboard）', () => {
  it('返回受控渲染产物 pg-page + 三张不同指标卡', async () => {
    const res = await app.fetch('/api/page/agent-dashboard');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.schema?.type).toBe('dashboard');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="dashboard"');
    // 三卡标题互斥且取值形态不同（健康=“N 个在线” / 待审批=“N 单” / 覆盖=“N 场景”）
    expect(body.html).toContain('Agent 健康');
    expect(body.html).toContain('待审批');
    expect(body.html).toContain('决策覆盖');
    expect(body.html).toContain('个在线');
    expect(body.html).toContain('单');
    expect(body.html).toContain('场景');
  });

  it('含告警 table 与单 Agent 任务流 subtable（容器存在）', async () => {
    const res = await app.fetch('/api/page/agent-dashboard');
    const body = await res.json();
    // metric-card/table/subtable 三种组件均应渲染（pg-table / pg-subtable 存在）
    expect(body.html).toContain('pg-table');
    expect(body.html).toContain('pg-subtable');
  });

  it('静态页 /agent-dashboard.html 含 #agent-dashboard-root 注入锚点', async () => {
    const res = await app.fetch('/agent-dashboard.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="agent-dashboard-root"');
  });
});
