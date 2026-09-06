// test/propagation/routes.test.js
// Task 6（RED→GREEN）：中枢 API acceptSuggestion 经 requireDecision（第0闸）+ writeConfig（upsert 禁删）落库
// 设计依据：docs/2026-09-04-param-propagation-hub-design.md §5、§6；计划 Task 6
// 铁律：写操作 100% 经决策第0闸；绝对禁 DELETE（由 no-delete 专项测试覆盖）。
import { describe, it, expect } from 'vitest';

function makeCtx() {
  const actions = [];
  const pool = {
    query: async (t, a) => {
      if (t.includes('INSERT INTO crm.propagation_action')) {
        actions.push({ ref: a[0], status: a[1] });
        return { rows: [{ id: a[0] }] };
      }
      if (t.includes('FROM crm.propagation_action WHERE status <>')) return { rows: [] };
      if (t.startsWith('SELECT') && t.includes('crm.decision_retro_report')) {
        return { rows: [{ report_id: 'r1', draft_patches: JSON.stringify([{ knob: 'config_store', target: 'precedent-conf.minSimilarity', to_value: 0.4, tenant_id: 't-a', risk: 'LOW', label: '放宽' }]) }] };
      }
      return { rows: [] };
    },
  };
  return { pool, actions };
}

// ── 继承矩阵 / 已落地留痕 辅助桩（按 SQL 形态路由到内存数据） ──
function matrixPool(store = {}) {
  // store: { 't-a': [{key:'k1',value:{minSimilarity:0.3}}, {key:'k2',value:{_seeded:'system-template'}}], ... }
  const pool = {
    query: async (t, a) => {
      if (t.includes('tenant_id <> \'system\'') && t.includes('FROM crm.config_store')) {
        const rows = [];
        const filter = a && a[0] ? a[0] : null;
        for (const [tid, items] of Object.entries(store)) {
          if (filter && tid !== filter) continue;
          for (const it of items) rows.push({ tenant_id: tid, key: it.key, value: it.value });
        }
        return { rows };
      }
      return { rows: [] };
    },
  };
  return pool;
}

describe('propagation accept', () => {
  it('accept config_store 候选 → requireDecision + writeConfig 各调用 1 次，返回 ok', async () => {
    const { pool } = makeCtx();
    const calls = { decision: 0, write: 0 };
    const mod = await import('../../src/http/propagationRoutes.js');
    mod.__setDeps({
      requireDecision: async () => {
        calls.decision++;
        return { decision_id: 'D1' };
      },
      writeConfig: async () => {
        calls.write++;
        return { ok: true };
      },
    });

    const r = await mod.acceptSuggestion(pool, {
      kind: 'config_store',
      ref: 'retro:r1:0',
      patch: { knob: 'config_store', target: 'precedent-conf.minSimilarity', to_value: 0.4, tenant_id: 't-a' },
      by: 'admin',
    });

    expect(r.ok).toBe(true);
    expect(calls.decision).toBe(1); // 第0闸命中且仅 1 次
    expect(calls.write).toBe(1); // 落库 upsert 1 次
  });

  it('未知 kind 抛错（fail-closed，不静默落库）', async () => {
    const { pool } = makeCtx();
    const mod = await import('../../src/http/propagationRoutes.js');
    mod.__setDeps({
      requireDecision: async () => ({ decision_id: 'D1' }),
      writeConfig: async () => ({ ok: true }),
    });
    await expect(
      mod.acceptSuggestion(pool, { kind: 'bogus', ref: 'x', by: 'admin' })
    ).rejects.toThrow(/未知 kind/);
  });

});

describe('propagation actions 留痕（④已落地）', () => {
  it('action 表缺一(未建)时 fail-open 返回空，不抛错', async () => {
    const pool = {
      query: async () => {
        throw new Error('42P01 undefined_table');
      },
    };
    const mod = await import('../../src/http/propagationRoutes.js');
    const items = await mod.listActions(pool, {});
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBe(0);
  });
});

describe('propagation inherit-matrix（①继承视图）', () => {
  it('custom/seeded 状态识别：_seeded 标记→seeded，无标记→custom', async () => {
    const mod = await import('../../src/http/propagationRoutes.js');
    const pool = matrixPool({
      't-a': [
        { key: 'k1', value: { minSimilarity: 0.3 } }, // 真定制
        { key: 'k2', value: { _seeded: 'system-template', minSimilarity: 0.5 } }, // 模板拷贝
      ],
      't-b': [{ key: 'k1', value: { minSimilarity: 0.6 } }],
    });
    const m = await mod.buildInheritMatrix(pool, {});
    expect(m.tenants.sort()).toEqual(['t-a', 't-b']);
    expect(m.entries['t-a']).toEqual([
      { key: 'k1', status: 'custom', value: { minSimilarity: 0.3 } },
      { key: 'k2', status: 'seeded', value: { _seeded: 'system-template', minSimilarity: 0.5 } },
    ]);
    expect(m.entries['t-b'][0].status).toBe('custom');
  });

  it('按租户过滤：tenantId 传入时仅返回该租户', async () => {
    const mod = await import('../../src/http/propagationRoutes.js');
    const pool = matrixPool({
      't-a': [{ key: 'k1', value: {} }],
      't-b': [{ key: 'k1', value: {} }],
    });
    const m = await mod.buildInheritMatrix(pool, { tenantId: 't-a' });
    expect(m.tenants).toEqual(['t-a']);
    expect(Object.keys(m.entries)).toEqual(['t-a']);
  });
});
