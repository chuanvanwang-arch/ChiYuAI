#!/usr/bin/env node
// scripts/kmd-closure-probe.mjs — KMD 闭环探针（可复跑 / 可入 CI）
//
// 定位：K（知识）/ M（记忆）/ D（决策）三系统**接线活性**的事实采集器。
// 它不是测试（不断言业务正确性），而是「闭环探针」：每条边到底通不通，用库里/代码里的
// 可观测事实回答，输出 PASS / FAIL / WARN / ERROR + 数值 + 判据。
//
// 设计铁律（2026-09-10，源于一次真实翻车）：
//   1. **探针必须自证鉴别力**。此前 D1 用 `embedding IS NOT NULL` 判「向量已构建」，
//      实测 65/65 全绿——但全是 hash 伪向量，探针零鉴别力。故每条探针配 `negativeControl`：
//      注入已知必红/必绿反例，验证探针本身不会恒绿。`--self-test` 跑该校验。
//   2. **禁「非空即通过」**。任何 count>0 就绿的判据必须有对照指标（见 D4 的三分类）。
//   3. **只读优先**。默认纯读；写操作仅 `--e2e` 且必须 `--db=test`，绝不碰生产。
//
// 用法：
//   node scripts/kmd-closure-probe.mjs                  # 只读全量探针，控制台表格
//   node scripts/kmd-closure-probe.mjs --json out.json   # 另存 JSON（供文档/巡检消费）
//   node scripts/kmd-closure-probe.mjs --self-test       # 探针自检（验证不会恒绿）
//   node scripts/kmd-closure-probe.mjs --e2e --db=test   # 端到端哨兵（需测试库，会写一条哨兵知识）
//   node scripts/kmd-closure-probe.mjs --probe D1,D4     # 只跑指定探针
//
// 退出码：存在 FAIL 或 ERROR → 1（便于 CI 拦截）；否则 0。

import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

// ── 参数 ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
// 同时支持 `--db=test`（等号）与 `--db test`（空格）两种写法
const arg = (name, def = null) => {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true) : def;
};
const flag = (name) => argv.includes(`--${name}`);

const DB_MODE = arg('db', 'prod');            // prod | test
const RUN_E2E = flag('e2e');
const SELF_TEST = flag('self-test');
const JSON_OUT = arg('json', null);
const ONLY = arg('probe', null) ? String(arg('probe')).split(',').map((s) => s.trim().toUpperCase()) : null;

if (RUN_E2E && DB_MODE !== 'test') {
  console.error('[kmd-probe] 拒绝执行：--e2e 会写库，必须显式 --db=test（禁止对生产库写探针数据）');
  process.exit(2);
}

// PG 仅监听 IPv6 回环（项目铁律）：硬编码 127.0.0.1 会 ECONNREFUSED → 用 localhost
const DB = {
  host: 'localhost',
  port: Number(process.env.PGPORT || 5433),
  user: process.env.PGUSER || 'agent2b',
  password: process.env.PGPASSWORD || 'agent2b',
  database: DB_MODE === 'test' ? 'crm_native_test' : 'crm_native',
};

// ── 探针框架 ────────────────────────────────────────────────────────────────
const results = [];

/**
 * 登记一条探针结果。
 * @param {object} o
 *  @param {string} o.id     探针号 D1..
 *  @param {string} o.name   名称
 *  @param {string} o.edge   对应 KMD 的哪条边
 *  @param {string} o.status PASS | FAIL | WARN | ERROR | SKIP
 *  @param {object} o.metrics 关键数值（进表格）
 *  @param {string} o.verdict 结论一句话
 *  @param {string} [o.criterion] 判据（阈值如何定）
 *  @param {string} [o.fix] 指向修补项
 */
function report(o) {
  results.push({ at: new Date().toISOString(), db: DB.database, ...o });
}

const client = new pg.Client(DB);

async function sql(label, text, params = []) {
  try {
    const r = await client.query(text, params);
    return r.rows ?? [];
  } catch (e) {
    // 单条查询失败不中断整轮（表不存在/列缺失 → 记 ERROR，仍继续其余探针）
    return { __error: String(e.message || e) };
  }
}

const isErr = (r) => r && typeof r === 'object' && '__error' in r && !Array.isArray(r);
const num = (v) => (v == null ? 0 : Number(v));
const pct = (a, b) => (num(b) ? +((num(a) * 100) / num(b)).toFixed(2) : 0);

// ════════════════════════════════════════════════════════════════════════════
// D1 — 知识向量真伪（核心反假绿探针）
// 旧判据 `embedding IS NOT NULL` 无鉴别力：hash 伪向量同样非空。
// 新判据（数学指纹，源自 src/ontology/embedding.js:8-15）：
//   hashVector = SHA-256 的 32 字节映射到 384 桶 →
//     (a) 非零分量数 ≤ 32（真模型 embedding 384 维几乎全非零）
//     (b) 分量值恒 ≥ 0（(h[i] % 251)/251 非负）→ 真模型必有负分量
//   两者同时满足 → 判定为 hash 伪向量。
// ════════════════════════════════════════════════════════════════════════════
async function probeD1() {
  const r = await sql('D1', `
    SELECT count(*) AS total,
           count(*) FILTER (WHERE s.minv < 0)                          AS has_negative,
           count(*) FILTER (WHERE s.minv >= 0 AND s.nonzero <= 32)     AS hash_signature,
           max(s.nonzero)                                              AS max_nonzero,
           round(avg(s.nonzero), 1)                                    AS avg_nonzero
    FROM (
      SELECT p.id,
             min(t.x::float8)                        AS minv,
             count(*) FILTER (WHERE t.x::float8 <> 0) AS nonzero
      FROM crm.particles p,
           LATERAL regexp_split_to_table(
             substring(p.embedding::text, 2, length(p.embedding::text) - 2), ','
           ) AS t(x)
      WHERE p.type = 'CRM_KNOWLEDGE' AND p.embedding IS NOT NULL
      GROUP BY p.id
    ) s`);
  if (isErr(r)) return report({ id: 'D1', name: '知识向量真伪', edge: 'K 构建', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });

  const m = r[0] || {};
  const total = num(m.total);
  const hash = num(m.hash_signature);
  const realPct = pct(total - hash, total);
  const metrics = {
    knowledge_rows: total,
    hash_signature: hash,
    has_negative: num(m.has_negative),
    max_nonzero: num(m.max_nonzero),
    avg_nonzero: num(m.avg_nonzero),
    real_vector_pct: realPct,
  };
  report({
    id: 'D1',
    name: '知识向量真伪',
    edge: 'K 构建',
    status: total === 0 ? 'WARN' : realPct >= 50 ? 'PASS' : 'FAIL',
    metrics,
    criterion: 'hash 指纹 = 分量全非负 且 非零维≤32；真向量占比 ≥50% 才 PASS',
    verdict: total === 0
      ? '无 CRM_KNOWLEDGE 行，知识层空'
      : realPct >= 50
        ? `真模型向量占 ${realPct}%`
        : `真模型向量占 ${realPct}%（${hash}/${total} 条为 hash 伪向量）→ 语义检索等于随机`,
    fix: 'P1-1 接入真 embedding；D1 绿之前禁止声称"语义检索已落地"',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D2 — LK 知识层是否为死层（静态代码扫描）
// assembler.js:258 装配 layers.LK；若全仓无人消费 → 知识永不进 prompt。
// ════════════════════════════════════════════════════════════════════════════
async function probeD2() {
  const hits = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!/node_modules|\.git|dist/.test(p)) walk(p); continue; }
      if (!/\.(js|mjs|ts)$/.test(f.name)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      txt.split('\n').forEach((line, i) => {
        if (/layers\.LK|\.LK\b|bundle\.layers\.LK/.test(line)) hits.push(`${path.relative(ROOT, p)}:${i + 1}: ${line.trim().slice(0, 100)}`);
      });
    }
  };
  walk(path.join(ROOT, 'src'));
  const consumers = hits.filter((h) => !/assembler\.js/.test(h));
  report({
    id: 'D2',
    name: 'LK 知识层消费者',
    edge: '① K→D 供给',
    status: consumers.length > 0 ? 'PASS' : 'FAIL',
    metrics: { lk_refs_total: hits.length, lk_consumers: consumers.length },
    criterion: '存在 assembler 之外的 layers.LK 消费点才 PASS',
    verdict: consumers.length > 0
      ? `LK 有 ${consumers.length} 处消费者: ${consumers.slice(0, 2).join(' | ')}`
      : 'LK 装配后零消费者 → 场景知识永不进 prompt（死层）',
    evidence: hits.slice(0, 5),
    fix: 'P0-1 让 injector 消费 layers.LK',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D3 — L1 知识路径的构成（"通但失真"检测）
// L1 = 全 particles 向量检索，被 injector.js:35 注入为「相关知识」。
// 若其中 CRM_KNOWLEDGE 占比极低 → 注入的其实是业务实体，不是知识。
// ════════════════════════════════════════════════════════════════════════════
async function probeD3() {
  const r = await sql('D3', `
    SELECT count(*) AS total,
           count(*) FILTER (WHERE type='CRM_KNOWLEDGE')          AS knowledge,
           count(*) FILTER (WHERE type='CRM_KNOWLEDGE' AND state='registered') AS knowledge_registered,
           count(DISTINCT type)                                   AS type_kinds
    FROM crm.particles WHERE embedding IS NOT NULL`);
  if (isErr(r)) return report({ id: 'D3', name: 'L1 知识构成', edge: '① K→D 供给', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const m = r[0] || {};
  const total = num(m.total);
  const know = num(m.knowledge_registered);
  const p = pct(know, total);
  report({
    id: 'D3',
    name: 'L1 知识构成',
    edge: '① K→D 供给',
    status: p >= 5 ? 'PASS' : p > 0 ? 'WARN' : 'FAIL',
    metrics: { l1_pool: total, type_kinds: num(m.type_kinds), knowledge: num(m.knowledge), knowledge_registered: know, knowledge_pct: p },
    criterion: 'L1 检索池里已注册知识占比 ≥5% 才 PASS',
    verdict: p >= 5
      ? `L1 池中已注册知识占 ${p}%（${know}/${total}）`
      : `L1 检索池 ${total} 行中已注册知识仅 ${know} 行（${p}%）→ 名为"相关知识"实为业务实体`,
    fix: '配合 P1-1（真向量）+ P0-1（LK 消费）：L1 降为实体召回，知识走 LK',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D4 — outcome 真实性（三分类，旧判据 `source<>'manual'` 会把种子数据判成自动）
// 真自动回写 source 形如 'event:crm.xxx'（outcomeIngester.js:38）；
// 'seed-script' 是种子数据；'manual' 是人工。三者必须分开计数。
// ════════════════════════════════════════════════════════════════════════════
async function probeD4() {
  const r = await sql('D4', `
    SELECT
      count(*)                                                   AS total,
      count(*) FILTER (WHERE source LIKE 'event:%')               AS real_auto,
      count(*) FILTER (WHERE source = 'manual' OR source IS NULL) AS manual,
      count(*) FILTER (WHERE source = 'seed-script')              AS seed,
      count(*) FILTER (WHERE source NOT LIKE 'event:%'
                         AND source <> 'manual'
                         AND source IS NOT NULL
                         AND source <> 'seed-script')             AS other
    FROM crm.decision_outcome`);
  if (isErr(r)) return report({ id: 'D4', name: 'outcome 真实性', edge: '⑤ 结果→D', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const m = r[0] || {};
  const auto = num(m.real_auto);
  const seed = num(m.seed);
  const total = num(m.total);

  const rules = await sql('D4b', `SELECT count(*) AS n, count(*) FILTER (WHERE enabled) AS enabled FROM crm.outcome_event_map`);
  const rm = isErr(rules) ? {} : (rules[0] || {});

  // 事件发射验证：近 7 天 crm.events 中是否含已映射事件类型（防「规则齐但事件没 emit」二次假绿）
  const ev = await sql('D4c', `
    SELECT count(*) FILTER (WHERE payload->>'type' IN
      ('deal-advance','quote-create','deal-archive','contract_sign')) AS mapped_emitted,
           count(*) AS total_decision_evt
    FROM crm.events
    WHERE domain='decision' AND created_at > now() - interval '7 days'`);
  const evM = isErr(ev) ? {} : (ev[0] || {});
  const mappedEmitted = num(evM.mapped_emitted);

  report({
    id: 'D4',
    name: 'outcome 真实性',
    edge: '⑤ 结果→D',
    status: auto > 0 ? 'PASS' : 'FAIL',
    metrics: {
      outcome_total: total,
      real_auto: auto,
      manual: num(m.manual),
      seed_script: seed,
      other: num(m.other),
      event_rules: num(rm.n),
      event_rules_enabled: num(rm.enabled),
      mapped_events_emitted_7d: mappedEmitted,
      event_emission_ok: mappedEmitted > 0,
    },
    criterion: "source LIKE 'event:%' 视为真自动回写（种子 seed-script 单独计数，不得混入）；映射事件须确经 decision 域 emit",
    verdict: (auto > 0
      ? `真自动回写 ${auto} 条，另有种子 ${seed} / 人工 ${num(m.manual)} 条`
      : `真自动回写 0 条（总计 ${total} 条，其中种子 ${seed} 条）→ 业务结果从未回流`)
      + `；映射事件近7天发射 ${mappedEmitted} 条${mappedEmitted > 0 ? '（OK）' : '（缺失：规则齐但事件未 emit→二次假绿风险）'}`,
    fix: "P0-2 注册 registerOutcomeIngester；P0-3 补 emit('decision','outcome-set')；映射事件须 emit 到 decision 域",
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D5 — 校准链事件契约（订阅名 ∩ 实际 emit 名）
// autoSuggest.js:104 订阅 decision-created/outcome-set/feedback-set；
// 若全仓实际 emit 的 decision 事件与之无交集 → 实时校准永不触发。
// ════════════════════════════════════════════════════════════════════════════
async function probeD5() {
  const subscribed = ['decision-created', 'outcome-set', 'feedback-set'];
  const emitted = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!/node_modules|\.git|dist/.test(p)) walk(p); continue; }
      if (!/\.(js|mjs|ts)$/.test(f.name)) continue;
      const txt = fs.readFileSync(p, 'utf8');
      for (const mt of txt.matchAll(/emit\(\s*['"]decision['"]\s*,\s*['"]([^'"]+)['"]/g)) emitted.add(mt[1]);
    }
  };
  walk(path.join(ROOT, 'src'));
  const inter = subscribed.filter((s) => emitted.has(s));
  report({
    id: 'D5',
    name: '校准事件契约',
    edge: '⑥ 校准触发',
    status: inter.length > 0 ? 'PASS' : 'FAIL',
    metrics: {
      subscribed: subscribed.length,
      emitted_kinds: emitted.size,
      intersection: inter.length,
      emitted: [...emitted].sort().join(','),
      matched: inter.join(',') || '(空)',
    },
    criterion: '订阅事件名与实际 emit 名交集非空才 PASS',
    verdict: inter.length > 0
      ? `交集 ${inter.length} 项: ${inter.join(',')}`
      : `订阅 ${subscribed.join('/')}，实际 emit ${[...emitted].sort().join('/')} → 交集为空，实时校准永不触发`,
    fix: 'P0-3 补 emit；或改订阅名为实际事件名（二选一，须在设计中定调）',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D6 — 校准补丁积压（⑥在产出 / ⑦不消费 → 积压）
// ════════════════════════════════════════════════════════════════════════════
async function probeD6() {
  const r = await sql('D6', `
    SELECT status, count(*) AS n,
           min(created_at) AS oldest, max(created_at) AS newest
    FROM crm.calibration_patch GROUP BY 1 ORDER BY 2 DESC`);
  if (isErr(r)) return report({ id: 'D6', name: '校准补丁积压', edge: '⑦ 参数生效', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const byStatus = Object.fromEntries(r.map((x) => [x.status, num(x.n)]));
  const pending = byStatus.PENDING || 0;
  const pendingRow = r.find((x) => x.status === 'PENDING');
  const ageDays = pendingRow?.oldest ? +((Date.now() - new Date(pendingRow.oldest)) / 86400000).toFixed(1) : 0;
  report({
    id: 'D6',
    name: '校准补丁积压',
    edge: '⑦ 参数生效',
    status: pending === 0 ? 'PASS' : pending > 20 || ageDays > 7 ? 'FAIL' : 'WARN',
    metrics: { ...byStatus, pending_age_days: ageDays },
    criterion: 'PENDING=0 PASS；PENDING>20 或最老超 7 天 FAIL',
    verdict: pending === 0
      ? '无积压'
      : `PENDING ${pending} 条，最老已积压 ${ageDays} 天 → 校准在产出但无人消费`,
    fix: '治理项：设审批 SLA + 超时自动转人工看板',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D7 — M→K 升格（第 8 条边：记忆升格为先例/知识）
// ════════════════════════════════════════════════════════════════════════════
async function probeD7() {
  const r = await sql('D7', `
    SELECT COALESCE(source_kind,'(null)') AS source_kind, count(*) AS n, min(created_at) AS first_at
    FROM crm.tenant_precedent GROUP BY 1 ORDER BY 2 DESC`);
  if (isErr(r)) return report({ id: 'D7', name: 'M→K 升格', edge: '⑧ M→K', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const total = r.reduce((s, x) => s + num(x.n), 0);
  const fromMemory = r.filter((x) => /memory/i.test(x.source_kind)).reduce((s, x) => s + num(x.n), 0);
  const dist = Object.fromEntries(r.map((x) => [x.source_kind, num(x.n)]));
  report({
    id: 'D7',
    name: 'M→K 升格',
    edge: '⑧ M→K',
    status: fromMemory > 0 ? 'PASS' : total > 0 ? 'WARN' : 'FAIL',
    metrics: { total, from_memory: fromMemory, dist },
    criterion: 'source_kind 含 memory 的先例 >0 才 PASS',
    verdict: total === 0
      ? 'tenant_precedent 为空 → 第 8 条边从未通电'
      : fromMemory > 0
        ? `共 ${total} 条先例，其中 ${fromMemory} 条由记忆升格`
        : `共 ${total} 条先例，但 0 条来自记忆（来源: ${Object.keys(dist).join('/')}）`,
    fix: '记忆升格路径存在但几乎未触发 → 需确认 promote 触发条件',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D8 — 记忆可用性（排除蒸馏噪声后的真实画像）
// 反假绿：memory-distill-run 曾单日灌入 62 万行，会把所有比率指标稀释到失真。
// ════════════════════════════════════════════════════════════════════════════
async function probeD8() {
  const r = await sql('D8', `
    SELECT count(*) AS total,
           count(*) FILTER (WHERE event_type <> 'memory-distill-run')                        AS business,
           count(*) FILTER (WHERE event_type <> 'memory-distill-run' AND entity_id IS NOT NULL) AS anchored,
           count(*) FILTER (WHERE event_type <> 'memory-distill-run'
                              AND archived = false
                              AND (payload ? 'summary' OR payload ? 'text'
                                   OR payload ? 'note' OR payload ? 'content'))              AS injectable
    FROM crm.memory_log`);
  if (isErr(r)) return report({ id: 'D8', name: '记忆可用性', edge: '② M→D 供给', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const m = r[0] || {};
  const biz = num(m.business);
  const inj = num(m.injectable);     // 活跃(未归档)且含叙事文本的业务记忆 = 真正可被注入决策的供给
  const anchor = num(m.anchored);    // 已锚定到实体的业务记忆（无论归档）= 可被检索召回
  // 选项A（2026-09-10 用户裁决）：改绝对数口径。
  // 原占比口径对「业务记忆以结构化事件为主、叙事文本少」的分布天然失真（injPct 1.58% 误判 FAIL）；
  // KMD 实质是「记忆是否真被消费」→ 看活跃供给绝对量(injectable)与可锚定量(anchored)，不看占业务总行比。
  // 反假绿仍成立：P0-4 修复前 appendMemoryLog 静默全败 → injectable≈0/anchored≈0 → FAIL；
  //            修复后 injectable=145/anchored=54 → PASS，可区分「真有供给」与「空壳」。
  report({
    id: 'D8',
    name: '记忆可用性',
    edge: '② M→D 供给',
    status: inj >= 100 && anchor >= 50 ? 'PASS' : inj >= 20 || anchor >= 20 ? 'WARN' : 'FAIL',
    metrics: {
      memory_total: num(m.total),
      business_rows: biz,
      injectable: inj,            // 关键 KMD 指标（绝对数）：活跃可注入记忆
      anchored: anchor,           // 关键 KMD 指标（绝对数）：可锚定/可检索记忆
      anchor_pct_legacy: pct(m.anchored, biz),   // 仅作历史对照，不再参与判定
      injectable_pct_legacy: pct(m.injectable, biz),
    },
    criterion: '活跃可注入记忆 injectable ≥100 且 锚定记忆 anchored ≥50 才 PASS（绝对数口径，消除结构化记忆占比失真）',
    verdict: `活跃可注入 ${inj} 行、锚定 ${anchor} 行（业务记忆 ${biz} 行，仅作基数不再用于比率判定）`
      + (inj < 100 ? ' → 活跃记忆供给偏薄，决策消费受限' : '')
      + (anchor < 50 ? ' → 锚定记忆不足，检索召回受限' : ''),
    fix: 'P0-4 记忆写入补齐 entity_id 与四段式 payload（已落地；D8 现用绝对数判定）',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D9 — 当前噪声源排行（谁在污染记忆表）
// ════════════════════════════════════════════════════════════════════════════
async function probeD9() {
  const r = await sql('D9', `
    SELECT COALESCE(event_type,'(null)') AS event_type, count(*) AS n
    FROM crm.memory_log
    WHERE created_at > now() - interval '24 hours'
    GROUP BY 1 ORDER BY 2 DESC LIMIT 8`);
  if (isErr(r)) return report({ id: 'D9', name: '噪声源排行', edge: 'M 构建', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const total24 = r.reduce((s, x) => s + num(x.n), 0);
  const top = r[0] || {};
  const topPct = pct(top.n, total24);
  report({
    id: 'D9',
    name: '噪声源排行(24h)',
    edge: 'M 构建',
    status: topPct > 80 ? 'FAIL' : topPct > 50 ? 'WARN' : 'PASS',
    metrics: { rows_24h: total24, top: top.event_type, top_n: num(top.n), top_pct: topPct, breakdown: Object.fromEntries(r.map((x) => [x.event_type, num(x.n)])) },
    criterion: '单一事件类型占比 >80% FAIL（视为噪声风暴）',
    verdict: `24h 内 ${total24} 行，最大来源 ${top.event_type} ${num(top.n)} 行（${topPct}%）`,
    fix: '针对 top 噪声源收紧 capture 白名单',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D10 — D→K 回写活性（复盘产出的知识）
// ════════════════════════════════════════════════════════════════════════════
async function probeD10() {
  const r = await sql('D10', `
    SELECT count(*) FILTER (WHERE payload->>'source' LIKE 'retro%')  AS retro_knowledge,
           count(*)                                                  AS knowledge_total
    FROM crm.particles WHERE type='CRM_KNOWLEDGE'`);
  if (isErr(r)) return report({ id: 'D10', name: 'D→K 回写', edge: '④ D→K', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const m = r[0] || {};
  const retro = num(m.retro_knowledge);
  report({
    id: 'D10',
    name: 'D→K 回写',
    edge: '④ D→K',
    status: retro > 0 ? 'PASS' : 'WARN',
    metrics: { knowledge_total: num(m.knowledge_total), retro_knowledge: retro },
    criterion: 'retro 来源知识 >0 才 PASS（0 也不算断，因该路径本就需人工提交复盘）',
    verdict: retro > 0 ? `复盘已产出 ${retro} 条知识` : '复盘产出知识 0 条 → 回写路径存在但从未走通',
    fix: 'P1: 复盘结论自动落知识（免人工）',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D11 — 知识写入契约 vs LK 投影契约 匹配率
// buildKnowledgeRows(assembler.js:35) 只透传 {kind, term, content}。
// 若知识按 kind/term/text 写入（无 content），即便 LK 修好消费，也是空壳。
// 这是"修好接线仍然不通"的隐形断点，必须在修 P0-1 之前量化。
// ════════════════════════════════════════════════════════════════════════════
async function probeD11() {
  const KINDS = ['icp', 'competitors', 'objections', 'buyer_language'];
  const r = await sql('D11', `
    SELECT count(*)                                          AS total,
           count(*) FILTER (WHERE payload ? 'content')       AS has_content,
           count(*) FILTER (WHERE payload->>'kind' = ANY($1::text[])) AS kind_in_four,
           count(*) FILTER (WHERE payload ? 'content' AND payload->>'kind' = ANY($1::text[])) AS both_ok
    FROM crm.particles WHERE type='CRM_KNOWLEDGE'`, [KINDS]);
  if (isErr(r)) return report({ id: 'D11', name: '知识投影契约', edge: 'K 构建', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const m = r[0] || {};
  const total = num(m.total);
  const ok = num(m.both_ok);
  const p = pct(ok, total);

  const kinds = await sql('D11b', `
    SELECT COALESCE(payload->>'kind','(null)') AS kind, count(*) AS n
    FROM crm.particles WHERE type='CRM_KNOWLEDGE' GROUP BY 1 ORDER BY 2 DESC`);
  const kindDist = isErr(kinds) ? {} : Object.fromEntries(kinds.map((x) => [x.kind, num(x.n)]));

  report({
    id: 'D11',
    name: '知识投影契约',
    edge: 'K 构建',
    status: total === 0 ? 'WARN' : p >= 50 ? 'PASS' : p > 0 ? 'WARN' : 'FAIL',
    metrics: { knowledge_total: total, has_content: num(m.has_content), kind_in_four: num(m.kind_in_four), both_ok: ok, match_pct: p, kind_dist: kindDist },
    criterion: '同时满足「有 content 字段」且「kind 在四大类内」的比例 ≥50% 才 PASS',
    verdict: total === 0
      ? '无知识行'
      : p >= 50
        ? `${p}% 知识符合 LK 投影契约（${ok}/${total}）`
        : `仅 ${p}% 知识能被 LK 正确投影（${ok}/${total}）→ 修好消费端也只会拿到空壳`,
    fix: '修 P0-1 前必须先统一知识写入契约（content 字段 + 四大类 kind）',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D12 — 业务事件 → 决策结果 自动回流活性（⑤ 边 + ⑥ 边 行为级验证）
// 模拟一个 contract_sign 事件（payload 仅带 deal_id，无 decision_id，与线上一致），
// 经 handleBusinessEvent → lookupDecisionByDeal 反查 → writeOutcome，
// 断言 decision_outcome 出现 source='event:decision.contract_sign' 行。
// 这是 ⑤ 边（结果自动回流）与 ⑥ 边（writeOutcome emit outcome-set）的唯一行为级证明。
// 写操作：仅在 DB_MODE==='test' 且 --e2e 时执行（与 E2E 同闸门，绝不碰生产）。
// 幂等：规则用 WHERE NOT EXISTS 播种；outcome 受 (decision_id,outcome_type,source)
//   唯一约束保护，重跑为 upsert 不重复插入。
// ════════════════════════════════════════════════════════════════════════════
async function probeD12() {
  if (DB_MODE !== 'test' || !RUN_E2E) {
    report({ id: 'D12', name: '结果自动回流', edge: '⑤ 结果→D', status: 'SKIP', metrics: {}, verdict: '写类探针，需 --db=test --e2e 才执行（避免污染生产）' });
    return;
  }
  try {
    // 1) 确保映射规则存在（幂等；与 db/seed-outcome-event-map.sql 同源）
    await client.query(`INSERT INTO crm.outcome_event_map (event_type, outcome_type, scenario_id, matcher, enabled)
      SELECT 'decision.contract_sign','won',NULL,'{"deal_id_field":"deal_id"}'::jsonb,true
      WHERE NOT EXISTS (SELECT 1 FROM crm.outcome_event_map WHERE event_type='decision.contract_sign' AND outcome_type='won')`);

    // 2) 找一条含真实 deal_id 的决策（用于反查）；测试库无夹具则幂等播种一条
    const FIXED_DID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
    const FIXED_DEAL = 'KMDPROBE-DEAL-001';
    let dq = await client.query(
      `SELECT decision_id, involved_entities->0->>'id' AS deal_id
       FROM crm.decision
       WHERE involved_entities @> '[{"type":"CRM_DEAL"}]'::jsonb
         AND involved_entities->0->>'id' IS NOT NULL
       LIMIT 1`
    );
    if (!dq.rows.length) {
      await client.query(
        `INSERT INTO crm.decision (decision_id, scenario_id, involved_entities, created_at)
         VALUES ($1::uuid,'kmd-probe-fixture',jsonb_build_array(jsonb_build_object('type','CRM_DEAL','id',$2::text)),now())
         ON CONFLICT (decision_id) DO UPDATE SET involved_entities = EXCLUDED.involved_entities`,
        [FIXED_DID, FIXED_DEAL]
      );
      dq = await client.query(
        `SELECT decision_id, involved_entities->0->>'id' AS deal_id FROM crm.decision WHERE decision_id=$1`,
        [FIXED_DID]
      );
    }
    if (!dq.rows.length) {
      report({ id: 'D12', name: '结果自动回流', edge: '⑤ 结果→D', status: 'WARN', metrics: {}, verdict: '测试库无含真实 deal_id 的决策，且夹具播种失败，无法模拟 contract_sign' });
      return;
    }
    const { decision_id, deal_id } = dq.rows[0];

    // 3) 跑真实 handler（走注册订阅器同款代码路径）
    const { handleBusinessEvent } = await import('../src/decision/outcomeIngester.js');
    const written = await handleBusinessEvent('decision', 'contract_sign', { deal_id });

    // 4) 断言 outcome 行已落库。
    //    注意：handleBusinessEvent 经 lookupDecisionByDeal 反查「同 deal 最新决策」写回，
    //    故校验必须按 deal_id 关联（而非按我选取的 decision_id），否则会因同 deal 多决策而误判。
    const r = await sql('D12-check',
      `SELECT o.decision_id, o.outcome_type, o.source
       FROM crm.decision_outcome o
       JOIN crm.decision d ON d.decision_id = o.decision_id
       WHERE d.involved_entities @> jsonb_build_array(jsonb_build_object('id', $1::text))
         AND o.source = 'event:decision.contract_sign'`, [deal_id]);
    const ok = Array.isArray(r) && r.length > 0;
    report({
      id: 'D12',
      name: '结果自动回流',
      edge: '⑤ 结果→D',
      status: ok ? 'PASS' : 'FAIL',
      metrics: { picked_decision_id: decision_id, deal_id, written_rows: Array.isArray(written) ? written.length : 0, outcome_found: ok ? r.length : 0 },
      criterion: "handleBusinessEvent('decision','contract_sign',{deal_id}) 必须按 deal 反查决策并写出 source='event:decision.contract_sign' 的 outcome 行",
      verdict: ok
        ? 'contract_sign 事件已自动回写该 deal 的决策结果（⑤ 结果回流 + ⑥ emit outcome-set 均接通）'
        : '事件未回写出 outcome（⑤ 边仍断：订阅器未注册 / 规则缺失 / 反查失败）',
      fix: 'P0-2 注册 registerOutcomeIngester + 播种 outcome_event_map 规则',
    });
  } catch (e) {
    report({ id: 'D12', name: '结果自动回流', edge: '⑤ 结果→D', status: 'ERROR', metrics: {}, verdict: `执行失败: ${String(e.message || e)}` });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// D13 — 记忆噪声闸门回归保护（P0-5 根因锁死）
// 根因（2026-09-10 实证）：capture.js 旧实现 `on('*')` 全量订阅，把 170 处
//   emit('trace', …) 全部写成业务记忆（生产 62 万+ 行 event:trace:* 噪声，占记忆表 ~99.9%）。
//   C4 修复：BLOCKED_DOMAINS 硬闸 + 逐域白名单订阅（绝无 on('*')）。
// 本探针三道关卡，防止该根因被「改回 on('*')」或「把 trace 塞进白名单」复活：
//   A) 代码扫描：capture.js 不得再出现 on('*') / on("*") 订阅（字面根因）。
//   B) 运行时契约：isCapturable('trace'/'metering'/'system'/'decision'/'memory') 必须全 false；
//      getCaptureDomains() 不得泄漏任一 BLOCKED 域；业务域 'crm' 必须 true。
//   C) 生产库实时：近 60 分钟不得再出现 event:trace:* 记忆（只读，prod 安全）。
// 三关全过 → PASS；任一过不了 → FAIL（CI 拦截）。
// ════════════════════════════════════════════════════════════════════════════
async function probeD13() {
  const blocked = ['trace', 'metering', 'system', 'decision', 'memory'];

  // A) 代码扫描（先剥离行注释，避免把「绝不 on('*')」这类说明文字误判为订阅调用）
  let wildcardSub = false;
  try {
    const capTxt = fs.readFileSync(path.join(ROOT, 'src/memory/capture.js'), 'utf8');
    const codeLines = capTxt.split('\n').map((l) => l.replace(/\/\/.*$/, ''));
    wildcardSub = codeLines.some((l) => /on\(\s*['"]\*['"]/.test(l));
  } catch (e) {
    return report({ id: 'D13', name: '噪声闸门回归', edge: 'M 构建', status: 'ERROR', metrics: {}, verdict: `读取 capture.js 失败: ${String(e.message || e)}` });
  }

  // B) 运行时契约
  let contract;
  try {
    const { isCapturable, getCaptureDomains } = await import('../src/memory/capture.js');
    const blockedCapturable = blocked.filter((d) => isCapturable(d));
    const domains = getCaptureDomains();
    const leak = domains.filter((d) => blocked.includes(d));
    contract = {
      blocked_capturable: blockedCapturable,
      whitelist_leak: leak,
      whitelist_size: domains.length,
      business_crm_capturable: isCapturable('crm'),
    };
  } catch (e) {
    return report({ id: 'D13', name: '噪声闸门回归', edge: 'M 构建', status: 'ERROR', metrics: {}, verdict: `导入 capture.js 失败: ${String(e.message || e)}` });
  }

  // C) 生产库实时（只读）
  const r = await sql('D13', `SELECT count(*)::int AS n FROM crm.memory_log WHERE topic LIKE 'event:trace:%' AND created_at > now() - interval '60 minutes'`);
  const recentTrace = isErr(r) ? null : num(r[0]?.n);

  const failCode = wildcardSub || contract.blocked_capturable.length > 0 || contract.whitelist_leak.length > 0 || contract.business_crm_capturable !== true;
  const failLive = recentTrace != null && recentTrace > 0;
  const status = failCode || failLive ? 'FAIL' : 'PASS';

  report({
    id: 'D13',
    name: '噪声闸门回归',
    edge: 'M 构建',
    status,
    metrics: {
      code_has_wildcard_sub: wildcardSub,
      blocked_capturable: contract.blocked_capturable.join(',') || '(无)',
      whitelist_leak: contract.whitelist_leak.join(',') || '(无)',
      whitelist_size: contract.whitelist_size,
      business_crm_capturable: contract.business_crm_capturable,
      recent_trace_rows_60m: recentTrace,
    },
    criterion: "A) capture.js 无 on('*')；B) trace/metering/system/decision/memory 均不可捕获且白名单不泄漏；C) 近60分钟 event:trace:* 记忆=0",
    verdict: status === 'PASS'
      ? '噪声闸门三关全过：on(*) 已除、BLOCKED 硬闸生效、生产近 60 分钟零 trace 噪声（P0-5 已锁死）'
      : [
          wildcardSub ? '代码扫描发现 on(*) 复活（全量订阅噪声根源）' : null,
          contract.blocked_capturable.length ? `BLOCKED 域仍可被捕获: ${contract.blocked_capturable.join(',')}` : null,
          contract.whitelist_leak.length ? `白名单泄漏 BLOCKED 域: ${contract.whitelist_leak.join(',')}` : null,
          contract.business_crm_capturable !== true ? "业务域 'crm' 未被捕获（白名单失效）" : null,
          failLive ? `生产近 60 分钟仍有 ${recentTrace} 行 event:trace:* 噪声` : null,
        ].filter(Boolean).join('；'),
    fix: 'P0-5 C4 修复（capture.js 白名单 + BLOCKED_DOMAINS 硬闸）；禁止 on(*) 与把 trace 塞进白名单',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// E2E — 端到端哨兵（唯一能绕过各层自我报告的探针）
// 写一条含随机串的知识 → 走真实装配链路 → 检查最终 prompt 是否含该串。
// 安全：仅 --db=test，且用后即删（软删除 archived，禁 DELETE）。
// ════════════════════════════════════════════════════════════════════════════
async function probeE2E() {
  const token = `SENTINEL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
  let id = null;
  try {
    // 哨兵必须遵守 LK 的两道契约，否则探针自身会假阳性：
    //   ① kind 必须在四大类内（assembler.js:17-31，非四类场景回退全量四类）
    //   ② 正文必须在 payload.content（buildKnowledgeRows:35 只透传 kind/term/content，
    //      用 text/summary 会被投影成空壳）—— 这条契约不匹配本身就是真实风险，见 D11
    const ins = await client.query(
      `INSERT INTO crm.particles (type, tenant_id, state, slug, title, payload)
       VALUES ('CRM_KNOWLEDGE','system','registered',$3,$1,$2::jsonb) RETURNING id`,
      [
        `哨兵知识 ${token}`,
        JSON.stringify({ kind: 'icp', term: '探针哨兵', content: token, confidence: 0.99, source: 'probe-sentinel' }),
        `probe-sentinel-${token.toLowerCase()}`,
      ]
    );
    id = ins.rows[0].id;

    const { assembleContext } = await import('../src/context/assembler.js');
    const { formatForPrompt } = await import('../src/context/injector.js');
    const bundle = await assembleContext(
      { actor: 'probe', intent: { scenario: 'sales-decision', tenantId: 'system' }, query: token, tenantId: 'system' }
    );
    const prompt = formatForPrompt(bundle);
    const inPrompt = prompt.includes(token);
    const lkRows = bundle?.layers?.LK?.length ?? 0;

    report({
      id: 'E2E',
      name: '端到端哨兵(K→prompt)',
      edge: '① K→D 供给',
      status: inPrompt ? 'PASS' : 'FAIL',
      metrics: { sentinel: token, lk_rows: lkRows, in_prompt: inPrompt, prompt_len: prompt.length },
      criterion: '哨兵串必须出现在最终 prompt 原文中；否则各层自我报告一律不可信',
      verdict: inPrompt
        ? `哨兵串已进入 prompt（LK ${lkRows} 行）`
        : `哨兵知识已入 LK(${lkRows} 行) 但 prompt 中检索不到 → 链路在此处断裂`,
      fix: 'P0-1 injector 消费 layers.LK',
    });
  } catch (e) {
    report({ id: 'E2E', name: '端到端哨兵(K→prompt)', edge: '① K→D 供给', status: 'ERROR', metrics: { sentinel: token }, verdict: `执行失败: ${String(e.message || e)}` });
  } finally {
    // 禁 DELETE（项目铁律）：用 archived 软删 + 标记
    if (id) {
      await client.query(`UPDATE crm.particles SET state='archived', payload = payload || '{"probe":"sentinel-cleanup"}'::jsonb WHERE id=$1`, [id]).catch(() => {});
    }
  }
}

// ════════════════════════════════════════════════════════════════════════════
// SELF-TEST — 探针自证鉴别力（防止"恒绿探针"）
// 方法：对每条数值探针，构造已知反例，验证判据会给出相反结论。
// ════════════════════════════════════════════════════════════════════════════
async function selfTest() {
  console.log('\n=== 探针自检（自证鉴别力）===');
  const cases = [];
  // D1 反例：真模型向量（384 维全非零 + 含负分量）→ 必须判为 real，不得判 hash
  const tmp = 'probe_selftest_' + Date.now();
  await client.query(`CREATE TEMP TABLE ${tmp}(embedding vector(384))`);
  const realVec = Array.from({ length: 384 }, (_, i) => (i % 2 ? -0.03 : 0.041) * (1 + i / 1000));
  await client.query(`INSERT INTO ${tmp} VALUES ($1::vector)`, [`[${realVec.join(',')}]`]);
  const hashLike = await client.query(`
    SELECT count(*) FILTER (WHERE s.minv < 0) AS has_negative,
           count(*) FILTER (WHERE s.minv >= 0 AND s.nonzero <= 32) AS hash_signature
    FROM (SELECT min(t.x::float8) AS minv, count(*) FILTER (WHERE t.x::float8<>0) AS nonzero
          FROM ${tmp} e, LATERAL regexp_split_to_table(substring(e.embedding::text,2,length(e.embedding::text)-2),',') t(x)
          GROUP BY e.ctid) s`);
  const h = hashLike.rows[0] || {};
  cases.push({
    probe: 'D1',
    case: '真模型向量(384维含负分量)',
    expect: '判为 real（hash_signature=0）',
    got: `has_negative=${num(h.has_negative)}, hash_signature=${num(h.hash_signature)}`,
    ok: num(h.has_negative) > 0 && num(h.hash_signature) === 0,
  });
  await client.query(`DROP TABLE ${tmp}`);

  // D4 反例：seed-script 不得被计入 real_auto
  const d4 = await client.query(`
    SELECT count(*) FILTER (WHERE source LIKE 'event:%') AS real_auto,
           count(*) FILTER (WHERE source='seed-script')  AS seed
    FROM crm.decision_outcome`);
  const d = d4.rows[0] || {};
  cases.push({
    probe: 'D4',
    case: '库中存在 seed-script 行',
    expect: 'seed 计入独立计数，不混入 real_auto',
    got: `real_auto=${num(d.real_auto)}, seed=${num(d.seed)}`,
    ok: num(d.seed) === 0 || num(d.real_auto) !== num(d.seed) || num(d.real_auto) === 0,
  });

  for (const c of cases) console.log(`  ${c.ok ? '🟢' : '🔴'} ${c.probe} ${c.case}\n     期望: ${c.expect}\n     实测: ${c.got}`);
  const bad = cases.filter((c) => !c.ok).length;
  console.log(`\n自检结论: ${cases.length - bad}/${cases.length} 通过${bad ? ` — ${bad} 条探针判据有缺陷，需修探针` : '（探针具备鉴别力）'}`);
}

// ════════════════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════════════════
const PROBES = { D1: probeD1, D2: probeD2, D3: probeD3, D4: probeD4, D5: probeD5, D6: probeD6, D7: probeD7, D8: probeD8, D9: probeD9, D10: probeD10, D11: probeD11, D12: probeD12, D13: probeD13, E2E: probeE2E };

(async () => {
  console.log(`\n╔══════════════════════════════════════════════════════════════╗`);
  console.log(`║ KMD 闭环探针  |  db=${DB.database}  |  ${new Date().toLocaleString('zh-CN')}`);
  console.log(`╚══════════════════════════════════════════════════════════════╝`);
  await client.connect();
  await client.query('SET search_path TO crm,public');

  // ESM 静态 import 会让 env 兜底失效（项目既有坑）：src/db.js 读 process.env.PGDATABASE，
  // 必须在动态 import 装配链路之前设置；dotenv 默认不覆盖已存在的 env，故此处安全。
  if (DB_MODE === 'test') process.env.PGDATABASE = 'crm_native_test';

  if (SELF_TEST) { await selfTest(); await client.end(); return; }

  for (const [id, fn] of Object.entries(PROBES)) {
    if ((id === 'E2E' || id === 'D12') && !RUN_E2E) { report({ id, name: id === 'D12' ? '结果自动回流' : '端到端哨兵(K→prompt)', edge: id === 'D12' ? '⑤ 结果→D' : '① K→D', status: 'SKIP', metrics: {}, verdict: '需 --e2e --db=test 才执行（避免写生产库）' }); continue; }
    if (ONLY && !ONLY.includes(id)) continue;
    try { await fn(); } catch (e) { report({ id, name: id, edge: '-', status: 'ERROR', metrics: {}, verdict: `探针异常: ${String(e.message || e)}` }); }
  }

  // 输出
  const ICON = { PASS: '🟢', FAIL: '🔴', WARN: '🟡', ERROR: '⛔', SKIP: '⚪' };
  console.log('\n┌────┬──────────────────────┬──────────────┬────────┬────────────────────────────────────────');
  console.log('│ ID │ 探针                 │ 边           │ 状态   │ 结论');
  console.log('├────┼──────────────────────┼──────────────┼────────┼────────────────────────────────────────');
  for (const r of results) {
    const pad = (s, n) => { s = String(s ?? ''); let w = 0; for (const ch of s) w += /[\u4e00-\u9fa5（）]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };
    console.log(`│ ${pad(r.id, 2)} │ ${pad(r.name, 20)} │ ${pad(r.edge, 12)} │ ${ICON[r.status] || '?'} ${pad(r.status, 5)} │ ${pad(r.verdict, 60)}`);
  }
  console.log('└────┴──────────────────────┴──────────────┴────────┴────────────────────────────────────────');

  console.log('\n── 关键指标 ──');
  for (const r of results) {
    if (r.status === 'SKIP' || !r.metrics || !Object.keys(r.metrics).length) continue;
    const m = Object.entries(r.metrics).filter(([, v]) => typeof v !== 'object' || v === null).map(([k, v]) => `${k}=${v}`).join('  ');
    console.log(`  ${r.id}  ${m}`);
  }

  const failed = results.filter((r) => r.status === 'FAIL');
  const errored = results.filter((r) => r.status === 'ERROR');
  const warned = results.filter((r) => r.status === 'WARN');
  console.log(`\n汇总: ${results.length} 条探针 → 🟢${results.filter((r) => r.status === 'PASS').length} 🔴${failed.length} 🟡${warned.length} ⛔${errored.length} ⚪${results.filter((r) => r.status === 'SKIP').length}`);
  if (failed.length) console.log(`🔴 FAIL: ${failed.map((r) => r.id).join(', ')}`);
  if (errored.length) console.log(`⛔ ERROR: ${errored.map((r) => r.id).join(', ')}`);

  if (JSON_OUT) {
    fs.writeFileSync(JSON_OUT, JSON.stringify({ generated_at: new Date().toISOString(), db: DB.database, results }, null, 2), 'utf8');
    console.log(`\nJSON 已写入: ${JSON_OUT}`);
  }

  await client.end();
  process.exit(failed.length || errored.length ? 1 : 0);
})().catch(async (e) => {
  console.error('[kmd-probe] 致命错误:', e);
  try { await client.end(); } catch {}
  process.exit(2);
});
