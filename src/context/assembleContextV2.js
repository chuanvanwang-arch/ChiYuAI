// src/context/assembleContextV2.js — A-T3/A-T4/A-T5：供给侧 S1–S7 装配编排 + 快照落库 + 分层注入
//
// 设计（unified 文档 §4.2–§4.6）：
//   A-T3 装配即审计：7 操作并行（Promise.allSettled）+ 逐操作独立超时 200ms；任一失败不阻断装配，
//        把"静默 missing"升级为"带 note 的结构化 status"（对齐文章「不静默」+ BG-06 留痕）。
//   A-T4 快照落库：crm.decision_context_snapshot（supplied_dims 来自运行时真实供给，根治 BG-04 假绿）；
//        逐操作 trackEntry 写 PROV-O 条目（S7 操作级溯源）。
//   A-T5 注入形态：事实/叙事/规则/先例四段，每条带来源 id（否则不可审计）；非标签列表（承接 BG-01a/b）。
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { query, queryWrite } from '../db.js';
import { DEFAULT_SUPPLY_OPS, DIM_KEYS } from './supplySpec.js';
import { retrieveEntityProfile } from './assembler.js';
import { buildTimelineRows } from './timelineSource.js';
import { loadTimelineSources } from '../account/insightService.js'; // T8 单一事实源（timelineSource.js 不再导出 loadTimelineSources）
import { searchPrecedents } from '../decision/decisionRepo.js';
import { detectConflicts } from '../decision/conflict.js';
import { ruleEngine, evaluateRules } from '../ruleEngine.js';
import { trackEntry } from '../decision/provenance.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';

const OP_TIMEOUT_MS = 200; // 逐操作独立超时（unified §4.5）

function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((resolve) => setTimeout(() => resolve({ __timeout: true }), ms)),
  ]);
}

async function runOp(op, ctx, retrievers) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(retrievers[op.op](ctx), OP_TIMEOUT_MS);
    if (r && r.__timeout) {
      return { op: op.op, name: op.name, serves_dims: op.serves_dims, kind: op.kind, status: 'timeout', items: [], provenance: { source: op.module, ts: new Date().toISOString() }, cost_ms: Date.now() - t0, note: `超过 ${OP_TIMEOUT_MS}ms 超时` };
    }
    return {
      op: op.op, name: op.name, serves_dims: op.serves_dims, kind: op.kind,
      status: (r && r.items && r.items.length) ? 'hit' : (r && r.items) ? 'empty' : 'hit',
      items: (r && r.items) || (r ? [r] : []),
      provenance: { source: op.module, actor: ctx.actor, ts: new Date().toISOString(), hash: r?.hash || null },
      cost_ms: Date.now() - t0, note: null,
    };
  } catch (e) {
    return { op: op.op, name: op.name, serves_dims: op.serves_dims, kind: op.kind, status: 'degraded', items: [], provenance: { source: op.module, ts: new Date().toISOString() }, cost_ms: Date.now() - t0, note: String(e?.message || e) };
  }
}

// 故事线（S5）作用域推断：决策链路传 entities 的真实形态是 {type,id}（见 decision.involved_entities
// 实测 [{"id":"a1111111-...","type":"CRM_ACCOUNT"}]），并无 account_id 键 → 原取值恒 undefined → S5 恒 empty。
// 抽为纯函数以便无 DB 单测锁定该推断（2026-09-02 缝修复护栏）。
// 兜底链：显式 account_id → entities 中 CRM_ACCOUNT 的 id → entities[0].account_id（兼容旧形态）→ null。
export function resolveAccountId(ctx = {}) {
  return ctx.account_id
    || (ctx.entities || []).find((e) => e && e.type === 'CRM_ACCOUNT')?.id
    || ctx.entities?.[0]?.account_id
    || null;
}

// 默认检索器（真实模块接线）；retrievers 可注入覆盖（测试用）
export function defaultRetrievers() {
  return {
    S1: async (ctx) => ({ items: (ctx.entities || []).map((p) => retrieveEntityProfile(p)) }),
    S2: async (ctx) => {
      // 【F4 单轨 2026-09-02】引擎已在事前算出的同一批先例 → 直接复用，不二次检索。
      //   缺陷背景：autonomyEngine 用 k=5/qvec(hashVector(ctx+cond)) 检索先例算置信度，
      //   createDecision 事后又用 k=3/minSimilarity=0.6/qvec(conditions=[]) 重检一次 →
      //   归档快照里的先例 ≠ 驱动决策的先例，快照沦为「事后解释」。此处复用即根治。
      if (Array.isArray(ctx.precedents)) {
        return {
          items: ctx.precedents.map((p) => ({
            decision_id: p.decision_id,
            similarity: p.similarity,
            scenario: p.scenario_id || ctx.scenario_id,
            disposition: p.disposition,
            overridden: false,
            source: `precedent:${p.decision_id}`,
          })),
          reused: true,
        };
      }
      // 无 ctx.precedents 的 fallback 检索（C4 两段式，2026-09-03 T8）。
      //   阈值读配置(默认 0.45，量纲已变) 而非旧硬编码 0.6 —— 旧 0.6 是「伪向量时代」阈值，与新结构相似度不同量纲。
      //   复用分支的 similarity 已由 autonomyEngine 按新四分量算法算好，故两路口径一致。
      if (!ctx.scenario_id) return { items: [] };
      const { loadPrecedentConf } = await import('../decision/precedentScoring.js');
      const conf = await loadPrecedentConf({ tenantId: ctx.tenant_id });
      const ps = await searchPrecedents(ctx.scenario_id, {
        trigger_context: ctx.trigger_context || {},
        conditions_evaluated: [],
        business_tier: null,
        disposition: null,
      }, { k: 3, minSimilarity: conf.minSimilarity, tenantId: ctx.tenant_id });
      return { items: (ps || []).map((p) => ({ decision_id: p.decision_id, similarity: p.similarity, scenario: p.scenario_id, disposition: p.disposition, overridden: false, source: `precedent:${p.decision_id}` })) };
    },
    S3: async (ctx) => {
      // 契约（conflict.js:41）：detectConflicts(entity_id, attr) → 对象 {assertions, hasConflict, needsReview}
      // 装配按「冲突对象」形态消费：无冲突=empty、有冲突=hit（needs_review 保留分歧，不静默覆盖）。
      const eid = ctx.entities?.[0]?.id;
      if (!eid) return { items: [] };
      const cf = await detectConflicts(eid, null);
      const items = (cf?.assertions || []).map((c) => ({ attr: c.attr, sources: c.source_id, unresolved: c.needs_review }));
      return { items, status_hint: { hasConflict: !!cf?.hasConflict, needsReview: !!cf?.needsReview } };
    },
    S4: async (ctx) => {
      // 契约（ruleEngine.js evaluateRules）：只读评估对当前决策语境适用的治理规则，返回 {ok,reasons}。
      // 修复（P-1 T2）：原调用 check('CRM_DEAL','context-assembly',…) 动作名错配——内置/DB 规则仅认
      //   action==='advance'，且 patch 传 trigger_context（无 from/to 键）→ 双重错位恒不命中，governance 维恒 false。
      // 改用 evaluateRules('CRM_DEAL','advance', trigger_context)：① 动作名对齐规则注册 ② 只读不落 rule_hit
      //   （避免与写闸重复留痕）③ 适用规则即「治理已校验」信号，违规以 result='blocked' 呈现。
      const { applied } = evaluateRules('CRM_DEAL', 'advance', ctx.trigger_context || {});
      const items = applied.map((a) => ({ rule: a.code, result: a.ok ? 'ok' : 'blocked', reasons: a.reasons }));
      return { items };
    },
    S5: async (ctx) => {
      // 缝修复 2026-09-02：实体项真实形态是 {type,id}（见 decision.involved_entities 实测：
      // [{"id":"a1111111-...","type":"CRM_ACCOUNT"}]），并无 account_id 键 → 原取值恒 undefined → S5 恒 empty。
      // 兜底链：显式 account_id → entities 中 CRM_ACCOUNT 的 id → entities[0].account_id（兼容旧形态）。
      const accountId = resolveAccountId(ctx);
      const dealIds = (ctx.entities || []).filter((e) => e.type === 'CRM_DEAL').map((e) => e.id);
      const srcs = accountId ? await loadTimelineSources(accountId, dealIds, ctx.tenant_id || 'system') : [];
      const rows = buildTimelineRows(srcs);
      return { items: rows.slice(0, 20), hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16) };
    },
    S6: async (ctx) => {
      const tid = ctx.tenant_id || 'system';
      const tk = await query(`SELECT id, title, action_name, status FROM crm.tasks WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 20`, [tid]);
      return { items: (tk.rows || []).map((t) => ({ id: t.id, title: t.title, action: t.action_name, status: t.status })) };
    },
    S7: async () => ({ items: [] }), // S7 落库阶段统一调 trackEntry，装配返回空
  };
}

// A-T3 运行时覆盖：以「全部未供给」为基线（supplied=false），仅当某操作运行时命中（status=hit）
// 才标记其服务的维度为 supplied=true。declarative 候选（哪些 op 可服务该维）仅作 ops 列表记录，
// 不参与 supplied 判定——根治 BG-04「声明即覆盖」假绿。
export function computeDimCoverage(ops, spec = DEFAULT_SUPPLY_OPS) {
  const base = {};
  for (const d of DIM_KEYS) base[d] = { supplied: false, ops: [] };
  for (const o of spec) for (const d of (o.serves_dims || [])) if (base[d]) base[d].ops.push(o.op);
  for (const o of ops) {
    if (o.status === 'hit') for (const d of o.serves_dims) if (base[d]) base[d].supplied = true;
  }
  return base;
}

// A-T5 分层注入（事实/叙事/规则/先例四段；每条带来源 id）
export function formatForPromptV2(ops) {
  const parts = [];
  const byOp = Object.fromEntries(ops.map((o) => [o.op, o]));
  // 事实段仅收 S1/S3/S6（结构/冲突/运行态）；S2 是「先例」另段渲染，避免同一 op 双段重复输出
  const facts = ops.filter((o) => o.kind === 'fact' && o.op !== 'S2' && o.status === 'hit');
  const narrative = ops.find((o) => o.op === 'S5');
  const rules = ops.find((o) => o.op === 'S4');
  const precedents = ops.find((o) => o.op === 'S2');
  if (facts.length) {
    const lines = facts.flatMap((o) => (o.items || []).map((it) => `· ${o.name}: ${summarize(it)}${it?.source ? ` [source: ${it.source}]` : ''}`));
    if (lines.length) parts.push(`▸ 事实（${facts.map((f) => f.op).join('/')}）\n  ${lines.join('\n  ')}`);
  }
  if (narrative && narrative.status === 'hit' && narrative.items?.length) {
    const lines = narrative.items.map((it) => `· ${it.title || ''} ${it.summary || ''}${it.source ? ` [source: ${it.source}]` : ''}`);
    parts.push(`▸ 故事时间线（S5，最近 ${narrative.items.length} 条）\n  ${lines.join('\n  ')}`);
  }
  if (rules && rules.items?.length) {
    // 规则条目无个体 source，挂模块级 provenance（ruleEngine.check）保证可追溯
    const src = rules.provenance?.source;
    const lines = rules.items.map((it) => `· ${it.rule}(${it.result})${src ? ` [source: ${src}]` : ''}`);
    parts.push(`▸ 治理边界（S4 规则校验）\n  ${lines.join('\n  ')}`);
  }
  if (precedents && precedents.status === 'hit' && precedents.items?.length) {
    const lines = precedents.items.map((it) => `· ${it.similarity?.toFixed?.(2) ?? it.similarity} ${it.scenario} → ${it.disposition}${it.overridden ? ' ⚠已被 OVERRIDES' : ''}${it.source ? ` [source: ${it.source}]` : ''}`);
    parts.push(`▸ 相似先例（S2，top-${precedents.items.length}）\n  ${lines.join('\n  ')}`);
  }
  return parts.join('\n\n');
}

function summarize(it) {
  if (it == null) return '';
  if (typeof it === 'string') return it;
  try { return JSON.stringify(it); } catch { return String(it); }
}

// F4 冻结（2026-09-02）：把「事前装配（persist:false）」的结果落库，不再重跑任何 retriever。
//   契约：ops/dim_coverage/prompt_block/prompt_hash 逐字复用 pre_context，phase 固定 'pre'。
//   语义：快照 = 真正驱动该决策的那份上下文，而非决策落库后再补一份「事后解释」。
export async function freezePreContext(pre, input = {}) {
  const ctx = {
    actor: input.actor ?? pre.actor ?? null,
    decision_id: input.decision_id ?? pre.decision_id ?? null,
    tenant_id: input.tenant_id ?? pre.tenant_id ?? 'system',
    scenario_id: input.scenario_id ?? pre.scenario_id ?? null,
    query: input.query ?? input.query_text ?? pre.query ?? null,
  };
  const snapshotId = randomUUID();
  let persisted = false;
  try {
    await queryWrite(
      `INSERT INTO crm.decision_context_snapshot
        (snapshot_id, assembly_id, decision_id, tenant_id, actor, scenario_id, query_text, ops, dim_coverage, supplied_dims, degraded, prompt_block, prompt_hash, cost_ms, phase, routing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
      [snapshotId, pre.assembly_id, ctx.decision_id, ctx.tenant_id, ctx.actor, ctx.scenario_id, ctx.query,
       JSON.stringify(pre.ops), JSON.stringify(pre.dim_coverage), pre.supplied_dims, !!pre.degraded,
       pre.prompt_block, pre.prompt_hash,
       (pre.ops || []).reduce((a, o) => a + (o?.cost_ms || 0), 0), 'pre',
       // F4 冻结契约：routing 逐字复用事前装配结果（不重跑路由解析），缺失则 null（旧 pre_context 兼容）
       pre.routing ? JSON.stringify(pre.routing) : null]
    );
    if (ctx.decision_id) {
      await queryWrite(`UPDATE crm.decision SET context_snapshot_id=$1 WHERE decision_id=$2`, [snapshotId, ctx.decision_id]).catch(() => {});
    }
    persisted = true;
    for (const o of (pre.ops || [])) {
      await trackEntry({
        decision_id: ctx.decision_id, entry_type: 'context_supply',
        payload: { assembly_id: pre.assembly_id, op: o.op, status: o.status, item_count: (o.items || []).length, provenance: o.provenance },
      }).catch((e) => {
        emit('trace', 'provenance-track-failed', { decision_id: ctx.decision_id, assembly_id: pre.assembly_id, op: o.op, error: String(e?.message || e) });
        recordFailure('provenance-track-failed', e);
      });
    }
  } catch (e) {
    try {
      await trackEntry({ decision_id: ctx.decision_id, entry_type: 'context_supply_failed', payload: { assembly_id: pre.assembly_id, error: String(e?.message || e) } })
        .catch((e2) => {
          emit('trace', 'provenance-track-failed', { decision_id: ctx.decision_id, assembly_id: pre.assembly_id, op: 'S7', error: String(e2?.message || e2) });
          recordFailure('provenance-track-failed', e2);
        });
    } catch { /* noop */ }
  }
  return {
    assembly_id: pre.assembly_id, snapshot_id: snapshotId, ops: pre.ops,
    dim_coverage: pre.dim_coverage, supplied_dims: pre.supplied_dims, degraded: !!pre.degraded,
    prompt_block: pre.prompt_block, prompt_hash: pre.prompt_hash,
    persisted, phase: 'pre', frozen: true, reused_assembly_id: pre.assembly_id,
    actor: ctx.actor, tenant_id: ctx.tenant_id, scenario_id: ctx.scenario_id,
    query: ctx.query, decision_id: ctx.decision_id,
  };
}

// A-T3 主入口：并行跑 S1–S7 → 覆盖 → 注入 → 落库 → PROV-O
// 【F4 单轨 2026-09-02】新增四种输入契约（全部可选，存量调用方零修改）：
//   input.pre_context  → 冻结模式：逐字复用事前装配结果落库，不重跑任何 retriever
//   input.persist:false → 只装配不落库（决策尚未物化，避免孤儿快照 + 延后 PROV-O 拿到真 decision_id）
//   input.phase        → 'pre'(默认) / 'post'（事前装配失败退回事后装配时必须诚实标注 'post'）
//   input.precedents   → 引擎事前算出的先例集合，S2 复用不再二次检索（双轨根治点）
export async function assembleContextV2(input = {}, retrievers = null) {
  // 冻结模式优先：任何 retriever 都不执行
  if (input.pre_context) return freezePreContext(input.pre_context, input);
  const ctx = {
    actor: input.actor || null,
    scenario_id: input.scenario_id || null,
    account_id: input.account_id || null,
    entities: input.entities || [],
    trigger_context: input.trigger_context || {},
    tenant_id: input.tenant_id || 'system',
    decision_id: input.decision_id || null,
    query: input.query || input.query_text || null,
    precedents: Array.isArray(input.precedents) ? input.precedents : null, // F4：引擎注入的先例
  };
  const rs = retrievers || defaultRetrievers();

  // ─── 场景路由闸门（2026-09-05 修复）────────────────────────────────────────
  // 缺陷：V2 是**决策落库主路径**（decisionRepo / autonomyEngine / decisionReadRoutes 均走此），
  //   但此前完全不读 config_store['context-routing']，S5 叙事**无条件注入** →
  //   配置中心里把某场景设为「图谱主（tracks 不含 narrative）」对生产决策完全不生效，
  //   而 agentLoop 走的 assembleContext（assembler.js:181）却遵守 → 两条路径行为分裂。
  // 修复：与 assembler.js:181 同口径——narrative 不在 tracks 内则 S5 不取数、返回空。
  // 语义（同 assembler.js:181-197）：被路由排除 ≠ 缺失，**不计 degraded**，但必须留痕（不静默）。
  // fail-open：路由读取失败 → 按全轨处理（wantNarrative=true），绝不阻断装配。
  let routing = null;
  try {
    const { resolveTracks } = await import('./routing.js');
    routing = await resolveTracks(ctx.scenario_id, { tenantId: ctx.tenant_id || 'system' });
  } catch (e) {
    emit('trace', 'context-routing-resolve-failed', { scenario_id: ctx.scenario_id, error: String(e?.message || e) });
    routing = null;
  }
  // ── P1 实验臂覆盖（2026-09-05）：只改内存 tracks，**绝不写 config_store**（红线 §0）──────
  // 覆盖后再算 wantNarrative，保证「实验臂」与「叙事闸门」同一次判定，不出现两路分叉。
  let experiment = null;
  try {
    const { resolveActiveArm, applyExperimentArm } = await import('./routingExperiment.js');
    experiment = await resolveActiveArm(ctx.scenario_id, { tenantId: ctx.tenant_id || 'system' });
    if (experiment && routing && Array.isArray(routing.tracks)) {
      routing = { ...routing, tracks: applyExperimentArm(routing.tracks, experiment) };
    }
  } catch (e) {
    emit('trace', 'routing-experiment-arm-failed', { scenario_id: ctx.scenario_id, error: String(e?.message || e) });
    experiment = null; // fail-open：按配置原样继续
  }

  const wantNarrative = !routing || !Array.isArray(routing.tracks) || routing.tracks.includes('narrative');
  // 受闸操作 = kind='narrative' 的供给操作（当前注册表内仅 S5；新增叙事操作时自动纳入）
  const narrativeOps = new Set(DEFAULT_SUPPLY_OPS.filter((o) => o.kind === 'narrative').map((o) => o.op));
  const effective = wantNarrative ? rs : { ...rs };
  if (!wantNarrative) for (const opKey of narrativeOps) effective[opKey] = async () => ({ items: [] });

  const ops = await Promise.all(DEFAULT_SUPPLY_OPS.map((o) => runOp(o, ctx, effective)));
  // 留痕：把排除原因写进 op.note（随 ops 落进快照 JSONB，可审计），而非静默为空
  if (!wantNarrative) {
    for (const o of ops) {
      if (narrativeOps.has(o.op)) o.note = `routing-excluded（场景 ${ctx.scenario_id || 'null'} 的 tracks 不含 narrative）`;
    }
  }

  const dimCoverage = computeDimCoverage(ops);
  const supplied = Object.values(dimCoverage).filter((d) => d.supplied).length;
  const degraded = ops.some((o) => o.status === 'degraded' || o.status === 'timeout');
  const promptBlock = formatForPromptV2(ops);
  const promptHash = createHash('sha256').update(promptBlock).digest('hex').slice(0, 32);
  const phase = input.phase === 'post' ? 'post' : 'pre';
  const base = {
    assembly_id: randomUUID(), ops, dim_coverage: dimCoverage, supplied_dims: supplied, degraded,
    prompt_block: promptBlock, prompt_hash: promptHash,
    // 路由回带（与 assembler.js bundle.routing 同字段），供可观测/审计：本场景走了哪些轨、主体线判定
    // P1 实验字段（exp_id/exp_arm/exp_track）P0 恒 null —— 结构一次性到位，避免届时二次迁移与兼容分叉
    routing: routing ? {
      scene: routing.scene, tracks: routing.tracks, mode: routing.mode, score: routing.score,
      // 实验臂留痕（P0 恒 null）：回算「这条决策当时走了哪个臂」的锚点
      exp_id: experiment?.experiment_id ?? null,
      exp_arm: experiment?.arm ?? null,
      exp_track: experiment?.track ?? null,
      exp_window_end: experiment?.window_end ?? null,
    } : null,
    actor: ctx.actor, tenant_id: ctx.tenant_id, scenario_id: ctx.scenario_id,
    query: ctx.query, decision_id: ctx.decision_id, phase, frozen: false,
  };
  // persist:false → 只返回装配结果，落库与 PROV-O 延后到 freeze（决策落库后才有 decision_id）
  if (input.persist === false) {
    return { ...base, snapshot_id: null, persisted: false };
  }

  // A-T4 快照落库 + 回指决策主记录（assembly_id 复用 base，与 persist:false 路径同源）
  const assemblyId = base.assembly_id;
  const snapshotId = randomUUID();
  let persisted = false;
  try {
    await queryWrite(
      `INSERT INTO crm.decision_context_snapshot
        (snapshot_id, assembly_id, decision_id, tenant_id, actor, scenario_id, query_text, ops, dim_coverage, supplied_dims, degraded, prompt_block, prompt_hash, cost_ms, phase, routing)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
      [snapshotId, assemblyId, ctx.decision_id, ctx.tenant_id, ctx.actor, ctx.scenario_id, ctx.query,
       JSON.stringify(ops), JSON.stringify(dimCoverage), supplied, degraded, promptBlock, promptHash,
       ops.reduce((a, o) => a + (o.cost_ms || 0), 0), phase,
       base.routing ? JSON.stringify(base.routing) : null]
    );
    if (ctx.decision_id) {
      await queryWrite(`UPDATE crm.decision SET context_snapshot_id=$1 WHERE decision_id=$2`, [snapshotId, ctx.decision_id]).catch(() => {});
    }
    persisted = true;
    // A-T4 S7 操作级 PROV-O（逐操作留痕，AGE 降级不静默）
    // 不静默铁律（2026-09-02）：此处原为 .catch(()=>{}) 静默吞错——生产库因 crm.decision_provenance
    // 表缺失（DDL 未入 schema.sql，ensureProvenanceSchema 仅测试调用）而 100% 抛 relation does not exist
    // 被吞掉，溯源留痕全丢且无人知晓。改为 emit trace + recordFailure 留痕，装配本身仍 fail-open。
    for (const o of ops) {
      await trackEntry({
        decision_id: ctx.decision_id, entry_type: 'context_supply',
        payload: { assembly_id: assemblyId, op: o.op, status: o.status, item_count: (o.items || []).length, provenance: o.provenance },
      }).catch((e) => {
        emit('trace', 'provenance-track-failed', {
          decision_id: ctx.decision_id, assembly_id: assemblyId, op: o.op, error: String(e?.message || e),
        });
        recordFailure('provenance-track-failed', e);
      });
    }
  } catch (e) {
    // 快照落库失败不阻断装配（但留痕）；装配结果仍返回给调用方
    try {
      await trackEntry({ decision_id: ctx.decision_id, entry_type: 'context_supply_failed', payload: { assembly_id: assemblyId, error: String(e?.message || e) } })
        .catch((e2) => {
          emit('trace', 'provenance-track-failed', { decision_id: ctx.decision_id, assembly_id: assemblyId, op: 'S7', error: String(e2?.message || e2) });
          recordFailure('provenance-track-failed', e2);
        });
    } catch { /* noop */ }
  }

  return {
    ...base,
    assembly_id: assemblyId, snapshot_id: snapshotId, ops, dim_coverage: dimCoverage,
    supplied_dims: supplied, degraded, prompt_block: promptBlock, prompt_hash: promptHash, persisted,
  };
}
