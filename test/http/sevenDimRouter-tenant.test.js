import { test, expect, beforeAll } from 'vitest';
import { createSevenDimRouter } from '../../src/http/sevenDimRouter.js';
import { query, queryWrite } from '../../src/db.js';

const T = 'tenantAlpha';

beforeAll(async () => {
  // 幂等复位（禁 DELETE：用 UPDATE 而非 DELETE）
  await queryWrite(
    `UPDATE crm.config_store SET value=value WHERE key='seven-dim' AND tenant_id=$1`,
    [T]
  ).catch(() => {});
});

test('PUT 透传 scopeOf(me).tenantId 进 updateScenario（修复前 opts 无 tenantId）', async () => {
  let captured = null;
  const router = createSevenDimRouter({
    resolveMe: () => ({ ok: true, role: 'sysadmin', tenantId: T }),
    updateScenario: (id, patch, opts) => { captured = opts; return { required_dims: patch.required_dims }; },
    produceDecision: async () => ({ decisionId: 'd-x', ok: true }),
  });
  let code = 0, body = null;
  const res = { status: (c) => { code = c; return { json: (p) => { body = p; } }; }, json: (p) => { body = p; } };
  await router.handlers.put(
    { body: { scenario_id: 'LEAD_FOLLOW_UP', required_dims: [{ dim: 'identity', on_missing: 'warn' }] } },
    res
  );
  expect(code).not.toBe(400);
  expect(captured).not.toBeNull();
  expect(captured.tenantId).toBe(T); // 关键：修复前此处为 undefined
});

test('PUT default_strictness 按租户落 config_store，不污染 system', async () => {
  const router = createSevenDimRouter({
    resolveMe: () => ({ ok: true, role: 'sysadmin', tenantId: T }),
  });
  let body = null;
  const res = { json: (p) => { body = p; } };
  await router.handlers.put({ body: { default_strictness: 'block' } }, res);
  expect(body.default_strictness).toBe('block');
  expect(body.updated).toBe(true);
  const r = await query(
    `SELECT value FROM crm.config_store WHERE key='seven-dim' AND tenant_id=$1`,
    [T]
  );
  expect(r.rows.length).toBe(1);
  expect(r.rows[0].value.default_strictness).toBe('block');
  // system 基线不受影响（若存在）
  const sys = await query(
    `SELECT value FROM crm.config_store WHERE key='seven-dim' AND tenant_id='system'`
  );
  if (sys.rows.length) expect(sys.rows[0].value.default_strictness).not.toBe('block');
});
