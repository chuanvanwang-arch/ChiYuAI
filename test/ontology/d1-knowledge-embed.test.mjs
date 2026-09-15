// test/ontology/d1-knowledge-embed.test.mjs
// D1：ensureEmbedding 接真模型路径 + fail-open。通过 mock embedText 确定性覆盖两条分支（不触网）。
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { query, queryWrite } from '../../src/db.js';

// 受控 mock：hooks.js 从 './embedding.js' 导入 embedText；用可变 fakeEmbed 切换返回值。
let fakeEmbed = async () => ({ provider: 'model', vector: new Array(1024).fill(0.1) });
vi.mock('../../src/ontology/embedding.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, embedText: (...a) => fakeEmbed(...a) };
});

const { ensureEmbedding } = await import('../../src/ontology/hooks.js');

const PID = (n) => `d1111111-1111-1111-1111-11111111111${n}`; // 合法 UUID（particles.id 为 uuid 类型）
async function upsert(id, resetHash = true) {
  await queryWrite(
    `INSERT INTO crm.particles (id, type, slug, title, payload, tenant_id, content_hash)
     VALUES ($1, 'CRM_KNOWLEDGE', $2, 'fixture', '{"k":"v"}', 'system', ${resetHash ? 'NULL' : "'x'"})
     ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload, content_hash=${resetHash ? 'NULL' : "'x'"}`,
    [id, id]
  );
}
const embDims = async (id) => {
  const r = await query(`SELECT vector_dims(embedding) AS d, embedding IS NULL AS isnull FROM crm.particles WHERE id=$1`, [id]);
  return r.rows[0];
};

beforeEach(() => { delete process.env.EMBEDDING_PROVIDER; });

describe('D1 ensureEmbedding', () => {
  it('provider≠model → 写 NULL（hash 384 无法入 vector(1024)，fail-open 不阻断写）', async () => {
    const id = PID(1);
    await upsert(id);
    fakeEmbed = async () => ({ provider: 'model', vector: new Array(1024).fill(0.1) });
    await ensureEmbedding({ id, payload: { k: 'v' } });
    const r = await embDims(id);
    expect(r.isnull).toBe(true);
  });

  it('provider=model 且 embedText 返回真 1024 向量 → 写真向量', async () => {
    process.env.EMBEDDING_PROVIDER = 'model';
    const id = PID(2);
    await upsert(id);
    fakeEmbed = async () => ({ provider: 'model', vector: new Array(1024).fill(0.1) });
    await ensureEmbedding({ id, payload: { k: 'v' } });
    const r = await embDims(id);
    expect(r.isnull).toBe(false);
    expect(Number(r.d)).toBe(1024);
  });

  it('provider=model 但 embedText 降级 hash(384) → fail-open 写 NULL（绝不抛错）', async () => {
    process.env.EMBEDDING_PROVIDER = 'model';
    const id = PID(3);
    await upsert(id);
    fakeEmbed = async () => ({ provider: 'hash', vector: new Array(384).fill(0.01) }); // 降级为伪向量
    await expect(ensureEmbedding({ id, payload: { k: 'v' } })).resolves.toBeUndefined();
    const r = await embDims(id);
    expect(r.isnull).toBe(true);
  });
});
