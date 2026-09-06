// test/web/billingTokenSection.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const html = readFileSync('src/web/billing.html', 'utf8');
describe('billing.html Token 明细专区', () => {
  it('含 Token 额度与使用明细 section 与 loadTokenUsage 调用', () => {
    expect(html).toContain('Token 额度与使用明细');
    expect(html).toContain('id="token-quota"');
    expect(html).toContain('id="token-by-account"');
    expect(html).toContain('id="token-by-action"');
    expect(html).toContain('loadTokenUsage');
  });
});
