// test/living-contract/store.test.js — contractStore（真实 plm_test；beforeAll 自举建表）
import { describe, it, expect, beforeAll } from 'vitest';
import { query } from '../../src/db.js';
import { upsertFeedback, getFeedback } from '../../src/contract/contractStore.js';

const DDL = `CREATE TABLE IF NOT EXISTS crm.contract_feedback (
  id BIGSERIAL PRIMARY KEY, doc_path TEXT NOT NULL, task TEXT NOT NULL, gap_type TEXT NOT NULL,
  observed TEXT, expected TEXT, severity TEXT DEFAULT 'warn', status TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now(), updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (doc_path, task, gap_type))`;

beforeAll(async () => { await query(DDL); });

describe('contractStore', () => {
  it('upsert 幂等：重复同 (doc_path,task,gap_type) 不新增行', async () => {
    const base = { doc_path: 'docs/a.md', task: 'T-x', gap_type: 'success' };
    await upsertFeedback({ ...base, observed: 'first', status: 'open' });
    await upsertFeedback({ ...base, observed: 'second', status: 'resolved' });
    const rows = await getFeedback({ docPath: 'docs/a.md', task: 'T-x' });
    expect(rows).toHaveLength(1);
    expect(rows[0].observed).toBe('second');
    expect(rows[0].status).toBe('resolved');
  });
  it('getFeedback 按 doc_path 过滤', async () => {
    await upsertFeedback({ doc_path: 'docs/b.md', task: 'T-y', gap_type: 'skill', observed: 'x' });
    const all = await getFeedback({});
    const b = await getFeedback({ docPath: 'docs/b.md' });
    expect(b.length).toBeLessThanOrEqual(all.length);
    expect(b[0].doc_path).toBe('docs/b.md');
  });
  it('缺必填抛错', async () => {
    await expect(upsertFeedback({ doc_path: 'd' })).rejects.toThrow();
  });
});
