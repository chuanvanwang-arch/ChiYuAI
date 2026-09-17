// src/channels/channelIngestWiring.js — 需求② §5 图谱汇入的**生产接线**（T7 Step 5）
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §5 + plans/2026-09-17-channel-adapters-p1-p4.md Task 7
//
// 职责：把 channelGraphIngest 的抽象 deps 落成真实现，并以**单一读入**方式挂到 sync 内核的读入路径上
//   （包装 provider.readIncremental：同一批 rows 既进内核 upsert，也进图谱汇入——不双读、不重复推进游标）。
//
// 红线：
//   ① 仅通道 kind 生效（generic-email/calendar/meeting/wechat）；其它 kind 原样返回，零行为变化；
//   ② 命中既有账户才写——按 payload.domains 精确匹配（不模糊、不建新账户）；
//   ③ 弱边目标必须是**既有粒子**：按参与者邮箱匹配既有 CRM_CONTACT 才挂边；匹配不到则跳过（不留悬空边）；
//   ④ 不静默：读入行数/汇入条数/失败逐项 emit trace（「读了 N 行零汇入」与「没接线」必须可区分）；
//   ⑤ 任何异常都不阻断内核读入链路（读入是主链路，汇入是可补偿步骤）。
import { normalizeChannelRow } from './eventNormalizer.js';
import { ingestChannelEvent } from './channelGraphIngest.js';
import { query, queryWrite } from '../db.js';
// 通道 kind 单一事实源（见 channels/kinds.js；本文件不再自建集合）
import { CHANNEL_KINDS } from './kinds.js';

export { CHANNEL_KINDS };

// —— 生产 deps：真实现（可注入替身以便单测；缺省走真实 DB）——
export function createChannelIngestDeps(deps = {}) {
  const q = deps.query || query;
  const qw = deps.queryWrite || queryWrite;
  const emit = typeof deps.emit === 'function' ? deps.emit : () => {};
  const tenantId = deps.tenantId || 'system';

  // 命中既有 CRM_ACCOUNT（payload.domains 为字符串或数组，两种形状都精确匹配）。
  // ⚠ domains 语义单一来源＝particleModel.js CRM_ACCOUNT.coreAttributes.domains（'domain' 类型）
  async function findAccountByDomain(domain) {
    if (!domain) return null;
    const r = await q(
      `SELECT id, payload FROM particles
        WHERE tenant_id=$1 AND type='CRM_ACCOUNT'
          AND (payload->>'domains' = $2 OR payload->'domains' @> to_jsonb($2::text))
        LIMIT 1`,
      [tenantId, domain],
    ).catch(() => null);
    const row = r?.rows?.[0];
    if (!row) return null;
    return { particle_id: row.id, enrichment: row.payload?.enrichment || {} };
  }

  // 追加 enrichment（**合并**而非覆盖：updateParticle 的 patch 是 payload 顶层浅合并，
  // 故须把整份 enrichment 合并后回填，否则会抹掉既有 enrichment 子键）。
  async function appendEnrichment({ particleId, channel, payload } = {}) {
    if (!particleId) return { ok: false, error: 'particle_id_missing' };
    const cur = await q(`SELECT payload FROM particles WHERE id=$1`, [particleId]).catch(() => null);
    const curEnrichment = cur?.rows?.[0]?.payload?.enrichment || {};
    const merged = { ...curEnrichment, ...payload };
    const r = await qw(
      `UPDATE particles SET payload = payload || $1::jsonb, updated_at=now() WHERE id=$2 RETURNING id`,
      [JSON.stringify({ enrichment: merged }), particleId],
    );
    if (!r?.rowCount) return { ok: false, error: 'update_no_rows' };
    emit('trace', 'channel-enrichment-appended', { channel, particle_id: particleId });
    return { ok: true };
  }

  // 弱边：ACCOUNT --sourcedFrom--> 既有 CRM_CONTACT（按参与者邮箱匹配）。
  // 匹配不到 → 不挂边（不留悬空边；红线「图谱=既有粒子图」）。
  async function addWeakEdge({ from, kind = 'sourcedFrom', participants = [] } = {}) {
    if (!from) return { ok: false, error: 'from_missing' };
    const emails = participants.map((p) => p?.email).filter(Boolean);
    if (!emails.length) return { ok: true, skipped: 'no_participant_email' };
    const r = await q(
      `SELECT id FROM particles
        WHERE tenant_id=$1 AND type='CRM_CONTACT' AND payload->>'email' = ANY($2::text[])
        LIMIT 1`,
      [tenantId, emails],
    ).catch(() => null);
    const target = r?.rows?.[0]?.id;
    if (!target) return { ok: true, skipped: 'no_matching_contact' };
    await qw(
      `INSERT INTO edges (tenant_id, source_type, source_id, edge_type, target_type, target_id, meta)
       VALUES ($1,'CRM_ACCOUNT',$2,$3,'CRM_CONTACT',$4,$5::jsonb)
       ON CONFLICT DO NOTHING`,
      [tenantId, from, kind, target, JSON.stringify({ edge_source: 'auto_weak', provenance: 'channel-ingest' })],
    ).catch(() => null);
    return { ok: true, target };
  }

  return { findAccountByDomain, appendEnrichment, addWeakEdge };
}

// —— 包装 provider：单一读入 → 逐行归一化 → 汇入（仅通道 kind 生效）——
export function wrapProviderForIngest({ provider, kind, tenantId = 'system', trustLevel, deps, emit } = {}) {
  if (!provider || !CHANNEL_KINDS.has(kind)) return provider; // 非通道 kind：原样返回（零行为变化）
  const orig = provider.readIncremental;
  if (typeof orig !== 'function') return provider;
  const trace = typeof emit === 'function' ? emit : () => {};
  const ingestDeps = (deps && typeof deps.findAccountByDomain === 'function') ? deps : createChannelIngestDeps({ emit, tenantId });
  const level = trustLevel || 'L1';

  return {
    ...provider,
    kind: provider.kind || kind,
    async readIncremental(opts = {}) {
      const inc = await orig.call(provider, opts);
      const rows = Array.isArray(inc?.rows) ? inc.rows : [];
      let ingested = 0;
      let failed = 0;
      const keys = new Set(); // 本轮实际落到的 enrichment 键（落点可观测：不静默）
      for (const row of rows) {
        try {
          const ev = normalizeChannelRow(row);
          const r = await ingestChannelEvent(ev, {
            ...ingestDeps,
            trustLevel: async () => level,
            emit: trace,
          });
          if (r?.written) {
            ingested++;
            if (r.enrichment_key) keys.add(r.enrichment_key);
          }
        } catch (e) {
          // ⑤ 行级失败不阻断读入链路，但留痕（不静默）
          failed++;
          trace('trace', 'channel-ingest-row-failed', {
            tenant_id: tenantId, kind, error: String(e?.message || e),
          });
        }
      }
      // 不静默：本轮「读入 N 行 / 汇入 M 条 / 失败 K 条 / 落到哪些键」上墙——
      // 「零汇入」与「没接线」可区分，且落点键可核对（防「写进了错的键」这类静默错配）。
      if (rows.length) {
        trace('trace', 'channel-ingest-done', {
          tenant_id: tenantId, kind, read: rows.length, ingested, failed, enrichment_keys: [...keys],
        });
      }
      return inc;
    },
  };
}
