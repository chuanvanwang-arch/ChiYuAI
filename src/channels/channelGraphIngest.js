// src/channels/channelGraphIngest.js — 需求② §5 图谱汇入接线：事件行 → 命中既有 CRM_ACCOUNT → enrichment 追加 + sourcedFrom 弱边
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §5（图谱=既有粒子图，通道只是新的边来源）
//   + docs/superpowers/plans/2026-09-17-channel-adapters-p1-p4.md Task 7
// 判据（红线）：
//   ① 只命中**既有** CRM_ACCOUNT（by domain）才写——不入新图、不创建新账户（图谱汇入不改企业识别面）；
//   ② L1 只读观察期不写（对齐 trust L1）；L2/L3 才追加 enrichment.email_intent[] + sourcedFrom 弱边；
//   ③ 追加是**幂等**（external_id 去重）：同一事件行重复汇入不产生重复条目；
//   ④ 不新建粒子类型/不新建图（零内核断言）；写经上层 engine/mount 第 0 闸（本层不重复铸决策）；
//   ⑤ 任何失败都不静默（emit trace 'channel-ingest-failed'），trustLevel 读不到 → fail-safe 降 L1。
import { extractEntities } from './entityExtractor.js';

// 可写信任档（对齐 mount.js SYNC_TRUST_ORDER 的写语义：L1 只读，L2/L3 才落库）
const WRITE_LEVELS = new Set(['L2', 'L3']);

function noop() {}

export async function ingestChannelEvent(ev = {}, deps = {}) {
  const { findAccountByDomain, appendEnrichment, addWeakEdge, trustLevel, emit } = deps;
  const trace = typeof emit === 'function' ? emit : noop;

  // ① 企业归属识别：事件行 domain 优先，兜底实体抽取（domain/参与者 corp）
  const ents = extractEntities(ev);
  const domain = ev.domain || ents.domain || ents.company || null;
  if (!domain) return { ok: true, written: false, reason: 'no_domain' }; // 无归属 → 不越权写、不查账户

  // ② 信任档（fail-safe：读不到 → 最严 L1 只读）
  let level = 'L1';
  try {
    const l = trustLevel ? await trustLevel() : 'L1';
    if (typeof l === 'string' && WRITE_LEVELS.has(l)) level = l;
  } catch {
    level = 'L1';
  }

  // ③ 只命中既有账户（不入新图）
  const acc = typeof findAccountByDomain === 'function'
    ? await findAccountByDomain(domain).catch(() => null)
    : null;
  if (!acc) return { ok: true, written: false, reason: 'account_not_found' };
  if (!WRITE_LEVELS.has(level)) return { ok: true, written: false, reason: 'read_only_l1' };

  // ④ 幂等：同一 external_id 已汇入 → 不重复追加（无 external_id 时不去重，保持向后兼容）
  const existing = Array.isArray(acc.enrichment?.email_intent) ? acc.enrichment.email_intent : [];
  if (ev.external_id && existing.some((x) => x && x.external_id === ev.external_id)) {
    return { ok: true, written: false, reason: 'duplicate', company: ents.company || domain };
  }

  const payload = {
    email_intent: [
      ...existing,
      {
        external_id: ev.external_id ?? null,
        kind: ev.kind ?? null,
        ts: ev.ts ?? null,
        subject: ev.content?.subject ?? null,
        domain,
      },
    ],
  };
  const w = typeof appendEnrichment === 'function'
    ? await appendEnrichment({ particleId: acc.particle_id, channel: ev.channel, payload })
      .catch((e) => ({ ok: false, error: String(e?.message || e) }))
    : { ok: false, error: 'appendEnrichment_not_wired' };
  if (!w?.ok) {
    // ⑤ 不静默：失败上墙（与 mount.js 单目标失败留痕同源）
    trace('trace', 'channel-ingest-failed', {
      channel: ev.channel, external_id: ev.external_id, domain, error: w?.error || 'unknown',
    });
    return { ok: false, written: false, error: w?.error || 'unknown' };
  }

  // 弱边（sourcedFrom）：失败不阻断（enrichment 已落，弱边是可补偿步骤）。
  // 传入 domain/participants 供生产侧解析**既有**目标粒子（不建悬空边——见 channelIngestWiring）。
  if (typeof addWeakEdge === 'function') {
    await addWeakEdge({
      from: acc.particle_id,
      to: ev.external_id,
      kind: 'sourcedFrom',
      channel: ev.channel,
      domain,
      participants: ev.participants || [],
    }).catch(() => {});
  }
  return { ok: true, written: true, company: ents.company || domain };
}
