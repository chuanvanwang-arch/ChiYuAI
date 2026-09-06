import { describe, it, expect } from 'vitest';
import { renderPriceList, renderPriceListForm } from '../../src/portal/priceListRender.js';
import { renderOfferPolicyList, renderOfferPolicyForm } from '../../src/portal/offerPolicyRender.js';
import { renderDictList, renderDictForm } from '../../src/portal/dictEntriesRender.js';
import { renderPaymentList, renderPaymentForm } from '../../src/portal/paymentPolicyRender.js';

const opt = { showTenant: false, tenantMap: {} };

describe('价格表 render 徽章 + crm-* 组件', () => {
  it('启用态显示绿色徽章 + 停用按钮', () => {
    const html = renderPriceList([{ id: 'p1', state: 'active', payload: { name: '标准价', products: ['A', 'B'] } }], opt);
    expect(html).toContain('pl-badge-on');
    expect(html).toContain('启用');
    expect(html).toContain('<crm-button class="btn danger" data-set="p1" data-state="expired">停用</crm-button>');
  });
  it('停用态显示灰徽章 + 启用按钮（可恢复）', () => {
    const html = renderPriceList([{ id: 'p1', state: 'expired', payload: { name: '标准价' } }], opt);
    expect(html).toContain('pl-badge-off');
    expect(html).toContain('已停用');
    expect(html).toContain('<crm-button class="btn" data-set="p1" data-state="active">启用</crm-button>');
  });
  it('表单全部使用 crm-* 组件（无裸 input/select/button）', () => {
    const f = renderPriceListForm();
    expect(f).toContain('<crm-input');
    expect(f).toContain('<crm-select');
    expect(f).toContain('<crm-button class="btn primary" type="submit">');
    expect(f).not.toMatch(/<input\b/);
    expect(f).not.toMatch(/<select\b/);
    expect(f).not.toMatch(/<button\b/);
  });
});

describe('报价规则包 render 徽章 + crm-* 组件', () => {
  it('启用/停用态徽章与按钮', () => {
    const on = renderOfferPolicyList([{ id: 'o1', state: 'active', payload: { name: 'X' } }], opt);
    const off = renderOfferPolicyList([{ id: 'o2', state: 'expired', payload: { name: 'Y' } }], opt);
    expect(on).toContain('op-badge-on');
    expect(on).toContain('data-state="expired">停用');
    expect(off).toContain('op-badge-off');
    expect(off).toContain('<crm-button class="btn" data-set="o2" data-state="active">启用</crm-button>');
  });
  it('表单 JSON 字段使用 crm-textarea', () => {
    const f = renderOfferPolicyForm();
    expect(f).toContain('<crm-textarea name="cost_structure"');
    expect(f).toContain('<crm-textarea name="price_bands"');
    expect(f).toContain('<crm-input name="margin_redline"');
    expect(f).not.toMatch(/<textarea\b/);
    expect(f).not.toMatch(/<input\b/);
  });
});

describe('字典值域 render 徽章 + crm-* 组件', () => {
  it('停用(deprecated)态仅显示已停用标记，不提供启用按钮', () => {
    const html = renderDictList([{ id: 'd1', state: 'deprecated', payload: { dict_key: 'k', dict_value: 'v' } }], opt);
    expect(html).toContain('de-badge-off');
    expect(html).toContain('tag-stopped');
    expect(html).not.toContain('<crm-button');
  });
  it('启用态显示停用按钮（data-stop）', () => {
    const html = renderDictList([{ id: 'd2', state: 'registered', payload: { dict_key: 'k', dict_value: 'v' } }], opt);
    expect(html).toContain('de-badge-on');
    expect(html).toContain('<crm-button class="btn danger" data-stop="d2" data-state="deprecated">停用</crm-button>');
  });
  it('表单使用 crm-* 组件（含 crm-checkbox 替换裸 checkbox）', () => {
    const f = renderDictForm();
    expect(f).toContain('<crm-select name="dict_key"');
    expect(f).toContain('<crm-input name="dict_value"');
    expect(f).toContain('<crm-checkbox name="active" checked>启用</crm-checkbox>');
    expect(f).toContain('<crm-button class="btn primary" type="submit">');
    expect(f).not.toMatch(/<input\b/);
    expect(f).not.toMatch(/<select\b/);
  });
});

describe('回款政策 render 徽章 + crm-* 组件', () => {
  it('启用/停用态徽章与按钮', () => {
    const on = renderPaymentList([{ id: 'y1', state: 'active', payload: { name: '政策A', subtype: 'payment' } }], opt);
    const off = renderPaymentList([{ id: 'y2', state: 'expired', payload: { name: '政策B', subtype: 'payment' } }], opt);
    expect(on).toContain('pp-badge-on');
    expect(on).toContain('data-state="expired">停用');
    expect(off).toContain('pp-badge-off');
    expect(off).toContain('<crm-button class="btn" data-set="y2" data-state="active">启用</crm-button>');
  });
  it('表单使用 crm-* 组件', () => {
    const f = renderPaymentForm();
    expect(f).toContain('<crm-input name="payment_term"');
    expect(f).toContain('<crm-select name="collection_tier"');
    expect(f).toContain('<crm-button class="btn primary" type="submit">');
    expect(f).not.toMatch(/<input\b/);
    expect(f).not.toMatch(/<select\b/);
  });
});
