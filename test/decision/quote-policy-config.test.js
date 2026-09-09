// test/decision/quote-policy-config.test.js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeConfig, readConfig } from '../../src/config/configStore.js';

const T = 'plan-t4-' + Date.now();
const PRICE_AUTH = { default_max_discount_pct: 10, roles: { sales: { max_discount_pct: 10 }, manager: { max_discount_pct: 30 } } };
const REQ_DIMS = { levels: ['MUST', 'SHOULD', 'NICE'], dimensions: [
  { dim_key: 'REQ_PRICE_BASELINE', label: '报价基线确认', level: 'MUST' },
  { dim_key: 'REQ_DISCOUNT_AUTHORITY', label: '折扣权限确认', level: 'MUST' },
  { dim_key: 'REQ_WRITTEN_APPROVAL', label: '书面批文', level: 'MUST' },
] };

describe('quote policy config seeding', () => {
  beforeAll(async () => {
    await writeConfig('price-authority', PRICE_AUTH, { tenantId: 'system' });
    await writeConfig('requirement-dimensions', REQ_DIMS, { tenantId: 'system' });
  });
  afterAll(async () => {
    await writeConfig('price-authority', PRICE_AUTH, { tenantId: T });
  });
  it('system 模板写入后，租户读时 autoSeed 落到本租户', async () => {
    const r = await readConfig('price-authority', { tenantId: T });
    expect(r?.value?.default_max_discount_pct).toBe(10);
  });
  it('requirement-dimensions 含 MUST 维度', async () => {
    const r = await readConfig('requirement-dimensions', { tenantId: 'system' });
    const must = (r?.value?.dimensions || []).filter((d) => d.level === 'MUST');
    expect(must.length).toBeGreaterThanOrEqual(3);
  });
});
