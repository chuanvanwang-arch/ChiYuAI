// scripts/particle-embedding-coverage.mjs
// 只读：crm.particles 向量覆盖率按 type 分组（真实向量 / hash 伪向量 / NULL）。
//
// 为什么要单独有这个报告（2026-09-18 实证）：
//   KMD 探针 D1 只看 CRM_KNOWLEDGE，D3 只看「池子总量」——两者都**看不到"其他类型被清空"**。
//   本机执行 particles.embedding 384→1024 迁移（USING NULL）后，其他类型的 hash 向量一并被清空，
//   D3 的 L1 池由 447 掉到 72 却无任何告警指向该原因。分组报告把「谁被清空了、还差多少」显式列出。
//
// 用法：
//   node scripts/particle-embedding-coverage.mjs            # 全部类型
//   node scripts/particle-embedding-coverage.mjs --top=20   # 仅前 20 类（按总量降序）
//
// 只读：不写任何表。
import { query } from '../src/db.js';
import { HASH_FINGERPRINT_SQL, EMBED_STATS_LATERAL } from './lib/embedding-backfill-query.mjs';

const TOP = Number(process.argv.find((a) => a.startsWith('--top='))?.split('=')[1] || 0) || 0;

const { text } = {
  text: `SELECT p.type,
                count(*)                                                AS total_rows,
                count(*) FILTER (WHERE p.embedding IS NOT NULL)         AS embedded,
                count(*) FILTER (WHERE ${HASH_FINGERPRINT_SQL})         AS hash_pseudo
           FROM crm.particles p
           ${EMBED_STATS_LATERAL}
          GROUP BY p.type
          ORDER BY count(*) DESC`,
};

const r = await query(text);
const rows = r.rows.map((x) => ({
  type: x.type,
  total: Number(x.total_rows),
  embedded: Number(x.embedded),
  hash: Number(x.hash_pseudo),
  missing: Number(x.total_rows) - Number(x.embedded),
}));

const shown = TOP ? rows.slice(0, TOP) : rows;
const pad = (s, n) => { s = String(s ?? ''); let w = 0; for (const ch of s) w += /[\u4e00-\u9fa5]/.test(ch) ? 2 : 1; return s + ' '.repeat(Math.max(0, n - w)); };
console.log(`\n${pad('type', 34)}${pad('总行', 8)}${pad('已嵌', 8)}${pad('缺向量', 8)}${pad('hash伪', 8)}覆盖率`);
console.log('-'.repeat(78));
for (const x of shown) {
  const cov = x.total ? ((x.embedded * 100) / x.total).toFixed(1) : '0.0';
  console.log(`${pad(x.type, 34)}${pad(x.total, 8)}${pad(x.embedded, 8)}${pad(x.missing, 8)}${pad(x.hash, 8)}${cov}%`);
}
const sum = rows.reduce((a, x) => ({
  total: a.total + x.total, embedded: a.embedded + x.embedded, missing: a.missing + x.missing, hash: a.hash + x.hash,
}), { total: 0, embedded: 0, missing: 0, hash: 0 });
console.log('-'.repeat(78));
console.log(`${pad('合计', 34)}${pad(sum.total, 8)}${pad(sum.embedded, 8)}${pad(sum.missing, 8)}${pad(sum.hash, 8)}${sum.total ? ((sum.embedded * 100) / sum.total).toFixed(1) : '0.0'}%`);
if (sum.missing > 0) {
  console.log(`\n⚠ 有 ${sum.missing} 行缺向量（检索池以 embedding IS NOT NULL 为门 ⇒ 这些行不参与向量召回）`);
  console.log('  回填：EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --force-hash [--types=all]');
}
