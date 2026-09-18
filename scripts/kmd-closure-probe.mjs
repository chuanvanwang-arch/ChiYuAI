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
//   node scripts/kmd-closure-probe.mjs --no-external     # 跳过 D14 外部依赖活性探针（离线/CI）
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
const NO_EXTERNAL = flag('no-external');      // 跳过 D14（外部依赖活性探针；无外网/离线 CI 场景）

if (RUN_E2E && DB_MODE !== 'test') {
  console.error('[kmd-probe] 拒绝执行：--e2e 会写库，必须显式 --db=test（禁止对生产库写探针数据）');
  process.exit(2);
}

// PG 仅监听 IPv6 回环（项目铁律）：硬编码 127.0.0.1 会 ECONNREFUSED → 用 localhost
// 2026-09-18：host/port 改为可被 env 覆盖（缺省值不变）—— 使同一探针可在**容器内**跑：
//   docker exec -w /app -e PGHOST=crm-pg -e PGPORT=5432 crm-app node scripts/kmd-closure-probe.mjs
//   此前 host 被硬编码为 'localhost'，在容器内必然 ECONNREFUSED（PG 不在同容器），
//   故「生产能力活性」只能靠外部脚本另写一份 —— 判据分叉的风险源。
const DB = {
  host: process.env.PGHOST || 'localhost',
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
// D0 — 环境基线漂移（与「闭环健康度」正交的独立维度）
// 背景（2026-09-18 元问题）：D1/D11 等在**开发库**恒红，根因是该库「迁移/种子执行不完整」
//   （列 384 vs 1024、规则 1 vs 4 条），与闭环是否接线无关。两类维度混在同一张红绿表里
//   互相污染语义 → 长期训练出「告警疲劳」（每晚必红 3 条，真红反而被淹没）。
// 判据：与**声明基线**（schema.sql 列类型 / 种子声明的规则数 / llm_config 默认条目）比对；
//   漂移 → WARN，**永不 FAIL**（基线差异不是闭环故障）。
// ════════════════════════════════════════════════════════════════════════════
async function probeD0() {
  const col = await sql('D0a', `
    SELECT format_type(a.atttypid, a.atttypmod) AS t
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='crm' AND c.relname='particles' AND a.attname='embedding'`);
  const rules = await sql('D0b', `SELECT count(*) AS n FROM crm.outcome_event_map`);
  const llm = await sql('D0c', `SELECT count(*) AS n FROM crm.llm_config WHERE is_default AND NOT coalesce(is_deleted,false)`);
  const colT = isErr(col) ? '?' : (col[0]?.t || '?');
  const ruleN = isErr(rules) ? -1 : num(rules[0]?.n);
  const llmN = isErr(llm) ? -1 : num(llm[0]?.n);
  const embProvider = process.env.EMBEDDING_PROVIDER || '(未设置)';

  const drift = [];
  if (colT !== 'vector(1024)') drift.push(`particles.embedding=${colT}（基线 vector(1024)）`);
  if (ruleN >= 0 && ruleN < 4) drift.push(`outcome_event_map=${ruleN} 条（基线 ≥4）`);
  if (llmN === 0) drift.push('llm_config 无默认条目');

  report({
    id: 'D0',
    name: '环境基线漂移',
    edge: '-',
    status: drift.length ? 'WARN' : 'PASS',
    metrics: { particles_embedding_col: colT, outcome_rules: ruleN, llm_default_cfg: llmN, embedding_provider: embProvider, drift_items: drift.length },
    criterion: '与声明基线（schema.sql 列类型 / 种子规则数 / llm_config 默认条目）比对；漂移仅 WARN，永不 FAIL（基线差异 ≠ 闭环故障）',
    verdict: drift.length
      ? `环境基线漂移 ${drift.length} 项：${drift.join('；')} → D1/D4 类红可能源于此，非闭环缺陷`
      : '环境基线与声明一致',
    fix: '跑 `node db/migrate.js` 对齐迁移/种子；particles.embedding 列迁移见 db/migration-2026-09-14-particles-embedding-1024.sql（须由发布流程显式执行）',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D1 — 知识向量真伪（核心反假绿探针）
// 旧判据 `embedding IS NOT NULL` 无鉴别力：hash 伪向量同样非空。
// 新判据（数学指纹，源自 src/ontology/embedding.js:8-15）：
//   hashVector = SHA-256 的 32 字节映射到 384 桶 →
//     (a) 非零分量数 ≤ 32（真模型 embedding 384 维几乎全非零）
//     (b) 分量值恒 ≥ 0（(h[i] % 251)/251 非负）→ 真模型必有负分量
//   两者同时满足 → 判定为 hash 伪向量。
// ════════════════════════════════════════════════════════════════════════════
// D1 状态分类（纯函数：探针与自检共用 —— 判据必须可被反例证伪，故不得内联在探针里）
// 三态区分，语义互不覆盖：
//   empty-layer   0 行知识（知识层尚未产出）→ WARN
//   zero-vector   有知识但向量全 NULL（回填待执行 / 写入能力失效）→ FAIL
//   hash-dominated 向量在但以 hash 伪向量为主（语义检索等于随机）→ FAIL
//   real          真模型向量占多数 → PASS
function d1Classify({ totalRows = 0, embedded = 0, hashCount = 0 } = {}) {
  const rows = num(totalRows);
  const emb = num(embedded);
  const hash = num(hashCount);
  if (rows === 0) return { status: 'WARN', kind: 'empty-layer', realPct: 0 };
  if (emb === 0) return { status: 'FAIL', kind: 'zero-vector', realPct: 0 };
  const realPct = pct(emb - hash, emb);
  return realPct >= 50
    ? { status: 'PASS', kind: 'real', realPct }
    : { status: 'FAIL', kind: 'hash-dominated', realPct };
}

async function probeD1() {
  // 2026-09-18 修正：「知识层空」与「有知识但零向量」是两种完全不同的状态，原实现把
  //   后者也报成前者 —— 本机执行 384→1024 幂等迁移后向量被按设计清空（待回填），
  //   探针却称"无 CRM_KNOWLEDGE 行，知识层空"，而 D3 同时报 knowledge=69。
  //   判据错配会直接误导处置方向（去查"为什么没知识"而非"去跑回填"）。
  //   ⇒ 总行数与已嵌行数必须分开取。
  const tot = await sql('D1a', `SELECT count(*) AS n FROM crm.particles WHERE type='CRM_KNOWLEDGE'`);
  if (isErr(tot)) return report({ id: 'D1', name: '知识向量真伪', edge: 'K 构建', status: 'ERROR', metrics: {}, verdict: `查询失败: ${tot.__error}` });
  const totalRows = num(tot[0]?.n);
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
  const total = num(m.total);                 // 有向量的行
  const hash = num(m.hash_signature);
  const cls = d1Classify({ totalRows, embedded: total, hashCount: hash });
  const realPct = cls.realPct;
  const embeddedPct = pct(total, totalRows);
  const metrics = {
    knowledge_rows: totalRows,               // 知识总行数
    embedded_rows: total,                    // 已写入向量的行数
    embedded_pct: embeddedPct,
    hash_signature: hash,
    has_negative: num(m.has_negative),
    max_nonzero: num(m.max_nonzero),
    avg_nonzero: num(m.avg_nonzero),
    real_vector_pct: realPct,                // 占**已嵌行**的真向量占比
    state: cls.kind,                         // empty-layer | zero-vector | hash-dominated | real
  };
  const CRIT = 'hash 指纹 = 分量全非负 且 非零维≤32；已嵌行中真向量占比 ≥50% 才 PASS';

  if (cls.kind === 'empty-layer') {
    return report({
      id: 'D1', name: '知识向量真伪', edge: 'K 构建', status: cls.status, metrics, criterion: CRIT,
      verdict: '知识层空（crm.particles type=CRM_KNOWLEDGE 0 行）',
      fix: 'K 构建链路尚未产出知识',
    });
  }
  if (cls.kind === 'zero-vector') {
    return report({
      id: 'D1', name: '知识向量真伪', edge: 'K 构建', status: cls.status, metrics, criterion: CRIT,
      verdict: `${totalRows} 行知识**零向量**（embedding 全为 NULL）→ 语义检索不可用；与「知识层空」不同，须执行回填`,
      fix: 'EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --force-hash（先确认列已为 vector(1024)）',
    });
  }
  report({
    id: 'D1',
    name: '知识向量真伪',
    edge: 'K 构建',
    status: cls.status,
    metrics,
    criterion: CRIT,
    verdict: cls.kind === 'real'
      ? `真模型向量占 ${realPct}%（已嵌 ${total}/${totalRows} 行）`
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

  // 链路就绪（静态判据）：订阅器真的被 server 启动路径调用 —— 与 D2/D3 同范式，
  //   防「规则齐备但订阅器未接线」的二次假绿。
  const serverSrc = (() => {
    try { return fs.readFileSync(new URL('../src/http/server.js', import.meta.url), 'utf8'); } catch { return ''; }
  })();
  const subRegistered = /registerOutcomeIngester/.test(serverSrc);
  const rulesEnabled = num(rm.enabled);
  const linkReady = subRegistered && rulesEnabled > 0;

  report({
    id: 'D4',
    name: 'outcome 真实性',
    edge: '⑤ 结果→D',
    // 双指标正交拆分（2026-09-18）：原判据 `auto>0 ? PASS : FAIL` 把**两个正交维度**混为一谈 ——
    //   「链路是否接通」与「业务动作是否发生过」。链路就绪但业务未发生时误判为断链（假红）。
    //   现拆分：FAIL 只保留给**链路真断**（订阅器未接线 / 无启用规则）；
    //   链路就绪而回流量 0 → WARN（陈述事实，不冒充缺陷）。真实回流量始终独立暴露。
    status: !linkReady ? 'FAIL' : auto > 0 ? 'PASS' : 'WARN',
    metrics: {
      link_ready: linkReady,
      ingester_registered: subRegistered,
      outcome_total: total,
      real_auto: auto,
      manual: num(m.manual),
      seed_script: seed,
      other: num(m.other),
      event_rules: num(rm.n),
      event_rules_enabled: rulesEnabled,
      mapped_events_emitted_7d: mappedEmitted,
      event_emission_ok: mappedEmitted > 0,
    },
    criterion: "① 链路：订阅器 registerOutcomeIngester 须被 server 调用 且 启用规则 >0（否则 FAIL）；② 业务：source LIKE 'event:%' 为真实回流量（种子 seed-script 单独计数，不得混入）",
    verdict: !linkReady
      ? `链路断：${subRegistered ? '' : '订阅器未接线；'}${rulesEnabled > 0 ? '' : '无启用规则；'}→ 结果永不回流`
      : auto > 0
        ? `链路就绪；真自动回写 ${auto} 条（另有种子 ${seed} / 人工 ${num(m.manual)} 条）；映射事件近7天发射 ${mappedEmitted} 条`
        : `链路就绪（订阅器已接线 + 启用规则 ${rulesEnabled} 条），但真实回流量 0 → 业务动作（合同签署/商机归档/报价创建）尚未发生，非链路缺陷`,
    fix: "链路类：注册 registerOutcomeIngester / 补 emit('decision','outcome-set')。业务类：产生一次真实业务动作（或演练等价动作）以验证端到端回流",
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
// 噪声绝对量门（2026-09-18 双门判据）：占比高必须**同时**量级高才是风暴。
// 依据：实测 1494 行 ≈ 15 租户 × 50 owner × 2 条/日，属业务预期量级非风暴。
const NOISE_ROWS_GATE = 5000;

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
  // 双门判据（2026-09-18 修正）：原「占比>80% 即 FAIL」缺绝对量门 —— 正常业务量级
  //   （按 owner 逐人巡检的状态型信号）同样占比 65%+，被判噪声风暴属判据错配（假红）。
  //   真风暴 = 高占比 **且** 高绝对量；高占比但量级正常 → WARN（可优化提示，非故障）。
  const isStorm = topPct > 80 && total24 > NOISE_ROWS_GATE;
  report({
    id: 'D9',
    name: '噪声源排行(24h)',
    edge: 'M 构建',
    status: isStorm ? 'FAIL' : topPct > 50 ? 'WARN' : 'PASS',
    metrics: { rows_24h: total24, noise_rows_gate: NOISE_ROWS_GATE, top: top.event_type, top_n: num(top.n), top_pct: topPct, breakdown: Object.fromEntries(r.map((x) => [x.event_type, num(x.n)])) },
    criterion: `单一事件类型占比 >80% **且** 24h 总量 >${NOISE_ROWS_GATE} 才 FAIL（双门防正常量级误报）；占比 >50% 降级 WARN`,
    verdict: `24h 内 ${total24} 行（量门 ${NOISE_ROWS_GATE}），最大来源 ${top.event_type} ${num(top.n)} 行（${topPct}%）`
      + (isStorm ? ' → 高占比且高量级，判噪声风暴' : topPct > 50 ? ' → 高占比但量级正常，非风暴（可优化）' : ''),
    fix: '1) 状态型信号（带 dedup_key）按边沿写入记忆，避免每日重复；2) 针对 top 噪声源收紧 capture 白名单',
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
           count(*) FILTER (WHERE payload ? 'content' AND payload->>'kind' = ANY($1::text[])) AS both_ok,
           count(*) FILTER (WHERE payload ? 'content' OR payload->>'kind' = ANY($1::text[])) AS contract_scope,
           count(*) FILTER (WHERE payload->>'kind' = 'vocabulary' AND payload ? 'content') AS vocab_with_content
    FROM crm.particles WHERE type='CRM_KNOWLEDGE'`, [KINDS]);
  if (isErr(r)) return report({ id: 'D11', name: '知识投影契约', edge: 'K 构建', status: 'ERROR', metrics: {}, verdict: `查询失败: ${r.__error}` });
  const m = r[0] || {};
  const total = num(m.total);
  const ok = num(m.both_ok);
  // 分母修正（2026-09-18）：原分母取全部 CRM_KNOWLEDGE，把 43 条 `vocabulary` 本体登记物
  //   （payload 仅 kind/layer/term/type，设计上**不含** content）计入分母，使比率上限被
  //   结构性压至 16/69=23.19% ⇒ 判显 WARN 属**分母污染**（判据错配），非知识内容缺失。
  //   契约相关行 = 有 content **或** kind 属四大类。
  const scope = num(m.contract_scope);
  const vocabLeak = num(m.vocab_with_content);
  const p = pct(ok, scope);

  const kinds = await sql('D11b', `
    SELECT COALESCE(payload->>'kind','(null)') AS kind, count(*) AS n
    FROM crm.particles WHERE type='CRM_KNOWLEDGE' GROUP BY 1 ORDER BY 2 DESC`);
  const kindDist = isErr(kinds) ? {} : Object.fromEntries(kinds.map((x) => [x.kind, num(x.n)]));

  report({
    id: 'D11',
    name: '知识投影契约',
    edge: 'K 构建',
    // 反向断言先行（防「改分母造绿」）：vocabulary 本体登记物**不得**携带 content，
    //   一旦出现即说明本体层与业务知识层发生混写 → 直接 FAIL（不得只改分母）。
    status: vocabLeak > 0 ? 'FAIL' : scope === 0 ? 'WARN' : p >= 50 ? 'PASS' : p > 0 ? 'WARN' : 'FAIL',
    metrics: { knowledge_total: total, contract_scope: scope, has_content: num(m.has_content), kind_in_four: num(m.kind_in_four), both_ok: ok, match_pct: p, vocab_with_content: vocabLeak, kind_dist: kindDist },
    criterion: '分母=契约相关行（有 content 或 kind∈四大类）；同时满足两者比例 ≥50% PASS。反向断言：vocabulary 带 content >0 即报警',
    verdict: vocabLeak > 0
      ? `⛔ 反向断言触发：${vocabLeak} 条 vocabulary 本体登记物混入 content → 本体层与知识层混写`
      : scope === 0
        ? '无契约相关行'
        : p >= 50
          ? `${p}% 契约相关知识符合 LK 投影契约（${ok}/${scope}，全量 ${total} 条含 ${total - scope} 条本体登记物）`
          : `仅 ${p}% 契约相关知识能被 LK 正确投影（${ok}/${scope}）→ 修好消费端也只会拿到空壳`,
    fix: '统一知识写入契约（content 字段 + 四大类 kind）；本体登记物（vocabulary/transition）不得携带 content',
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

  // D1 三态鉴别自证（2026-09-18 新增）：
  // 实证背景 —— 本机执行 384→1024 幂等迁移后，69 行知识向量被按设计清空（待回填），
  //   探针把该状态报成「知识层空」，而 D3 同时报 knowledge=69 ⇒ 判据错配会误导处置方向。
  // 四态必须互不覆盖：0 行 / 有行但零向量 / 全 hash 伪向量 / 真向量为主。
  for (const c of [
    { totalRows: 0, embedded: 0, hash: 0, wantStatus: 'WARN', wantKind: 'empty-layer', label: '0 行知识 → 知识层空' },
    { totalRows: 69, embedded: 0, hash: 0, wantStatus: 'FAIL', wantKind: 'zero-vector', label: '69 行知识全零向量（迁移后待回填）→ 不得报"知识层空"' },
    { totalRows: 69, embedded: 69, hash: 69, wantStatus: 'FAIL', wantKind: 'hash-dominated', label: '69 行全 hash 伪向量 → 语义检索等于随机' },
    { totalRows: 69, embedded: 69, hash: 10, wantStatus: 'PASS', wantKind: 'real', label: '真向量占 85% → PASS' },
  ]) {
    const got = d1Classify({ totalRows: c.totalRows, embedded: c.embedded, hashCount: c.hash });
    cases.push({
      probe: 'D1',
      case: c.label,
      expect: `${c.wantStatus}/${c.wantKind}`,
      got: `${got.status}/${got.kind}`,
      ok: got.status === c.wantStatus && got.kind === c.wantKind,
    });
  }

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

  // ── 2026-09-18 新增判据的自证（成对：每个放宽都必须配一个收紧）────────────────

  // D11 反向断言自证：vocabulary 本体登记物**携带 content** 时必须被检出（防「改分母造绿」）
  const t11 = 'probe_selftest_d11_' + Date.now();
  await client.query(`CREATE TEMP TABLE ${t11}(payload jsonb)`);
  await client.query(`INSERT INTO ${t11} VALUES
    ('{"kind":"vocabulary","term":"x"}'::jsonb),
    ('{"kind":"icp","content":"y"}'::jsonb),
    ('{"kind":"vocabulary","content":"LEAK"}'::jsonb)`);
  const d11 = await client.query(`
    SELECT count(*) FILTER (WHERE payload ? 'content' OR payload->>'kind' = ANY($1::text[])) AS contract_scope,
           count(*) FILTER (WHERE payload ? 'content' AND payload->>'kind' = ANY($1::text[])) AS both_ok,
           count(*) FILTER (WHERE payload->>'kind'='vocabulary' AND payload ? 'content')       AS vocab_with_content
    FROM ${t11}`, [['icp', 'competitors', 'objections', 'buyer_language']]);
  const b11 = d11.rows[0] || {};
  cases.push({
    probe: 'D11',
    case: 'vocabulary 混入 content（本体层↔知识层混写）',
    expect: 'vocab_with_content=1 且非零分母(2)/合格(1) 计算正确',
    got: `vocab_with_content=${num(b11.vocab_with_content)}, contract_scope=${num(b11.contract_scope)}, both_ok=${num(b11.both_ok)}`,
    ok: num(b11.vocab_with_content) === 1 && num(b11.contract_scope) === 2 && num(b11.both_ok) === 1,
  });
  await client.query(`DROP TABLE ${t11}`);

  // D9 双门自证：占比与绝对量必须**同时**越界才判风暴（防正常量级误报）
  for (const c of [
    { rows: 3164, p: 65.46, storm: false, label: '高占比(65%)低量级(3164) → 非风暴' },
    { rows: 9000, p: 92.0, storm: true, label: '高占比(92%)高量级(9000) → 风暴' },
    { rows: 200, p: 30.0, storm: false, label: '低占比(30%) → 非风暴' },
  ]) {
    const isStorm = c.p > 80 && c.rows > NOISE_ROWS_GATE;
    cases.push({ probe: 'D9', case: c.label, expect: `风暴=${c.storm}`, got: `风暴=${isStorm}`, ok: isStorm === c.storm });
  }

  // D4 正交自证：链路断=FAIL / 链路通但无业务量=WARN / 有回流量=PASS
  for (const c of [
    { sub: false, rules: 1, auto: 0, want: 'FAIL', label: '订阅器未接线 → 链路断' },
    { sub: true, rules: 0, auto: 0, want: 'FAIL', label: '无启用规则 → 链路断' },
    { sub: true, rules: 1, auto: 0, want: 'WARN', label: '链路就绪但业务未发生' },
    { sub: true, rules: 1, auto: 3, want: 'PASS', label: '链路就绪且有回流' },
  ]) {
    const linkReady = Boolean(c.sub) && c.rules > 0;
    const st = !linkReady ? 'FAIL' : c.auto > 0 ? 'PASS' : 'WARN';
    cases.push({ probe: 'D4', case: c.label, expect: c.want, got: st, ok: st === c.want });
  }

  // D14 判据自证：凭据类 401/402/403 → FAIL；瞬态 429/5xx → WARN
  for (const c of [
    { http: 402, want: 'FAIL', label: '账户欠费 402' },
    { http: 401, want: 'FAIL', label: '鉴权失败 401' },
    { http: 429, want: 'WARN', label: '限流 429（瞬态）' },
    { http: 503, want: 'WARN', label: '服务不可用 503（瞬态）' },
  ]) {
    const st = AUTH_FAIL_STATUS.has(c.http) ? 'FAIL' : 'WARN';
    cases.push({ probe: 'D14', case: c.label, expect: `判为 ${c.want}`, got: `判为 ${st}`, ok: st === c.want });
  }

  // D15 判据自证：「消费面可调用」不等于「可召回」—— 必须能区分五种形态，
  //   尤其"库中有实体却召不回"与"仅名称归位可用"不得被报成绿（2026-09-18 实况即前者恒绿）
  for (const c of [
    { error: null, missingL1: true, hit: false, semantic: false, want: 'FAIL', label: 'L1 被装配层判 missing（维度错/超时被 catch 吞）→ 不得报绿' },
    { error: null, missingL1: false, hit: false, semantic: true, want: 'FAIL', label: '实体确实存在却召不回 → FAIL' },
    { error: null, missingL1: false, hit: true, semantic: false, want: 'WARN', label: '仅名称归位可用（查询侧向量与列不同维）→ WARN 暴露语义召回静默丢失' },
    { error: null, missingL1: false, hit: true, semantic: true, want: 'PASS', label: '语义召回可用且命中实体 → PASS' },
    { error: 'boom', missingL1: false, hit: true, semantic: true, want: 'ERROR', label: '消费面抛错 → ERROR（不得因"有行"报绿）' },
  ]) {
    const got = d15Classify(c);
    cases.push({ probe: 'D15', case: c.label, expect: c.want, got: got.status, ok: got.status === c.want });
  }

  for (const c of cases) console.log(`  ${c.ok ? '🟢' : '🔴'} ${c.probe} ${c.case}\n     期望: ${c.expect}\n     实测: ${c.got}`);
  const bad = cases.filter((c) => !c.ok).length;
  console.log(`\n自检结论: ${cases.length - bad}/${cases.length} 通过${bad ? ` — ${bad} 条探针判据有缺陷，需修探针` : '（探针具备鉴别力）'}`);
}

// ════════════════════════════════════════════════════════════════════════════
// D14 — 外部依赖凭据活性（embedding / SMTP）
// 背景（2026-09-18 实证）：原 13 条探针**全部为内部数据面**探针，无一条检查外部依赖，
//   导致 SiliconFlow 账户欠费（HTTP 402）使 embedding 写入全面静默降级（写 NULL）
//   而无人知晓 —— 存量向量仍绿、"写入能力"已死，属探针体系的**结构性盲区**。
// 判据：embedding 须**实测可调用**；凭据/余额类失败（401/402/403）→ FAIL（持久性故障）；
//   瞬态（429/5xx/网络）→ WARN；SMTP 三要素须齐备。
// 只读：不写业务表；成功时仅 1 次约 10 token 的外部调用 + 一条计量记录。
// ════════════════════════════════════════════════════════════════════════════
const AUTH_FAIL_STATUS = new Set([401, 402, 403]);

async function probeD14() {
  const metrics = { embedding: 'skip', embedding_detail: '', smtp_configured: false };
  const reasons = [];
  let status = 'PASS';

  // 1) embedding —— K 构建链路的真实供给能力
  try {
    const { embed } = await import('../src/llm/embeddingClient.js');
    const v = await embed('kmd-probe-credential-liveness');
    if (Array.isArray(v) && v.length) {
      metrics.embedding = `ok(dim=${v.length})`;
    } else {
      metrics.embedding = 'empty-vector';
      status = 'FAIL';
      reasons.push('embedding 返回空向量');
    }
  } catch (e) {
    const st = e?.httpStatus ?? null;
    metrics.embedding = st ? `http-${st}` : 'error';
    metrics.embedding_detail = String(e?.message || e).slice(0, 200);
    if (st && AUTH_FAIL_STATUS.has(st)) {
      status = 'FAIL';
      reasons.push(`embedding 凭据失效（HTTP ${st}）：新知识粒子向量将全部静默降级为 NULL`);
    } else {
      status = 'WARN';
      reasons.push(`embedding 调用异常（${metrics.embedding}），疑瞬态`);
    }
  }

  // 2) SMTP —— 邮件/激活通道供给（脚本自身未加载 .env，此处显式加载；dotenv 不覆盖已有 env）
  try { const dotenv = await import('dotenv'); dotenv.config({ path: path.join(ROOT, '.env') }); } catch { /* 无 dotenv 不阻断 */ }
  metrics.smtp_configured = Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
  if (!metrics.smtp_configured) {
    if (status === 'PASS') status = 'WARN';
    reasons.push('SMTP 三要素未齐备（邮件通道不可用）');
  }

  report({
    id: 'D14',
    name: '外部依赖活性',
    edge: 'K 构建',
    status,
    metrics,
    criterion: 'embedding 须实测可调用：凭据/余额类失败（401/402/403）→ FAIL；瞬态（429/5xx/网络）→ WARN。SMTP 三要素须齐备',
    verdict: reasons.length ? reasons.join('；') : `embedding 可用（${metrics.embedding}）且 SMTP 已配置`,
    fix: 'embedding 凭据类失效属付费资源/密钥问题（非代码缺陷）：充值或更换 provider 后重跑本探针；拒因已由 embeddingClient 回传服务端原话',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// D15 — L1 消费面端到端可达（「数据健康 ≠ 可被检索」）
//
// 背景（2026-09-18 实证）：D1 判「向量真伪」、D3 判「池子构成/大小」，**全部只看存储面**。
//   当日实况：D1 已 🟢（真向量 100%）、池 995 行，而 L1 召回**恒抛**
//   `different vector dimensions 1024 and 384`（查询侧 hashVector(384) 对 vector(1024) 列，
//   assembler.js 写侧改了、读侧没改的半改形态）；该异常被 assembleContext 的
//   `catch { missing.L1 = true }` 吞掉 ⇒ 端到端一条实体都召不回，而全部探针恒绿。
//   ⇒ 必须有一条探针**调用真实消费函数**（import assembleContext），否则
//     「存了真向量但无人能查」这一形态在探针体系里不可测。
//
// 判据：装配不抛错 + 能召回库中**真实存在**的实体名（不看「函数被调用/返回 200」这类过程指标）。
// 同源性：探针独立进程不走 server.js bootstrap ⇒ 显式调用同一个 ensureEmbeddingProvider()；
//   若探针各写一份 provider 判据，它看到的世界 ≠ 运行时（判据分叉），结论对运行时无效。
// ════════════════════════════════════════════════════════════════════════════

// D15 状态分类（纯函数：探针与自检共用 —— 判据必须可被反例证伪）
//   call-error          消费面调用抛错                                → ERROR
//   layer-missing       装配层判定 L1 失效（异常/超时被 catch 吞掉） → FAIL
//   entity-unreachable  实体确实存在却召不回                          → FAIL
//   name-only           仅名称归位可用（查询侧向量与列不同维）        → WARN（语义召回静默丢失）
//   semantic            语义召回可用且命中实体                        → PASS
function d15Classify({ error = null, missingL1 = false, hit = false, semantic = false } = {}) {
  if (error) return { status: 'ERROR', kind: 'call-error' };
  if (missingL1) return { status: 'FAIL', kind: 'layer-missing' };
  if (!hit) return { status: 'FAIL', kind: 'entity-unreachable' };
  return semantic ? { status: 'PASS', kind: 'semantic' } : { status: 'WARN', kind: 'name-only' };
}

async function probeD15() {
  // 取一条**名称不含空白**的实体：装配层归位按空白分词后做整名精确匹配，含空白名称会被拆开
  //   （既有分词语义，非缺陷）⇒ 探针须选可判定样本，否则测到的是分词而非链路
  const pick = await sql('D15a', `
    SELECT p.type, p.payload->>'name' AS name
      FROM crm.particles p
     WHERE p.type IN ('CRM_ACCOUNT','CRM_DEAL','CRM_CONTACT')
       AND coalesce(p.payload->>'name','') <> ''
       AND p.payload->>'name' !~ '\\s'
     ORDER BY (p.embedding IS NOT NULL) DESC, p.updated_at DESC
     LIMIT 1`);
  const criterion = '以库中真实实体名做一次真实装配（assembleContext）：装配不抛错 + L1 命中该实体 ⇒ PASS；'
    + '仅名称归位可用（查询侧向量与存储列不同维）⇒ WARN；missing.L1 或召不回已存在实体 ⇒ FAIL';
  if (isErr(pick) || !pick.length) {
    return report({
      id: 'D15', name: 'L1 消费面可达', edge: '④ 上下文注入', status: 'WARN', metrics: {},
      criterion,
      verdict: '库内无 CRM_ACCOUNT/CRM_DEAL/CRM_CONTACT 名称（无可判定样本）→ 消费面无法验证',
      fix: '灌入至少一条带 name 的实体粒子后重跑本探针',
    });
  }
  const name = String(pick[0].name);
  const pool = await sql('D15b', `SELECT count(*) AS n FROM crm.particles WHERE embedding IS NOT NULL`);
  const metrics = {
    probe_entity: name,
    l1_pool: isErr(pool) ? -1 : num(pool[0]?.n),
    provider: '(未解析)',
    query_side_dim: null,
    expect_dim: null,
    l1_rows: 0,
    hit: false,
    missing_L1: false,
  };
  let error = null;
  let semantic = false;
  try {
    const { ensureEmbeddingProvider } = await import('../src/llm/embeddingBootstrap.js');
    metrics.provider = (await ensureEmbeddingProvider()) ?? '(未启用)';
    const { embedText, STORED_EMBED_DIM } = await import('../src/ontology/embedding.js');
    metrics.expect_dim = STORED_EMBED_DIM;
    // 查询侧自证：探针亲自拿一次查询向量，才能区分「召不回」是链路断还是查询向量与列不同维
    const ev = await embedText(name).catch((e) => ({ provider: 'error', error: String(e?.message || e) }));
    metrics.query_side_dim = Array.isArray(ev?.vector) ? ev.vector.length : null;
    semantic = ev?.provider === 'model' && metrics.query_side_dim === STORED_EMBED_DIM;
    const { assembleContext } = await import('../src/context/assembler.js');
    const r = await assembleContext({ actor: 'presales', intent: { scenario: 'OPP_QUALIFY' }, query: name });
    metrics.missing_L1 = !!r?.missing?.L1;
    metrics.l1_rows = (r?.layers?.L1 || []).length;
    metrics.hit = (r?.layers?.L1 || []).some((x) => x.title === name);
  } catch (e) {
    error = String(e?.message || e).slice(0, 200);
    metrics.error = error;
  }

  const got = d15Classify({ error, missingL1: metrics.missing_L1, hit: metrics.hit, semantic });
  const VERDICT = {
    'call-error': `消费面调用异常：${error}`,
    'layer-missing': `装配层判定 L1 失效（missing.L1=true）→ 已存在实体「${name}」端到端召不回（异常被 catch 吞掉即此形态）`,
    'entity-unreachable': `库中存在实体「${name}」但 L1 未召回（返回 ${metrics.l1_rows} 行）→ 消费面断裂`,
    'name-only': `名称归位可用，但**语义召回不可用**（查询侧 provider=${metrics.provider} dim=${metrics.query_side_dim} ≠ 存储 ${metrics.expect_dim}）→ 向量存了却无人能查`,
    semantic: `L1 端到端可达：以「${name}」查询命中（L1 ${metrics.l1_rows} 行，语义召回可用）`,
  };
  report({
    id: 'D15',
    name: 'L1 消费面可达',
    edge: '④ 上下文注入',
    status: got.status,
    metrics,
    criterion,
    verdict: VERDICT[got.kind],
    fix: '查询侧向量须与存储列同源同维（src/ontology/embedding.js:STORED_EMBED_DIM + assembler.js:l1QueryVector）；'
      + '名称精确归位是兜底，**不得**以 embedding IS NOT NULL 为门',
  });
}

// ════════════════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════════════════
const PROBES = { D0: probeD0, D1: probeD1, D2: probeD2, D3: probeD3, D4: probeD4, D5: probeD5, D6: probeD6, D7: probeD7, D8: probeD8, D9: probeD9, D10: probeD10, D11: probeD11, D12: probeD12, D13: probeD13, D14: probeD14, D15: probeD15, E2E: probeE2E };

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
    if (id === 'D14' && NO_EXTERNAL) { report({ id, name: '外部依赖活性', edge: 'K 构建', status: 'SKIP', metrics: {}, verdict: '--no-external 跳过（离线/CI 场景）' }); continue; }
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
