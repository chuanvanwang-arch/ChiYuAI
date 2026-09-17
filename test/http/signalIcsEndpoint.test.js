// test/http/signalIcsEndpoint.test.js — 日历下载端点（L2 §3.2）
// 为什么需要：日历载体若只能随邮件走，用户从站内点开信号时拿不到 .ics；且**跨租户隔离**是安全边界，
//   必须与其它信号端点同源收窄（scopeOf），不得以「能下载」替代隔离断言。
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createApp } from '../../src/http/server.js';
import { issueToken } from '../../src/http/auth.js';
import { query } from '../../src/db.js';

const app = createApp();
const salesTok = issueToken({ username: 'alice', role: 'sales', display_name: 'Alice', tenantId: 'system' });
const otherTok = issueToken({ username: 'bob', role: 'sales', display_name: 'Bob', tenantId: 'ics-other' });
const auth = { Authorization: 'Bearer ' + salesTok };
const authOther = { Authorization: 'Bearer ' + otherTok };

let dbOk = false;
try { await query('SELECT 1'); dbOk = true; } catch { dbOk = false; }

const SIG_WITH_DATE = 'ics-it-with-date';
const SIG_NO_DATE = 'ics-it-no-date';

beforeAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.signal WHERE signal_id = ANY($1::text[])`, [[SIG_WITH_DATE, SIG_NO_DATE]]);
  await query(
    `INSERT INTO crm.signal (signal_id, tenant_id, source, kind, severity, target_role, payload, dedup_key)
     VALUES ($1,'system','rule-scan','tender_deadline','high','sales',$2::jsonb,'ics-it-1'),
            ($3,'system','rule-scan','stage_silence','low','sales','{}'::jsonb,'ics-it-2')`,
    [SIG_WITH_DATE, JSON.stringify({ subject: '投标截止', event_at: '2026-11-04T09:30:00+08:00' }), SIG_NO_DATE],
  );
});
afterAll(async () => {
  if (!dbOk) return;
  await query(`DELETE FROM crm.signal WHERE signal_id = ANY($1::text[])`, [[SIG_WITH_DATE, SIG_NO_DATE]]);
});

it('缺失 token → 401', async () => {
  const res = await app.fetch(`/api/signals/${SIG_WITH_DATE}/ics`);
  expect(res.status).toBe(401);
});

const db = (name, fn) => (dbOk ? it(name, fn) : it.skip(name, fn));

db('自身租户且带 event_at → 200 + text/calendar + VEVENT', async () => {
  const res = await app.fetch(`/api/signals/${SIG_WITH_DATE}/ics`, { headers: auth });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toContain('text/calendar');
  const text = await res.text();
  expect(text).toContain('BEGIN:VCALENDAR');
  expect(text).toContain('UID:' + SIG_WITH_DATE);
});

db('无 event_at → 404 not_a_calendar_signal（不造假日程）', async () => {
  const res = await app.fetch(`/api/signals/${SIG_NO_DATE}/ics`, { headers: auth });
  expect(res.status).toBe(404);
  expect((await res.json()).error).toBe('not_a_calendar_signal');
});

db('跨租户读取 → 404（隔离为硬判据，不返回内容）', async () => {
  const res = await app.fetch(`/api/signals/${SIG_WITH_DATE}/ics`, { headers: authOther });
  expect(res.status).toBe(404);
  const body = await res.text();
  expect(body).not.toContain('BEGIN:VCALENDAR');
});
