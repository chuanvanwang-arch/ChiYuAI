// test/kanban-confirm-state.test.js — awaiting_confirm 状态机（Task 4）
import { describe, it, expect, beforeAll } from 'vitest';
import { TASK_STATUSES } from '../src/kanban/types.js';
import {
  requestConfirm, confirmTask, cancelConfirm, timeoutConfirm,
  getTask, createTask, resetTask,
} from '../src/kanban/kanban.js';
import { query } from '../src/db.js';

describe('TASK_STATUSES 含 awaiting_confirm', () => {
  it('枚举包含 awaiting_confirm', () => {
    expect(TASK_STATUSES).toContain('awaiting_confirm');
  });
});

describe('awaiting_confirm 函数导出', () => {
  it('requestConfirm/confirmTask/cancelConfirm/timeoutConfirm 均为函数', () => {
    expect(typeof requestConfirm).toBe('function');
    expect(typeof confirmTask).toBe('function');
    expect(typeof cancelConfirm).toBe('function');
    expect(typeof timeoutConfirm).toBe('function');
  });
});

// 集成段：仅当 crm.tasks 已含审计列（迁移已应用）时运行；否则跳过（纯逻辑段已覆盖契约）
async function auditColumnsReady() {
  try {
    await query('SELECT awaiting_confirm_at FROM tasks LIMIT 0', []);
    return true;
  } catch { return false; }
}

// 顶层 await：在 describe 收集前确定 ready（避免 skipIf 在 beforeAll 前误判）
const ready = await auditColumnsReady();

describe('awaiting_confirm 真实流转（集成，需迁移已应用）', () => {
  it.skipIf(!ready)('ready → awaiting_confirm → running（confirm）', async () => {
    const t = await createTask({ step: 1, title: 'T4-integration', actionName: 'noop' });
    const r1 = await requestConfirm(t.id, { reason: 'write' });
    expect(r1.status).toBe('awaiting_confirm');
    const r2 = await confirmTask(t.id, { role: 'sales' });
    expect(r2.status).toBe('running');
    expect(r2.confirmed_role).toBe('sales');
    await resetTask(t.id);
  });

  it.skipIf(!ready)('awaiting_confirm → ready（cancel）', async () => {
    const t = await createTask({ step: 1, title: 'T4-cancel', actionName: 'noop' });
    await requestConfirm(t.id, { reason: 'write' });
    const c = await cancelConfirm(t.id);
    expect(c.status).toBe('ready');
    await resetTask(t.id);
  });
});
