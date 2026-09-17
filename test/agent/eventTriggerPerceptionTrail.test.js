// E5-2② 护栏（2026-09-16）：感知桥 `recordPerception` 的两处静默必须留痕
//
// 背景（设计附录 E.5 / E.6）：判据 B（`gen_silent`，`src/monitor/signalMetrics.js`）自称语义是
//   「event-trigger **命中**但无内部信号生成」，而"命中"是用 `crm.signal.source='event-trigger'`
//   的**行数**测量的 —— 这些行**正是感知桥 `recordPerception` 自己写的**。桥此前有两处静默：
//     ① `!signalStoreRef` 直接 `return null`（未注入 ≠ 未命中，且无留痕）
//     ② 写入失败 `.catch(() => null)` 空吞（违 §15「不静默失败」）
//   ⇒ 桥写得越少 → 判据越认为"没命中" → 越不报警（**管道越坏、判据越安静**）。
//
// 本文件只修"可观测性"这一半（**零设计风险**）；"换独立仪器"那一半是设计决策，见 E.6，本轮不动。
//
// 隔离纪律：`vi.mock` 掉 db.js / configStore.js → 不触库、不读项目根 `.env`、可单独裸跑。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { queryMock, queryWriteMock } = vi.hoisted(() => ({ queryMock: vi.fn(), queryWriteMock: vi.fn() }));
vi.mock('../../src/db.js', () => ({ query: queryMock, queryWrite: queryWriteMock, pool: null }));
// readConfig → null ⇒ loadTriggerConfig 回退出厂默认矩阵（本用例不关心矩阵内容，只关心感知留痕）
vi.mock('../../src/config/configStore.js', () => ({ readConfig: vi.fn(async () => null) }));

import { createEventTrigger, setSignalStore } from '../../src/agent/eventTrigger.js';
import { on } from '../../src/events/bus.js';
import { resetFailures, getFailures } from '../../src/monitor/monitorStore.js';

// 出厂默认矩阵里可命中的只读档：CRM_DEAL + ontology-sync → stage-progression
const DESC = { source: 'event', domain: 'ontology', type: 'ontology-sync', entity_type: 'CRM_DEAL' };

function captureTraces() {
  const seen = [];
  const off = on('trace', (msg) => seen.push(msg));
  return { seen, off };
}

let offTrace = null;
beforeEach(() => {
  queryMock.mockReset();
  queryWriteMock.mockReset();
  queryMock.mockResolvedValue({ rows: [] });
  queryWriteMock.mockResolvedValue({ rows: [] });
  resetFailures();
});
afterEach(() => {
  offTrace?.();
  offTrace = null;
  setSignalStore(null); // 还原模块级状态，防跨用例污染
});

async function dispatch(evPayload, tenantId = 'system') {
  const { dispatchFromTrigger } = createEventTrigger({});
  return dispatchFromTrigger(DESC, evPayload, tenantId);
}

describe('E5-2②：感知桥失败必须留痕（不得静默）', () => {
  it('store 未注入 → 留痕 perception-skipped（未注入 ≠ 未命中），且不抛', async () => {
    setSignalStore(null);
    const cap = captureTraces();
    offTrace = cap.off;

    const r = await dispatch({ entity_id: 'e5s-1', tenant_id: 'system' });
    await new Promise((res) => setTimeout(res, 20));

    expect(r).toBeTruthy(); // 命中仍返回 match，派发流程不被打断
    // ⚠ 总线包装：`emit(domain, type, payload)` 的消息形状是 `{domain, type, ts, summary}` ——
    //   载荷在 `msg.summary`（**不是** `msg.payload`），见 `src/events/bus.js:16`。
    const skip = cap.seen.find((m) => m.type === 'agent-event-trigger-perception-skipped');
    expect(skip).toBeTruthy();
    expect(skip.summary.reason).toBe('signal-store-not-injected');
    expect(skip.summary.intent).toBe('stage-progression');
  });

  it('写入失败 → 留痕 perception-failed + recordFailure 计数 +1，且不抛', async () => {
    setSignalStore({ create: async () => { throw new Error('perception-write-boom'); } });
    const cap = captureTraces();
    offTrace = cap.off;

    const r = await dispatch({ entity_id: 'e5s-2', tenant_id: 'system' });
    await new Promise((res) => setTimeout(res, 20)); // 留痕在 .catch 内，等微任务

    expect(r).toBeTruthy();
    const failed = cap.seen.find((m) => m.type === 'agent-event-trigger-perception-failed');
    expect(failed).toBeTruthy();
    expect(failed.summary.error).toContain('perception-write-boom');
    expect(failed.summary.intent).toBe('stage-progression');
    expect(getFailures()['agent-event-trigger-perception']).toBe(1);
  });

  it('写入成功 → 不得产生上述两种留痕（防"无脑留痕"把正常路径报成故障）', async () => {
    let called = 0;
    setSignalStore({ create: async () => { called++; return { signal_id: 'sig-ok' }; } });
    const cap = captureTraces();
    offTrace = cap.off;

    const r = await dispatch({ entity_id: 'e5s-3', tenant_id: 'system' });
    await new Promise((res) => setTimeout(res, 20));

    expect(r).toBeTruthy();
    expect(called).toBe(1);
    const bad = cap.seen.filter((m) => /perception-(skipped|failed)/.test(m.type));
    expect(bad).toEqual([]);
    expect(getFailures()['agent-event-trigger-perception']).toBeUndefined();
  });

  it('写入失败时信号确实未落库（留痕不掩盖"没有行"这一事实）', async () => {
    const created = [];
    setSignalStore({ create: async (row) => { created.push(row); throw new Error('nope'); } });
    // ⚠ 租户由**第二参数**决定（`dispatchFromTrigger(desc, evPayload, tenantId)`），
    //   不是从 evPayload.tenant_id 取 —— 这正是本用例第一版写错的地方。
    await dispatch({ entity_id: 'e5s-4', tenant_id: 'system' }, 'acme-demo');
    await new Promise((res) => setTimeout(res, 20));

    expect(created).toHaveLength(1);
    // 契约断言：即使留痕，也不能改成"静默补写"或"伪造一行"
    expect(created[0].tenant_id).toBe('acme-demo');
    expect(created[0].source).toBe('event-trigger');
  });
});
