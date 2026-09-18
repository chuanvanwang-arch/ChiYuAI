// scripts/backfill-knowledge-embeddings.mjs
// D1 回填：对 crm.particles(type=CRM_KNOWLEDGE) 的**缺向量行**与（可选）**hash 伪向量行**
//   重算真模型向量并幂等 upsert。
//
// 前置：EMBEDDING_PROVIDER=model 且 DB llm_config 含 SiliconFlow embedding 密钥；否则仅报告 skip。
// 绝对禁 DELETE；幂等；小批先 --limit 验证维度/延迟/成本。
//
// 用法：
//   EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --limit=3 --dry-run
//   EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --limit=200
//   EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --force-hash --limit=100
//   EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --types=all --limit=1000
//   EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --tenant=acme-auto
//   （--types 缺省 = CRM_KNOWLEDGE；'all' = 全类型；亦支持 --types=CRM_ACCOUNT,CRM_DEAL）
//
// 2026-09-18 变更（SiliconFlow 余额恢复后执行 D1 重嵌）：
//   ① 新增 `--force-hash`：把**存量 hash 伪向量**纳入候选。原实现只筛 `embedding IS NULL`，
//      而缺陷子集是「非 NULL 的假向量」⇒ candidate 恒 0、脚本成功退出、假向量永不自愈。
//   ② 每次运行**无条件**打印存量陈旧度（hash_stale=N），使「候选=0 但存量全假」在日志里可见。
//   ③ 新增维度前置校验：列类型不是 vector(1024) 时**显式失败退出**（exit 3）而非静默 skip
//      —— 384 列写 1024 维向量必失败，静默会让「回填跑过了但零效果」再次发生。
//   ④ 新增 `--types`：384→1024 迁移的 USING NULL 会清空**全部类型**的旧向量，
//      而原实现只回填 CRM_KNOWLEDGE ⇒ 其他类型的 L1 检索池静默塌陷。
//      范围现在是显式开关（缺省仍是知识类，保持既有语义）。
import { query, queryWrite } from '../src/db.js';
import { embedText, EMBED_PROVIDER, contentHash } from '../src/ontology/embedding.js';
import {
  buildCandidateQuery,
  buildStaleCountQuery,
  buildEmbeddingColumnQuery,
  parseVectorDim,
  parseTypes,
  REQUIRED_EMBED_DIM,
} from './lib/embedding-backfill-query.mjs';

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0) || 200;
const DRY = process.argv.includes('--dry-run');
const FORCE_HASH = process.argv.includes('--force-hash');
const TENANT = process.argv.find((a) => a.startsWith('--tenant='))?.split('=')[1] || null;
const TYPES = parseTypes(process.argv.find((a) => a.startsWith('--types='))?.split('=')[1]);

async function main() {
  if (process.env.EMBEDDING_PROVIDER !== 'model') {
    console.log('[backfill] SKIP: EMBEDDING_PROVIDER != model（真向量路径未启用，退出）');
    return;
  }

  // ① 维度前置校验（防「跑过了但零效果」的静默失败）
  const col = await query(buildEmbeddingColumnQuery().text);
  const dim = parseVectorDim(col.rows[0]?.t);
  if (dim !== REQUIRED_EMBED_DIM) {
    console.error(
      `[backfill] FAIL: crm.particles.embedding 当前为 ${col.rows[0]?.t ?? '(缺失)'}，需 vector(${REQUIRED_EMBED_DIM})。\n` +
      `           请先执行 node db/migrate.js（幂等迁移 migration-2026-09-18-particles-embedding-1024.sql）。\n` +
      `           384 列无法写入 1024 维向量 —— 此处必须显式失败，否则表现为「回填成功但零效果」。`
    );
    process.exit(3);
  }

  // ② 存量陈旧度（无条件打印，与开关无关）
  const stale = await query(buildStaleCountQuery().text);
  const staleN = Number(stale.rows[0]?.stale || 0);

  // ③ 候选
  const { text, params } = buildCandidateQuery({ limit: LIMIT, tenant: TENANT, forceHash: FORCE_HASH, types: TYPES });
  const rows = await query(text, params);
  const hint = !FORCE_HASH && staleN > 0
    ? `；⚠ 另有 hash_stale=${staleN} 条存量伪向量不在候选内 —— 加 --force-hash 才会重算`
    : '';
  const scope = TYPES === 'all' ? 'all-types' : TYPES.join(',');
  console.log(
    `[backfill] provider=model col=vector(${dim}) types=${scope} force_hash=${FORCE_HASH ? 'on' : 'off'} ` +
    `hash_stale=${staleN} candidate=${rows.rows.length} (limit=${LIMIT}${TENANT ? ` tenant=${TENANT}` : ''})${hint}`
  );

  let ok = 0;
  let skip = 0;
  for (const row of rows.rows) {
    const text = JSON.stringify(row.payload || {});
    let vec = null;
    let hash = null;
    try {
      hash = contentHash(row.payload || {});
      const ev = await embedText(text, {
        metering: { tenantId: row.tenant_id || 'system', actor: 'backfill', action: 'particle-embed' },
      });
      if (
        ev.provider === EMBED_PROVIDER.MODEL &&
        Array.isArray(ev.vector) &&
        ev.vector.length === REQUIRED_EMBED_DIM
      ) {
        vec = JSON.stringify(ev.vector.map(Number));
      }
    } catch (e) {
      console.error(`[backfill] embed fail ${row.id}: ${e?.message || e}`);
    }
    if (!vec) {
      skip++;
      continue;
    }
    if (!DRY) {
      await queryWrite(
        `UPDATE crm.particles SET embedding=$1, content_hash=$2, updated_at=now() WHERE id=$3`,
        [vec, hash, row.id]
      );
    }
    ok++;
  }
  console.log(`[backfill] done ok=${ok} skip=${skip}${DRY ? ' (dry-run)' : ''}`);
  if (skip > 0) {
    console.error(`[backfill] ⚠ ${skip} 条未产出真向量（降级留痕已写 monitor_event embedding-degraded，请核查拒因）`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
