import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { appendAccountMemory, distillAccountMemory, DISTILL_AFTER_DAYS } from '../../src/memory/accountMemory.js';

const OLD = new Date(Date.now() - 40 * 86400000).toISOString();

describe('accountMemory (C3)', () => {
  it('append 走真实 appendMemory 契约（topic 规约 + ACCOUNT 锚点 + 租户透传）', async () => {
    const store = { appendMemory: vi.fn(async (e) => ({ ok: true, row: { id: 'm1', ...e } })) };
    const r = await appendAccountMemory('acc1', { kind: 'rescore', payload: { why_narrative: 'x' } }, { store, tenantId: 't1' });
    expect(store.appendMemory).toHaveBeenCalledTimes(1);
    const arg = store.appendMemory.mock.calls[0][0];
    expect(arg.topic).toBe('account:acc1');
    expect(arg.entityId).toBe('acc1');
    expect(arg.entityType).toBe('ACCOUNT');
    expect(arg.tenantId).toBe('t1');
    expect(arg.kind).toBe('rescore');
    expect(r.ok).toBe(true);
  });

  it('蒸馏：30 天前历史聚合成 curated note，且 log 仍保留（append-only，零 DELETE）', async () => {
    const store = {
      retrieveMemory: vi.fn(async () => ({ channel: 'log', rows: [
        { kind: 'rescore', created_at: OLD, payload: { why_narrative: 'a' } },
        { kind: 'rescore', created_at: OLD, payload: { why_narrative: 'b' } },
      ] })),
      upsertNote: vi.fn(async (n) => ({ id: 'note1', ...n })),
    };
    const note = await distillAccountMemory('acc1', { store, now: Date.now() });
    expect(note.content).toContain('a');           // 真实 note 行键是 content，非 summary
    expect(DISTILL_AFTER_DAYS).toBe(30);
    expect(store.upsertNote).toHaveBeenCalledTimes(1);
    expect(store.deleteMemoryLog).toBeUndefined(); // 零 DELETE
  });

  it('无过期历史 → null（不产空 note）', async () => {
    const store = {
      retrieveMemory: vi.fn(async () => ({ channel: 'log', rows: [
        { kind: 'rescore', created_at: new Date().toISOString(), payload: {} },
      ] })),
      upsertNote: vi.fn(async () => ({ id: 'x' })),
    };
    expect(await distillAccountMemory('acc1', { store, now: Date.now() })).toBeNull();
    expect(store.upsertNote).not.toHaveBeenCalled();
  });

  it('零 DELETE：源码无删写字面', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/memory/accountMemory.js'), 'utf8');
    expect(/DELETE\s+FROM|\.delete\s*\(/i.test(src)).toBe(false);
  });
});
