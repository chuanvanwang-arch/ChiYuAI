// src/signal/dispatcher.js — 投递编排器（水泵）
// 设计输入：docs/2026-09-16-full-chain-integration-design.md v1.1 §3.1 / §3.1.1
// 存在理由（务必保留本注释，防后人误删）：
//   S1 交付了「投递 provider + 分发器类」（src/signal/delivery/index.js），但**没有任何生产触发点驱动它**
//   —— `createDeliveryRegistry` 在 src/ 下生产调用点为 0，仅被单元测试调用。
//   后果：crm.signal 有真实数据，而 crm.signal_delivery 恒为 0 行，
//   面板四条 delivery_silent 告警成立（正确防假绿行为，但暴露「造了水管没造水泵」）。
//   本模块即水泵：读 open signal → 经 route 决策 → 调既有 registry.deliver() → 落流水。
// 铁律：
//   ① 幂等：同 (signal_id, channel) 已 sent → 不重投（sentChannels）；
//      ⚠ 该幂等只在 **sent** 维度生效——`skipped`/`failed` 行允许按重试上限重投（设计如此）。
//      「skipped 每轮新增一行」曾是无界增长的根因，已由**台账侧确定性键**（F-6(b)）而非本层解决：
//      本层允许重投，台账层收敛为一行并累加 attempts。两层职责不得互相替代。
//   ② 重试上限来自配置（policy.retryLimit），编排器零阈值字面量；
//   ③ 不静默：所有 skipped 必带 last_error（no_recipient / quiet_hours / rate_limited / retry_exhausted）；
//   ④ **防双记**：provider 内部已调 deliveryStore.record()，编排器只在「自身判定 skip」时记录；
//   ⑤ **D1（设计 §3.1.1 修正）**：泵范围**含 `system` 平台租户** —— 严禁 `tenant_id <> 'system'`
//      （该写法会让平台级信号永久静默，正是「泵上线但红框不消失」的成因）；
//   ⑥ **D2（设计 §3.1.1 修正）**：候选集受时间窗约束（`make_interval(days => $n)`，来自
//      config_store['signal-dispatch'].max_age_days，缺省 7 天）——窗口**只收窄候选集**，
//      **绝不允许删除或迁移 `crm.signal` 行**（本仓绝对禁 DELETE）；
//   ⑦ **不静默（P-5 执行期修正）**：零投递必须能区分「渠道没配」与「没什么可做」——
//      故 pumpOnce/pumpAllTenants 回带 `idle: { reason → 条数 }`（来自 route.resolve 的 reason，
//      如 delivery_config_missing / no_channel_enabled / no_channel_for_severity），由调用方 emit trace。
//      **背景（真实库实测 2026-09-16）**：crm_native 中 signal-delivery 配置为**零行**、
//      419 条 open signal、signal_delivery 恒 0 行 —— 即本泵上线后若无此字段，将是「每 5 分钟
//      空转且完全无痕」；面板无告警与链路已通将不可区分。此字段是该风险的唯一可观测出口。
//
// 执行期修正（2026-09-16，已登记 docs/superpowers/plans/2026-09-16-full-chain-q1-export-dispatch.md）：
//   P-4 计划原文在本文件顶部 import 了 `createDeliveryRegistry` / `createDeliveryStore`，但两者
//       **在最终代码中均未被使用**（生产装配按计划下沉到 timers.js，dispatcher 只接收注入）。
//       未使用的 import 在 ESM 下仍会执行被引入模块的**模块体**（连带拉入 4 个 provider 与 pg 无关的
//       依赖链），纯属噪声与隐式耦合 → 已删除。本文件保持**纯工厂 + 依赖注入**，零副作用导入。
//
// 文件边界（务必遵守）：本文件**只导出 `createDispatcher` 一个函数**。生产装配在
//   `src/scheduler/timers.js`（那里本就 import query/pool），不要在此追加 createProductionDispatcher
//   之类的便捷构造器——否则会形成「两个装配点」的漂移源，并破坏本模块的零 DB 可测性。

// D2：窗口缺省值。仅在配置读取不可用时兜底；正常路径来自 config_store（继承「差异化 100% 后台配置化」铁律）
const WINDOW_DAYS_FALLBACK = 7;
const WINDOW_CONFIG_KEY = 'signal-dispatch';

export function createDispatcher({ query, deliveryRegistry, deliveryStore, router, readConfig } = {}) {
  // D2：解析泵窗口（天）。**平台级旋钮**：口径统一由平台租户 `system` 的配置决定，
  //   避免同一批 signal 因租户不同而候选集语义分裂。读不到 → 兜底值（并允许注入以做零 DB 单测）。
  async function resolveWindowDays() {
    if (typeof readConfig !== 'function') return WINDOW_DAYS_FALLBACK;
    try {
      const row = await readConfig(WINDOW_CONFIG_KEY, { tenantId: 'system' });
      const v = row?.value?.max_age_days;
      return Number.isFinite(v) && v > 0 ? v : WINDOW_DAYS_FALLBACK;
    } catch {
      return WINDOW_DAYS_FALLBACK; // 配置读取异常 → 兜底（不阻断泵；异常本身由调用方 trace）
    }
  }

  // 已 sent 渠道集合（幂等依据）。只认 sent —— failed/skipped 允许按重试上限重投。
  async function sentChannels(signal_id) {
    const { rows } = await query(
      `SELECT DISTINCT channel FROM crm.signal_delivery WHERE signal_id=$1 AND status='sent'`,
      [signal_id],
    );
    return new Set((rows || []).map((r) => r.channel));
  }

  // 某渠道已尝试次数。**F-6(b)（2026-09-16）：必须读 `attempts` 列，不得用 `COUNT(*)`** ——
  //   `signal_delivery` 已收敛为「同 (signal_id, channel) 唯一一行」（见 signalDeliveryStore.deliveryKey，
  //   含 ON CONFLICT DO UPDATE + attempts 累加）。此时 `COUNT(*)` 恒为 1 ⇒ `attempts > retryLimit`
  //   只对 `retryLimit < 1` 成立，retry 上限**基本失效** ⇒ 无限重投（新缺陷）。
  //   ⚠ 本行与 signalDeliveryStore 的幂等键是**成对契约**：任何一侧单独回退都会产生缺陷。
  //   配套守卫：test/signal/dispatcher.test.js「F-6(b) 守卫」（断言该 SQL 读 attempts 且不含 COUNT(*)）。
  async function attemptCount(signal_id, channel) {
    const { rows: [r] } = await query(
      `SELECT COALESCE(MAX(attempts), 0)::int AS c FROM crm.signal_delivery WHERE signal_id=$1 AND channel=$2`,
      [signal_id, channel],
    );
    return Number(r?.c || 0);
  }

  // 单条 signal 的投递
  async function pumpSignal({ signal, tenantId, now }) {
    const resolved = await router.resolve({ signal, tenantId, now });
    if (!resolved.decisions || resolved.decisions.length === 0) {
      // P-5（执行期修正）：不静默 —— 路由无决策 ≠ 无事发生。回带原因，由上层聚合后 emit trace。
      //   否则「租户根本没配渠道」与「确实没有待投递项」在流水与日志上完全不可区分（本仓头号假绿形态）。
      return { sent: 0, failed: 0, skipped: 0, idleReason: resolved.reason || 'no_decision' };
    }

    const already = await sentChannels(signal.signal_id);
    const retryLimit = Number.isInteger(resolved.policy?.retryLimit) ? resolved.policy.retryLimit : 0;
    let sent = 0, failed = 0, skipped = 0;

    for (const d of resolved.decisions) {
      if (already.has(d.channel)) continue;              // ① 幂等
      if (d.skip) {                                      // ③ 自身判定 skip → 记录（不静默）
        // countAttempt:false（2026-09-17 修正）：skip 不是「投递尝试」，不得消耗重试预算。
        //   否则 no_recipient/quiet_hours/rate_limited 会随泵累加 attempts，把 attempts 变成泵轮次计数器。
        await deliveryStore.record({
          signal_id: signal.signal_id, tenant_id: tenantId,
          channel: d.channel, status: 'skipped', last_error: d.reason, countAttempt: false,
        });
        skipped += 1;
        continue;
      }
      const attempts = await attemptCount(signal.signal_id, d.channel);
      if (attempts > retryLimit) {                       // ② 超重试上限 → 放弃（既有 failed 行已留痕）
        // countAttempt:false 同上：终结态记账本身不是一次尝试。
        //   否则「已放弃」的 signal 每轮泵都会把 attempts 再 +1（实测 retryLimit=1 的租户累到 attempts=6）→ 无界增长。
        await deliveryStore.record({
          signal_id: signal.signal_id, tenant_id: tenantId,
          channel: d.channel, status: 'skipped', last_error: 'retry_exhausted', countAttempt: false,
        });
        skipped += 1;
        continue;
      }
      // ④ 交给 provider：其内部负责 record(sent/failed)，编排器不补记
      // recipient 来自上面 route.resolve 的决策（收件人解析的**唯一**事实源在 route.js）——
      //   原先此处未传，导致 email provider 只能去读 `signal.payload.to`，而该键**无任何生产者**
      //   （2026-09-16 实测 grep 0 命中）→ 即使 SMTP 配好也恒以 `to: undefined` 失败。
      const res = await deliveryRegistry.deliver({
        signal, channel: d.channel, store: deliveryStore, recipient: d.recipient || null,
      });
      if (res?.ok && res?.skipped) skipped += 1;
      else if (res?.ok) sent += 1;
      else failed += 1;
    }
    return { sent, failed, skipped };
  }

  // 泵单租户。D2：候选集限定在时间窗内（窗口外 signal 仍留在库中，只是不再被泵）
  async function pumpOnce({ tenantId = 'system', maxSignals = 200, now = new Date(), windowDays } = {}) {
    const days = Number.isFinite(windowDays) ? windowDays : await resolveWindowDays();
    const { rows: signals } = await query(
      `SELECT * FROM crm.signal
        WHERE tenant_id=$1 AND status='open' AND created_at >= now() - make_interval(days => $2)
        ORDER BY created_at ASC LIMIT $3`,
      [tenantId, days, maxSignals],
    );
    const totals = { signals: (signals || []).length, sent: 0, failed: 0, skipped: 0, idle: {} };
    for (const signal of signals || []) {
      try {
        const r = await pumpSignal({ signal, tenantId, now });
        totals.sent += r.sent; totals.failed += r.failed; totals.skipped += r.skipped;
        if (r.idleReason) totals.idle[r.idleReason] = (totals.idle[r.idleReason] || 0) + 1;
      } catch (e) {
        totals.failed += 1;
        totals.errors = totals.errors || [];
        totals.errors.push({ signal_id: signal.signal_id, error: String(e?.message || e) });
      }
    }
    return totals;
  }

  // 泵全部租户：单租户失败不中断其余（失败项收集返回，由调用方 emit trace）
  //   D1：**不得排除 `system`** —— 平台级信号同样必须被泵（否则平台告警永久静默）
  async function pumpAllTenants({ maxSignals = 200, now = new Date(), windowDays } = {}) {
    const days = Number.isFinite(windowDays) ? windowDays : await resolveWindowDays();
    const { rows } = await query(
      `SELECT DISTINCT tenant_id FROM crm.signal
        WHERE status='open' AND created_at >= now() - make_interval(days => $1)`,
      [days],
    );
    const totals = { tenants: (rows || []).length, days, sent: 0, failed: 0, skipped: 0, idle: {}, failures: [] };
    for (const { tenant_id } of rows || []) {
      try {
        const r = await pumpOnce({ tenantId: tenant_id, maxSignals, now, windowDays: days });
        totals.sent += r.sent; totals.failed += r.failed; totals.skipped += r.skipped;
        // P-5：跨租户聚合空转原因（键为 route.resolve 的 reason；见 pumpSignal）
        for (const [k, v] of Object.entries(r.idle || {})) totals.idle[k] = (totals.idle[k] || 0) + v;
      } catch (e) {
        totals.failures.push({ tenant_id, error: String(e?.message || e) });
      }
    }
    return totals;
  }

  return { sentChannels, attemptCount, pumpSignal, pumpOnce, pumpAllTenants, resolveWindowDays };
}
