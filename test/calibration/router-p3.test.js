import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { query, withTx } from '../../src/db.js';
import { issueToken } from '../../src/http/auth.js';
import { snapshotRequiredDims, restoreRequiredDims } from '../fixtures/scenarioDimsBaseline.js';

function appWith(role = 'sysadmin') {
  const app = createApp();
  const t = issueToken({ username: 'sysadmin', role, sub: 'sysadmin' });
  return { app, auth: { Authorization: `Bearer ${t}` } };
}

describe('校准路由 · 手动发起 required_dims 处方', () => {
  // 共享库快照/还原（2026-09-17 修复）：本文件原先**无 afterEach**，测试 4 的「降级前置」
  // UPDATE 又是无租户谓词的整场景写（PK=(scenario_id,tenant_id) 落地后 = 跨租户写全部行），
  // 文件跑完把 OPP_QUALIFY 全部租户行留在 block → 顺序依赖污染 decision-gate 等后续文件。
  let baseline;
  beforeAll(async () => {
    baseline = await snapshotRequiredDims('OPP_QUALIFY');
  });
  beforeEach(async () => {
    await withTx(async (client) => {
      // 按快照内租户逐个清空（带 tenant_id 谓词），不再整场景写
      for (const s of baseline) {
        await client.query(`UPDATE crm.decision_scenario SET required_dims='[]'::jsonb WHERE scenario_id='OPP_QUALIFY' AND tenant_id=$1`, [s.tenant_id]);
      }
      await client.query(`DELETE FROM crm.calibration_patch WHERE scenario_id='OPP_QUALIFY' AND knob='required_dims'`);
    });
  });
  afterEach(async () => {
    await restoreRequiredDims('OPP_QUALIFY', baseline);
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
