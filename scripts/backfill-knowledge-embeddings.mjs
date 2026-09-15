// scripts/backfill-knowledge-embeddings.mjs
// D1 回填：对 crm.particles(type=CRM_KNOWLEDGE) 缺失向量者重算真模型向量并幂等 upsert。
// 前置：EMBEDDING_PROVIDER=model 且 DB llm_config 含 SiliconFlow embedding 密钥；否则仅报告 skip。
// 绝对禁 DELETE；幂等（只处理 embedding IS NULL 的行，已嵌者不重算）；小批先 --limit 验证维度/延迟/成本。
//
// 用法：
//   PGDATABASE=crm_native_test EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --limit=3 --dry-run
//   PGDATABASE=crm_native_test EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --limit=200
//   PGDATABASE=crm_native_test EMBEDDING_PROVIDER=model node scripts/backfill-knowledge-embeddings.mjs --tenant=acme-auto
import { query, queryWrite } from '../src/db.js';
import { embedText, EMBED_PROVIDER, contentHash } from '../src/ontology/embedding.js';

const LIMIT = Number(process.argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0) || 200;
const DRY = process.argv.includes('--dry-run');
const TENANT = process.argv.find((a) => a.startsWith('--tenant='))?.split('=')[1] || null;

async function main() {
  if (process.env.EMBEDDING_PROVIDER !== 'model') {
    console.log('[backfill] SKIP: EMBEDDING_PROVIDER != model（真向量路径未启用，退出）');
    return;
  }
  const where = TENANT ? 'AND tenant_id=$1' : '';
  const params = TENANT ? [TENANT] : [];
  const rows = await query(
    `SELECT id, payload, tenant_id FROM crm.particles
     WHERE type='CRM_KNOWLEDGE' AND embedding IS NULL ${where}
     ORDER BY updated_at ASC LIMIT ${Number(LIMIT)}`,
    params
  );
  console.log(`[backfill] candidate=${rows.rows.length} (limit=${LIMIT}${TENANT ? ` tenant=${TENANT}` : ''})`);
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
        ev.vector.length === 1024
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
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
