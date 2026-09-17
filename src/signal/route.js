// src/signal/route.js — 投递路由与收件人解析（消费端契约）
// 设计输入：docs/2026-09-16-full-chain-integration-design.md v1.1 §3.2（含 D1 修正：system 平台租户收件人回退）
// 铁律：
//   ① 渠道集合**必须**来自 config_store['signal-delivery'].channels，零硬编码默认值
//      （此前 signalMetrics.js 的 DEFAULT_CHANNELS 就是本条被违反的产物——判据自带假前提）；
//   ② 收件人解析不到**必须**显式返回 skip 原因（不静默、不假绿）；
//   ③ 静默时段/限速丢弃一律 skip 留痕（含跨午夜区间）；
//   ④ system 租户回退 role_recipients.platform，**非 system 租户绝不回退**（跨租户隔离）；收件人禁硬编码。
//
// 执行期修正（2026-09-16，逐条已登记 docs/superpowers/plans/2026-09-16-full-chain-q1-export-dispatch.md）：
//   P-1 计划原文 `import { readConfig, query } from '../config/configStore.js'` —— configStore.js
//       **不导出 query**（它只是从 ../db.js 引入自用）。ESM 下引用不存在的具名导出 = 链接期报错，
//       整模块无法加载。（计划期的临时校验树里我给它垫了一个同时导出 readConfig/query 的 shim，
//       **恰好掩盖了这个缺陷** —— 替身形状与真实模块导出面不一致，是「假绿」的又一种成因。）
//       现改为从 '../db.js' 引入 query 作为默认值：既消除链接错误，也使「未显式注入 query」时
//       限速闸**真实生效**（原写法默认 undefined → overRateLimit 直接返回 false = 限速静默失效）。
//   P-3 工厂名 `createSignalRouter` → **`createDeliveryRouter`**：同名导出已被
//       src/signal/router.js 占用（告警→信号路由，签名 {now}），且两文件路径仅差一个字符
//       （router.js / route.js）。保留同名会制造「同名漂移」陷阱，故更名。
import { readConfig as defaultRead } from '../config/configStore.js';
import { query as defaultQuery } from '../db.js';

export const ALL_CHANNELS = ['inbox', 'email', 'im', 'webhook'];
// 无需外部收件人的渠道（平台内视角消费 crm.signal 完成「投递」）
const IN_PLATFORM_CHANNELS = ['inbox'];

export function createDeliveryRouter({ readConfig = defaultRead, query = defaultQuery } = {}) {
  // loadPolicy：读配置 → 归一化为可用策略。读不到 → configured:false + 空渠道（fail-closed）
  //   两种「读不到」必须可区分（P-2）：
  //     delivery_config_read_failed —— DB/连接故障（真故障，须报警）
  //     delivery_config_missing     —— 客户尚未配置（待办项）
  //   把前者压成后者 = 把真故障降级成"待配置项"，是本项目明令禁止的误归因。
  const emptyPolicy = (reason, extra = {}) => ({
    configured: false, reason, channels: [], route: {}, roleRecipients: {},
    quietHours: null, rateLimit: null, retryLimit: 0, ...extra,
  });

  async function loadPolicy({ tenantId = 'system' } = {}) {
    let row = null;
    let readFailed = null;
    try {
      row = await readConfig('signal-delivery', { tenantId });
    } catch (e) {
      readFailed = String(e?.message || e);
    }
    if (readFailed) return emptyPolicy('delivery_config_read_failed', { readError: readFailed });

    const cfg = row?.value || null;
    if (!cfg || typeof cfg !== 'object') return emptyPolicy('delivery_config_missing');

    const raw = cfg.channels || {};
    const channels = ALL_CHANNELS.filter((c) => raw[c] === 'on' || raw[c] === true);
    return {
      configured: true,
      reason: null,
      channels,
      route: cfg.route || {},
      roleRecipients: cfg.role_recipients || {},
      quietHours: cfg.quiet_hours || null,
      rateLimit: cfg.rate_limit || null,
      // 重试上限：无配置即 0（不重试）。**不设默认阈值字面量**——阈值一律配置化。
      retryLimit: Number.isInteger(cfg.retry) ? cfg.retry : 0,
    };
  }

  // 静默时段（跨午夜安全：start > end 表示跨越 0 点，如 22:00–06:00）
  function inQuietHours(quietHours, now = new Date()) {
    if (!quietHours || quietHours.start == null || quietHours.end == null) return false;
    const h = now.getHours();
    const { start, end } = quietHours;
    if (start === end) return false;
    if (start < end) return h >= start && h < end;
    return h >= start || h < end;
  }

  // 限速（Task 2b 修正，2026-09-17）：统计窗口内**出站渠道**已 sent 行数；达到上限即拒。
  //   根因（实测于 Task 2 执行期）：原 SQL 无 channel 过滤，inbox 的 sent 行计入出站配额，
  //   而 rate_limited 又归 globalSkip → 连带拦截站内投递且 retry=0 不可自愈。
  //   现在配额只约束出站渠道：exclude 站内渠道（IN_PLATFORM_CHANNELS）的 sent 行。
  //   修正的同时保留「静默时段全局生效」语义（那是运营显式意图，与配额性质不同）。
  async function overRateLimit(rateLimit, { tenantId, now = new Date() } = {}) {
    if (!rateLimit || typeof rateLimit !== 'object') return false;
    const windows = [
      { limit: rateLimit.per_hour, hours: 1 },
      { limit: rateLimit.per_day, hours: 24 },
    ].filter((w) => Number.isFinite(w.limit) && w.limit > 0);
    if (!windows.length) return false;
    if (typeof query !== 'function') return false; // 未注入 query（纯函数级单测）→ 不限速
    const excluded = IN_PLATFORM_CHANNELS; // ['inbox'] — 站内渠道不计入出站配额
    for (const w of windows) {
      const { rows: [r] } = await query(
        `SELECT COUNT(*)::int AS c FROM crm.signal_delivery
         WHERE tenant_id=$1 AND status='sent'
           AND channel <> ALL($3::text[])            -- 出站配额不计站内渠道（Task 2b）
           AND created_at > now() - make_interval(hours => $2)`,
        [tenantId, w.hours, excluded],
      );
      if (Number(r?.c || 0) >= w.limit) return true;
    }
    return false;
  }

  // 渠道选择：severity 路由优先；缺失则回落到「全部已启用渠道」。结果必须 ∩ policy.channels
  function channelsFor(signal, policy) {
    const byRoute = policy.route?.[signal?.severity];
    const wanted = Array.isArray(byRoute) && byRoute.length ? byRoute : policy.channels;
    return wanted.filter((c) => policy.channels.includes(c));
  }

  // 收件人解析：role_recipients[target_role]（首个为默认收件人）
  //   D1（设计 §3.2 修正）：**仅当租户为平台租户 `system`** 且业务角色解析不到时，回退 `role_recipients.platform`；
  //     platform 键同样缺失 → 仍返回 no_recipient（**system 不享有投递豁免**）；
  //     非 system 租户**绝不**回退 platform（防止跨租户借用收件人）；
  //     收件人一律来自 config_store —— 禁止硬编码平台收件人（继承「差异化 100% 后台配置化」铁律）。
  function recipientsFor(signal, policy, tenantId = signal?.tenant_id) {
    const pick = (role) => {
      const list = role ? policy.roleRecipients?.[role] : null;
      return Array.isArray(list) && list.length ? list : null;
    };
    const direct = pick(signal?.target_role);
    if (direct) return { recipients: direct, reason: null };
    if (tenantId === 'system') {
      const fallback = pick('platform');
      if (fallback) return { recipients: fallback, reason: null };
    }
    return { recipients: [], reason: 'no_recipient' };
  }

  // resolve：一次解析出「逐渠道决策」。全局性跳过（配置缺失/限速/静默）作用于全部渠道；
  //   渠道级跳过（no_recipient）只影响出站渠道，不影响 inbox。
  async function resolve({ signal, tenantId = signal?.tenant_id || 'system', now = new Date() } = {}) {
    const policy = await loadPolicy({ tenantId });
    if (!policy.configured) {
      return { configured: false, reason: policy.reason || 'delivery_config_missing', policy, decisions: [] };
    }
    if (policy.channels.length === 0) return { configured: true, reason: 'no_channel_enabled', policy, decisions: [] };

    const channels = channelsFor(signal, policy);
    if (channels.length === 0) return { configured: true, reason: 'no_channel_for_severity', policy, decisions: [] };

    // Task 2b：限速从 globalSkip 拆出。静默时段仍全局生效；限速只约束出站渠道。
    const globalSkip = inQuietHours(policy.quietHours, now) ? 'quiet_hours' : null;
    const outboundSkip = globalSkip || ((await overRateLimit(policy.rateLimit, { tenantId, now })) ? 'rate_limited' : null);

    const { recipients, reason: recipientMiss } = recipientsFor(signal, policy, tenantId);
    const decisions = channels.map((channel) => {
      // 站内渠道受静默时段约束，但**不受限速约束**（Task 2b：rate_limited 不得拦 inbox）
      if (IN_PLATFORM_CHANNELS.includes(channel)) {
        return { channel, recipient: null, skip: !!globalSkip, reason: globalSkip };
      }
      if (outboundSkip) return { channel, recipient: null, skip: true, reason: outboundSkip };
      if (recipientMiss) return { channel, recipient: null, skip: true, reason: recipientMiss };
      return { channel, recipient: recipients[0], skip: false, reason: null };
    });
    return { configured: true, reason: null, policy, decisions };
  }

  return { loadPolicy, inQuietHours, overRateLimit, channelsFor, recipientsFor, resolve, ALL_CHANNELS };
}
