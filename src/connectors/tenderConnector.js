// src/connectors/tenderConnector.js — 标讯连接器 + 外部事件源（T3-11；设计 §E16：大单网订阅/推送 → 线索挖掘）
// 原生机制：线索挖掘 = 「外部标讯源（订阅+自动推送）→ 筛选匹配 → 生成线索/预警商机」管道
//          = ai-event-driven-evolution 主动预警事件源（标讯订阅 = 定时任务事件触发器）+ crm-lead 线索生成 Action
//          （§5ter-quater Q.12：外部事件源 = 连接器组件；外部事件与内部事件同构进总线）
// 铁律：① 订阅条件可配置（关键词/区域） ② 匹配标讯自动生成线索（事件驱动） ③ 外部事件进总线（审计）
//       ④ 连接器禁删除；写走第 0 闸（autoDecision）——由 conn-tender-push Action 承载
import { emit } from '../events/bus.js';

// —— 标讯匹配（纯函数）：订阅条件（关键词/区域） vs 招标信息 → 是否命中 ——
// sub:   { keywords: string[], region: string, tenantId? }
// tender:{ id, title, region, industry?, amount?, buyer?, published_at }
// 命中规则：标题包含任一关键词（大小写不敏感）且区域匹配（空区域=不限）
export function matchTender(sub, tender) {
  if (!tender?.title) return { ok: false, reason: '标讯缺标题' };
  const kws = (sub.keywords || []).map((k) => String(k).toLowerCase());
  const title = String(tender.title).toLowerCase();
  const kwHit = kws.length === 0 || kws.some((k) => k && title.includes(k));
  if (!kwHit) return { ok: false, reason: `标题不含关键词: ${(sub.keywords || []).join('/')}` };
  const region = (sub.region || '').trim();
  const regionHit = !region || String(tender.region || '').includes(region);
  if (!regionHit) return { ok: false, reason: `区域不匹配: 订阅=${region} 标讯=${tender.region}` };
  return { ok: true, matched_keyword: (sub.keywords || []).find((k) => k && title.includes(String(k).toLowerCase())) };
}

// —— 批量筛选：订阅 vs 标讯流 → 命中列表（验收①：订阅条件可配置生效）——
export function filterTenders(sub, tenders) {
  const hits = [];
  for (const t of tenders || []) {
    const m = matchTender(sub, t);
    if (m.ok) hits.push({ ...t, matched_keyword: m.matched_keyword });
  }
  return hits;
}

// —— 推送管道：命中标讯 → tender_push 事件进总线（审计）+ 返回命中（供上层生成 LEAD）——
// 验收③：外部事件进总线（emit('trace', 'TENDER_PUSHED' / emit('connector','tender_push')）
export function pushTenderMatches(sub, tenders, { emitFn = emit } = {}) {
  const hits = filterTenders(sub, tenders);
  for (const h of hits) {
    emitFn('trace', 'TENDER_PUSHED', {
      connector: 'tender', tenant_id: sub.tenantId || 'system',
      tender_id: h.id, title: h.title, region: h.region, amount: h.amount,
      matched_keyword: h.matched_keyword, created_at: new Date().toISOString(),
    });
  }
  return hits;
}

// —— LEAD 生成（验收②：匹配标讯自动生成线索）—— 写通道：conn-tender-push Action 承载（第 0 闸）
// 此函数为 Action handler 复用：创建 DEAL(lead) 粒子 + sourcedFrom 边（auto_weak，provenance=tender）
export async function createLeadFromTender({ tender, tenantId = 'system' }) {
  const { createParticle, createEdge } = await import('../particles/particleRepo.js');
  const deal = await createParticle('CRM_DEAL', {
    name: tender.title, stage: 'lead', source: '标讯',
    expected_amount: tender.amount || 0, region: tender.region,
    tender_id: tender.id, expected_close_date: null,
  }, { tenantId });
  // 来源语义边：DEAL --sourcedFrom-->（标讯外部源），auto_weak + 低置信需 review
  await createEdge('CRM_DEAL', deal.id, 'sourcedFrom', 'CRM_KNOWLEDGE', tender.knowledge_id || 'tender-source', {
    edge_source: 'auto_weak', relation_confidence: 0.5, provenance: 'tender-connector', tender_id: tender.id,
  }, tenantId).catch(() => {});
  emit('crm', 'tender-lead-created', { deal_id: deal.id, tender_id: tender.id, title: tender.title });
  return deal;
}