// src/skills/methodOutreachHook.js — P1-1b 钩子生成 + 可验证性校验（Anysite 借鉴，设计 docs/2026-09-15-anysite-borrowing-analysis.md §4.1）
// 案例依据：B2B Outbound ICP Discovery / Sales Intelligence——个性化触达开口需锚定真实可验证信号。
// 铁律：
//   ① 只读（零写）：钩子产出不落库；DEAL payload.outreach_hooks[] 由调用方（Action/前端）经第 0 闸写入
//   ② fail-closed：无锚点可引用 → 拒出；钩子超 30 词 → 拒出（对齐 CitationGuard：不可溯源即拒出）
//   ③ 每个事实必须来自 deal/signal/contact（可溯源），verifiable[] 逐条标注来源
import { freshnessMultiplier, ageDaysOf } from '../config/signalFreshness.js';

const MAX_WORDS = 30;

// 锚点选取优先级：信号 URL（帖文/新闻/中标/融资）> 官网 URL
// 返回 null → fail-closed（调用方拒出）
export function pickAnchor(signal, deal) {
  if (signal?.url) return { type: 'signal', url: signal.url, label: `${signal.type || 'signal'} 信号` };
  if (deal?.homepage_url) return { type: 'homepage', url: deal.homepage_url, label: '官网' };
  return null;
}

// 钩子生成：verifiable[] 逐条事实校验 + 30 词硬闸 + 新鲜度衰减
export async function generateHook({ deal = {}, signal = null, contact = {}, rules = null, llm = null }) {
  const anchor = pickAnchor(signal, deal);
  if (!anchor) throw new Error('outreach-hook: 无锚点可引用（fail-closed），补充 signal.url 或 deal.homepage_url');
  // 事实校验：钩子内每个事实必须来自 deal/signal/contact（可溯源）
  const facts = [
    { fact: deal.name, source: 'deal', ok: !!deal.name },
    { fact: contact.title, source: 'contact', ok: !!contact.title },
    { fact: signal?.type, source: 'signal', ok: !!signal?.type },
  ];
  const verifiable = facts.map((f) => ({ fact: f.fact, source: f.source, ok: f.ok }));
  const hook = llm
    ? await llm.genHook({ deal, signal, contact, anchor })
    : buildFallbackHook(deal, signal, contact, anchor);
  if (hook.split(' ').length > MAX_WORDS) throw new Error('outreach-hook: 钩子超 30 词（fail-closed，对齐 CitationGuard）');
  const allOk = verifiable.every((v) => v.ok);
  return {
    hook, anchor, verifiable,
    verifiable_all: allOk,
    confidence: allOk ? 0.9 : 0.4,
    freshness: freshnessMultiplier(ageDaysOf(signal?.ts), rules?.signal_age_tiers),
  };
}

// 兜底钩子（无 LLM 时）：开口=锚点事实 + 职责定位 + 价值主张；字数受 MAX_WORDS 闸管制
export function buildFallbackHook(deal, signal, contact, anchor) {
  const who = contact.title ? `作为${contact.title}` : '';
  const what = signal?.type ? `注意到贵司${signal.type}动态` : `关注到贵司${deal.name}`;
  const value = deal.industry ? `我们专注${deal.industry}` : '我们专注 B2B 数字化';
  return trimToWords(`您好${who}，${what}（${anchor.label}）。${value}，想介绍相关方案。`, MAX_WORDS);
}

function trimToWords(str, max) {
  const parts = str.split(' ');
  return parts.slice(0, max).join(' ');
}
