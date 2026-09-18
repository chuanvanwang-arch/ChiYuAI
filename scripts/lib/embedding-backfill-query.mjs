// scripts/lib/embedding-backfill-query.mjs
// D1 回填的**候选筛选**与**陈旧度判据**（纯函数、无副作用、不连库）——供脚本与单测共用。
//
// 背景（2026-09-18 实证）：
//   原实现只筛 `embedding IS NULL` ⇒ 本机 69 条 hash 伪向量（embedding **非 NULL**，
//   是 384 桶 SHA-256 签名）永远不进候选，脚本 candidate=0 仍打印 `done ok=0 skip=0`
//   并以 0 退出 —— 存量假向量因此**永不自愈且无任何告警**。
//   形态归类：不是「判据没跑」，而是「筛选条件与缺陷形态错配」的隐性缺口
//   （分母/流程都正确，唯谓词覆盖不到缺陷的那个子集）。
//
// 判据与 KMD 探针 D1 **完全同源**（同一谓词，防脚本与探针口径分叉导致互不承认）：
//   hashVector = SHA-256 的 32 字节映射到 384 桶（src/ontology/embedding.js:8-17）→
//     (a) 分量值恒 ≥ 0（(h[i] % 251)/251 非负）；(b) 非零维 ≤ 32（真模型向量近乎全维非零）
//   两者同时成立 → 判定为 hash 伪向量。

/** hash 伪向量的 SQL 指纹（依赖 LATERAL 子查询的别名 h.minv / h.nz）。 */
export const HASH_FINGERPRINT_SQL =
  '(p.embedding IS NOT NULL AND coalesce(h.minv, 0) >= 0 AND coalesce(h.nz, 0) <= 32)';

/** 逐行解析 embedding 文本 → (最小值, 非零维数)；供指纹判据使用。 */
export const EMBED_STATS_LATERAL = `LEFT JOIN LATERAL (
      SELECT min(t.x::float8)                        AS minv,
             count(*) FILTER (WHERE t.x::float8 <> 0) AS nz
        FROM regexp_split_to_table(
               substring(p.embedding::text, 2, length(p.embedding::text) - 2), ','
             ) AS t(x)
    ) h ON true`;

/** 声明基线维度（与 db/schema.sql 的 vector(1024)、EMBEDDING_MODEL=BAAI/bge-large-zh-v1.5 一致）。 */
export const REQUIRED_EMBED_DIM = 1024;

/** 默认回填范围：仅知识粒子（D1 关注面）。'all' = 全部类型。 */
export const DEFAULT_BACKFILL_TYPES = ['CRM_KNOWLEDGE'];

/**
 * 解析 --types 参数：'all' → 'all'；'A,B' → ['A','B']；缺省 → DEFAULT_BACKFILL_TYPES。
 * 背景（2026-09-18 实证）：384→1024 迁移的 USING NULL 会清空**全部类型**的 history 向量，
 *   而回填只覆盖 CRM_KNOWLEDGE ⇒ 其他类型的 L1 检索池静默塌陷（D3 池 447→72）。
 *   分成开关后，「只补知识」与「恢复全池」是两条显式选择的路径，不再靠默认值隐含。
 */
export function parseTypes(arg) {
  if (!arg) return DEFAULT_BACKFILL_TYPES;
  const s = String(arg).trim();
  if (!s || s === 'all') return 'all';
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * 候选集的 WHERE 片段。
 * @param {object} o
 * @param {boolean} [o.forceHash] true → 除 NULL 外**同时**收纳 hash 伪向量（存量自愈）。
 *                                 false → 仅 NULL（原行为，等价于「只补新写的缺行」）。
 */
export function buildCandidateWhere({ forceHash = false } = {}) {
  return forceHash
    ? `(p.embedding IS NULL OR ${HASH_FINGERPRINT_SQL})`
    : 'p.embedding IS NULL';
}

/**
 * 回填候选查询。
 * @param {object} o
 * @param {number} [o.limit] 本批上限
 * @param {string|null} [o.tenant] 仅处理指定租户
 * @param {boolean} [o.forceHash] 见 buildCandidateWhere
 * @param {string[]|'all'} [o.types] 处理的粒子类型（'all' = 不设类型条件）
 * @returns {{ text: string, params: any[] }}
 */
export function buildCandidateQuery({ limit = 200, tenant = null, forceHash = false, types = DEFAULT_BACKFILL_TYPES } = {}) {
  const params = [];
  const typeCond = types === 'all'
    ? ''
    : ` AND p.type = ANY($${params.push(types)}::text[])`;
  const tenantCond = tenant ? ` AND p.tenant_id = $${params.push(tenant)}` : '';
  const n = Number(limit) || 200;
  const text = `SELECT p.id, p.payload, p.tenant_id, p.type,
             ${HASH_FINGERPRINT_SQL} AS is_hash_stale
        FROM crm.particles p
        ${EMBED_STATS_LATERAL}
       WHERE ${buildCandidateWhere({ forceHash })}${typeCond}${tenantCond}
       ORDER BY p.updated_at ASC
       LIMIT ${n}`;
  return { text, params };
}

/**
 * 存量陈旧度统计（**始终执行**，与 --force-hash 开关无关）。
 * 目的：让「候选=0 但存量 69 条是假的」这一状态在**日志里可见**，而不是静默成功。
 */
export function buildStaleCountQuery() {
  return {
    text: `SELECT count(*) AS stale
             FROM crm.particles p
             ${EMBED_STATS_LATERAL}
            WHERE p.type = 'CRM_KNOWLEDGE' AND ${HASH_FINGERPRINT_SQL}`,
    params: [],
  };
}

/** 维度前置校验：列类型须为 vector(1024)，否则 UPDATE 写入 1024 维必失败（或静默 skip）。 */
export function buildEmbeddingColumnQuery() {
  return {
    text: `SELECT format_type(a.atttypid, a.atttypmod) AS t
             FROM pg_attribute a
             JOIN pg_class c     ON c.oid = a.attrelid
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'crm' AND c.relname = 'particles' AND a.attname = 'embedding'`,
    params: [],
  };
}

/** 列类型文本 → 维度数字（'vector(1024)' → 1024；不可解析 → null）。 */
export function parseVectorDim(typeText) {
  const m = /^vector\((\d+)\)$/.exec(String(typeText || '').trim());
  return m ? Number(m[1]) : null;
}
