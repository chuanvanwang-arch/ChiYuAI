// test/decision/d4-outcome-reflow.test.mjs
// D4 回流闭环：outcome_event_map 启用规则 ≥4 且 outcome_type 合法 + ingester 直解 decision_id 回写。
// 注意：本环境 psql 不可用，种子经 node pg（queryWrite）应用。
import { readFileSync } from 'node:fs';
import { beforeAll, test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, queryWrite } from '../../src/db.js';
import { OUTCOME_TYPES } from '../../src/decision/outcome.js';
import { handleBusinessEvent } from '../../src/decision/outcomeIngester.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = join(__dirname, '../../db/seed-outcome-event-map-2026-09-14.sql');

async function applySeed() {
  const sql = readFileSync(SEED, 'utf8');
  for (const stmt of sql.split(';')) {
    const s = stmt.trim();
    if (s) await queryWrite(s);
  }
}

beforeAll(async () => {
  await applySeed();
}, 30000);

test('D4: outcome_event_map 含 ≥4 启用规则且 outcome_type 合法', async () => {
  const r = await query(
    `SELECT event_type, outcome_type, enabled FROM crm.outcome_event_map WHERE enabled=true ORDER BY event_type`
  );
  const enabled = r.rows;
  expect(enabled.length).toBeGreaterThanOrEqual(4);
  for (const row of enabled) expect(OUTCOME_TYPES).toContain(row.outcome_type);
  const types = new Set(enabled.map((x) => x.event_type));
  expect(types.has('decision.contract_sign')).toBe(true);
  expect(types.has('decision.deal-advance')).toBe(true);
  expect(types.has('decision.quote-create')).toBe(true);
  expect(types.has('decision.deal-archive')).toBe(true);
}, 30000);

test('D4: deal-advance 事件直解 decision_id 并回写 partial', async () => {
  const written = [];
  const spyWrite = async (sqlText, params) => {
    if (/INSERT INTO crm\.decision_outcome/.test(sqlText)) written.push(params);
    return { rows: [{ decision_id: params[0] }] };
  };
  // 仅覆写 write 为 spy；query 用默认（真实测试库，已含种子规则）
  const results = await handleBusinessEvent(
    'decision', 'deal-advance',
    { deal_id: 'deal-xyz', decision_id: 'dec-xyz', to_stage: 'S3' },
    { write: spyWrite }
  );
  expect(written.length).toBeGreaterThanOrEqual(1);
  expect(written[0][1]).toBe('partial'); // outcome_type 列位置
}, 30000);

test('D4: contract_sign 经 deal_id 反查回写 won', async () => {
  // 造一条带 involved_entities=[{id:deal-xyz}] 的决策，供 lookupDecisionByDeal 反查
  await queryWrite(
    `INSERT INTO crm.decision
       (decision_id, tenant_id, scenario_id, trigger_context, involved_entities, conditions_evaluated,
        disposition, decider_type, rationale, business_tier, state, created_at, updated_at)
     VALUES ('8d6e7f0a-1b2c-4d3e-8f9a-0b1c2d3e4f5a', 'system', 'LEAD_FIT',
        '{"scenario_id":"LEAD_FIT"}'::jsonb, '[{"id":"deal-xyz","type":"CRM_DEAL"}]'::jsonb, '[]'::jsonb,
        'approved', 'human', 'fixture', 'tier1', 'open', now(), now())
     ON CONFLICT (decision_id) DO UPDATE SET involved_entities=EXCLUDED.involved_entities`
  );
  const written = [];
  const spyWrite = async (sqlText, params) => {
    if (/INSERT INTO crm\.decision_outcome/.test(sqlText)) written.push(params);
    return { rows: [{ decision_id: params[0] }] };
  };
  const results = await handleBusinessEvent(
    'decision', 'contract_sign',
    { contract_id: 'c-1', deal_id: 'deal-xyz', contract_no: 'CN1', signed_at: new Date().toISOString() },
    { write: spyWrite }
  );
  expect(written.length).toBeGreaterThanOrEqual(1);
  expect(written[0][1]).toBe('won');
}, 30000);
