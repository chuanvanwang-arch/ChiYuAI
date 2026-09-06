// test/billing/tokenTenant.test.js — token_accounting 写入 tenant_id（T1）
import { describe, test, expect, afterEach } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import { recordTokens } from '../../src/alerts/tokenAccounting.js';

afterEach(async () => {
  await queryWrite(`DELETE FROM crm.token_accounting WHERE actor='__t_test'`);
});

describe('recordTokens tenant scoping', () => {
  test('写入 tenant_id', async () => {
    const r = await recordTokens({ actor: '__t_test', action: 'crm-deal-advance', tokensIn: 10, tokensOut: 5, tenantId: 'acme' });
    expect(r.ok).toBe(true);
    const q = await query(`SELECT tenant_id, tokens_in FROM crm.token_accounting WHERE actor='__t_test'`);
    expect(q.rows[0].tenant_id).toBe('acme');
    expect(Number(q.rows[0].tokens_in)).toBe(10);
  });

  test('缺省 tenant_id 归 system', async () => {
    await recordTokens({ actor: '__t_test', action: 'crm-deal-advance', tokensIn: 1 });
    const q = await query(`SELECT tenant_id FROM crm.token_accounting WHERE actor='__t_test'`);
    expect(q.rows[0].tenant_id).toBe('system');
  });
});
