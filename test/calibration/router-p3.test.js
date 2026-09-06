import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query, withTx } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';

function appWith(role = 'sysadmin') {
  const app = createApp();
  const t = issueToken({ username: 'sysadmin', role, sub: 'sysadmin' });
  return { app, auth: { Authorization: `Bearer ${t}` } };
}

describe('校准路由 · 手动发起 required_dims 处方', () => {
  beforeEach(async () => {
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP_QUALIFY'`);
      await client.query(`DELETE FROM crm.calibration_patch WHERE scenario_id='OPP_QUALIFY' AND knob='required_dims'`);
    });
  });

  it('POST generate 带 required_dims_draft → 生成 PENDING 处方 + risk', async () => {
    const { app, auth } = appWith();
    const res = await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP_QUALIFY', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.created).toBe(1);
    expect(j.risk).toBe('MEDIUM');
    expect(j.patch.knob).toBe('required_dims');
  });

  it('幂等：同 scenario_id + to_value PENDING 跳过', async () => {
    const { app, auth } = appWith();
    await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP_QUALIFY', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    const res2 = await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP_QUALIFY', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    const j2 = await res2.json();
    expect(j2.created).toBe(0);
    expect(j2.skipped).toBe(1);
  });

  it('非 sysadmin 被 403', async () => {
    const { app, auth } = appWith('sales');
    const res = await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP_QUALIFY', required_dims_draft: [{ dim: 'identity', on_missing: 'block' }] }),
    });
    expect(res.status).toBe(403);
  });

  it('降级（block→warn）风险标 HIGH', async () => {
    const { app, auth } = appWith();
    await withTx(async (client) => {
      await client.query(`UPDATE crm.decision_scenario SET required_dims=$1::jsonb WHERE scenario_id='OPP_QUALIFY'`,
        [JSON.stringify([{ dim: 'identity', on_missing: 'block' }])]);
    });
    const res = await app.fetch('/api/calibration/patches/generate', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify({ scenario_id: 'OPP_QUALIFY', required_dims_draft: [{ dim: 'identity', on_missing: 'warn' }] }),
    });
    const j = await res.json();
    expect(j.risk).toBe('HIGH');
  });
});
