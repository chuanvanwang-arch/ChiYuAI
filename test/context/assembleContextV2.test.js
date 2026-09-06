// A-T3/A-T4/A-T5 — assembleContextV2 供给侧 S1–S7 装配编排 + 快照落库 + 分层注入
//
// 覆盖点：
//   A-T3 装配即审计：7 操作并行（Promise.allSettled）+ 逐操作 200ms 独立超时；
//        单操作失败/超时不影响其余（不静默 missing，升级为结构化 status）。
//   A-T4 快照落库：crm.decision_context_snapshot（ops/dim_coverage/supplied_dims/degraded/prompt_block/prompt_hash）；
//        逐操作 trackEntry 写 PROV-O（S7 操作级溯源）；落库失败 fail-open 仍返回装配结果。
//   A-T5 注入形态：事实/叙事/规则/先例四段，每条带来源 id；S2 仅出先例段不重复出事实段。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
  writes: [],
  trackEntries: [],
}));

vi.mock('../../src/db.js', () => ({
  query: vi.fn(async () => ({ rows: [] })),
  queryWrite: vi.fn(async (sql, params) => {
    state.writes.push({ sql, params });
    return { rowCount: 1 };
  }),
}));
vi.mock('../../src/decision/provenance.js', () => ({
  trackEntry: vi.fn(async (p) => {
    state.trackEntries.push(p);
    return { ok: true };
  }),
}));

const {
  assembleContextV2,
  defaultRetrievers,
  computeDimCoverage,
  formatForPromptV2,
} = await import('../../src/context/assembleContextV2.js');

// 构造 7 个可控 retriever（注入覆盖真实模块，零外部依赖）
function mkRetrievers(overrides = {}) {
  const ok = async (items, extra = {}) => ({ items, ...extra });
  const base = {
    S1: async () => ok([{ id: 'p-1', label: 'CRM_ACCOUNT', source: 'particle:p-1' }]),
    S2: async () => ok([{ similarity: 0.82, scenario: 'SC-9', disposition: 'approved', source: 'precedent:SC-9' }]),
    S3: async () => ok([{ attr: 'budget', sources: ['a', 'b'], source: 'conflict:c1' }]),
    S4: async () => ok([{ rule: 'R1', result: 'block' }]),
    S5: async () => ok([{ ts: '2026-02-01T00:00:00Z', type: 'decision', title: 'stage-gate', source: '决策', summary: '推进', entity: 'd1' }]),
    S6: async () => ok([{ id: 't1', title: '跟进', action: 'followup', status: 'done', source: 'task:t1' }]),
    S7: async () => ok([]),
  };
  return { ...base, ...overrides };
}

beforeEach(() => {
  state.writes = [];
  state.trackEntries = [];
});

describe('A-T3 — 七操作并行装配（Promise.allSettled 不静默）', () => {
  it('默认 7 操作全部装配 → ops 长度 7，S1–S6 命中、S7 为 empty（溯源捕获无运行期条目）', async () => {
    const r = await assembleContextV2({ actor: 'alice', decision_id: 'd1' }, mkRetrievers());
    expect(r.ops).toHaveLength(7);
    const byOp = Object.fromEntries(r.ops.map((o) => [o.op, o.status]));
    expect(byOp.S1).toBe('hit'); expect(byOp.S2).toBe('hit'); expect(byOp.S3).toBe('hit');
    expect(byOp.S4).toBe('hit'); expect(byOp.S5).toBe('hit'); expect(byOp.S6).toBe('hit');
    expect(byOp.S7).toBe('empty');
    const s1 = r.ops.find((o) => o.op === 'S1');
    expect(s1.provenance.source).toBe('retrieveEntityProfile+particles');
    expect(s1.items[0].source).toBe('particle:p-1');
  });

  it('单操作抛异常 → 该 op status=degraded，其余 S1/S2/S4/S5/S6 仍命中（降级留痕不阻断）', async () => {
    const rs = mkRetrievers({ S3: async () => { throw new Error('conflict svc down'); } });
    const r = await assembleContextV2({ actor: 'alice' }, rs);
    const s3 = r.ops.find((o) => o.op === 'S3');
    expect(s3.status).toBe('degraded');
    expect(s3.note).toContain('conflict svc down');
    expect(s3.items).toEqual([]);
    expect(r.ops.find((o) => o.op === 'S7').status).toBe('empty');
    expect(r.ops.filter((o) => o.status === 'hit')).toHaveLength(5);
    expect(r.degraded).toBe(true);
  });

  it('单操作超时（>200ms）→ status=timeout 且记录 note，其余不受影响', async () => {
    const rs = mkRetrievers({ S4: async () => {
      await new Promise((res) => setTimeout(res, 300));
      return { items: [{ rule: 'R1' }] };
    } });
    const r = await assembleContextV2({ actor: 'alice' }, rs);
    const s4 = r.ops.find((o) => o.op === 'S4');
    expect(s4.status).toBe('timeout');
    expect(s4.note).toContain('超时');
    expect(r.ops.find((o) => o.op === 'S7').status).toBe('empty');
    expect(r.ops.filter((o) => o.status === 'hit')).toHaveLength(5);
  });

  it('每个 op 带 cost_ms 耗时字段（装配即审计可观测）', async () => {
    const r = await assembleContextV2({ actor: 'alice' }, mkRetrievers());
    expect(r.ops.every((o) => typeof o.cost_ms === 'number' && o.cost_ms >= 0)).toBe(true);
  });
});

describe('A-T5 — 分层注入 formatForPromptV2（四段 + 来源可追溯）', () => {
  it('S2 仅出先例段、不重复出事实段（修复双段重复缺陷）', () => {
    const ops = [
      { op: 'S1', name: '实体与结构取', kind: 'fact', serves_dims: ['identity'], status: 'hit', items: [{ label: 'CRM_ACCOUNT', source: 'particle:p-1' }] },
      { op: 'S2', name: '决策史检索', kind: 'fact', serves_dims: ['decision_history'], status: 'hit', items: [{ similarity: 0.8, scenario: 'SC-9', disposition: 'approved', source: 'precedent:SC-9' }] },
      { op: 'S3', name: '冲突探测', kind: 'fact', serves_dims: ['semantics'], status: 'hit', items: [{ attr: 'budget', source: 'conflict:c1' }] },
      { op: 'S4', name: '规则校验', kind: 'deterministic', serves_dims: ['governance'], status: 'hit', items: [{ rule: 'R1', result: 'block' }] },
      { op: 'S5', name: '时间线构建', kind: 'narrative', serves_dims: ['time_config'], status: 'hit', items: [{ ts: '2026-02-01', type: 'decision', title: 'stage-gate', source: '决策', summary: '推进' }] },
      { op: 'S6', name: '运行态取', kind: 'fact', serves_dims: ['operational_state'], status: 'hit', items: [{ id: 't1', title: '跟进', source: 'task:t1' }] },
      { op: 'S7', name: '溯源捕获', kind: 'deterministic', serves_dims: [], status: 'empty', items: [] },
    ];
    const blk = formatForPromptV2(ops);
    expect(blk).toContain('事实（S1/S3/S6）'); // S2 不在事实段
    expect(blk).toContain('相似先例（S2');
    expect(blk).toContain('故事时间线（S5');
    expect(blk).toContain('治理边界（S4');
    // S2 的内容只应出现在先例段，不重复出现在事实段
    const factSegment = blk.split('▸ 事实')[1]?.split('▸ 故事')[0] || '';
    expect(factSegment).not.toContain('SC-9');
  });

  it('每条事实/先例项携带 [source: id]，否则不可审计', () => {
    const ops = [
      { op: 'S1', name: '实体与结构取', kind: 'fact', serves_dims: ['identity'], status: 'hit', items: [{ label: 'CRM_ACCOUNT', source: 'particle:p-1' }] },
      { op: 'S2', name: '决策史检索', kind: 'fact', serves_dims: ['decision_history'], status: 'hit', items: [{ similarity: 0.8, scenario: 'SC-9', disposition: 'approved', source: 'precedent:SC-9' }] },
      { op: 'S3', name: '冲突探测', kind: 'fact', serves_dims: ['semantics'], status: 'empty', items: [] },
      { op: 'S4', name: '规则校验', kind: 'deterministic', serves_dims: ['governance'], status: 'empty', items: [] },
      { op: 'S5', name: '时间线构建', kind: 'narrative', serves_dims: ['time_config'], status: 'empty', items: [] },
      { op: 'S6', name: '运行态取', kind: 'fact', serves_dims: ['operational_state'], status: 'empty', items: [] },
      { op: 'S7', name: '溯源捕获', kind: 'deterministic', serves_dims: [], status: 'empty', items: [] },
    ];
    const blk = formatForPromptV2(ops);
    expect(blk).toContain('[source: particle:p-1]');
    expect(blk).toContain('[source: precedent:SC-9]');
  });

  it('空装配（全 empty）→ 返回空串而非 undefined/报错', () => {
    const ops = [
      { op: 'S1', name: 'x', kind: 'fact', serves_dims: ['identity'], status: 'empty', items: [] },
      { op: 'S2', name: 'x', kind: 'fact', serves_dims: ['decision_history'], status: 'empty', items: [] },
      { op: 'S3', name: 'x', kind: 'fact', serves_dims: ['semantics'], status: 'empty', items: [] },
      { op: 'S4', name: 'x', kind: 'deterministic', serves_dims: ['governance'], status: 'empty', items: [] },
      { op: 'S5', name: 'x', kind: 'narrative', serves_dims: ['time_config'], status: 'empty', items: [] },
      { op: 'S6', name: 'x', kind: 'fact', serves_dims: ['operational_state'], status: 'empty', items: [] },
      { op: 'S7', name: 'x', kind: 'deterministic', serves_dims: [], status: 'empty', items: [] },
    ];
    expect(formatForPromptV2(ops)).toBe('');
  });
});

describe('A-T3 — computeDimCoverage（真实供给驱动覆盖，根 BG-04 假绿）', () => {
  it('全命中 → 7 维 supplied=true', async () => {
    const r = await assembleContextV2({ actor: 'alice' }, mkRetrievers());
    const cov = r.dim_coverage;
    const dims = Object.keys(cov);
    expect(dims).toHaveLength(7);
    expect(dims.every((d) => cov[d].supplied)).toBe(true);
    expect(r.supplied_dims).toBe(7);
  });

  it('空装配 → supplied_dims=0（无内容供给即不声称覆盖，防假绿）', async () => {
    const rs = mkRetrievers({
      S1: async () => ({ items: [] }), S2: async () => ({ items: [] }), S3: async () => ({ items: [] }),
      S4: async () => ({ items: [] }), S5: async () => ({ items: [] }), S6: async () => ({ items: [] }), S7: async () => ({ items: [] }),
    });
    const r = await assembleContextV2({ actor: 'alice' }, rs);
    expect(r.supplied_dims).toBe(0);
    expect(Object.values(r.dim_coverage).every((d) => !d.supplied)).toBe(true);
  });

  it('computeDimCoverage 纯函数：部分命中仅标记对应维', () => {
    const ops = [
      { op: 'S1', name: 'x', kind: 'fact', serves_dims: ['identity', 'structure'], status: 'hit', items: [{ id: '1' }] },
      { op: 'S2', name: 'x', kind: 'fact', serves_dims: ['decision_history'], status: 'empty', items: [] },
    ];
    const cov = computeDimCoverage(ops);
    expect(cov.identity.supplied).toBe(true);
    expect(cov.structure.supplied).toBe(true);
    expect(cov.decision_history.supplied).toBe(false);
  });
});

describe('A-T4 — 快照落库 decision_context_snapshot（真实供给落库，根 BG-04）', () => {
  it('装配后写一条快照：ops/dim_coverage/supplied_dims/degraded/prompt_block/prompt_hash 齐全', async () => {
    const r = await assembleContextV2({ actor: 'alice', decision_id: 'd1', query_text: '是否推进 S3' }, mkRetrievers());
    expect(state.writes).toHaveLength(2); // INSERT 快照 + UPDATE decision.context_snapshot_id
    const ins = state.writes[0];
    expect(ins.sql).toContain('INSERT INTO crm.decision_context_snapshot');
    const p = ins.params;
    expect(p[2]).toBe('d1'); // decision_id
    expect(p[6]).toBe('是否推进 S3'); // query_text
    expect(JSON.parse(p[7])).toHaveLength(7); // ops
    expect(Object.keys(JSON.parse(p[8]))).toHaveLength(7); // dim_coverage
    expect(p[9]).toBe(7); // supplied_dims
    expect(p[10]).toBe(false); // degraded
    expect(p[11]).toBe(r.prompt_block); // prompt_block
    expect(p[12]).toHaveLength(32); // prompt_hash sha256(16B)? -> 32 hex
    expect(p[13]).toBeGreaterThanOrEqual(0); // cost_ms
    expect(r.persisted).toBe(true);
    expect(r.snapshot_id).toBeTruthy();
  });

  it('无 decision_id 时不发 UPDATE 回指（避免误写无关决策）', async () => {
    await assembleContextV2({ actor: 'alice' }, mkRetrievers());
    const ups = state.writes.filter((w) => w.sql.includes('UPDATE crm.decision SET context_snapshot_id'));
    expect(ups).toHaveLength(0);
    expect(state.writes).toHaveLength(1);
  });

  it('decision_id 回指 UPDATE 走 .catch 不阻断快照（弱一致，非强一致点）', async () => {
    // queryWrite 第二次（UPDATE）抛错被 .catch 吞掉，persisted 仍为 true
    const { queryWrite } = await import('../../src/db.js');
    let call = 0;
    queryWrite.mockImplementation(async (sql, params) => {
      call += 1;
      if (call === 2) throw new Error('decision row locked');
      state.writes.push({ sql, params });
      return { rowCount: 1 };
    });
    const r = await assembleContextV2({ actor: 'alice', decision_id: 'd1' }, mkRetrievers());
    expect(r.persisted).toBe(true); // INSERT 成功即视为已落库
    queryWrite.mockImplementation(async (sql, params) => { state.writes.push({ sql, params }); return { rowCount: 1 }; });
  });
});

describe('A-T4 — S7 操作级 PROV-O 溯源（trackEntry 逐操作留痕）', () => {
  it('每个操作写一条 context_supply 条目（7 操作 = 7 条），含 assembly_id/op/status', async () => {
    const r = await assembleContextV2({ actor: 'alice', decision_id: 'd1' }, mkRetrievers());
    const sup = state.trackEntries.filter((e) => e.entry_type === 'context_supply');
    expect(sup).toHaveLength(7);
    expect(sup.every((e) => e.payload.assembly_id === r.assembly_id)).toBe(true);
    expect(sup.map((e) => e.payload.op).sort()).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
  });

  it('快照落库整体失败 → 写 context_supply_failed 且装配结果仍返回（fail-open）', async () => {
    const { queryWrite } = await import('../../src/db.js');
    const err = new Error('snapshot table missing');
    queryWrite.mockImplementation(async () => { throw err; });
    const r = await assembleContextV2({ actor: 'alice', decision_id: 'd1' }, mkRetrievers());
    expect(r.persisted).toBe(false);
    expect(r.ops).toHaveLength(7); // 装配结果不丢失
    const failed = state.trackEntries.find((e) => e.entry_type === 'context_supply_failed');
    expect(failed).toBeTruthy();
    expect(failed.payload.error).toContain('snapshot table missing');
    queryWrite.mockImplementation(async (sql, params) => { state.writes.push({ sql, params }); return { rowCount: 1 }; });
  });
});

describe('A-T3 — defaultRetrievers 接线结构（真实模块注册不缺失）', () => {
  it('返回 S1–S7 七键函数表，fallback 到真实模块而非抛错', () => {
    const rs = defaultRetrievers();
    for (const k of ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']) {
      expect(typeof rs[k]).toBe('function');
    }
  });

  it('defaultRetrievers 在无 scope 时安全返回空（S2 无 scenario_id / S3 无 entity / S5 无 account）', async () => {
    const rs = defaultRetrievers();
    // 这些分支在真实模块未 mock 时走 early-return 空，验证不抛
    expect(await rs.S2({ scenario_id: null })).toEqual({ items: [] });
    expect(await rs.S3({ entities: [] })).toEqual({ items: [] });
    const s5 = await rs.S5({ account_id: null, entities: [] });
    expect(s5.items).toEqual([]); // 无 account 作用域安全返回空（hash 为派生字段，不强制）
  });
});
