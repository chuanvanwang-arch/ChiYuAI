// scripts/enable-fusion-providers.mjs — 运行期启用外部数据源融合（D1 显式授权通道）
// 仅把 qixin/anysite/xinbang 的 enabled 翻为 true（保留其余 provider 与其它配置），并在库内落 discovery_draft 表。
// 用法：node scripts/enable-fusion-providers.mjs   （默认连 PGDATABASE；生产请显式 PGDATABASE=crm_native）
import { query, queryWrite, pool } from '../src/db.js';

const ENABLE = ['qixin', 'anysite', 'xinbang'];

function enableById(list = []) {
  return list.map((p) => (ENABLE.includes(p.id) ? { ...p, enabled: true } : p));
}

async function readValue(key, tenantId) {
  const r = await query(`SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key=$2`, [tenantId, key]);
  return r.rows[0]?.value || null;
}
async function upsertValue(key, value, tenantId) {
  await queryWrite(
    `INSERT INTO crm.config_store (tenant_id, key, value) VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = $3`,
    [tenantId, key, JSON.stringify(value)]
  );
}

async function main() {
  // 1) discovery_draft 表（幂等）
  await queryWrite(`
    CREATE TABLE IF NOT EXISTS crm.discovery_draft (
      draft_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT NOT NULL DEFAULT 'system',
      provider    TEXT NOT NULL,
      kind        TEXT NOT NULL,
      items       JSONB NOT NULL DEFAULT '[]'::jsonb,
      status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'expired')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
      consumed_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS ix_crm_discovery_draft_tenant ON crm.discovery_draft(tenant_id, status, expires_at);
  `);
  console.log('[enable] discovery_draft 表就绪（幂等）');

  // 2) discovery-rules：仅翻 3 个付费源 enabled，保留其余
  for (const tenantId of ['system']) {
    const cur = await readValue('discovery-rules', tenantId);
    const base = cur || {
      icp: { industries: [], min_revenue_y: 1e8, min_headcount: 50, geo: ['CN'] },
      providers: [
        { id: 'email-verify', kind: 'email/phone', scope: 'system', costTier: 1, enabled: true },
        { id: 'web-research', kind: 'web/serp', scope: 'system', costTier: 0, enabled: true },
        { id: 'tender', kind: 'internal-signal', scope: 'system', costTier: 0, enabled: true },
        { id: 'gaode', kind: 'geo_firmographics', scope: 'system', costTier: 1, enabled: true },
        { id: 'attio', kind: 'firmographics', scope: 'system-candidate', costTier: 2, enabled: false },
        { id: 'zhizao', kind: 'biz-verify', scope: 'system-candidate', costTier: 1, enabled: false },
        { id: 'clearbit', kind: 'firmographics', scope: 'paid', costTier: 3, enabled: false },
        { id: 'linkedin', kind: 'social', scope: 'paid', costTier: 3, enabled: false },
        { id: 'qixin', kind: 'firmographics', scope: 'paid', costTier: 2, enabled: false },
        { id: 'anysite', kind: 'firmographics', scope: 'paid', costTier: 2, enabled: false },
        { id: 'xinbang', kind: 'social', scope: 'paid', costTier: 2, enabled: false },
      ],
      signals: {}, duplicate_criteria: {}, playbooks: [],
    };
    base.providers = enableById(base.providers);
    await upsertValue('discovery-rules', base, tenantId);
    console.log(`[enable] discovery-rules(${tenantId}) 已启用 ${ENABLE.join('/')}`);
  }

  // 3) prospecting-rules：sources 同步翻 3 源 enabled（prospecting-search 路径用）
  for (const tenantId of ['system']) {
    const cur = await readValue('prospecting-rules', tenantId);
    const base = cur || { icp: {}, signals: {}, sources: {}, candidate_limit: 50, fit_threshold: 0.6 };
    base.sources = base.sources || {};
    for (const id of ENABLE) base.sources[id] = { ...(base.sources[id] || {}), enabled: true };
    await upsertValue('prospecting-rules', base, tenantId);
    console.log(`[enable] prospecting-rules(${tenantId}) sources 已启用 ${ENABLE.join('/')}`);
  }

  await pool.end();
  console.log('[enable] 完成。anysite/qixin/xinbang 已通过 config_store 显式授权启用。');
}

main().catch((e) => { console.error('[enable] 失败:', e.message); process.exit(1); });
