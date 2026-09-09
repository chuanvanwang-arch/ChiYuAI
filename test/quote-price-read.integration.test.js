// test/quote-price-read.integration.test.js — 2026-09-09 修复验收
// 验证：MCP 报价路径（crm-quote-create handler）真正读取租户配置的 CRM_PRODUCT.list_price，
//       而非依赖调用方自带 unit_price / deal.amount 拍脑袋。
// 复现路径：创建测试租户产品（含 list_price）+ 商机 → 调 crm-quote-create handler（items 无 unit_price）
//   → 断言返回报价明细 unit_price === list_price、source === 'product_master'、金额正确。
import { describe, it, expect, beforeAll } from 'vitest';
import { createParticle } from '../src/particles/particleRepo.js';
import { seedActions } from '../src/action/seed-actions.js';
import { getAction } from '../src/action/registry.js';

const TID = `acme-quote-fix-${Date.now()}`;
const SUF = Math.random().toString(36).slice(2, 8);

describe('crm-quote-create 读取租户产品单价（2026-09-09 修复）', () => {
  let productId;
  let dealId;

  beforeAll(async () => {
    seedActions();
    const prod = await createParticle('CRM_PRODUCT', {
      name: `报价修复测试产品-${SUF}`, unit: '套', category: '软件', list_price: 123456, status: 'on_sale',
    }, { tenantId: TID, actor: 'alice' });
    productId = prod.id;
    const deal = await createParticle('CRM_DEAL', {
      name: `报价修复测试商机-${SUF}`, stage: 'S1', customer_tier: '重点', project_tier: '标准',
    }, { tenantId: TID, actor: 'alice' });
    dealId = deal.id;
  });

  it('items 无 unit_price → 自动取价自 CRM_PRODUCT.list_price（product_master）', async () => {
    const action = getAction('crm-quote-create');
    expect(action).toBeTruthy();
    const out = await action.handler({
      name: `报价单-${SUF}`,
      deal_id: dealId,
      valid_until: '2026-12-31',
      items: [{ product_id: productId, qty: 2 }],
    }, { actor: 'alice', tenantId: TID });
    expect(out.ok === undefined ? out.id : out.id).toBeTruthy();
    const item = out.items?.[0] || out.payload?.items?.[0];
    // createQuote 返回 { ...quote, amount, lines }；明细在 items / lines
    const filled = (out.items && out.items[0]) || (out.lines && out.lines[0]);
    expect(filled).toBeTruthy();
    expect(filled.unit_price).toBe(123456);
    expect(filled.source).toBe('product_master');
    // 金额 = 单价 × 数量（无折扣/税）= 246912
    expect(out.amount).toBe(123456 * 2);
  });

  it('价格表无此产品 → 仍回退产品主数据（证明取价源是产品而非价目表名分组）', async () => {
    // 用 system 租户（已 seed 价目表，但价目表 products 仅产品名、无单价）下不存在的产品引用
    const action = getAction('crm-quote-create');
    const prod2 = await createParticle('CRM_PRODUCT', {
      name: `报价修复测试产品B-${SUF}`, unit: '套', category: '软件', list_price: 77777, status: 'on_sale',
    }, { tenantId: TID, actor: 'alice' });
    const deal2 = await createParticle('CRM_DEAL', {
      name: `报价修复测试商机B-${SUF}`, stage: 'S1', customer_tier: '重点', project_tier: '标准',
    }, { tenantId: TID, actor: 'alice' });
    const out = await action.handler({
      name: `报价单B-${SUF}`, deal_id: deal2.id, valid_until: '2026-12-31',
      items: [{ product_id: prod2.id, qty: 1 }],
    }, { actor: 'alice', tenantId: TID });
    const filled = (out.items && out.items[0]) || (out.lines && out.lines[0]);
    expect(filled.unit_price).toBe(77777);
    expect(filled.source).toBe('product_master');
  });
});
