// src/decision/provenance.js — C4 审计链：SHA-256 校验和链 + 篡改校验 + 审计导出
// 设计输入：docs/superpowers/specs/2026-08-26-semantica-decision-network-monitoring-design.md §4.3/§5.1-C4/§6.2
// 纪律：decision_provenance 为 append-only（不做物理删除；擦除用 invalidated 墓碑标记，对齐 Semantica never hard delete）
// 链序：以 id BIGSERIAL 自然递增保证稳定有序（非 chain_seq 列；Task 1 DDL 落地现状已对齐）。
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { createHash } from 'crypto';

// 幂等建表（设计 §4.3 DDL，含校验和链字段；外键指向 crm.decision 保证决策链不孤儿）
export async function ensureProvenanceSchema() {
  await query(`CREATE TABLE IF NOT EXISTS crm.decision_provenance (
    id BIGSERIAL PRIMARY KEY,
    decision_id UUID NOT NULL REFERENCES crm.decision(decision_id),
    entry_type text NOT NULL,        -- entity / decision / relationship / property
    payload jsonb NOT NULL,          -- 当时全字段（决策 7 点/边/来源）
    source text,                     -- 来源（粒子/事件/Agent）
    activity_id text,                -- 产生它的流程
    checksum text NOT NULL,          -- SHA-256（含 previous_checksum 链式）
    previous_checksum text,          -- 前一条校验和（链式防篡改）
    invalidated boolean DEFAULT false, -- 墓碑标记（擦除不物理删除）
    created_at timestamptz DEFAULT now()
  )`);
  // 兼容补列（铁律：CREATE TABLE IF NOT EXISTS 不补列，新增列必须走 ALTER）。
  //   上面这段 CREATE 是历史遗留的旧版 DDL，缺两列；在「表已由迁移建好」的环境里 IF NOT EXISTS 会静默跳过，
  //   缺陷长期不可见——但一旦表被重建（新库 / 被 DROP），就会静默产出一个残表，
  //   表现为 verifyChain 报 "column archived does not exist"、哈希代次恒为 1（v2 白名单形同虚设）。
  //   2026-09-03 实测：DROP TABLE 后重建即复现，故在此补齐，与 db/schema.sql:632 对齐。
  await query(`ALTER TABLE crm.decision_provenance ADD COLUMN IF NOT EXISTS archived BOOLEAN DEFAULT false`);
  await query(`ALTER TABLE crm.decision_provenance ADD COLUMN IF NOT EXISTS hash_version INT NOT NULL DEFAULT 1`);
  await query(`CREATE INDEX IF NOT EXISTS idx_crm_decision_provenance_decision ON crm.decision_provenance(decision_id)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_crm_decision_provenance_hv ON crm.decision_provenance(hash_version)`);
}

// ───────────────────── SHA-256 校验和链 ─────────────────────
// canonical：深度键排序序列化（避免 pg jsonb 返回键序不稳定导致 verifyChain 误报 TAMPERED）
// 详见计划 Self-Review 瑕疵 2：原 JSON.stringify(payload) 在 jsonb 往返后键序可能变化 → 改用深度排序键
function sortKeys(o) {
  if (Array.isArray(o)) return o.map(sortKeys);
  if (o && typeof o === 'object') {
    return Object.keys(o).sort().reduce((a, k) => { a[k] = sortKeys(o[k]); return a; }, {});
  }
  return o;
}
function canonical(o) { return JSON.stringify(sortKeys(o)); }

// ───────────────────── 哈希白名单（T1，分代兼容） ─────────────────────
// 白名单设计对齐 Semantica integrity.py:45-51「哪些字段不进哈希」的教训：
//   纳入 = 身份(decision_id/entry_type/source/activity_id) + 语义(payload) + 墓碑(invalidated/archived)。
//     理由：v1 只哈希 payload 时，把某条审计记录的 entry_type 由 'decision' 改成 'entity'、
//          或把 invalidated 墓碑翻转，链校验完全无感 —— 墓碑可任意翻转而不触发 TAMPERED。
//   排除 = id / created_at。
//     理由：id 由 BIGSERIAL 自增、created_at 由 now() 生成，二者「读回重算」必然与原值一致
//          （无篡改检出价值），却会让「重建行」这类合法操作极易误判为 TAMPERED。
//          与 Semantica 故意排除 entity_id（版本化会重命名存档 X → X:v:...）同源考量。
export const HASH_VERSION = 2;
export const HASH_FIELDS = ['decision_id', 'entry_type', 'payload', 'source', 'activity_id', 'invalidated', 'archived'];

function pickHashFields(entry = {}) {
  const out = {};
  for (const k of HASH_FIELDS) out[k] = k in entry ? entry[k] : null;
  return out;
}

// v2：白名单哈希（新增，供 trackEntry 使用）
export function shaChainEntry(entry, previousChecksum, { version = HASH_VERSION } = {}) {
  const h = createHash('sha256');
  h.update(`v${version}|`);
  h.update((previousChecksum || '') + '|');
  h.update(canonical(pickHashFields(entry)));
  return h.digest('hex');
}

// v1：仅 payload（保留，供历史行校验与老调用方；签名语义不变）
export function shaChain(payload, previousChecksum) {
  const h = createHash('sha256');
  h.update((previousChecksum || '') + '|' + canonical(payload));
  return h.digest('hex');
}

// 按行代次分派算法：hash_version>=2 走白名单，否则走 v1（历史行不因算法升级而失效）
function hashOf(row, previousChecksum) {
  return Number(row?.hash_version || 1) >= 2
    ? shaChainEntry(row, previousChecksum, { version: Number(row.hash_version) })
    : shaChain(row.payload, previousChecksum);
}

// 追写一条审计条目并串接校验和链（append-only；擦除用 invalidated 而非 DELETE）
export async function trackEntry({ decision_id, entry_type, payload, source = null, activity_id = null }) {
  // 取同决策上一条（id 最大者）的 checksum 作为 previous（若有）
  const prev = (await query(
    `SELECT checksum FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id DESC LIMIT 1`,
    [decision_id]
  )).rows[0];
  const previous_checksum = prev ? prev.checksum : null;
  // v2：把身份/墓碑字段一并送进哈希（对象形态，字段由 pickHashFields 白名单裁剪）
  // 注意 previous_checksum 必须显式传入——漏传则每条都按 null 计算，第 1 条恰好正确、第 2 条起全链错（测试已锁死此回归）
  const checksum = shaChainEntry(
    { decision_id, entry_type, payload, source, activity_id, invalidated: false, archived: false },
    previous_checksum
  );
  const r = await queryWrite(
    `INSERT INTO crm.decision_provenance
       (decision_id, entry_type, payload, source, activity_id, checksum, previous_checksum, hash_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [decision_id, entry_type, JSON.stringify(payload), source, activity_id, checksum, previous_checksum, HASH_VERSION]
  );
  // 写时自检（fail-open）：仅留痕，不阻断主写。失败/异常链会在定时巡检中再次暴露。
  // VITEST 护栏（同 decision-agent 派发护栏）：后台查询与测试 TRUNCATE / afterEach 回写存在竞态，
  //   会读到中间态并写出虚假 violation 污染 monitor_event；测试改为直接 await verifyTail() 验证行为。
  if (!process.env.VITEST) {
    verifyTail({ decision_id })
      .then((v) => {
        if (v.status !== 'OK' && v.status !== 'EMPTY') {
          // 同 patrolChains：走 decision 域以便 monitor_event 落库留痕（trace 域不落库）
          emit('decision', 'provenance-tail-violation', { decision_id, status: v.status, broken_at: v.broken_at || null });
          recordFailure('provenance-tail-violation', new Error(`tail ${v.status} decision=${decision_id}`));
        }
      })
      .catch((e) => {
        emit('trace', 'provenance-tail-check-failed', { decision_id, error: String(e?.message || e) });
        recordFailure('provenance-tail-check-failed', e);
      });
  }
  return r.rows[0];
}

// 重算整链校验和，逐项比对。
// 检出四类状态：
//   TAMPERED    内容或链序不符（含 v1/v2 按行分派后任一算法不匹配）
//   FORKED      同 previous_checksum 出现多条 → 并发写入分叉（trackEntry 无锁无 seq 的固有风险）
//   BROKEN_HEAD 首条 previous_checksum 非空 → 链头被删
//   OK
export async function verifyChain({ decision_id }) {
  const rows = (await query(
    `SELECT id, decision_id, entry_type, payload, source, activity_id, invalidated, archived,
            checksum, previous_checksum, hash_version
     FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id`,
    [decision_id]
  )).rows;
  // ── 分叉检测必须「先于」链序遍历（2026-09-03 修正）──────────────────────────────
  // 原实现把 FORKED 判据写在遍历内部（「当前行 previous 已出现过」），是**死代码**：
  //   遍历时 prev 已被前一条的 checksum 更新，两条同 previous_checksum 的兄弟行中，
  //   第二条必然先命中 `row.previous_checksum !== prev` 而返回 TAMPERED，永远走不到 FORKED。
  //   语义也不对：分叉 = 「同一个父有多个子」，与遍历顺序无关，应做全局计数而非顺序比对。
  // 定位 broken_at = 第二条的 id（即分叉点）。
  const childrenOf = new Map();
  for (const row of rows) {
    if (!row.previous_checksum) continue;
    const n = (childrenOf.get(row.previous_checksum) || 0) + 1;
    childrenOf.set(row.previous_checksum, n);
    if (n > 1) return { status: 'FORKED', broken_at: row.id, entries: rows.length };
  }
  let prev = null;
  for (const row of rows) {
    // entries 在所有分支都返回（= 本次扫描到的实际行数）：
    //   巡检封印比对需要它做「条目变少 = 链尾被删」判据，异常分支给 undefined 会让封印写入 0 污染基准
    if (row.previous_checksum !== prev) {
      // 首条即非空 previous → 链头被删；否则为链序断裂
      return { status: prev === null && row.previous_checksum ? 'BROKEN_HEAD' : 'TAMPERED', broken_at: row.id, entries: rows.length };
    }
    if (hashOf(row, prev) !== row.checksum) return { status: 'TAMPERED', broken_at: row.id, entries: rows.length };
    prev = row.checksum;
  }
  return { status: 'OK', entries: rows.length, head: prev };
}

// ───────────────────── T2 写时自检 + 定时巡检（2026-09-03） ─────────────────────
// 背景：verifyChain 此前只在「人导出审计报告 / 可审计性评估」时被调用，篡改可能长期无人发现。
// 两层常态化：trackEntry 后 O(1) 链尾自检（立即留痕）+ patrolChains 定时全量重算 + 封印比对。

// 写时自检：只校验链尾两条（O(1)，不重算全链）。
// 价值：检出自本次写入起的链断裂（含并发分叉导致的 previous 错位），失败必须留痕（禁静默吞错）。
export async function verifyTail({ decision_id }) {
  const rows = (await query(
    `SELECT id, decision_id, entry_type, payload, source, activity_id, invalidated, archived,
            checksum, previous_checksum, hash_version
     FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id DESC LIMIT 2`,
    [decision_id]
  )).rows;
  const cur = rows[0];
  if (!cur) return { status: 'EMPTY', entries: 0 };
  const prev = rows[1];
  // 分叉检测（同父多子）：一次索引计数，仍是常数级开销。
  //   与 verifyChain 同源判据——放在链序比对之前，否则会被「previous 不匹配」抢先判成 TAMPERED。
  if (cur.previous_checksum) {
    const dup = (await query(
      `SELECT count(*)::int AS n FROM crm.decision_provenance WHERE decision_id=$1 AND previous_checksum=$2`,
      [decision_id, cur.previous_checksum]
    )).rows[0]?.n || 0;
    if (dup > 1) return { status: 'FORKED', broken_at: cur.id, entries: rows.length };
  }
  if ((cur.previous_checksum || null) !== (prev ? prev.checksum : null)) {
    return { status: prev ? 'TAMPERED' : 'BROKEN_HEAD', broken_at: cur.id, entries: rows.length };
  }
  if (hashOf(cur, prev ? prev.checksum : null) !== cur.checksum) {
    return { status: 'TAMPERED', broken_at: cur.id, entries: rows.length };
  }
  return { status: 'OK', entries: rows.length, head: cur.checksum };
}

// 封印表（provenance_seal）幂等建表：巡检自持，避免巡检跑在无迁移的环境里静默失败。
// DDL 单一事实源仍是 db/migration-decision-integrity.sql，此处仅为兼容补建（IF NOT EXISTS）。
async function ensureSealSchema() {
  await query(`CREATE TABLE IF NOT EXISTS crm.provenance_seal (
    decision_id   UUID PRIMARY KEY,
    head_checksum TEXT,
    entry_count   INT NOT NULL DEFAULT 0,
    sealed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_status   TEXT
  )`);
}

// 定时巡检：全量重算 + 封印比对（补哈希链「删链尾不可检出」的固有盲区）。
//   盲区说明：哈希链只能校验「存在的前后关系」。删掉链尾后，新链尾的 previous 仍指向已删行的前驱，
//   全链重算依旧自洽 → 纯哈希链永远检不出「截尾」。封印记录上次良好状态的 (head, count) 才能暴露它。
//   seal 比对规则（仅在链本身 OK 时才有意义——链已断时直接按链状态告警）：
//     entries < seal.entry_count                          → HEAD_LOST（条目变少 = 链尾被删）
//     entries == seal.entry_count 但 head 变了             → TAMPERED（就地篡改后重算出自洽哈希）
//   封印更新策略：仅 status==='OK' 时刷新 head/entry_count（脏状态不污染基准），
//                last_status/sealed_at 每次都刷新（反映最近一次巡检结论）。
// decisionIds：指定则只巡检这些链（供「立即校验此决策链」与测试精确断言；为空则按 limit 全量扫）
// tenantId（T11，P2）：指定则只巡检该租户的链（decision_provenance 经 decision 表联查租户），
//   默认 undefined 保持全表巡检（平台治理面，向后兼容）
export async function patrolChains({ limit = 200, decisionIds = null, tenantId = null } = {}) {
  await ensureSealSchema();
  const ids = Array.isArray(decisionIds) && decisionIds.length
    ? decisionIds
    : (await query(
        tenantId
          ? `SELECT DISTINCT p.decision_id
             FROM crm.decision_provenance p JOIN crm.decision d ON d.decision_id = p.decision_id
             WHERE d.tenant_id=$1
             ORDER BY p.decision_id LIMIT $2`
          : `SELECT DISTINCT decision_id FROM crm.decision_provenance
             ORDER BY decision_id LIMIT $1`,
        tenantId ? [tenantId, limit] : [limit]
      )).rows.map((r) => r.decision_id);
  const results = { scanned: ids.length, ok: 0, tampered: 0, forked: 0, head_lost: 0, sealed: 0 };
  for (const decision_id of ids) {
    let v;
    try {
      v = await verifyChain({ decision_id });
    } catch (e) {
      emit('trace', 'provenance-patrol-error', { decision_id, error: String(e?.message || e) });
      recordFailure('provenance-patrol-error', e);
      continue;
    }
    const seal = (await query(
      `SELECT head_checksum, entry_count FROM crm.provenance_seal WHERE decision_id=$1`, [decision_id]
    )).rows[0];
    let status = v.status;
    if (status === 'OK' && seal) {
      if (v.entries < Number(seal.entry_count)) status = 'HEAD_LOST';
      else if (seal.head_checksum && v.head !== seal.head_checksum && v.entries === Number(seal.entry_count)) status = 'TAMPERED';
    }
    if (status === 'OK') results.ok++;
    else if (status === 'FORKED') results.forked++;
    else if (status === 'HEAD_LOST') results.head_lost++;
    else results.tampered++;
    if (status !== 'OK') {
      // 事件域刻意用 'decision' 而非 'trace'：monitorSubscriber.js:32 只落库 decision 域，
      //   trace 域仅 SSE 推送 + recordFailure 内存计数 → 事后无法证明「曾经检出过篡改」，治理留痕断裂。
      //   审计链违规本就是决策域事件，落 monitor_event 后 decision_id 列自动填充，可回溯。
      emit('decision', 'provenance-chain-violation', { decision_id, status, entries: v.entries, broken_at: v.broken_at || null });
      recordFailure('provenance-chain-violation', new Error(`chain ${status} @${v.broken_at || '-'} decision=${decision_id}`));
    }
    const isOk = status === 'OK';
    await queryWrite(
      `INSERT INTO crm.provenance_seal (decision_id, head_checksum, entry_count, sealed_at, last_status)
       VALUES ($1,$2,$3, now(), $4)
       ON CONFLICT (decision_id) DO UPDATE SET
         head_checksum = CASE WHEN $5::boolean THEN EXCLUDED.head_checksum ELSE crm.provenance_seal.head_checksum END,
         entry_count   = CASE WHEN $5::boolean THEN EXCLUDED.entry_count   ELSE crm.provenance_seal.entry_count   END,
         sealed_at = now(), last_status = EXCLUDED.last_status`,
      [decision_id, v.head || null, v.entries || 0, status, isOk]
    );
    results.sealed++;
  }
  return results;
}

// 审计导出依赖 AGE 图（失败仅降级，不阻断导出）
async function getTrace(id) {
  const age = await import('./ageGraph.js');
  await age.ensureGraph();
  return {
    upstream: await age.traceUpstream(id, { maxDepth: 3 }),
    downstream: await age.traceDownstream(id, { maxDepth: 3 }),
  };
}

// ───────────────────── G3 PROV-O 标准导出 + 归档分级 ─────────────────────
// 测试计划 §5.2：exportTurtle 产出 W3C PROV-O Turtle（entity/activity/agent 三元组）；
// applyArchival 软归档（archived 标记，不做物理删除，对齐 Semantica never hard delete）。

// 幂等补 archived 列（既有库无此列，ALTER IF NOT EXISTS 兼容老表）
async function ensureArchivedColumn() {
  await query(`ALTER TABLE crm.decision_provenance ADD COLUMN IF NOT EXISTS archived boolean DEFAULT false`);
}

// PROV-O Turtle：决策=prov:Entity，引擎=prov:Agent（wasAttributedTo），审计条目=prov:Activity
export function exportTurtle({ decision_id, decision = null, entries = [], chainStatus = 'OK' }) {
  const L = [];
  L.push('@prefix prov: <http://www.w3.org/ns/prov#>.');
  L.push('@prefix crm:  <http://localhost:3000/crm#>.');
  L.push('');
  L.push(`crm:decision_${decision_id} a prov:Entity ;`);
  L.push(`    prov:wasAttributedTo crm:agent_engine ;`);
  L.push(`    prov:generatedAtTime "${decision?.created_at || new Date().toISOString()}" .`);
  L.push('');
  L.push(`crm:agent_engine a prov:Agent .`);
  L.push('');
  for (const e of (entries || [])) {
    L.push(`crm:entry_${e.id}_${e.entry_type} a prov:Activity ;`);
    L.push(`    prov:used crm:decision_${decision_id} ;`);
    L.push(`    crm:type "${e.entry_type}" .`);
    L.push('');
  }
  L.push(`# chain status: ${chainStatus}`);
  return L.join('\n');
}

// 归档分级：超过 retentionDays 的 entry 软标记 archived（行保留，链不断）
export async function applyArchival({ decision_id, retentionDays = 365 }) {
  await ensureArchivedColumn();
  const r = await queryWrite(
    `UPDATE crm.decision_provenance SET archived=true
     WHERE decision_id=$1 AND archived IS NOT true
       AND created_at < now() - make_interval(days => $2)`,
    [decision_id, retentionDays]
  );
  return { archived: r.rowCount || 0 };
}

// 审计导出：7 点 + 上游因果链 + 下游影响 + 先例 + 校验和状态
export async function exportAudit({ decision_id }) {
  const d = (await query(`SELECT * FROM crm.decision WHERE decision_id=$1`, [decision_id])).rows[0];
  const precs = (await query(
    `SELECT precedent_id, similarity FROM crm.decision_precedent_rel WHERE decision_id=$1`,
    [decision_id]
  )).rows;
  const chain = await verifyChain({ decision_id });
  const trace = await getTrace(decision_id).catch(() => ({ upstream: [], downstream: [] }));
  const entries = (await query(
    `SELECT entry_type, payload, checksum, previous_checksum, created_at FROM crm.decision_provenance WHERE decision_id=$1 ORDER BY id`,
    [decision_id]
  )).rows;
  return {
    decision_id,
    decision: d || null,
    referenced_precedents: precs,
    upstream: trace.upstream,
    downstream: trace.downstream,
    chainStatus: chain.status,
    entries,
  };
}
