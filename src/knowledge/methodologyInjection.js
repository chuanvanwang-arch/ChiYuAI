// src/knowledge/methodologyInjection.js — P3 D1 Knowledge 注入（统一设计 v3 §3.5 / §11.5-D1）
//
// 职责：把「每次都要重复讲的公司背景」类知识（methodology_dimension 34 行，带 weight+required）
//       接进 Pre 装配，并让落库 concept_refs 与 Pre 概念清单「同源」——消除 N4/F2 发现的双轨：
//       此前 concept_refs 由调用方手抄、methodology_dimension 34 行零消费点。
//
// 单一事实源纪律：
//   - Pre 概念清单 = methodology_dimension 按 decision_scenario.methodology_ids 过滤；
//   - 落库 concept_refs 经 enrichConceptRefs 回查同一张表补全 weight/required。
//   两端都指向 methodology_dimension，依据与留痕同源（D1 的 T4 前置条件即「消除双轨」）。
//
// 与 DB 的边界：本模块只 SELECT methodology_dimension / decision_scenario，不写；
// 写操作（concept_refs 落库）在 decisionRepo.createDecision，本模块仅提供补全函数。

/**
 * 取某场景的「概念清单」（Knowledge 注入的载体）。
 * @param {string} scenarioId
 * @param {object} pool  pg Pool（须已 SET search_path crm）
 * @returns {Promise<{scenario_id:string, methodology_ids:string[], checklist:Array, summary:object}>}
 *   checklist: [{ methodology_id, dim_key, label, weight, required }]（按 methodology_id, dim_key 稳定序）
 *   summary:   { methodology_id: { label_hint, dims:[dim_key], required_count, optional_count } }
 */
export async function getConceptChecklist(scenarioId, pool) {
  if (!scenarioId) throw new Error('getConceptChecklist 需要 scenario_id');
  const sc = await pool.query(
    `SELECT methodology_ids FROM crm.decision_scenario WHERE scenario_id=$1`,
    [scenarioId]
  );
  const methodologyIds = Array.isArray(sc.rows[0]?.methodology_ids)
    ? sc.rows[0].methodology_ids
    : [];
  if (!methodologyIds.length) {
    return { scenario_id: scenarioId, methodology_ids: [], checklist: [], summary: {} };
  }
  const md = await pool.query(
    `SELECT methodology_id, dim_key, label, weight, required
     FROM crm.methodology_dimension
     WHERE methodology_id = ANY($1)
     ORDER BY methodology_id, dim_key`,
    [methodologyIds]
  );
  const checklist = md.rows.map((r) => ({
    methodology_id: r.methodology_id,
    dim_key: r.dim_key,
    label: r.label,
    weight: Number(r.weight),
    required: !!r.required,
  }));
  // 按 methodology 聚合，供 Pre UI 分组展示
  const summary = {};
  for (const c of checklist) {
    summary[c.methodology_id] = summary[c.methodology_id] || {
      methodology_id: c.methodology_id,
      dims: [],
      required_count: 0,
      optional_count: 0,
    };
    summary[c.methodology_id].dims.push(c.dim_key);
    if (c.required) summary[c.methodology_id].required_count += 1;
    else summary[c.methodology_id].optional_count += 1;
  }
  return { scenario_id: scenarioId, methodology_ids: methodologyIds, checklist, summary };
}

/** 纯函数：把 methodology_dimension 行索引为 (methodology_id|dim_key) → {weight,required}。便于单测不依赖 DB。 */
export function indexMethodology(rows) {
  const idx = new Map();
  for (const r of rows || []) {
    idx.set(`${r.methodology_id}|${r.dim_key}`, {
      weight: Number(r.weight),
      required: !!r.required,
      label: r.label,
    });
  }
  return idx;
}

/**
 * 双轨闭合：用 methodology_dimension 补全 concept_refs 的 weight / required / label。
 * @param {Array|null} conceptRefs  调用方传入的 [{methodology_id, dimension_key, hit, ...}]
 * @param {Map} mdIndex  由 indexMethodology 生成（测试可注入；生产传 null 由本函数回查 DB）
 * @param {object} [pool] 生产路径需传 pool（mdIndex 为 null 时回查）
 * @param {object} [opts] { onMiss?: (ref) => void }  未命中维度时留痕回调（MISS 可观测，
 *        消除「引用了镜像中不存在的维键却静默无痕」的盲区；不影响返回语义）。
 * @returns {Promise<Array|null>} 补全后的 concept_refs（命中表则注入 canonical 值，未命中 dim 诚实保留调用方值）
 */
export async function enrichConceptRefs(conceptRefs, mdIndex = null, pool = null, opts = {}) {
  if (!Array.isArray(conceptRefs)) return conceptRefs;
  let idx = mdIndex;
  if (!idx) {
    if (!pool) return conceptRefs; // 无索引且无 DB → 不假填充，原样返回（fail-open）
    const md = await pool.query(
      `SELECT methodology_id, dim_key, label, weight, required FROM crm.methodology_dimension`
    );
    idx = indexMethodology(md.rows);
  }
  return conceptRefs.map((ref) => {
    const key = `${ref.methodology_id}|${ref.dimension_key}`;
    const hit = idx.get(key);
    if (!hit) {
      if (typeof opts.onMiss === 'function') opts.onMiss(ref); // MISS 留痕（默认无回调=静默，向后兼容）
      return ref; // 不在方法论矩阵的维度：诚实保留调用方自填（不静默丢弃、不假造）
    }
    return {
      ...ref,
      weight: hit.weight,
      required: hit.required,
      label: hit.label,
    };
  });
}

/**
 * 取「规则清单」——Knowledge 注入**第三载体**：`crm.decision_rule`（统一设计 v3 §3.5）。
 *
 * 背景（N4/F2「Knowledge 存在但零注入」的残留）：`decision_rule` 此前仅被 S4 当治理维供给消费
 * （`ruleEngine.evaluateRules` 只读 enabled 规则做命中校验），**从未作为显式 Knowledge 清单注入决策前链路**。
 * 本函数把它提升为与 `methodology_dimension` 并列的 Pre 装配 Knowledge 载体，让决策者在写前即看到
 * 「公司常设规则」（Lightfield C3：每次都要重复讲的公司背景 = Knowledge）。
 *
 * 与 evaluateRules **同源口径**：仅读取 `enabled=true`；按 `match_type('TYPE.action')` 前缀可选匹配实体类型。
 *
 * @param {object} pool  pg Pool（须已 SET search_path crm）
 * @param {object} [opts] { entityType?:string }  不传则返回全部启用规则（Pre 阶段展示「公司常设规则」全貌）
 * @returns {Promise<Array<{code,match_type,match_payload,check_payload,scope_hint}>>}
 */
export async function getRuleKnowledge(pool, opts = {}) {
  const entityType = opts && opts.entityType ? String(opts.entityType) : null;
  const params = [];
  let sql = `SELECT code, match_type, match_payload, check_payload
             FROM crm.decision_rule WHERE enabled=true`;
  if (entityType) {
    params.push(`${entityType}.%`);
    sql += ` AND match_type LIKE $1`;
  }
  sql += ` ORDER BY code`;
  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({
    code: r.code,
    match_type: r.match_type,
    match_payload: r.match_payload,
    check_payload: r.check_payload,
    scope_hint: r.match_type, // 人类可读：规则适用的实体.动作域
  }));
}
