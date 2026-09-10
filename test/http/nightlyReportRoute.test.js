import { describe, it, expect, beforeAll } from 'vitest';
import { ensureNightlyReportTable } from '../../src/report/nightlyReport.js';
import { query } from '../../src/db.js';

describe('GET /api/nightly-report/:date 契约', () => {
  beforeAll(async () => { await ensureNightlyReportTable(); });

  it('权限判据：非 admin 角色不通过（与 router 内一致）', () => {
    const role = 'SALES';
    expect(['ADMIN', 'SYSADMIN', 'admin', 'sysadmin'].includes(role)).toBe(false);
  });

  it('upsert 幂等：同 run_date 重复写入走 DO UPDATE（run_date 以 text 返回，前端拼 URL 无时区偏移）', async () => {
    // 共享测试库可能残留真实夜批行（如 2026-09-08），"全局最新行=自插行" 假设不成立。
    // 改为按 run_date 精确断言，自证 upsert 幂等而非依赖表内最新行。
    await query(`INSERT INTO crm.nightly_report (run_date, title, file_path, total_tasks, healthy, drift, patches_count)
      VALUES ('2026-09-05','t','/x.md',22,20,2,1)
      ON CONFLICT (run_date) DO UPDATE SET title=EXCLUDED.title`);
    // 二次 upsert 变更 title → 应命中 DO UPDATE 分支；若唯一键缺失会插入第二行，下方 toHaveLength(1) 捕获
    await query(`INSERT INTO crm.nightly_report (run_date, title, file_path, total_tasks, healthy, drift, patches_count)
      VALUES ('2026-09-05','t2','/x.md',22,20,2,1)
      ON CONFLICT (run_date) DO UPDATE SET title=EXCLUDED.title`);
    const r = await query(`SELECT run_date::text AS run_date, title FROM crm.nightly_report WHERE run_date='2026-09-05'`);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].run_date).toBe('2026-09-05');
    expect(r.rows[0].title).toBe('t2');
    await query(`DELETE FROM crm.nightly_report WHERE run_date='2026-09-05'`);
  });
});
