// src/signal/scheduleScanner.js — T15 时间型信号（signal-schedule 配置驱动）
// 三类：quote_approval_timeout / stage_silence / price_baseline_drift
// 阈值全读 config_store['signal-schedule']（零字面量）；命中落 crm.signal source='rule-scan'
import { readConfig as defaultRead } from '../config/configStore.js';

export function createScheduleScanner({ query, signalStore, readConfig = defaultRead } = {}) {
  // 单规则命中评估（纯函数，可单测）：返回 true 表示该实体命中
  function hitsRule(rule, entity, now = Date.now()) {
    const p = entity.payload || {};
    const cond = rule.condition || {};
    const fieldVal = p[cond.field];
    if (cond.op === 'eq' && fieldVal !== cond.value) return false;
    if (cond.op === 'ne' && fieldVal === cond.value) return false;
    // L3 前瞻语义（2026-09-16）：'due_within_days' —— 「截止日落在未来 N 天内」
    //   存在理由：既有实现只支持 threshold_days 的「已逾期 N 天」（age ≥ N），而「投标截止」「汇报到期」
    //   属**前瞻**型；用 age 语义会得到「截止日过去 N 天之后才提醒」（时机反了）。
    //   与既有 age 语义互斥且不改后者：本分支只认 condition.op，**不读** rule.threshold_days，
    //   故旧规则（有 threshold_days、无该 op）走原路径 → 零回归（见测试负向对照）。
    if (cond.op === 'due_within_days') {
      // ts_field 必须由规则**显式**声明：回退 updated_at 会把「最近改过」当截止日 → 假提醒
      if (!rule.ts_field) return false;
      const ts = p[rule.ts_field];
      if (!ts) return false;
      const win = Number(cond.threshold_days);
      if (!Number.isFinite(win)) return false;
      const dueInDays = (new Date(ts).getTime() - now) / 86400000;
      if (Number.isNaN(dueInDays)) return false;   // 非 ISO 文本（实测 payload.bidding.started_at 即此类）
      return dueInDays >= 0 && dueInDays <= win;   // 已过期（<0）与超窗（>win）均不命中
    }
    if (rule.threshold_days != null) {
      const ts = p[rule.ts_field || 'updated_at'] || p.approval_requested_at || p.last_activity_at;
      if (!ts) return false;
      const ageDays = (now - new Date(ts).getTime()) / 86400000;
      if (ageDays < rule.threshold_days) return false;
    }
    return true;
  }

  // 周期型命中：现在的小时/星期等于规则声明值即为窗口（二者省略则恒真 = 每小时）。
  //   ⚠ 窗口判定只到「小时」粒度 → 语义上依赖调用频率 ≤ 每小时一次；**幂等**不靠窗口，靠 bucketKey。
  function hitsPeriodic(rule, now = Date.now()) {
    const d = new Date(now);
    if (Number.isInteger(rule.weekday) && d.getDay() !== rule.weekday) return false;
    if (Number.isInteger(rule.hour) && d.getHours() !== rule.hour) return false;
    return true;
  }

  // 桶键：决定「多久算一次新的到期提醒」。同日/同周/同月内重复扫描 → 键相同 → 由
  //   signalStore.create 的 dedup_key 幂等吸收（不新增行）。
  function bucketKey(now = Date.now(), bucket = 'day') {
    const d = new Date(now);
    const p = (n) => String(n).padStart(2, '0');
    if (bucket === 'month') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
    if (bucket === 'week') {
      // ISO 周（周一为首日）
      const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      const day = t.getUTCDay() || 7;
      t.setUTCDate(t.getUTCDate() + 4 - day);
      const yStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
      const week = Math.ceil(((t - yStart) / 86400000 + 1) / 7);
      return `${t.getUTCFullYear()}-W${p(week)}`;
    }
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // 日历载体日期（2026-09-17 补）：把**前瞻型**规则命中的那个日期写进信号 payload.event_at，
  //   使 `delivery/email.js` 能挂 .ics 附件、`/api/signals/:id/ics` 能下载 —— 这是需求③
  //   「到点自动运行……**同时建立日历**（汇报/投标/拜访）」的唯一可达路径。
  //   ⚠ 实测缺口（2026-09-17，本地 crm_native）：全库 `payload ? 'event_at'` 的信号 = **0** 行，
  //     即 buildIcs 恒返回 null ⇒「建立日历」在此之前**结构性不可达**（不是"没配日历服务"，是没有日期）。
  //
  //   为什么**只**对 due_within_days 写：
  //     ① age 型（stage_silence / quote_approval_timeout）谈的是「已经过了多久」，其时间戳在**过去**；
  //        写进 event_at 会让 buildIcs 产出**过去的幽灵日程**，违反 ics.js 铁律②「缺日期不造日程」的精神
  //        （用户日历里出现一个早已发生的"会议"比没有更坏）。
  //     ② 周期型（report_due）本就不绑日期。
  //   与 hitsRule 同源判据：ts_field 必须由规则显式声明；非 ISO 文本（如 payload.bidding.started_at
  //   的自由文本 `"2026-11-04 前后"`）→ new Date() 得 NaN → 不写（错误日期比没有日期更坏）。
  function calendarDate(rule, entity) {
    if (rule?.condition?.op !== 'due_within_days') return null; // 仅前瞻型
    if (!rule.ts_field) return null;                            // 与 hitsRule 同：禁回退 updated_at
    const ts = entity?.payload?.[rule.ts_field];
    if (!ts) return null;
    return Number.isNaN(new Date(ts).getTime()) ? null : ts;
  }

  async function scanOnce({ tenantId = 'system', now = Date.now() } = {}) {
    const cfgRow = await readConfig('signal-schedule', { tenantId }).catch(() => null);
    const cfg = cfgRow?.value || {};
    if (cfg.enabled === false) return { scanned: 0, signals: 0 };
    const rules = Array.isArray(cfg.rules) ? cfg.rules.filter((r) => r.enabled !== false) : [];
    if (!rules.length) return { scanned: 0, signals: 0 };
    // 周期型规则不绑粒子（entity_type 为 null）→ 不得进入粒子类型集合：
    //   传 null 进 `type = ANY(...)` 会让该元素恒为 NULL 匹配（等价于静默丢规则）。
    const particleRules = rules.filter((r) => r.schedule_kind !== 'periodic' && r.entity_type);
    const periodicRules = rules.filter((r) => r.schedule_kind === 'periodic');
    const types = [...new Set(particleRules.map((r) => r.entity_type))];
    const { rows } = await query(
      `SELECT id, tenant_id, payload FROM crm.particles WHERE type = ANY($1::text[]) AND tenant_id=$2`,
      [types, tenantId]
    );
    let signals = 0;
    let deduped = 0;          // 被 dedup 吸收的命中数（与 signals 分开，保留既有 signals 计数语义）
    const missing = [];       // 「规则就绪但数据面缺失」的显式归因（禁止静默零命中）
    for (const entity of rows) {
      for (const rule of particleRules) {
        if (entity.payload?.type && entity.payload.type !== rule.entity_type) continue;
        if (!hitsRule(rule, entity, now)) continue;
        // 前瞻型把被判定日期带进 payload.event_at（= .ics 日历载体；见 calendarDate 头注）。
        //   缺日期时**不加该键**（而非 event_at:null）——保持「无该键」与「有该键」在 DB 上可区分，
        //   便于用 `payload ? 'event_at'` 直接审计日历覆盖率。
        const eventAt = calendarDate(rule, entity);
        const r = await signalStore.create({
          tenant_id: tenantId, source: 'rule-scan', kind: rule.kind,
          severity: rule.severity || 'medium', target_role: rule.target_role || 'sales',
          // T21 个人隔离：时间型信号的负责人取粒子 payload.owner_id（商机的跟进责任人是私人事务）。
          //   ⚠ 原实现**丢弃了**该键（entity.payload.owner_id 一直可读却从未传）→ 204 行 owner_id 全 NULL 的成因之一。
          //   无主的（如公海/未分配）落 NULL → 按 target_role 广播，符合语义。
          owner_id: entity.payload?.owner_id || null,
          particle_id: entity.id,
          payload: {
            subject: `${rule.kind} 命中`, rule_id: rule.id,
            ...(eventAt ? { event_at: eventAt } : {}),
          },
          evidence: { rule_id: rule.id, threshold_days: rule.threshold_days },
          dedup_key: `schedule:${rule.id}:${entity.id}:${rule.bucket || 'day'}`,
        });
        if (r?.ok) { signals += 1; if (r.deduped) deduped += 1; }
      }
    }
    // ── 周期型规则：不读 particles，按租户内启用用户逐人产个人级信号 ──
    for (const rule of periodicRules) {
      if (!hitsPeriodic(rule, now)) continue;
      const { rows: users } = await query(
        `SELECT username FROM crm.crm_users WHERE tenant_id=$1 AND enabled IS TRUE ORDER BY username`,
        [tenantId],
      ).catch(() => ({ rows: [] }));              // 用户面读取失败 → 归因见 evidence.missing，不静默造假
      if (!users.length) { missing.push({ rule_id: rule.id, reason: 'no_enabled_users' }); continue; }
      for (const u of users) {
        const r = await signalStore.create({
          tenant_id: tenantId, source: 'rule-scan', kind: rule.kind,
          severity: rule.severity || 'low', target_role: rule.target_role || 'sales',
          owner_id: u.username,
          payload: { subject: `${rule.kind} 到期`, rule_id: rule.id },
          evidence: { rule_id: rule.id, schedule_kind: 'periodic', weekday: rule.weekday ?? null, hour: rule.hour ?? null },
          dedup_key: `schedule:${rule.id}:${u.username}:${bucketKey(now, rule.bucket)}`,
        });
        if (r?.ok) { signals += 1; if (r.deduped) deduped += 1; }
      }
    }
    return { scanned: rows.length, signals, deduped, missing };
  }
  return { scanOnce, hitsRule, hitsPeriodic, bucketKey, calendarDate };
}
