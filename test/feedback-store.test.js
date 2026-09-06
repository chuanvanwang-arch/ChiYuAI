// test/feedback-store.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const upserts = [];
vi.mock('../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  queryWrite: vi.fn(async (sql, params) => { upserts.push({ sql, params }); return { rows: [{ id: 1 }] }; }),
}));

const { upsertFeedback, mirrorFeedback } = await import('../src/agent/feedbackStore.js');
const tmp = mkdtempSync(join(tmpdir(), 'fb-'));
const docPath = join(tmp, 'demo-design.md');

describe('feedbackStore', () => {
  beforeEach(() => upserts.length = 0);
  it('upsertFeedback 按 (contract_task_id,gap_type) 幂等', async () => {
    await upsertFeedback({ contractTaskId: 'T-DEMO', agent: 'crm-copilot', gapType: 'skill', observed: 'none', expected: 'data-particle-read' });
    expect(String(upserts[0].sql)).toContain('ON CONFLICT (contract_task_id, gap_type)');
  });
  it('mirrorFeedback 追加到 <doc>.feedback.json', () => {
    const r1 = mirrorFeedback(docPath, { contractTaskId: 'T-DEMO', gapType: 'skill' });
    const r2 = mirrorFeedback(docPath, { contractTaskId: 'T-DEMO', gapType: 'skill' });
    expect(r1.ok && r2.ok).toBe(true);
    const arr = JSON.parse(require('node:fs').readFileSync(docPath.replace(/\.md$/, '.feedback.json'), 'utf8'));
    expect(arr.length).toBe(2);
    expect(arr[0].gapType).toBe('skill');
  });
});
