import { test, expect } from 'vitest';
import { alertRuleDeps } from '../../src/portal/alertRuleConfig.js';
import { query } from '../../src/db.js';

const T = 'e2e-tenant-alert';

test('persist 对租户首写：克隆 system 模板 → 自建 (kind,tenant_id) 行且 UPDATE 生效', async () => {
  const r = await alertRuleDeps.persist(
    'deal_stuck',
    { enabled: false, check_params: { stuck_days: 99 } },
    { tenantId: T }
  );
  expect(r.ok).toBe(true);
  const row = await query(
    `SELECT enabled, check_params FROM crm.alert_rule WHERE kind='deal_stuck' AND tenant_id=$1`,
    [T]
  );
  expect(row.rows.length).toBe(1);
  expect(row.rows[0].enabled).toBe(false);
  expect(row.rows[0].check_params.stuck_days).toBe(99);
  // system 模板不被污染
  const sys = await query(
    `SELECT enabled FROM crm.alert_rule WHERE kind='deal_stuck' AND tenant_id='system'`
  );
  expect(sys.rows[0].enabled).toBe(true);
});

test('persist 对已有租户行：UPDATE 不复制新行（幂等）', async () => {
  await alertRuleDeps.persist('lead_overdue', { enabled: true }, { tenantId: T });
  const before = await query(`SELECT count(*)::int n FROM crm.alert_rule WHERE tenant_id=$1`, [T]);
  await alertRuleDeps.persist('lead_overdue', { enabled: false }, { tenantId: T });
  const after = await query(`SELECT count(*)::int n FROM crm.alert_rule WHERE tenant_id=$1`, [T]);
  expect(after.rows[0].n).toBe(before.rows[0].n); // 行长不变
  const row = await query(`SELECT enabled FROM crm.alert_rule WHERE kind='lead_overdue' AND tenant_id=$1`, [T]);
  expect(row.rows[0].enabled).toBe(false);
});
