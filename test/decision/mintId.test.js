import { describe, it, expect, beforeEach } from 'vitest';
import { query, queryWrite } from '../../src/db.js';
import {
  stableKey, mintEntityIri, mintRelationshipIri, computeParticleStableKey,
  backfillStableKeys, upsertParticleByStableKey,
} from '../../src/particles/mintId.js';

describe('6.7 确定性标识铸造 mintId', () => {
  it('stableKey 确定性：同输入同输出', () => {
    const a = stableKey({ tenantId: 't1', type: 'CRM_DEAL', naturalKey: 'D-100' });
    const b = stableKey({ tenantId: 't1', type: 'CRM_DEAL', naturalKey: 'D-100' });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('stableKey 区分 tenant/type/naturalKey', () => {
    const base = { tenantId: 't1', type: 'CRM_DEAL', naturalKey: 'D-100' };
    expect(stableKey({ ...base, tenantId: 't2' })).not.toBe(stableKey(base));
    expect(stableKey({ ...base, type: 'CRM_ACCOUNT' })).not.toBe(stableKey(base));
    expect(stableKey({ ...base, naturalKey: 'D-101' })).not.toBe(stableKey(base));
  });

  it('mintEntityIri 带 crm://entity/ 前缀且含 stableKey', () => {
    const iri = mintEntityIri({ tenantId: 't1', type: 'CRM_DEAL', naturalKey: 'D-100' });
    expect(iri).toBe(`crm://entity/${stableKey({ tenantId: 't1', type: 'CRM_DEAL', naturalKey: 'D-100' })}`);
  });

  it('mintRelationshipIri 确定性且区分端点', () => {
    const f = mintEntityIri({ type: 'CRM_DEAL', naturalKey: 'D1' });
    const t = mintEntityIri({ type: 'CRM_ACCOUNT', naturalKey: 'A1' });
    const r1 = mintRelationshipIri({ fromIri: f, relType: 'belongs_to', toIri: t });
    const r2 = mintRelationshipIri({ fromIri: f, relType: 'belongs_to', toIri: t });
    expect(r1).toBe(r2);
    expect(r1).toMatch(/^crm:\/\/rel\/[0-9a-f]{64}$/);
    expect(mintRelationshipIri({ fromIri: f, relType: 'part_of', toIri: t })).not.toBe(r1);
  });

  it('缺参抛错', () => {
    expect(() => stableKey({ type: 'X' })).toThrow();
    expect(() => mintRelationshipIri({ fromIri: 'crm://entity/abc', relType: 'x' })).toThrow();
    expect(() => mintRelationshipIri({ relType: 'x', toIri: 'crm://entity/def' })).toThrow();
  });

  it('computeParticleStableKey 与 stableKey 等价', () => {
    expect(computeParticleStableKey('CRM_DEAL', 'D-100', 't1'))
      .toBe(stableKey({ tenantId: 't1', type: 'CRM_DEAL', naturalKey: 'D-100' }));
  });
});

const SCN = 'TEST_MINTID_SCEN';
const PT = 'MINTID_DEAL';
describe('6.7 数据库集成（回填 + 幂等 upsert）', () => {
  beforeEach(async () => {
    await queryWrite('DELETE FROM crm.particles WHERE type=$1', [PT]);
  });

  it('backfillStableKeys 为已有粒子补 stable_key；重复调用幂等', async () => {
    await queryWrite(
      `INSERT INTO crm.particles (tenant_id, type, slug, title, payload)
       VALUES ('system',$1,'slug-A','A','{}'::jsonb),('system',$1,'slug-B','B','{}'::jsonb)`,
      [PT]
    );
    const r1 = await backfillStableKeys();
    expect(r1.backfilled).toBeGreaterThanOrEqual(2); // 共享库可能含其它 NULL 行
    // 仅断言受控行被正确补全
    const rows = (await query(
      `SELECT slug, stable_key FROM crm.particles WHERE type=$1 AND slug IN ('slug-A','slug-B') ORDER BY slug`,
      [PT]
    )).rows;
    expect(rows.length).toBe(2);
    expect(rows[0].stable_key).toBe(computeParticleStableKey(PT, 'slug-A'));
    expect(rows[1].stable_key).toBe(computeParticleStableKey(PT, 'slug-B'));
    // 幂等：再跑一次，受控行 stable_key 不变
    await backfillStableKeys();
    // ⚠ 2026-09-17 修：此处原缺 `ORDER BY slug`（上面那次查询有、这次没有）——无 ORDER BY 时
    //   PG 返回顺序取决于物理堆顺序，而上一次 `backfillStableKeys()` 的 UPDATE 会重写行版本、
    //   改变堆顺序 ⇒ `rows2[0]` 可能取到 slug-B，报「expected 26e8a45a… to be 480adce9…」，
    //   看起来像 stable_key 被改写，实为**取行顺序不定**。判据：多行断言必须显式 ORDER BY，
    //   不得依赖"两次查询返回顺序一致"。
    const rows2 = (await query(
      `SELECT slug, stable_key FROM crm.particles WHERE type=$1 AND slug IN ('slug-A','slug-B') ORDER BY slug`,
      [PT]
    )).rows;
    expect(rows2[0].stable_key).toBe(computeParticleStableKey(PT, 'slug-A'));
    expect(rows2[1].stable_key).toBe(computeParticleStableKey(PT, 'slug-B'));
  });

  it('upsertParticleByStableKey 首次插入、第二次按 stable_key 命中更新（不产生新行）', async () => {
    const a = await upsertParticleByStableKey({ type: PT, slug: 'slug-U', title: 'v1', payload: { x: 1 } });
    const b = await upsertParticleByStableKey({ type: PT, slug: 'slug-U', title: 'v2', payload: { x: 2 } });
    expect(a.stable_key).toBe(b.stable_key);
    const cnt = (await query(`SELECT count(*)::int AS n FROM crm.particles WHERE type=$1 AND slug='slug-U'`, [PT])).rows[0].n;
    expect(cnt).toBe(1); // 幂等：同一 slug 只占一行
    const cur = (await query(`SELECT title, payload FROM crm.particles WHERE slug='slug-U' AND type=$1`, [PT])).rows[0];
    expect(cur.title).toBe('v2');
    expect(cur.payload.x).toBe(2);
  });
});
