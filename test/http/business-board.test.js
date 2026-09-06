// test/http/business-board.test.js — S15 业务看板（L2C）受控渲染（TDD：先绿后改）
// 验证：/api/page/business-board 返回 renderPage(S15_SCHEMA) 产物，六卡 title 索引注入真实计数 + L2C 阶段 table
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造 L2C 最小闭环：DEAL(lead+opportunity) + QUOTATION + CONTRACT
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a1111111-1111-1111-1111-111111111111','system','CRM_DEAL','lead-demo','食品礼盒-线索','lead',
     '{"name":"食品礼盒-线索","stage":"lead","amount":0}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00'),
    ('a2222222-2222-2222-2222-222222222222','system','CRM_DEAL','opp-demo','食品礼盒-商机','opportunity',
     '{"name":"食品礼盒-商机","stage":"opportunity","amount":1500000}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00'),
    ('a3333333-3333-3333-3333-333333333333','system','CRM_QUOTATION','quote-demo','食品礼盒-报价','submitted',
     '{"name":"食品礼盒-报价","stage":"quotation","amount":1500000}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00'),
    ('a4444444-4444-4444-4444-444444444444','system','CRM_CONTRACT','contract-demo','食品礼盒-合同','signed',
     '{"name":"食品礼盒-合同","stage":"contract","amount":1500000}',
     '2026-08-01T09:00:00+08:00','2026-08-01T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S15 业务看板 受控渲染（L2C）', () => {
  it('GET /api/page/business-board 返回 pg-page 看板产物', async () => {
    const { status, body } = await getJson('/api/page/business-board');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('dashboard');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('业务看板');
    expect(body.html).toContain('pg-metric-card');
    expect(body.html).toContain('pg-table');
  });

  it('六张 metric-card 按 title 索引注入真实计数（线索/商机/报价/合同）', async () => {
    const { body } = await getJson('/api/page/business-board');
    // 六卡 title 索引法（S06 同款）：每卡 title 唯一 key，value 为对应真实计数
    expect(body.html).toContain('线索');
    expect(body.html).toContain('商机');
    expect(body.html).toContain('报价');
    expect(body.html).toContain('合同');
    expect(body.html).toContain('订单');
    expect(body.html).toContain('回款');
    // 计数：线索/商机/报价/合同 =1（真实种子），订单/回款 =0 —— renderMetricCard 输出 pg-value（金额格式化 1.00）
    expect(body.html).toContain('<span class="pg-value">1.00</span>'); // 线索/商机/报价/合同 各 1
    expect(body.html).toContain('<span class="pg-value">0.00</span>'); // 订单/回款 0（无种子）
  });

  it('L2C 阶段 table 注入真实阶段分布（stage/name/amount）', async () => {
    const { body } = await getJson('/api/page/business-board');
    expect(body.html).toContain('pg-table');
    // renderTable 只渲染列头/行（不渲染 comp.title），断言列头与行数据本身
    expect(body.html).toContain('阶段');   // 列头 stage
    expect(body.html).toContain('食品礼盒-商机');   // DEAL opportunity 行
    expect(body.html).toContain('1500000');        // amount 真实值
    expect(body.html).toContain('食品礼盒-线索');   // DEAL lead 行
  });

  it('静态页 /business-closure.html 仍可访问（兼容既有手写板）', async () => {
    const res = await app.fetch('/business-closure.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('L2C 业务闭环'); // 中文标题（slug 仅用于路由）
    expect(html).toContain('id="app"');     // 手写板注入锚点
  });
});