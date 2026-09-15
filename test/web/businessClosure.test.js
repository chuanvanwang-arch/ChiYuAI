import { test, expect, describe } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── 样例 board（富化结构，对齐设计 §3.2）───
const BOARD_SAMPLE = {
  stages: [
    { key: 'account',   label: '客户', type: 'CRM_ACCOUNT',        count: 2, totalAmount: null,
      items: [{ id: 'a1', title: '客户A', amount: null, stage: null, type: 'CRM_ACCOUNT' }] },
    { key: 'deal',      label: '商机', type: 'CRM_DEAL',           count: 3, totalAmount: 300000,
      items: [{ id: 'd1', title: '商机X', amount: 100000, stage: 'opportunity', type: 'CRM_DEAL' }] },
    { key: 'quotation', label: '报价', type: 'CRM_QUOTATION',       count: 2, totalAmount: 200000,
      items: [{ id: 'q1', title: '报价Y', amount: 100000, stage: null, type: 'CRM_QUOTATION' }] },
    { key: 'contract',  label: '合同', type: 'CRM_CONTRACT',        count: 1, totalAmount: 120000,
      items: [{ id: 'c1', title: '合同Z', amount: 120000, stage: null, type: 'CRM_CONTRACT' }] },
    { key: 'order',     label: '订单', type: 'CRM_ORDER',           count: 1, totalAmount: 120000,
      items: [{ id: 'o1', title: '订单W', amount: 120000, stage: null, type: 'CRM_ORDER' }] },
    { key: 'payment',   label: '回款', type: 'CRM_PAYMENT_PLAN,CRM_PAYMENT_RECORD,CRM_INVOICE', count: 4, totalAmount: 50000,
      items: [{ id: 'p1', title: '回款R', amount: 50000, stage: null, type: 'CRM_PAYMENT_RECORD' }] },
  ],
  publicPool: { count: 1, note: '公海=CRM_DEAL 中 stage=S0' },
  privateLeads: 1,
  total: { dealAmount: 300000, contractAmount: 120000, receivedAmount: 50000 },
};

describe('businessClosure 渲染纯函数（浏览器可加载子模块）', () => {
  test('businessClosureRender.js 无服务端 import（可被浏览器原生 ESM 加载）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/portal/businessClosureRender.js'), 'utf8');
    expect(src).not.toMatch(/from ['"]express['"]/);
    expect(src).not.toMatch(/from ['"][^'"]*(\.\.\/db\.js|\.\.\/http\/|\.\.\/decision\/|\.\.\/alerts\/|\.\.\/events\/)/);
    expect(src).not.toMatch(/createBusinessBoardRouter/); // 渲染与 Router 分离
  });

  test('businessClosureRender.js 可导出 renderBusinessClosure', async () => {
    const mod = await import('../../src/portal/businessClosureRender.js');
    expect(typeof mod.renderBusinessClosure).toBe('function');
  });

  test('renderBusinessClosure 渲染 6 阶段卡（客户/商机/报价/合同/订单/回款）', async () => {
    const { renderBusinessClosure } = await import('../../src/portal/businessClosureRender.js');
    const html = renderBusinessClosure(BOARD_SAMPLE);
    for (const lbl of ['客户', '商机', '报价', '合同', '订单', '回款']) {
      expect(html, `应含阶段卡 ${lbl}`).toContain(lbl);
    }
    expect(html).toContain('公海'); // 公海/私海线索 标注条（T9 口径拆分）
  });

  test('renderBusinessClosure 金额 ¥ 千分位格式化', async () => {
    const { renderBusinessClosure } = await import('../../src/portal/businessClosureRender.js');
    const html = renderBusinessClosure(BOARD_SAMPLE);
    expect(html).toContain('¥300,000');   // dealAmount
    expect(html).toContain('¥120,000');   // contract
    expect(html).not.toContain('¥NaN');
  });

  test('renderBusinessClosure 条目下钻链接正确', async () => {
    const { renderBusinessClosure } = await import('../../src/portal/businessClosureRender.js');
    const html = renderBusinessClosure(BOARD_SAMPLE);
    expect(html).toContain('/deal-detail.html?id=d1');
    expect(html).toContain('/quotation-detail.html?id=q1');
    expect(html).toContain('/contract-detail.html?id=c1');
    expect(html).toContain('/order-detail.html?id=o1');
    expect(html).toContain('/payment-detail.html?id=p1');
    expect(html).toContain('/particle-detail.html?type=CRM_ACCOUNT&id=a1');
  });

  test('renderBusinessClosure 空数据降级', async () => {
    const { renderBusinessClosure } = await import('../../src/portal/businessClosureRender.js');
    const html = renderBusinessClosure({
      stages: [], publicPool: { count: 0, note: '' }, privateLeads: 0, total: { dealAmount: 0, contractAmount: 0, receivedAmount: 0 },
    });
    expect(html).toMatch(/暂无|空|empty|no data/i);
  });
});

describe('businessBoard 富化端点（TDD handler）', () => {
  test('businessBoard.js 导出 createBusinessBoardRouter', async () => {
    const mod = await import('../../src/portal/businessBoard.js');
    expect(typeof mod.createBusinessBoardRouter).toBe('function');
    expect(typeof mod.buildBoard).toBe('function');
  });

  test('createBusinessBoardRouter GET 聚合 6 阶段 + publicPool/privateLeads + total', async () => {
    const { createBusinessBoardRouter } = await import('../../src/portal/businessBoard.js');
    // 注入 queryParticles mock：返回各类型粒子（payload 含 amount/stage）
    const mockItems = [
      { id: 'a1', type: 'CRM_ACCOUNT', payload: { name: '客户A' } },
      { id: 'd1', type: 'CRM_DEAL', payload: { name: '商机X', amount: 100000, stage: 'opportunity' } },
      { id: 'd2', type: 'CRM_DEAL', payload: { name: '线索L', amount: 0, stage: 'S0' } }, // 公海（无归属）
      { id: 'd3', type: 'CRM_DEAL', payload: { name: '私海P', amount: 0, stage: 'S0P', owner_id: 'alice' } },
      { id: 'q1', type: 'CRM_QUOTATION', payload: { name: '报价Y', amount: 100000 } },
      { id: 'c1', type: 'CRM_CONTRACT', payload: { name: '合同Z', amount: 120000 } },
      { id: 'o1', type: 'CRM_ORDER', payload: { name: '订单W', amount: 120000 } },
      { id: 'p1', type: 'CRM_PAYMENT_RECORD', payload: { name: '回款R', paid_amount: 50000 } },
    ];
    const router = createBusinessBoardRouter({
      queryParticles: async ({ type }) => mockItems.filter((x) => x.type === type),
    });
    let code = 0, body = null;
    const res = {
      status: (c) => { code = c; return { json: (p) => { body = p; } }; },
      json: (p) => { code = code || 200; body = p; },
    };
    await router.handlers.get({}, res);
    expect(code).toBe(200);
    expect(body.stages).toHaveLength(6);
    const deal = body.stages.find((s) => s.key === 'deal');
    expect(deal.count).toBe(3);
    expect(deal.totalAmount).toBe(100000);
    expect(body.publicPool.count).toBe(1);      // 仅 d2（lead+无主 → S0 公海）
    expect(body.privateLeads).toBe(1);          // 仅 d3（S0P 已认领待校验）
    const payment = body.stages.find((s) => s.key === 'payment');
    expect(payment.totalAmount).toBe(50000); // paid_amount 合计
    expect(body.total.receivedAmount).toBe(50000);
  });

  test('buildBoard 纯函数：金额映射 + 回款合并 + publicPool/privateLeads 派生', async () => {
    const { buildBoard } = await import('../../src/portal/businessBoard.js');
    const items = [
      { id: 'd1', type: 'CRM_DEAL', payload: { name: 'X', amount: 100000, stage: 'S0' } }, // 公海
      { id: 'd2', type: 'CRM_DEAL', payload: { name: 'Y', amount: 50000, stage: 'opportunity' } },
      { id: 'pp', type: 'CRM_PAYMENT_PLAN', payload: { name: 'P', plan_amount: 80000 } },
      { id: 'pr', type: 'CRM_PAYMENT_RECORD', payload: { name: 'R', paid_amount: 30000 } },
    ];
    const b = buildBoard(items);
    expect(b.stages).toHaveLength(6);
    expect(b.publicPool.count).toBe(1); // 仅 d1
    expect(b.privateLeads).toBe(0);     // 无 S0P/S1
    expect(b.stages.find((s) => s.key === 'deal').totalAmount).toBe(150000);
    expect(b.stages.find((s) => s.key === 'payment').count).toBe(2); // PLAN+RECORD
    expect(b.stages.find((s) => s.key === 'payment').totalAmount).toBe(30000); // 仅 paid_amount
  });
});
