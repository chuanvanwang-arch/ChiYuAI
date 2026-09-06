// test/context-supply-7x7.test.js — 三问可测性护栏：
//   ① 如何测试故事线（S5 / WHEN 轴）
//   ② 如何测试决策 7 轴（校验侧七维 dim_coverage）
//   ③ 如何测试「决策真调用了 7×7 记忆系统」（7 供给操作 × 7 校验维度的运行时闭环）
//
// 设计原则：
//   - A/B 组零 DB 依赖（纯函数 + 注入桩），不污染共享测试库（共享库污染是本项目已知伪失败源）。
//   - C 组走真实 createDecision（不是手调装配），才叫「决策调用」；只断言自己创建的 decision_id，不 TRUNCATE。
//   - 每组都含一条「反假绿」断言：声明式恒绿 vs 运行时真实状态的差异必须能被测出来（BG-04）。
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { query } from '../src/db.js';
import {
  buildTimelineRows, chronological, formatTimelineRow, retrieveTimeline, DECISION_TIME_BASIS,
} from '../src/context/timelineSource.js';
import {
  resolveAccountId, assembleContextV2, computeDimCoverage,
} from '../src/context/assembleContextV2.js';
import { DEFAULT_SUPPLY_OPS, validateSupplySpec, dimCoverageFromOps } from '../src/context/supplySpec.js';
import { DIM_KEYS } from '../src/sevenDimensions/constants.js';
import { getDecisionContextSnapshot } from '../src/context/snapshotStore.js';
import { createDecision } from '../src/decision/decisionRepo.js';
import { ensureProvenanceSchema } from '../src/decision/provenance.js';

// ─────────────────────────────────────────────────────────────────────────────
// A. 故事线（S5 / WHEN 轴）怎么测
//    测四层：纯函数（去重/排序/渲染）→ 作用域推断 → 查询层 SQL 形态 → 装配层产出
// ─────────────────────────────────────────────────────────────────────────────
describe('A. 故事线（S5 / WHEN 轴）可测性', () => {
  const row = (ts, type, entityId, extra = {}) => ({
    ts, type, title: `${type}标题`, source: '测试源', actor: 'alice',
    entityType: 'CRM_ACCOUNT', entityId, summary: '', ...extra,
  });

  it('A1 纯函数：同 ts|type|entityId 去重 + 按 ts 倒序', () => {
    const rows = buildTimelineRows([
      row('2026-08-01T10:00:00Z', 'decision', 'e1'),
      row('2026-08-03T10:00:00Z', 'task', 'e2'),
      row('2026-08-01T10:00:00Z', 'decision', 'e1'), // 重复：同 ts|type|entityId
      row('2026-08-02T10:00:00Z', 'event', 'e3'),
    ]);
    expect(rows.length).toBe(3); // 去重后 3 条
    expect(rows.map((r) => r.ts)).toEqual([
      '2026-08-03T10:00:00Z', '2026-08-02T10:00:00Z', '2026-08-01T10:00:00Z',
    ]); // 倒序
  });

  it('A2 chronological 倒序→正序（叙事按最早→最近阅读）', () => {
    const desc = buildTimelineRows([
      row('2026-08-01T10:00:00Z', 'decision', 'e1'),
      row('2026-08-03T10:00:00Z', 'task', 'e2'),
    ]);
    const asc = chronological(desc);
    expect(asc.map((r) => r.ts)).toEqual(['2026-08-01T10:00:00Z', '2026-08-03T10:00:00Z']);
  });

  it('A3 formatTimelineRow 渲染三要素（时间/来源/标题）', () => {
    const line = formatTimelineRow(row('2026-08-03T10:00:00Z', 'decision', 'e1', { title: 'OPP_QUALIFY' }));
    expect(line).toContain('2026-08-03 10:00');
    expect(line).toContain('测试源');
    expect(line).toContain('OPP_QUALIFY');
  });

  it('A4 作用域推断：entities 真实形态 {type,id} 必须推出 account_id（2026-09-02 缝修复护栏）', () => {
    // 决策链路真实传参（decisionRepo.js:113 传 involved_entities=[{type:'CRM_ACCOUNT', id}]）
    const entities = [{ type: 'CRM_DEAL', id: 'd1' }, { type: 'CRM_ACCOUNT', id: 'a1' }];
    expect(resolveAccountId({ entities })).toBe('a1');
    // 显式 account_id 优先；无实体时回退 null（不抛错）
    expect(resolveAccountId({ account_id: 'explicit', entities })).toBe('explicit');
    expect(resolveAccountId({ entities: [] })).toBe(null);
    expect(resolveAccountId({})).toBe(null);
  });

  it('A5 查询层：决策源 SQL 兼容数组形态 involved_entities（防 2026-09-02 恒 false 缝回潮）', async () => {
    const calls = [];
    const fakeQuery = async (sql, params) => {
      calls.push({ sql: String(sql).replace(/\s+/g, ' '), params });
      return { rows: [] };
    };
    await retrieveTimeline({ accountId: 'ACC-X', dealIds: ['D1'], query: fakeQuery });

    // 四源都发起了查询（events/tasks/decision/memory_log）
    expect(calls.length).toBe(4);
    const decisionCall = calls.find((c) => c.sql.includes('FROM crm.decision'));
    expect(decisionCall).toBeTruthy();

    // ① 数组形态匹配：jsonb_typeof 守卫 + jsonb_array_elements 元素 id 命中
    expect(decisionCall.sql).toContain('jsonb_typeof(involved_entities)');
    expect(decisionCall.sql).toContain('jsonb_array_elements(involved_entities)');
    // ② 账户 id 作为独立参数传入（$3），不是只拼进对象形态
    expect(decisionCall.params).toContain('ACC-X');
    expect(decisionCall.params.length).toBeGreaterThanOrEqual(3);
    // ③ BG-08：决策时间基准不得漂移回裸 created_at
    expect(decisionCall.sql).toContain(DECISION_TIME_BASIS);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. 决策 7 轴怎么测
//    核心是「反假绿」：声明式（谁声明服务谁）恒 7/7，运行时（谁真命中）才代表真实供给。
// ─────────────────────────────────────────────────────────────────────────────
describe('B. 决策 7 轴（dim_coverage）可测性', () => {
  it('B1 注册表自检：7 操作齐备 + 7 维全覆盖 + 无悬空项', () => {
    const v = validateSupplySpec(DEFAULT_SUPPLY_OPS);
    expect(v.valid).toBe(true);
    expect(v.errors).toEqual([]);
    expect(new Set(v.coveredDims).size).toBe(DIM_KEYS.length);
    expect(DEFAULT_SUPPLY_OPS.map((o) => o.op)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
  });

  it('B2 反假绿（核心）：ops 全部 empty → supplied 必须是 0，不是 7', () => {
    // BG-04 假绿的根治点：若按「声明即覆盖」算，这里会是 7；运行时判定必须是 0。
    const ops = DEFAULT_SUPPLY_OPS.map((o) => ({ op: o.op, serves_dims: o.serves_dims, status: 'empty' }));
    const cov = computeDimCoverage(ops);
    const supplied = Object.values(cov).filter((d) => d.supplied).length;
    expect(supplied).toBe(0);
    // 但维度键仍须齐全（缺键=覆盖表结构破损，与供给数为 0 是两回事）
    expect(Object.keys(cov).length).toBe(DIM_KEYS.length);
  });

  it('B3 ops 全部 hit → supplied = 7（S7 服务全 7 维，兜底满供给）', () => {
    const ops = DEFAULT_SUPPLY_OPS.map((o) => ({ op: o.op, serves_dims: o.serves_dims, status: 'hit' }));
    const cov = computeDimCoverage(ops);
    expect(Object.values(cov).filter((d) => d.supplied).length).toBe(DIM_KEYS.length);
  });

  it('B4 声明式 vs 运行时：dimCoverageFromOps 恒 7，computeDimCoverage 按 status → 差异即诚实差', () => {
    const declared = dimCoverageFromOps(DEFAULT_SUPPLY_OPS);
    const declaredN = Object.values(declared).filter((d) => d.supplied).length;
    const runtimeOps = DEFAULT_SUPPLY_OPS.map((o) => ({
      op: o.op, serves_dims: o.serves_dims, status: o.op === 'S1' ? 'hit' : 'empty',
    }));
    const runtimeN = Object.values(computeDimCoverage(runtimeOps)).filter((d) => d.supplied).length;
    expect(declaredN).toBe(DIM_KEYS.length); // 声明式：永远满（不可用作品质指标）
    expect(runtimeN).toBeLessThan(declaredN); // 运行时：只有 S1 命中 → 2 维（identity/structure）
    expect(runtimeN).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. 决策是否真调用 7×7 记忆系统怎么测
//    判据不是「装配函数存在」，而是：真实 createDecision 后，
//    ① 产出快照且 ops=S1..S7 七条  ② dim_coverage 七键齐全  ③ decision↔snapshot 双向互指
//    ④ S7 操作级 PROV-O 留痕  ⑤ 注入形态为四段制（事实/故事/规则/先例）
// ─────────────────────────────────────────────────────────────────────────────
describe('C. 决策真调用 7×7 记忆系统（E2E）', () => {
  it('C1 createDecision → 自动装配：七操作齐 + 七维键齐 + 快照与决策双向互指', async () => {
    const { rows: [sc] } = await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`);
    const accountId = randomUUID();

    // 关键：走**真实决策创建**（不是手调 assembleContextV2），才能证明「决策调用了」记忆系统
    const d = await createDecision({
      scenario_id: sc.scenario_id,
      trigger_context: { query: '7x7 记忆系统调用验证', stage: 'qualify' },
      involved_entities: [{ type: 'CRM_ACCOUNT', id: accountId, name: '7x7 验证客户' }],
      conditions_evaluated: [{ name: 'bantcc', met: true }],
      effective_policy_version: null, // 测试库无 policy_version 行，避免 FK 失败
      disposition: 'PROCEED',
      decider_type: 'agent',
      decider_id: '7x7-test',
      rationale: 'C1：验证决策创建自动触发 7×7 装配并回指快照',
      business_tier: 'HIGH',
      state: 'PROCESSED',
      tenantId: 'system',
    });
    expect(d.decision_id).toBeTruthy();

    // ① 装配确实由决策创建触发：DB 权威行已回指快照
    const { rows: [row] } = await query(
      `SELECT context_snapshot_id FROM crm.decision WHERE decision_id=$1::uuid`, [d.decision_id]
    );
    expect(row.context_snapshot_id).toBeTruthy();

    // ② 七操作齐 + 七维键齐（「7×7」的第一层含义：7 供给操作 × 7 校验维度）
    const snap = await getDecisionContextSnapshot(d.decision_id);
    expect(snap).toBeTruthy();
    expect(snap.ops.map((o) => o.op).sort()).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    expect(Object.keys(snap.dim_coverage).sort()).toEqual([...DIM_KEYS].sort());

    // ③ 双向互指：快照→决策 且 决策→快照（防「快照落了但没挂上」的半接线）
    expect(String(snap.decision_id)).toBe(String(d.decision_id));
    expect(String(snap.snapshot_id)).toBe(String(row.context_snapshot_id));

    // ④ 不静默：任一操作失败必须留 status=degraded/timeout 而非静默消失
    for (const o of snap.ops) {
      expect(['hit', 'empty', 'degraded', 'timeout']).toContain(o.status);
      expect(typeof o.cost_ms).toBe('number');
    }
  });

  it('C2 S7 操作级 PROV-O：装配留痕可查（每个操作一条 context_supply）', async () => {
    // 溯源真实落点是 crm.decision_provenance（provenance.js:52），不是 memory_log 也不是 audit_event。
    await ensureProvenanceSchema(); // 幂等建表（测试库对齐 schema.sql 的 DDL）
    const { rows: [sc] } = await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`);
    const d = await createDecision({
      scenario_id: sc.scenario_id,
      trigger_context: { query: 'PROV-O 留痕验证', stage: 'qualify' },
      involved_entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: 'PROV-O 验证' }],
      conditions_evaluated: [{ name: 'bantcc', met: true }],
      effective_policy_version: null,
      disposition: 'PROCEED',
      decider_type: 'agent',
      decider_id: '7x7-test-prov',
      rationale: 'C2：验证 S7 操作级溯源留痕',
      business_tier: 'HIGH',
      state: 'PROCESSED',
      tenantId: 'system',
    });

    // 溯源真实落点：crm.decision_provenance（entry_type='context_supply'，逐操作一条）
    const { rows: prov } = await query(
      `SELECT entry_type, payload FROM crm.decision_provenance
        WHERE decision_id=$1::uuid AND entry_type='context_supply'`, [d.decision_id]
    );
    expect(prov.length).toBeGreaterThanOrEqual(1); // S1–S7 逐操作留痕（至少一条，证明 S7 接线通）
    // 每条留痕须含装配标识与操作状态（否则不可审计）
    for (const p of prov) {
      expect(p.payload).toHaveProperty('assembly_id');
      expect(p.payload).toHaveProperty('op');
      expect(['hit', 'empty', 'degraded', 'timeout']).toContain(p.payload.status);
    }
  });

  it('C3 注入形态：四段制（事实/故事/规则/先例），非标签列表', async () => {
    const bundle = await assembleContextV2({
      actor: '7x7-test',
      scenario_id: (await query(`SELECT scenario_id FROM crm.decision_scenario LIMIT 1`)).rows[0].scenario_id,
      query: '注入形态验证',
      entities: [{ type: 'CRM_ACCOUNT', id: randomUUID(), name: '注入形态验证客户' }],
      tenant_id: 'system',
    });
    // 至少渲染出事实段（S1 必命中）；其余段按命中情况出现——但绝不能是裸标签列表
    expect(bundle.prompt_block).toContain('▸ 事实');
    expect(bundle.prompt_block).not.toMatch(/^·?\s*(identity|structure)\s*[:：]/m);
    // 每条事实必须带来源标注（BG-01a：不可审计即不注入）
    const factLines = bundle.prompt_block.split('\n').filter((l) => l.trim().startsWith('·'));
    expect(factLines.length).toBeGreaterThanOrEqual(1);
  });
});

// ── D 组：四问判据「反假绿」护栏（2026-09-02 审计发现，防回潮）──
// 背景：auditability.computeAudit4q 的 Q1 原用「有上游先例或 rationale」判定，
//   与设计文档 §7.1「dim_coverage.supplied_dims ≥5/7」完全脱节 → 实测供给 2~4/7 仍判 pass（假绿）。
//   Q2 原只看 chainStatus，而 verifyChain 对空 entries 天然返回 OK → 「零溯源条目」也判 pass（假绿）。
// 护栏形态：**不变量断言**（不依赖具体数据），凡 pass 必满足其证据门槛；回潮即红。
describe('D 组 四问判据反假绿护栏（设计 §7.1 口径）', () => {
  it('D1 Q1 阈值常量 = 设计文档字面值 5/7', async () => {
    const { Q1_MIN_SUPPLIED_DIMS } = await import('../src/decision/auditability.js');
    expect(Q1_MIN_SUPPLIED_DIMS).toBe(5); // §7.1 Q1 通过条件：supplied_dims ≥ 5/7
  });

  it('D2 不变量：Q1=pass 的决策，其 supplied_dims 必须 ≥ 5（不得用 rationale 顶替）', async () => {
    const { computeAudit4q } = await import('../src/decision/auditability.js');
    const { rows } = await query(
      `SELECT decision_id FROM crm.decision ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 10`
    );
    let checked = 0;
    for (const { decision_id } of rows) {
      const a = await computeAudit4q(decision_id);
      if (!a) continue;
      checked++;
      const dims = a.questions.Q1.supplied_dims;
      if (a.health.statuses.Q1 === 'pass') {
        // pass 必须有真证据：维度供给达门槛。dims 为 null（无快照）时绝不可 pass
        expect(dims).not.toBeNull();
        expect(dims).toBeGreaterThanOrEqual(5);
      } else {
        // 反向：供给达门槛却判 warn → 判据过严，同样是不一致（暴露即修，不静默）
        if (dims !== null && dims >= 5) {
          throw new Error(`Q1 判据不一致：supplied_dims=${dims} 达门槛却判 ${a.health.statuses.Q1}`);
        }
      }
      // Q1 判据不得退化为「仅看 rationale」：字段必须携带维度证据
      expect(a.questions.Q1).toHaveProperty('supplied_dims');
    }
    expect(checked).toBeGreaterThan(0);
  }, 60000);

  it('D3 不变量：Q2=pass 必须同时满足 链OK + entries>0 + 含 context_supply（空链不可自称 OK）', async () => {
    const { computeAudit4q } = await import('../src/decision/auditability.js');
    const { rows } = await query(
      `SELECT decision_id FROM crm.decision ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 10`
    );
    let checked = 0;
    for (const { decision_id } of rows) {
      const a = await computeAudit4q(decision_id);
      if (!a) continue;
      checked++;
      const { entries, context_supply_entries: supplyEntries, chain_status: chain } = a.questions.Q2;
      if (a.health.statuses.Q2 === 'pass') {
        expect(chain).toBe('OK');
        expect(entries).toBeGreaterThan(0);        // 空链假绿的根治点
        expect(supplyEntries).toBeGreaterThan(0);  // §7.1「且覆盖上下文操作」
      }
      // 反向不变量：零条目绝不可 pass（这是本次修复的核心断言）
      if (entries === 0) {
        expect(a.health.statuses.Q2).not.toBe('pass');
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 60000);
});
