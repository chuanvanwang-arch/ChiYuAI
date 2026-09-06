// test/http/invoice-detail.test.js — S12 发票详情 真实数据渲染（TDD：先绿后改）
// 验证：/api/page/invoice-detail?invoiceId= 返回 renderPage(S12_SCHEMA) 产物，含真实发票字段/对账入口
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query } from '../../src/db.js';

let app;
beforeAll(() => { app = createApp(); });

// plm_test 无种子，自造 发票 最小闭环
beforeEach(async () => {
  await query('TRUNCATE crm.particles, crm.edges RESTART IDENTITY CASCADE');
  await query(`INSERT INTO crm.particles (id, tenant_id, type, slug, title, state, payload, created_at, updated_at) VALUES
    ('a1111111-1111-1111-1111-111111111111','system','CRM_INVOICE','INV-2026-001','食品礼盒框架-首期发票','open',
     '{"invoice_no":"INV-2026-001","invoice_type":"增值税专用发票","invoice_amount":500000,"invoice_date":"2026-08-10T09:00:00+08:00","contract_id":"c1111111-1111-1111-1111-111111111111","reconcile_status":"pending"}',
     '2026-08-10T09:00:00+08:00','2026-08-10T09:00:00+08:00')`);
});

async function getJson(path) {
  const res = await app.fetch(path);
  return { status: res.status, body: await res.json() };
}

describe('S12 发票详情 受控渲染（真实数据）', () => {
  it('GET /api/page/invoice-detail?invoiceId= 返回 pg-page 详情页产物', async () => {
    const { status, body } = await getJson('/api/page/invoice-detail?invoiceId=a1111111-1111-1111-1111-111111111111');
    expect(status).toBe(200);
    expect(body.schema.type).toBe('detail');
    expect(body.html).toContain('pg-page');
    expect(body.html).toContain('data-page-type="detail"');
    expect(body.html).toContain('pg-attr-field');
  });

  it('属性字段注入真实发票值（发票号/发票金额来自真实 payload）', async () => {
    const { body } = await getJson('/api/page/invoice-detail?invoiceId=a1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('INV-2026-001');  // invoice_no ← payload.invoice_no
    expect(body.html).toContain('500000');        // invoice_amount ← payload.invoice_amount
    // S12 schema 只声明 invoice_no/invoice_amount/reconciled 三字段（受控渲染 YAGNI）；
    // invoice_type 未声明故不渲染——断言其不存在（防 schema 漂移）
    expect(body.html).not.toContain('增值税专用发票');
  });

  it('对账状态由真实 reconcile_status 派生（pending→未对账）', async () => {
    const { body } = await getJson('/api/page/invoice-detail?invoiceId=a1111111-1111-1111-1111-111111111111');
    // label 恒为「已对账」（schema label），值形态由 reconcile_status 派生
    expect(body.html).toContain('已对账');          // schema label 渲染
    expect(body.html).toContain('value="未对账"');  // pending → 未对账（布尔 false 形态）
    expect(body.html).toContain('data-attr="reconciled"');
  });

  it('goal-form 渲染对账入口', async () => {
    const { body } = await getJson('/api/page/invoice-detail?invoiceId=a1111111-1111-1111-1111-111111111111');
    expect(body.html).toContain('pg-form');
    expect(body.html).toContain('POST /api/page/from-nl'); // goal-form action
    expect(body.html).toContain('执行发票对账');            // placeholder
  });

  it('静态页 /invoice-detail.html 含 #invoice-root 注入锚点', async () => {
    const res = await app.fetch('/invoice-detail.html');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('id="invoice-root"');
  });

  it('无 id 时默认取首条发票（防空白回归）', async () => {
    const { status, body } = await getJson('/api/page/invoice-detail');
    expect(status).toBe(200);
    expect(body.html).toContain('pg-attr-field');
  });
});