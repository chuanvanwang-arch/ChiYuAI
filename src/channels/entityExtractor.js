// src/channels/entityExtractor.js — 需求② §5 图谱汇入的实体抽取：事件行 → {domain, company, participants, intents, signals}
// 设计：docs/2026-09-17-channel-adapter-unified-design.md §3.0/§5（命中既有 CRM_ACCOUNT 才追加 enrichment）
// 纯函数：无 DB、无 IO。intents/signals 仅为结构化标记——真实汇入判据在 channelGraphIngest（P2 T7）。
// 红线：只抽结构化标记，不落原始内容（§8 决策点②）；空输入 fail-safe 返回空结构（不抛）。
const INTENT_PATTERNS = [
  { key: 'purchase', re: /报价|采购|预算|下单|比价|询价/ },
  { key: 'visit', re: /拜访|见面|约见|上门|约个时间/ },
  { key: 'tender', re: /招标|投标|竞标|应标|中选/ },
];
const SIGNAL_BY_INTENT = { tender: 'tender_push', visit: 'follow_reminder' };

export function extractEntities(ev = {}) {
  if (!ev || typeof ev !== 'object') return { domain: null, company: null, participants: [], intents: [], signals: [] };
  const domain = ev.domain || null;
  // 企业识别：优先事件行 domain；兜底参与者 corp（P2 的 providerRegistry 富化会再识别，此处仅初判）
  const company = domain || (ev.participants || []).map((p) => p.corp).find(Boolean) || null;
  const participants = (ev.participants || []).map((p) => ({ name: p.name || null, email: p.email || null, corp: p.corp || null }));
  const text = [ev.content?.subject, ev.content?.snippet].filter(Boolean).join(' ').toLowerCase();
  const intents = INTENT_PATTERNS.filter(({ re }) => re.test(text)).map(({ key }) => key);
  const signals = intents.map((i) => SIGNAL_BY_INTENT[i]).filter(Boolean);
  return { domain, company, participants, intents, signals };
}
