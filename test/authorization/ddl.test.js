// T19-1 红：断言 crm.standing_grant / crm.grant_execution 与 crm.decision.grant_ref/autonomy_level 已落地
import { describe, it, expect } from 'vitest';
import { query } from '../../src/db.js';

async function tableExists(table) {
  const r = await query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='crm' AND table_name=$1`,
    [table]
  );
  return r.rows.length > 0;
}
async function columnExists(table, column) {
  const r = await query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='crm' AND table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rows.length > 0;
}

describe('S6 DDL: standing_grant / grant_execution / decision.grant_ref', () => {
  it('crm.standing_grant 存在且含关键列', async () => {
    expect(await tableExists('standing_grant')).toBe(true);
    for (const c of ['grant_id', 'tenant_id', 'scope_actions', 'field_whitelist', 'risk_tier', 'status', 'decision_id', 'expires_at', 'revoked_at']) {
      expect(await columnExists('standing_grant', c), `standing_grant.${c}`).toBe(true);
    }
  });
  it('crm.grant_execution 存在且含关键列', async () => {
    expect(await tableExists('grant_execution')).toBe(true);
    for (const c of ['execution_id', 'grant_id', 'action_name', 'before_state', 'after_state', 'decision_id', 'hitl_verdict']) {
      expect(await columnExists('grant_execution', c), `grant_execution.${c}`).toBe(true);
    }
  });
  it('crm.decision 含 grant_ref / autonomy_level', async () => {
    expect(await columnExists('decision', 'grant_ref')).toBe(true);
    expect(await columnExists('decision', 'autonomy_level')).toBe(true);
  });
});
