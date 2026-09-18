// src/channels/privacyFilter.js — 隐私排除清单（G7）：通道线与同步线**共用的唯一判定实现**
// 设计：docs/2026-09-18-unified-integration-design-v2.md §8.1（对标 ROX Restricted Domains / ATTIO blocklist /
//       Lightfield Do-not-track —— 三家都有，成本最低、信任收益最高的缺口）
//
// 为什么必须放在**入口**（读入之后、落库之前），而不是查询时过滤：
//   查询时过滤＝数据已经在库里了，隐私承诺只是「不给你看」。入口过滤才是「根本没进来」。
//   这条区别在审计时是决定性的：前者可通过 SQL 直接取回，后者不能。
//
// 单一事实源纪律：本文件是**唯一**判定实现；两个消费点各自只做「从行的形状抽出信号」（见下方两个
//   signalsFrom* 适配器），判定一律走 evaluateSignals —— 否则两线会漂移出两套规则语义
//   （「通道线屏蔽了某域名，同步线却仍在落」＝同一隐私承诺两个答案）。
//
// fail-closed 方向（§8.1）：**读不到配置不得理解为「没有任何排除项，全放行」**。
//   ⚠ 但这里的「更私密」不等于「一律丢弃」——那是假红：把配置读取失败变成「所有数据丢光」，
//   用户会看到数据消失却查不到原因，比不放行更危险。故本实现的 fail-closed 是：
//     ① 未配置（null）→ 空规则 + config_ok=true（合法状态：用户就是没加规则）；
//     ①′ 读不到（DB 异常）→ 空规则 + config_ok=false 由装配层显式标记（`sync/mount.js loadPrivacyFilter`）；
//     ② 配置形状坏 → config_ok=false + invalid_items 记账，消费点必须留痕（不得静默）；
//     ③ 判定所需字段缺失 → 不丢（缺字段≠命中规则）。
//   为什么必须区分「未配置」与「读失败」：前者每轮都报异常＝告警疲劳，真故障会被淹没（另一种假绿）。
//   配置项 `matched_only`（G8）**不在本文件消费**：它属对已批设计的收窄，待 Q2 裁决后单列。

/** 配置键（config_store，租户级）。与 src/http/privacyConfigRouter.js 同源，禁止旁路硬编码。 */
export const PRIVACY_CONFIG_KEY = 'sync-privacy';

/** 空规则集＝不排除任何东西。用作「配置缺失」的取值（配合 config_ok=false 留痕）。 */
export const DEFAULT_PRIVACY = Object.freeze({
  exclude_domains: [],
  exclude_addresses: [],
  exclude_keywords: [],
});

/** 命中原因（计数与 trace 用；字符串是契约，前端/报告按此分组）。 */
export const PRIVACY_REASONS = Object.freeze({
  DOMAIN: 'excluded_domain',
  ADDRESS: 'excluded_address',
  KEYWORD: 'excluded_keyword',
});

const lower = (v) => String(v ?? '').trim().toLowerCase();
const uniq = (a) => [...new Set(a)];

/**
 * 归一配置。**永不抛异常、永不返回 null**——调用方不需要 try/catch（fail-closed 第一层）。
 * @returns {{exclude_domains:string[], exclude_addresses:string[], exclude_keywords:string[], config_ok:boolean, invalid_items:string[]}}
 */
export function normalizePrivacyConfig(raw) {
  const out = { ...DEFAULT_PRIVACY, config_ok: true, invalid_items: [] };
  // 兼容 {value:{...}} 形态（readConfig 的行）与裸对象；两者都接受，避免消费点各自解包
  const v = raw && typeof raw === 'object' && raw.value && typeof raw.value === 'object' ? raw.value : raw;
  // 「未配置」与「配置坏了」是两种状态，必须分开：
  //   未配置（null/undefined）＝ 合法状态（用户没加规则），config_ok=true —— 否则每个未配置的租户
  //     每轮同步都会落一条 config_ok=false，把真正的配置损坏淹没在噪音里；
  //   形状坏（字符串/数字/数组/字段非数组）＝ 真正的异常，config_ok=false 且必须留痕。
  if (v === null || v === undefined) return { ...out, config_ok: true };
  if (typeof v !== 'object' || Array.isArray(v)) return { ...out, config_ok: false };

  let droppedAnyKey = false;
  const pickList = (key, map) => {
    const src = v[key];
    if (src === undefined || src === null) return []; // 未配置：合法（空表）
    if (!Array.isArray(src)) { out.invalid_items.push(`${key} 非数组`); droppedAnyKey = true; return []; }
    const list = [];
    for (const item of src) {
      if (typeof item !== 'string' || !item.trim()) { out.invalid_items.push(`${key}:${String(item)}`); droppedAnyKey = true; continue; }
      list.push(map(item));
    }
    return uniq(list);
  };

  // 域名：小写、去首尾点（`*.example.com` / `.example.com` / `example.com` 三种写法等价）
  out.exclude_domains = pickList('exclude_domains', (s) => lower(s).replace(/^\*?\.?/, ''));
  // 地址：含 @ → 邮箱规则；不含 @ → 该地址的 local 部分精确匹配（域名请写 exclude_domains，分工明确不歧义）
  out.exclude_addresses = pickList('exclude_addresses', (s) => lower(s));
  // 关键词：小写（子串匹配）
  out.exclude_keywords = pickList('exclude_keywords', (s) => lower(s));

  out.config_ok = !droppedAnyKey;
  return out;
}

/** 域名后缀匹配：`a.corp.com` 命中规则 `corp.com`（含子域），但 `notcorp.com` 不命中。 */
export function domainMatches(host, rule) {
  const h = lower(host);
  const r = lower(rule).replace(/^\*?\.?/, '');
  if (!h || !r) return false;
  return h === r || h.endsWith(`.${r}`);
}

/** 地址匹配：`ceo@` 命中 local=ceo 的任意地址；`ceo@corp.com` 只命中该完整地址；`ceo` 命中 local=ceo。 */
export function addressMatches(email, rule) {
  const e = lower(email);
  const r = lower(rule);
  if (!e || !r) return false;
  if (r.endsWith('@')) return e.split('@')[0] === r.slice(0, -1);
  if (r.includes('@')) return e === r;
  return e.split('@')[0] === r;
}

/**
 * 核心判定。纯函数——同输入恒同输出，可被两条线共用、可被校验器直接驱动。
 * @param {{emails?:string[], domains?:string[], texts?:string[]}} signals
 * @param {object} rules normalizePrivacyConfig 的产物（或已归一的手写对象）
 * @returns {{drop:boolean, reason:string|null, matched:string|null}}
 */
export function evaluateSignals(signals = {}, rules = DEFAULT_PRIVACY) {
  const emails = (signals.emails || []).filter(Boolean).map(lower);
  const domains = (signals.domains || []).filter(Boolean).map(lower);
  const texts = (signals.texts || []).filter(Boolean).map(lower);
  const keep = { drop: false, reason: null, matched: null };

  // 顺序＝精确度优先（地址 > 域名 > 关键词）：命中的 reason 要指向**最具体的**那条规则，
  //   否则「为什么被拦」的答案会随规则书写顺序漂移，用户排查时得到误导性归因。
  for (const rule of rules.exclude_addresses || []) {
    if (emails.some((e) => addressMatches(e, rule))) return { drop: true, reason: PRIVACY_REASONS.ADDRESS, matched: rule };
  }
  for (const rule of rules.exclude_domains || []) {
    if (domains.some((d) => domainMatches(d, rule))) return { drop: true, reason: PRIVACY_REASONS.DOMAIN, matched: rule };
  }
  for (const rule of rules.exclude_keywords || []) {
    if (texts.some((t) => t.includes(rule))) return { drop: true, reason: PRIVACY_REASONS.KEYWORD, matched: rule };
  }
  return keep;
}

/**
 * 从邮箱地址推其域名。
 * 为什么必须补这一步：排除清单的语义是「凡涉及该域名的行都不要」，而客户侧同步行常常**只有邮箱字段**
 *   而没有独立域名字段（`{email:'bob@secret.com'}`）。若只把显式 domain 字段当域名信号，就会出现
 *   「用户配了排除 secret.com、通道线拦下了、同步线却照样落库」——配置显示生效而实际半失效（假绿）。
 */
export function domainFromEmail(email) {
  const e = lower(email);
  const i = e.lastIndexOf('@');
  return i > 0 ? e.slice(i + 1) : '';
}

/**
 * 从**通道事件行**抽信号（eventNormalizer 产物）。
 * 覆盖：发件人 + 参与者邮箱；对方域名 + 参与者归属域名 + **邮箱地址自身的域名**；主题 + 片段（前 500 字）。
 */
export function signalsFromChannelEvent(ev = {}) {
  const emails = uniq([ev?.actor?.email, ...(ev?.participants || []).map((p) => p?.email)].filter(Boolean).map(lower));
  const explicit = [ev?.domain, ...(ev?.participants || []).map((p) => p?.corp)].filter(Boolean).map(lower);
  const domains = uniq([...explicit, ...emails.map(domainFromEmail).filter(Boolean)]);
  const texts = [ev?.content?.subject, ev?.content?.snippet].filter(Boolean);
  return { emails, domains, texts };
}

/**
 * 从**同步行**（客户侧 CRM 对象）抽信号。形状不可预知，故按语义字段名收敛，不做「遍历所有字符串值」
 * 那种宽泛扫描——宽泛扫描会把「恰好长得像域名的产品型号」当成域名拦掉（误伤并不可解释）。
 * @param {object} row 客户侧对象行
 * @param {{emailFields?:string[], domainFields?:string[], textFields?:string[]}} fields 覆盖默认字段清单（描述符可声明）
 */
export function signalsFromSyncRow(row = {}, fields = {}) {
  const emailFields = fields.emailFields || ['email', 'Email', 'email_address', 'EmailAddress'];
  const domainFields = fields.domainFields || ['domain', 'Domain', 'website', 'Website', 'web_site'];
  const textFields = fields.textFields || ['subject', 'title', 'name', 'summary', 'description', 'notes', 'body'];
  // 键名大小写不敏感：客户侧 CRM 的字段命名各家不同（`Email` / `email` / `EmailAddress`），
  //   精确取不到时必须回退到大小写不敏感匹配，否则同一份配置在 A 家生效、在 B 家静默失效。
  const grab = (keys) => keys.flatMap((k) => {
    let v = row?.[k];
    if (v === undefined) {
      const hit = Object.keys(row || {}).find((kk) => kk.toLowerCase() === k.toLowerCase());
      if (hit) v = row[hit];
    }
    return String(v ?? '').split(/[,;\s]+/);
  }).filter(Boolean);
  return {
    emails: uniq(grab(emailFields).map(lower)),
    domains: uniq([...grab(domainFields).map(lower), ...grab(emailFields).map(domainFromEmail).filter(Boolean)]),
    texts: grab(textFields).map(lower),
  };
}

/**
 * 工厂：消费点用这一个入口，保证「归一 + 判定」不发生两次实现。
 * evaluate() 额外带回 `config_ok`，消费点据此决定是否 emit 留痕（不得静默）。
 */
export function createPrivacyFilter(rawConfig) {
  const rules = normalizePrivacyConfig(rawConfig);
  return {
    rules,
    config_ok: rules.config_ok,
    invalid_items: rules.invalid_items,
    isEmpty: !rules.exclude_domains.length && !rules.exclude_addresses.length && !rules.exclude_keywords.length,
    evaluate: (signals) => evaluateSignals(signals, rules),
  };
}
