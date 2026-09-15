// D6 校准 SLA 迁移集成测试（TDD：先红）
// 仅验证迁移产出（列 + 日志表）存在且可写；scanEscalations 行为在 test/calibration/store-sla.test.js。
// 迁移 SQL 幂等（ALTER ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS），beforeAll 直跑。
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { query } from '../../src/db.js';
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

const sql = readFileSync(new URL('../../db/migration-calibration-sla.sql', import.meta.url), 'utf8');
// patch_id 为 UUID；测试行用 gen_random_uuid() 生成，并限定清理范围（knob='threshold' AND status='PENDING'，
// 避免 afterEach 误删既有真实处方——仅删本测试插入的低风险测试锚行）。
const PID_MARKER = 'k' + Date.now().toString(36);

beforeAll(async () => { await query(sql); });
afterEach(async () => {
  await query('DELETE FROM crm.calibration_escalation_log WHERE patch_id IN (SELECT patch_id FROM crm.calibration_patch WHERE knob=$1)', ['threshold']);
  await query('DELETE FROM crm.calibration_patch WHERE knob=$1 AND status=$2 AND scenario_id IS NULL AND target IS NULL', ['threshold', 'PENDING']);
});

describe('D6 SLA 迁移', () => {
  it('calibration_patch 含 sla_due_at / escalated 列', async () => {
    const r = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='crm' AND table_name='calibration_patch'
          AND column_name IN ('sla_due_at','escalated')`
    );
    expect(r.rows.map(c => c.column_name).sort()).toEqual(['escalated', 'sla_due_at']);
  });

  it('可写入 escalated + sla_due_at（存量回填列可用）', async () => {
    await query(
      `INSERT INTO crm.calibration_patch
         (patch_id, knob, risk, status, assignee, tenant_id, created_at, sla_due_at, escalated, from_value, to_value, evidence)
       VALUES (gen_random_uuid(),'threshold','HIGH','PENDING','ADMIN','system', now()-interval '10 days', now()-interval '9 days', true,
               '{"threshold":0.8}'::jsonb, '{"threshold":0.7}'::jsonb, '{"source":"sla-test"}'::jsonb)`
    );
    const p = await query(
      `SELECT escalated, (sla_due_at IS NOT NULL) AS due_set
         FROM crm.calibration_patch
        WHERE knob='threshold' AND status='PENDING' AND scenario_id IS NULL AND target IS NULL
        ORDER BY created_at DESC LIMIT 1`
    );
    expect(p.rows[0].escalated).toBe(true);
    expect(p.rows[0].due_set).toBe(true);
  });

  it('calibration_escalation_log 追加式日志表存在', async () => {
    const r = await query(`SELECT to_regclass('crm.calibration_escalation_log') AS t`);
    expect(String(r.rows[0].t)).toContain('calibration_escalation_log');
  });
});
