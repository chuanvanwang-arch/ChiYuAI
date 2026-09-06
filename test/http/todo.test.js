// test/http/todo.test.js — S05 待办工作台 真实数据渲染（TDD：先绿后改）
// 验证：GET /api/page/todo?role= 返回 renderPage(S05_SCHEMA) 产物，
//       含 4 选项 select + 真实待办行（审批/跟进），且角色视角过滤生效。
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造最小闭环：1 个 submitted 报价单（→审批待办）+ 1 个 lead 商机（→跟进待办）
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('b1111111-1111-1111-1111-111111111201','system','CRM_QUOTATION','quote-a','华东彩盒报价','ACTIVE',
     '{"name":"华东彩盒报价","customer":"上海印通包装科技有限公司","amount":120000,"status":"submitted"}',
     '2026-08-20T09:00:00+08:00','2026-08-20T09:00:00+08:00'),
    ('d1111111-1111-1111-1111-111111111111','system','CRM_DEAL','deal-lead','彩盒打样询盘','ACTIVE',
     '{"name":"彩盒打样询盘","stage":"lead","expected_amount":120000,"probability":0.10,"customer":"上海印通包装科技有限公司","owner":"王川"}',
     '2026-08-18T09:00:00+08:00','2026-08-18T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S05 待办工作台 受控渲染（真实数据）', () => {
  it('GET /api/page/todo 返回 pg-page 表格页产物 + 4 选项 select', async () => {
    const { status, body } = await getJson('/api/page/todo');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('table');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="table"');
    expect(body.html).toContain('pg-table');
    // 4 个角色选项
    expect(body.html).toContain('value="sales"');
    expect(body.html).toContain('value="manager"');
    expect(body.html).toContain('value="finance"');
    expect(body.html).toContain('value="contract"');
  });

  it('经理视角含真实待办：报价单→审批、lead 商机→跟进', async () => {
    const { body } = await getJson('/api/page/todo?role=manager');
    expect(body.html).toContain('华东彩盒报价'); // 事项
    expect(body.html).toContain('审批'); // 待审批动作
    expect(body.html).toContain('彩盒打样询盘'); // 跟进事项
    expect(body.html).toContain('跟进'); // 跟进动作
  });

  it('财务视角过滤生效：只见审批/核对，不含销售跟进', async () => {
    const { body } = await getJson('/api/page/todo?role=finance');
    expect(body.html).toContain('审批'); // 报价单审批对财务可见
    expect(body.html).not.toContain('彩盒打样询盘'); // lead 跟进不属财务视角
    expect(body.html).not.toContain('跟进');
  });

  it('旧 /todo.html 301 重定向到 /my-todo.html（合并后单一入口）', async () => {
    const res = await app.fetch('/todo.html', { redirect: 'manual' });
    expect(res.status).toBe(301);
    expect(res.headers.location || res.headers['location']).toBe('/my-todo.html');
  });

  it('静态页 /my-todo.html 含 #wb-container 注入锚点', async () => {
    const res = await app.fetch('/my-todo.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="wb-container"');
  });
});
