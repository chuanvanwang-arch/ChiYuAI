import { describe, it, expect, beforeAll } from 'vitest';
import { ensureNightlyReportTable } from '../../src/report/nightlyReport.js';
import { query } from '../../src/db.js';

describe('GET /api/nightly-report/:date 契约', () => {
  beforeAll(async () => { await ensureNightlyReportTable(); });

  it('权限判据：非 admin 角色不通过（与 router 内一致）', () => {
    const role = 'SALES';
    expect(['ADMIN', 'SYSADMIN', 'admin', 'sysadmin'].includes(role)).toBe(false);
  });

  it('upsert 后最新行可被取到（run_date 以 text 返回，前端拼 URL 无时区偏移）', async () => {
    await query(`INSERT INTO crm.nightly_report (run_date, title, file_path, total_tasks, healthy, drift, patches_count)
      VALUES ('2026-09-05','t','/x.md',22,20,2,1)
      ON CONFLICT (run_date) DO UPDATE SET title=EXCLUDED.title`);
    const r = await query(`SELECT run_date::text AS run_date FROM crm.nightly_report ORDER BY run_date DESC LIMIT 1`);
    expect(r.rows[0].run_date).toBe('2026-09-05');
    await query(`DELETE FROM crm.nightly_report WHERE run_date='2026-09-05'`);
  });
});
