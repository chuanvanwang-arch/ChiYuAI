// src/particles/particleRepo.js — 统一粒子 CRUD + 受控谓词边（三钩子接线）
// 资源走 substrate（R2/R5）：不开独立 CRUD，9 粒子共用统一接口
import { query, queryWrite } from '../db.js';
import { PARTICLE_TYPES, CONTROLLED_PREDICATES, isControlledPredicateConfig, resolvePrototype } from './particleModel.js';
import { S_STAGES, toStageCode } from '../sales/stageTaxonomy.js';
import { ensureAll } from '../ontology/hooks.js';
import { evaluateAiAttributesFor } from '../aiAttributes/evaluator.js';
import { emit } from '../events/bus.js';
import { ensureAdaptiveRegistration, listMetaAttr } from '../metaAttr/metaAttrRepo.js'; // 6.6 读 meta_attr 行
import { normalizeFacts } from './normalizeFacts.js';                 // 6.6 写时校验（拦截脏事实）
import { ValidationError as FactValidationError } from './normalizeFacts.js';
import { recordAudit } from '../action/auditHook.js';   // 10-能力审计单点（V5 写通道必经）

// ─── Task 3（2026-08-27 UI/导航/规范重构）：CRM_DEAL 业务阶段白名单 ───
// 2026-08-31 统一术语：改用 S1-S8 单一事实源（src/sales/stageTaxonomy.js），
//   兼容旧英文值（toStageCode 归一为 S 码），杜绝第二套阶段命名。
// 设计输入：总体设计 §7 L2C（销售管道六段）；对齐 seed.sql:6（state=生命周期 / payload.stage=业务阶段）
export const DEAL_STAGES = S_STAGES;

export function normalizeStage(type, payload) {
  if (type !== 'CRM_DEAL') return payload; // 非 DEAL 粒子无业务阶段语义，透传
  const st = payload && payload.stage;
  if (st == null) return { ...(payload || {}), stage: 'S1' }; // 未分类兜底（新建商机默认 S1 线索）
  const code = toStageCode(st); // 旧英文 → S 码；已是 S 码则原样
  if (!DEAL_STAGES.includes(code)) throw new Error(`非法 stage: ${st}（须为 ${DEAL_STAGES.join('/')}）`);
  return code === st ? payload : { ...payload, stage: code }; // 归一到 S 码存储
}

// 6.6 写时校验辅助：按粒子类型取 meta_attr 行交 normalizeFacts（fail-safe：读取失败不阻断主写）
async function normalizeFactsToMeta(type, payload) {
  try {
    const rows = await listMetaAttr({ particleType: type, enabled: true });
    return normalizeFacts(payload, rows);
  } catch (e) {
    if (e instanceof FactValidationError) throw e;   // 校验失败必须阻断（拦截脏事实）
    return payload;                                   // 读 meta_attr 的系统故障 fail-safe 透传
  }
}

// 2026-08-31：根治 AI 写账户"无 named_owner 导致指名看板不可见"的根因
// CRM_ACCOUNT 在「指名客户管理」看板（src/sales/namedAccountBoard.js:91-94）必须拥有 named_owner 才可见，
// 缺则被无主户过滤链永久剔除，用户感受为"客户清单找不到"。
// 行为：若 actor 给出（!= system），自动回退注入 named_owner / owner_id / owner 三个键——保证看板立即可见。
//   若 enforceNamedOwner=true 且仍无 named_owner → 抛错（对话式入口强约束，不允许无主）。
//   系统引导（actor=null 或 'system'，admin seed/迁移脚本）保留旧语义：允许无主（向后兼容）。
export function backfillAccountOwner(payload, actor) {
  if (!payload || typeof payload !== 'object') return payload;
  const a = actor && String(actor).trim();
  if (!a || a === 'system') return payload;
  let next = payload;
  if (!next.named_owner) next = { ...next, named_owner: a };
  if (!next.owner_id) next = { ...next, owner_id: a };
  if (!next.owner) next = { ...next, owner: a };
  return next;
}

export async function createParticle(type, payload, { tenantId = 'system', actor = null, enforceNamedOwner = false, requireDecisionId = null, systemBypass = false, accountGuard = false } = {}) {
  // P2(G1) 多行业配置化：类型解析双源（代码基线 ∪ 租户 tenant-profile 配置原型）。
  // 代码类型在 resolvePrototype 首分支即返回（无额外 DB 读），CRM 行为零破坏；
  // 配置原型（如 TRAINING_SETTLEMENT）经租户画像解析为真实粒子，零新增类型字面量。
  const def = await resolvePrototype(type, tenantId);
  if (!def) throw new Error(`未知粒子类型: ${type}`);
  // 配置原型可能缺 slug/title/states/identity，给安全默认（universal core 收敛）
  const resolvedSlug = def.slug || String(type).toLowerCase().replace(/_/g, '-');
  const resolvedTitle = def.title || def.label || type;
  const resolvedState = (def.states && def.states.current) || 'ACTIVE';
  const resolvedIdentity = def.identity || [];
  // CRM_ACCOUNT 兜底（2026-08-31 根因修复）：缺 named_owner 自动回退 actor，确保指名看板可见
  if (type === 'CRM_ACCOUNT') {
    // 顺序铁律：先按 actor 兜底，再校验 enforceNamedOwner。
    //   反序会让 backfillAccountOwner 永远执行不到——有 actor 也被判「无主」抛错，
    //   非 DEAL 客户建档路径（routes.js:478 升级为 bootstrap）因此被误拦截返回 400。
    payload = backfillAccountOwner(payload, actor);
    if (enforceNamedOwner && !(payload?.named_owner || payload?.owner_id || payload?.owner)) {
      throw new Error('CRM_ACCOUNT 必填 named_owner/owner_id（指名客户归属，禁无主）');
    }
  }
  // 标题/身份归一：业务名优先 name → title → customer_name，缺失时回退类型标签（如「客户」）
  // 修复：原实现恒用 def.title（类型标签），导致所有账户 title 显示为「客户」、按名不可查
  const displayName = payload.name || payload.title || payload.customer_name || null;
  if (displayName && !payload.name) payload = { ...payload, name: displayName };
  for (const f of resolvedIdentity) {
    if (payload[f] === undefined || payload[f] === null || payload[f] === '') {
      throw new Error(`missing required field: ${f}`);
    }
  }
  // Task 3 第0闸后置校验：DEAL 六段白名单（拒 leads 脏值；缺省兜底 lead）——在写库前拦截
  payload = normalizeStage(type, payload);
  // §5 防复发（根因报告 account-misbind）：CRM_DEAL 账户归属守护
  // 默认关闭（accountGuard=false），仅受治理写入口（data-particle-create / crm-import-batch）开启；
  // 拒绝"错绑无关账户 / 无账户静默写"，并按 customer 名 find-or-create 正确归属。
  if (type === 'CRM_DEAL' && accountGuard) {
    const { resolveDealAccount } = await import('../sales/accountGuard.js');
    const { account_id } = await resolveDealAccount({ payload, tenantId, actor });
    if (account_id) payload = { ...payload, account_id };
  }
  // 6.6 写时校验：meta_attr required/类型不符抛 ValidationError（拦截脏事实防误触发 G2 规则）
  payload = await normalizeFactsToMeta(type, payload);
  // 待办②（2026-09-03）深度防御·软强制：requireDecisionId 双模语义
  //   - 传字符串（uuid）= 直接作为 decision 值持久化（业务写透传 ctx.decision_id 走此路）
  //   - 传 true = 强制要求（无值则抛，深度防御未来绕过 action 层的直写）
  //   历史/系统调用方 requireDecisionId=null/undefined → 不触发，向后兼容零破坏。
  const enforce = requireDecisionId === true;
  const decisionId = (typeof requireDecisionId === 'string' && requireDecisionId) || payload.decision_id || null;
  const isSystem = !actor || actor === 'system' || systemBypass === true;
  if (enforce && !decisionId && !isSystem) {
    throw new Error(`createParticle(${type}) 缺 decision_id（业务写须经第0闸 mint 后透传 requireDecisionId）`);
  }
  const r = await queryWrite(
    `INSERT INTO particles (tenant_id, type, slug, title, state, payload, decision_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    // state=粒子生命周期（ACTIVE）；业务阶段仅存 payload.stage（对齐 seed.sql:6 契约；不再混用）
    // title 优先业务名 displayName（修复前恒为 def.title 类型标签「客户」，致按名不可查）
    // decision_id 持久化第0闸 mint 结果（深度防御；系统写/历史行落 NULL）
    [tenantId, type, resolvedSlug, displayName || resolvedTitle, payload.state || resolvedState, JSON.stringify(payload), decisionId]
  );
  const particle = r.rows[0];
  // 写时自适应：新键自动登记元模型（enabled=false/source=ai），在 AI 求值前（payload 原始键可推断）
  // 元模型自适应登记：fail-open —— 登记失败不得阻断主写，更不能让已落库的粒子变成孤儿。
  // 与同文件 ensureAgeSync(…).catch(()=>{}) 的既有风格一致（2026-09-09 孤儿粒子根治）。
  await ensureAdaptiveRegistration(type, payload, tenantId, 'system').catch((e) => {
    emit('trace', 'meta-attr-registration-failed', { type, tenantId, error: String(e?.message || e) });
    return [];
  });
  // P4(T13)：on_write 公式触发（租户 profile.calculations）——沙箱求值，fail-safe 不阻断主写
  const { runProfileCalculations } = await import('../calc/formulaEngine.js');
  const calcOut = await runProfileCalculations(type, payload, tenantId);
  if (calcOut && Object.keys(calcOut).length) {
    const calcP = await queryWrite(
      `UPDATE crm.particles SET payload = payload || $1::jsonb WHERE id=$2 RETURNING *`,
      [JSON.stringify(calcOut), particle.id]
    );
    particle.payload = calcP.rows[0].payload;
    emit('trace', 'formula-computed', { id: particle.id, keys: Object.keys(calcOut), tenantId });
  }
  // 10-能力审计单点（V5 写通道必经）：粒子创建后落审计（fail-open 不阻断主写）
  await recordAudit({
    target_particle_type: type, source: 'particle', action: 'create', actor: 'system',
    decision_id: payload.decision_id || null, payload: { id: particle.id, type, title: particle.slug },
  });
  await ensureAll(particle);  // 写库即构建：embedding + FTS + 本体同步
  // 【P1】写时镜像粒子顶点进 AGE 图（失败不阻断主写；受控边在 createEdge 内同步）
  const { ensureAgeSync } = await import('../ontology/ageSync.js');
  await ensureAgeSync({ type, id: particle.id, title: particle.slug || '' }).catch(() => {});
  // ② AI 属性自动产生（写后评估，LLM 注入点；无 LLM 走确定性兜底）
  const aiRes = evaluateAiAttributesFor(particle, { llm: null });
  if (aiRes.changed) {
    const aiP = await queryWrite(
      `UPDATE particles SET payload = payload || $1::jsonb WHERE id=$2 RETURNING *`,
      [JSON.stringify({ ai: aiRes.ai }), particle.id]
    );
    particle.payload = aiP.rows[0].payload;
  }
  // C3（2026-09-10 收口）：建档即沉淀（新建实体=事实，必记；去重窗豁免）。
  //   与 updateParticle 的写时沉淀共用 precipitateFromParticleWrite，before=null 触发 created 分支。
  //   fail-open：沉淀失败只留痕，绝不阻断业务写（建档成功必须返回）。
  try {
    const { precipitateFromParticleWrite } = await import('../memory/precipitate.js');
    await precipitateFromParticleWrite(particle, null, {
      tenantId: tenantId || particle.tenant_id || null,
      actor: actor || 'system',
      decisionId: decisionId || null,
    });
  } catch (e) {
    emit('trace', 'memory-precipitate-create-failed', { id: particle.id, error: String(e?.message || e) });
  }
  emit('particle', 'created', { id: particle.id, type });
  return particle;
}

export async function getParticle(id) {
  const r = await query(`SELECT * FROM particles WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

export async function queryParticles({ type, tenantId = 'system', limit = 100, excludeStates = null } = {}) {
  // tenantId === '*' → 跨租户通配（admin/sysadmin），省略 tenant 条件
  // excludeStates: 字符串或字符串数组，排除指定 state（业务主数据软停用用例）
  const excludes = Array.isArray(excludeStates) ? excludeStates : (excludeStates ? [excludeStates] : []);
  const stateClause = excludes.length
    ? ` AND state <> ALL($${tenantId === '*' ? 3 : 4}::text[])`
    : '';
  if (tenantId === '*') {
    const r = await query(
      `SELECT * FROM particles WHERE ($1::text IS NULL OR type=$1)${stateClause}
       ORDER BY created_at DESC LIMIT $2`,
      excludes.length
        ? [type || null, limit, excludes]
        : [type || null, limit]
    );
    return r.rows;
  }
  const r = await query(
    `SELECT * FROM particles WHERE tenant_id=$1 AND ($2::text IS NULL OR type=$2)${stateClause}
     ORDER BY created_at DESC LIMIT $3`,
    excludes.length
      ? [tenantId, type || null, limit, excludes]
      : [tenantId, type || null, limit]
  );
  return r.rows;
}

export async function updateParticle(id, { state, patch = {}, event, requireDecisionId = null, systemBypass = false, tenantId = null } = {}) {
  const cur = await getParticle(id);
  if (!cur) throw new Error(`粒子不存在: ${id}`);
  // F1 防御层（defense-in-depth）：当调用方显式传入真实租户且与该粒子归属租户不符 → 拒绝跨租户写。
  // 'system' 租户（平台/admin/bootstrap 跨租户治理写）豁免，避免误伤 model='all' 角色。
  if (tenantId && tenantId !== 'system' && cur.tenant_id && cur.tenant_id !== tenantId) {
    throw new Error(`cross_tenant_write_denied: 目标粒子属租户 ${cur.tenant_id}`);
  }
  const newPayload = { ...cur.payload, ...patch };
  if (event) {
    const events = Array.isArray(cur.payload.events) ? cur.payload.events : [];
    newPayload.events = [...events, { at: new Date().toISOString(), ...event }];
  }
  // 6.6 写时校验（更新路径同样拦截脏值）
  try {
    const rows = await listMetaAttr({ particleType: cur.type, enabled: true });
    Object.assign(newPayload, normalizeFacts(newPayload, rows));
  } catch (e) {
    if (e instanceof FactValidationError) throw e;
  }
  // 待办②（2026-09-03）深度防御·软强制：同 createParticle 双模语义（字符串值 / 布尔 true 强制）。
  //   updateParticle 不接收 actor 形参 → 仅 systemBypass 判定豁免（业务写透传 requireDecisionId 为字符串值，不触发强制抛错）；
  //   若未来透传 actor，可在此扩展 isSystem 判定以启用强制。
  const enforce = requireDecisionId === true;
  const decisionId = (typeof requireDecisionId === 'string' && requireDecisionId) || patch.decision_id || cur.decision_id || null;
  const isSystem = systemBypass === true;
  if (enforce && !decisionId && !isSystem) {
    throw new Error(`updateParticle(${cur.type}) 缺 decision_id（业务写须经第0闸 mint 后透传 requireDecisionId）`);
  }
  const r = await queryWrite(
    `UPDATE particles SET payload=$1, state=$2, decision_id=$3, updated_at=now() WHERE id=$4 RETURNING *`,
    // decision_id 持久化：优先 requireDecisionId/patch 携带（首次锚定），否则保留既有（不覆盖为空）
    [JSON.stringify(newPayload), state || cur.state, decisionId, id]
  );
  const p = r.rows[0];
  // 写时自适应：patch 新键自动登记元模型（在 AI 求值前）
  await ensureAdaptiveRegistration(p.type, patch, cur.tenant_id || 'system', 'system').catch((e) => {
    emit('trace', 'meta-attr-registration-failed', { type: p.type, tenantId: cur.tenant_id, error: String(e?.message || e) });
    return [];
  });
  // P4(T13)：on_write 公式触发（更新路径同样；cur.type/cur.tenant_id 安全可用）
  const { runProfileCalculations } = await import('../calc/formulaEngine.js');
  const calcOut = await runProfileCalculations(cur.type, newPayload, cur.tenant_id || 'system');
  if (calcOut && Object.keys(calcOut).length) {
    const calcP = await queryWrite(
      `UPDATE crm.particles SET payload = payload || $1::jsonb WHERE id=$2 RETURNING *`,
      [JSON.stringify(calcOut), id]
    );
    p.payload = calcP.rows[0].payload;
  }
  // 10-能力审计单点（V5 写通道必经）：粒子更新后落审计（fail-open 不阻断主写）
  await recordAudit({
    target_particle_type: p.type, source: 'particle', action: 'update', actor: 'system',
    decision_id: (patch && patch.decision_id) || null, payload: { id: p.id, type: p.type, patch_keys: Object.keys(patch || {}) },
  });
  await ensureAll(p);
  // ② AI 属性自动产生（写后重评估；幂等：内容不变 changed=false 不重复写）
  const aiRes = evaluateAiAttributesFor(p, { llm: null });
  if (aiRes.changed) {
    const aiP = await queryWrite(
      `UPDATE particles SET payload = payload || $1::jsonb WHERE id=$2 RETURNING *`,
      [JSON.stringify({ ai: aiRes.ai }), id]
    );
    p.payload = aiP.rows[0].payload;
  }
  // C3（2026-09-10 P2）记忆自动沉淀：事实变更（阶段/金额/负责人…）自动写入客户记忆，
  //   不再依赖调用方记得手动 crm-memory-upsert（R3/R4 根因）。
  //   三重防雪崩：价值闸 + 字段闸（同值不写）+ 24h 去重窗。fail-open：失败只留痕，不阻断业务写。
  //   注意在 AI 属性重评估之后调用，使 after 快照含公式/AI 派生后的最终 payload。
  try {
    const { precipitateFromParticleWrite } = await import('../memory/precipitate.js');
    await precipitateFromParticleWrite(p, cur, {
      tenantId: tenantId || p.tenant_id || cur.tenant_id || null,
      actor: 'system',
      decisionId: decisionId || null,
    });
  } catch (e) {
    emit('trace', 'memory-precipitate-hook-failed', { id: p.id, error: String(e?.message || e) });
  }
  emit('particle', 'updated', { id: p.id, type: p.type });
  return p;
}

export async function appendEvent(id, event) {
  return updateParticle(id, { event });
}

export async function createEdge(sourceType, sourceId, edgeType, targetType, targetId, meta = {}, tenantId = 'system') {
  // P3(G3/G4)：受控谓词 = 基线 ∪ 租户 profile.edgeTypes（双源，零污染）
  const ok = await isControlledPredicateConfig(edgeType, tenantId);
  if (!ok) {
    throw new Error(`边谓词未受控: ${edgeType}（须属基线 CONTROLLED_PREDICATES 或租户 profile.edgeTypes）`);
  }
  // F1 防御层：源粒子租户须与边租户一致（'system' 豁免），拒绝跨租户挂边
  if (tenantId && tenantId !== 'system') {
    const src = await getParticle(sourceId);
    if (src && src.tenant_id && src.tenant_id !== tenantId) {
      throw new Error(`cross_tenant_write_denied: 源粒子属租户 ${src.tenant_id}`);
    }
  }
  const dup = await query(
    `SELECT * FROM edges WHERE tenant_id=$1 AND source_id=$2 AND edge_type=$3 AND target_id=$4`,
    [tenantId, sourceId, edgeType, targetId]
  );
  if (dup.rows.length > 0) {
    const edge = dup.rows[0];
    emit('particle', 'edge-created', { id: edge.id, sourceType, edgeType, targetType });
    return edge; // 幂等：已存在直接返回
  }
  // P3：基数落库（默认 'many'；后续可由 profile.edgeTypes 声明 HAS_ONE/HAS_MANY）
  const cardinality = (meta && meta.cardinality) || 'many';
  const r = await queryWrite(
    `INSERT INTO edges (tenant_id, source_type, source_id, edge_type, target_type, target_id, cardinality, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [tenantId, sourceType, sourceId, edgeType, targetType, targetId, cardinality, JSON.stringify(meta)]
  );
  const edge = r.rows[0];
  emit('particle', 'edge-created', { id: edge.id, sourceType, edgeType, targetType });
  // 10-能力审计单点（V5 写通道必经）：受控边创建后落审计（fail-open 不阻断主写）
  await recordAudit({
    target_particle_type: sourceType, source: 'particle-edge', action: 'edge-create', actor: 'system',
    decision_id: (meta && meta.decision_id) || null,
    payload: { edge_id: edge.id, source_id: sourceId, edge_type: edgeType, target_id: targetId, target_type: targetType },
  });
  // 【P1】写时镜像受控边进 AGE 图（失败不阻断主写）
  const { ensureAgeSync } = await import('../ontology/ageSync.js');
  await ensureAgeSync({
    edge_type: edgeType, source_id: sourceId, source_type: sourceType,
    target_id: targetId, target_type: targetType,
  }).catch(() => {});
  return edge;
}

export async function queryNeighbors(sourceType, sourceId, tenantId = 'system') {
  const r = await query(
    `SELECT e.*, t.slug AS target_slug, t.title AS target_title
     FROM edges e JOIN particles t ON t.id = e.target_id
     WHERE e.tenant_id=$1 AND e.source_type=$2 AND e.source_id=$3`,
    [tenantId, sourceType, sourceId]
  );
  return r.rows;
}
