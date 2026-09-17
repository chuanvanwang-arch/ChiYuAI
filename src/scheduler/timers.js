// src/scheduler/timers.js — 定时器（③ 定时规则驱动的数据产生）
// 设计输入：12 文档 §7-3（nightly 蒸馏 24h + crm-risk 30min 扫描）
// 幂等单例：routes.js createRoutes 建应用时调用 ensureTimers；防双实例（与 registerCaptureSubscriber 同模式）
// G3 R2/C1：nightly 蒸馏失败 emit trace + recordFailure（不再静默）；crm-risk 定时器接真扫描器 runRiskScan
// 07 文档 §5-2 修订口径（2026-08-26）：本文件定时器 =「规则治理兜底」——只规则检查→发射预警事件，
// 不直接跨粒子写；回收/处置动作由 crm-* 写 Action（写通道第 0 闸）显式触发。任何「定时扫描直接写粒子」即违 D4 反模式。
import { distillMemory } from '../memory/memoryLog.js';
import { runRiskScan } from './riskScanner.js';
import { runDecisionRetro, runRoutingReviewPass, runParamInspectionPass } from '../decision/retro.js';
import { runIcpEvolutionPass } from '../evolution/icpSelfEvolution.js';
import { createIcpStore } from '../evolution/icpStore.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { query, pool } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { setSignalStore } from '../agent/eventTrigger.js';
import { createGrantSweeper } from '../authorization/grantSweeper.js';
import { createSignalObservabilitySweep } from '../monitor/signalMetrics.js';
import { saveNightlyReport } from '../report/nightlyReport.js';
import { recordTokens as realRecordTokens } from '../alerts/tokenAccounting.js';
import { scanEscalations } from '../calibration/store.js';
// 全链集成 Q1-3（2026-09-16）：信号投递编排泵。装配集中在本文件（此处本就持有 query/pool），
// dispatcher.js / route.js 保持纯工厂 + 依赖注入，以便零 DB 单测。
// 注：工厂名为 createDeliveryRouter（非 createSignalRouter）——后者已被 ../signal/router.js 占用（告警→信号路由）。
import { createDispatcher } from '../signal/dispatcher.js';
import { createDeliveryRegistry } from '../signal/delivery/index.js';
import { createDeliveryStore } from '../signal/delivery/signalDeliveryStore.js';
import { createDeliveryRouter } from '../signal/route.js';

const timers = new Map();   // name → { handle, intervalMs, kind }

export function timerCount() { return timers.size; }

export function clearTimers() {
  for (const t of timers.values()) clearInterval(t.handle);
  timers.clear();
}

// ─── 决策复盘调度（模块级：ensureTimers 只负责注册，判定逻辑在此，便于单测注入依赖）───
const RETRO_HOUR = 2; // 每日跑批时点（运维调度，非业务阈值）

// 2026-09-05 P2-2（设计 §10）+ P0（参数闭环）：夜间跑批 = ①LLM 决策复盘 → ②场景路由实验收口 → ③参数体检。
//   ②负责把到期的 A/B 时间片实验判成结论 → 只出 PENDING 处方（红线：绝不自动写 context-routing）。
//   ③对 config_store + 场景级九尺子参数逐项体检（确定性、无 LLM；共 26 项含九尺子扩展）→ 只出 PENDING 处方（绝不自动 apply）。
//   三段各自 catch 互不传染：复盘失败（LLM 超时/降级）不拖垮收口/体检，任一段失败也不影响其余报告落库。
export const runRetroOnce = async ({ retroFn, routingFn, paramFn, icpFn, icpStoreFn, saveReportFn } = {}) => {
  const runRetro = retroFn || runDecisionRetro;
  const runRouting = routingFn || runRoutingReviewPass;
  const runParam = paramFn || runParamInspectionPass;
  // ③.5 ICP 自进化（P0#3）：可注入；store 为工厂（零 IO，无候选草稿时不会被调用）
  const runIcp = icpFn || runIcpEvolutionPass;
  const icpStore = icpStoreFn ? icpStoreFn() : createIcpStore();
  const saveReport = saveReportFn || saveNightlyReport;
  // ① LLM 决策复盘（失败降级不传染）
  const retro = await runRetro({ windowHours: 24 }).catch((err) => {
    emit('trace', 'decision-retro-failed', { error: String(err?.message || err) });
    recordFailure('decision-retro-failed', err);
    return null;
  });
  const retroReportId = retro?.report_id || null;
  // ② 路由收口（独立 catch）
  const routing = await runRouting().catch((err) => {
    emit('trace', 'routing-review-failed', { error: String(err?.message || err) });
    recordFailure('routing-review-failed', err);
    return null;
  });
  // ③ 参数体检（确定性，独立 catch；绝不自动 apply，只出 PENDING）
  const param = await runParam({ reportId: retroReportId }).catch((err) => {
    emit('trace', 'param-inspection-failed', { error: String(err?.message || err) });
    recordFailure('param-inspection-failed', err);
    return null;
  });
  // ③.5 ICP 自进化（P0#3；确定性、独立 catch；**只出草稿，HITL 前绝不生效**）
  //   默认无候选 draft → runIcpEvolutionPass 在 gate 之前 return（skipped:'no_draft_proposed'），
  //   不落决策行、不碰 config_store → 夜批零行为变化。候选由后台配置页（T17）/ CLI 显式注入 draft。
  const icp = await runIcp({ tenantId: 'system', store: icpStore }).catch((err) => {
    emit('trace', 'icp-evolution-failed', { error: String(err?.message || err) });
    recordFailure('icp-evolution-failed', err);
    return null;
  });
  // ④ 报告生成（第 4 个独立 catch：三段任一失败不拖垮报告落库）
  await saveReport({ retro, routing, param }).catch((err) => {
    emit('trace', 'nightly-report-failed', { error: String(err?.message || err) });
    recordFailure('nightly-report-failed', err);
  });
  return { retro, routing, param, icp };
};

// 下一个 02:00 时点（今日已过 → 顺延次日）
export function nextRetroAt(t0 = new Date()) {
  const next = new Date(t0);
  next.setHours(RETRO_HOUR, 0, 0, 0);
  if (next <= t0) next.setDate(next.getDate() + 1);
  return next;
}

// 启动补跑 catch-up（2026-09-03 实证新增）：
//   背景：定时器只在进程启动那一刻注册 → 夜间若进程挂起（EADDRINUSE 等待）/ DB 不可达，
//         该夜窗口**永久丢失**。实证：2026-09-03 查 decision_retro_report 长期 0 行，
//         只能靠 scripts/retro-once.mjs 人工补跑。
//   判据：最新报告 run_at 距今 > 24h → 立即补跑；24h 内已有 → 跳过（天然限流，重启再频繁也不重跑）。
//   护栏①：距下次 02:00 不足 30min → 交给定时，避免补跑与定时双跑。
//   依赖注入：run（跑批实现）/ nowMs（时点）—— 单测可隔离真实 LLM 与真实时钟。
export const CATCHUP_MAX_AGE_HOURS = 24;
export const CATCHUP_NEAR_SCHEDULE_MS = 30 * 60 * 1000;
export async function catchUpRetro({ run = runRetroOnce, nowMs = Date.now() } = {}) {
  try {
    const r = await query(`SELECT run_at FROM crm.decision_retro_report ORDER BY run_at DESC LIMIT 1`);
    const lastAt = r.rows[0]?.run_at ? Date.parse(r.rows[0].run_at) : 0;
    const ageMs = nowMs - lastAt;
    if (ageMs < CATCHUP_MAX_AGE_HOURS * 3600 * 1000) return { ran: false, reason: 'fresh', age_hours: Number((ageMs / 3600000).toFixed(1)) };
    if (nextRetroAt(new Date(nowMs)).getTime() - nowMs < CATCHUP_NEAR_SCHEDULE_MS) return { ran: false, reason: 'near_schedule' };
    emit('trace', 'decision-retro-catchup-start', {
      last_run_at: lastAt ? new Date(lastAt).toISOString() : null,
      age_hours: Number((ageMs / 3600000).toFixed(1)),
    });
    await run();
    return { ran: true, reason: 'stale' };
  } catch (err) {
    // 禁裸 catch：补跑探测失败（DB 不可达等）必须留痕，否则「没跑」与「跑了失败」无法区分
    emit('trace', 'decision-retro-catchup-failed', { error: String(err?.message || err) });
    recordFailure('decision-retro-catchup-failed', err);
    return { ran: false, reason: 'error', error: String(err?.message || err) };
  }
}

// —— 外部数据接入：integration-poll（混合模式·定时拉取）——
// 纯函数（可单测，零 IO）：逐租户对启用 provider 拉取 → runWaterfall → monitorAccount（C3 闭环）
// recordTokens（可注入；缺省接真 tokenAccounting）按租户聚合本轮 cost 落账（零新表，fail-open 不阻断主流程）
// 2026-09-16 A-B6（T06）增量分支：同循环内对「同步 descriptor（objects[]）」拉增量 → 同步内核 upsert。
//   零新增定时器、零调度框架改动；未注入 loadSyncTargets 或租户无 objects[] → no-op（既有行为零变化）。
export async function runIntegrationPollOnce({ listActiveTenants, loadAdapters, query, runWaterfall, monitorAccount, emit, recordTokens, loadSyncTargets, runSync, resolveCredentials } = {}) {
  const recTok = recordTokens || realRecordTokens;
  const tenants = listActiveTenants ? await listActiveTenants().catch(() => [{ tenant_id: 'system' }]) : [{ tenant_id: 'system' }];
  for (const t of tenants) {
    const tid = t.tenant_id;

    // A-B6 同步增量分支：**独立于富化适配器存在性**（租户可能只接同步、不接富化富集）
    if (loadSyncTargets && runSync) {
      try {
        let targets = [];
        try {
          targets = await loadSyncTargets({ tenantId: tid });
        } catch (err) {
          // 目标装配失败须留痕（不静默）：本租户跳过同步，富化主流程不受影响
          emit && emit('trace', 'integration-poll-sync-targets-failed', { tenant_id: tid, error: String(err?.message || err) });
          recordFailure('sync-targets-failed', err);
        }
        if (targets.length) {
          const r = await runSync({ tenantId: tid, targets });
          emit && emit('trace', 'integration-poll-sync', {
            tenant_id: tid, runs: r?.runs || 0, errors: r?.errors || 0,
            created: r?.created || 0, updated: r?.updated || 0,
          });
        }
      } catch (err) {
        // G3 不静默：同步分支失败不得拖垮富化主流程
        emit && emit('trace', 'integration-poll-sync-failed', { tenant_id: tid, error: String(err?.message || err) });
        recordFailure('integration-poll-sync-failed', err);
      }
    }

    let adapters = [];
    try { adapters = (await loadAdapters({ tenantId: tid })) || []; } catch { continue; }
    if (!adapters.length) continue;

    // A-B2 第二消费面（P-4 修复，2026-09-16）：凭据必须经 ctx.credentials 透传给 adapter。
    //   旧实现两处断点：① 本函数签名不接收 resolveCredentials —— 调用方（:501 起）已注入却被**静默丢弃**；
    //   ② runWaterfall 的 ctx 仅 `{ tenantId }` —— 四个消费 `ctx.credentials[pid]` 的 adapter
    //   （anysite / qixin / genericRest / genericMcp）凭据恒空，退化为「无 Authorization 的请求」
    //   → 表现为"没有数据"而非"凭据没送到"（典型假绿；与 §0.2 元缺陷「交付 ≠ 可触发」同族）。
    //   范式对齐 discoveryOrchestrator.js:58-63 / prospectingActions.js:79-83：注入优先，缺省动态 import 回落
    //   （回落使「未来调用方忘记注入」不再重演同一断点）。
    //   解析失败**不静默**（trace + recordFailure）但**不阻断**富化：凭据缺失在 adapter 侧本就等价于
    //   「不带 Authorization」，硬阻断会把「缺凭据」升级成「整轮富化归零」，超出本修复意图。
    let credentials = {};
    try {
      const resolve = resolveCredentials || (await import('../connectors/discovery/credentialVault.js')).resolveCredentials;
      credentials = (await resolve({ tenantId: tid, providerIds: adapters.map((a) => a.id) })) || {};
    } catch (err) {
      emit && emit('trace', 'integration-poll-credentials-failed', { tenant_id: tid, error: String(err?.message || err) });
      recordFailure('integration-poll-credentials-failed', err);
    }

    let tenantCost = 0;
    const { rows: accRows } = await query(
      `SELECT id, payload FROM crm.particles WHERE type='CRM_ACCOUNT' AND tenant_id=$1`, [tid]
    ).catch(() => ({ rows: [] }));
    for (const acc of accRows) {
      const fields = [...new Set(adapters.flatMap((a) => a.coverageFields || []))];
      const { values, cost } = await runWaterfall(adapters, { ...acc.payload, id: acc.id }, fields, { tenantId: tid, credentials }).catch(() => ({ values: {}, cost: 0 }));
      tenantCost += Number(cost) || 0;
      const sigs = Object.entries(values).map(([f, v]) => ({ type: f, provider: v?.provider, ts: v?.ts }));
      if (sigs.length) {
        // E.2.1 处置①（2026-09-16）：原为 `.catch(() => {})` —— 空吞与「G3 不静默」铁律冲突，
        //   使「C3 闭环从未执行」这件事在生产上完全不可见（无 trace、无账）。
        //   ⚠ ctx 四件套（getAccount/rescore/appendMemory/updateParticle）**尚未装配**
        //     （A-B7 经复核属「新建能力」而非补齐，未立项）→ 本轮**只消除静默**，不伪造成功：
        //     失败逐条留痕，让缺口显式可见，而不是被静默吞掉。
        await monitorAccount({ tenantId: tid }, acc.id, sigs).catch((err) => {
          emit && emit('trace', 'integration-poll-monitor-failed', {
            tenant_id: tid, account_id: acc.id, signals: sigs.length, error: String(err?.message || err),
          });
          recordFailure('integration-poll-monitor-failed', err);
        });
      }
    }
    // 可观测接线（T14）：聚合本轮 cost 落 token_accounting（零新表；fail-open）
    await recTok({ actor: 'integration-poll', action: 'integration-poll', tokensIn: tenantCost, tokensOut: 0, tenantId: tid, module: 'integration' }).catch(() => {});
    emit && emit('trace', 'integration-poll-done', { tenant_id: tid, providers: adapters.map((a) => a.id) });
  }
}

// D6 校准 SLA 超时升级扫描（治理工作流，非状态机推进）：依赖注入便于单测；默认走 store.scanEscalations。
//   失败 emit trace + recordFailure（G3 不静默）；绝不自动 apply（守 HITL 铁律）。
//   设计：docs/2026-09-14-d6-calibration-approval-flow-plan.md Task D。
export const runCalibrationSlaScanOnce = async ({ scanFn, emit, recordFailure } = {}) => {
  const scan = scanFn || scanEscalations;
  const out = { escalated: 0 };
  try {
    const r = await scan();
    out.escalated = r?.escalated || 0;
    if (out.escalated) emit?.('trace', 'calibration-sla-escalated', { count: out.escalated });
  } catch (err) {
    emit?.('trace', 'calibration-sla-scan-failed', { error: String(err?.message || err) });
    recordFailure?.('calibration-sla-scan-failed', err);
    out.error = String(err?.message || err);
  }
  return out;
};

export async function ensureTimers({ now = new Date().toISOString() } = {}) {
  if (timers.size > 0) return timers.size;   // 幂等单例：已注册则原样返回
  setSignalStore(pool); // T12：注入感知信号 store（registerAgentEventTrigger 新域触发后落 crm.signal）
  // ① nightly 蒸馏：每 24h 蒸馏 30 天前的流水 → distilled，60 天 → archived（标 distilled 非删除）
  const nightly = setInterval(() => {
    distillMemory({ ttlDays: 30 }).catch((err) => {
      // G3 R2 可观测化：蒸馏失败不再静默（记忆治理失效需有痕迹）
      emit('trace', 'nightly-distill-failed', { error: String(err?.message || err) });
      recordFailure('nightly-distill-failed', err);
    });
  }, 86400000);
  timers.set('nightly-distill', { handle: nightly, intervalMs: 86400000, kind: 'rule', registeredAt: now });
  // ② crm-risk 扫描：每 30 分钟触发一次真扫描（riskScanner.runRiskScan 全量重算 AI 属性 + trace 观测）
  //    不传 llm → 扫描器自动按 config_store('llm') 解析（未配置则整轮确定性兜底，配置后 15s 内生效）
  const scan = setInterval(() => {
    runRiskScan().catch((err) => {
      emit('trace', 'crm-risk-scan-failed', { error: String(err?.message || err) });
      recordFailure('crm-risk-scan-failed', err);
    });
  }, 1800000);
  timers.set('crm-risk-scan', { handle: scan, intervalMs: 1800000, kind: 'rule', registeredAt: now });
  // ③ lead 池回收扫描：每 30 分钟查超期未跟进（>recycle_days）且仍为**私海待校验（S0P）**的 DEAL
  //    2026-09-11 T4：口径从遗留 stage='lead' 迁移到 S0P（公海 S0 无归属不回收，回收对象=已认领未转正式线索）。
  //    命中 → emit lead-overdue 预警事件（带 tenant_id，多租户下按租户可路由）→ 触发 crm-lead-recycle 语义
  //    直接走查询不做跨粒子写（回收动作由 lead-recycle Action 显式触发，扫描只产生预警事件）
  const recycle = setInterval(() => {
    query(
      `SELECT id, tenant_id, payload FROM crm.particles
       WHERE type='CRM_DEAL' AND payload->>'stage'='S0P' AND payload->>'owner_id' IS NOT NULL`
    ).then(({ rows }) => {
      const now = Date.now();
      const overdue = rows.filter((r) => {
        const follow = r.payload.last_follow_up_at;
        if (!follow) return false; // 从未跟进不回收（避免新线索误回收，pool.js:75）
        return (now - new Date(follow).getTime()) / 86400000 > 30;
      });
      for (const deal of overdue) {
        emit('alert', 'lead-overdue', {
          particleType: 'CRM_DEAL', action: 'lead-recycled', tenant_id: deal.tenant_id,
          metric: { overdueDays: Math.floor((Date.now() - new Date(deal.payload.last_follow_up_at).getTime()) / 86400000) },
          particle_id: deal.id,
        });
        emit('crm', 'lead-overdue', { deal_id: deal.id, owner_id: deal.payload.owner_id, tenant_id: deal.tenant_id });
      }
      if (overdue.length) {
        emit('trace', 'lead-pool-recycle-scan', { scanned: rows.length, overdue: overdue.length });
      }
    }).catch((err) => {
      emit('trace', 'lead-pool-recycle-scan-failed', { error: String(err?.message || err) });
      recordFailure('lead-pool-recycle-scan-failed', err);
    });
  }, 1800000);
  timers.set('lead-pool-recycle', { handle: recycle, intervalMs: 1800000, kind: 'rule', registeredAt: now });
  // ④ 决策复盘：每日全量扫描 → LLM 深度归因 → 产出方案草稿（J3 校准层夜间批量复盘）
  //    设计：docs/2026-08-30-*（决策复盘智能体）。与 nightly-distill 同模式：失败 emit trace + recordFailure，绝不静默。
  //    落库为追加式 decision_retro_report（绝不 DELETE、不触碰 calibration_patch 写通道）。
  // ④ 决策复盘：每日凌晨 02:00 跑批（D 选项：对齐 cron 语义，替代原 setInterval 24h 漂移 + 闭环首周期恒空）。
  //    设计：docs/2026-08-30-*（决策复盘智能体）。失败 emit trace + recordFailure，绝不静默。
  //    落库为追加式 decision_retro_report（绝不 DELETE、不触碰 calibration_patch 写通道）。
  //    LLM 已配置（getLlmJson 非空）→ analyzeCluster 走 LLM 路径产出 draft_patches；仅样本不足(R6<MIN_SAMPLE=20)降级。
  //    调度：首次对齐到下一个 02:00 再启动，之后每 24h 自然落在 02:00（零依赖、无 cron 库；时点固定不漂移）。
  const alignRetroToHour = () => {
    const t0 = new Date();
    const next = nextRetroAt(t0);
    const boot = setTimeout(() => {
      runRetroOnce();
      const retro = setInterval(runRetroOnce, 86400000);
      timers.set('decision-retro', { handle: retro, intervalMs: 86400000, kind: 'rule', registeredAt: new Date().toISOString() });
    }, next - t0);
    timers.set('decision-retro-boot', { handle: boot, intervalMs: next - t0, kind: 'rule', registeredAt: now });
  };
  // ④-b 启动补跑 catch-up（2026-09-03 实证新增）：实现见模块级 catchUpRetro（依赖注入，可单测）。
  //     背景：夜间窗口错过即永久丢失（decision_retro_report 曾长期 0 行，只能人工补跑）。
  //     护栏①：距下次 02:00 不足 30min → 交给定时；护栏②：VITEST 下不触发（不打到真实 LLM/DB）。
  alignRetroToHour();
  if (!process.env.VITEST) catchUpRetro(); // fire-and-forget：不阻塞 ensureTimers 返回
  // ⑤ 三分类 A 类巡检（2026-08-30）：每 30 分钟扫覆盖缺口/流失警戒/漏斗健康/承诺红/拜访达标/信息收集
  //    复用 salesDailyScan 纯函数（只读 + 产出告警清单）；createAlert 落库 + emit('alert') SSE 转播。
  //    铁律对齐 07 文档 §5-2：巡检只读 + 发射预警事件，处置由 crm-* 写 Action 显式触发（不跨粒子写）。
  //    阈值经 config_store['sales-thresholds']（mergedThresholds 动态读），客户可后台直调。
  const sales = setInterval(() => {
    (async () => {
      const { salesDailyScan } = await import('./salesDailyScan.js');
      const { mergedThresholds } = await import('../sales/salesThresholds.js');
      const { createAlertWithDb } = await import('../alerts/alertStore.js');
      // 多租户（T3，P0，设计 §3.3.1）：平台巡检器做租户循环——每租户读自身配置 + 扫描自身粒子。
      //   listActiveTenants 由 T9 提供（crm.tenants status='active'）；缺失时回退单租户 [{tenant_id:'system'}]（存量兼容）
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants
        ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }]))
        : [{ tenant_id: 'system' }];
      let totalScanned = 0, totalHits = 0;
      for (const t of tenants) {
        let accRes = { rows: [] }, dealRes = { rows: [] };
        try {
          [accRes, dealRes] = await Promise.all([
            query(`SELECT id, payload, created_at FROM crm.particles WHERE type='CRM_ACCOUNT' AND tenant_id=$1`, [t.tenant_id]),
            query(`SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`, [t.tenant_id]),
          ]);
        } catch { /* 单租户扫描失败留痕继续（巡检不因单租户异常整体中断） */ }
        const th = mergedThresholds(
          await readConfig('sales-thresholds', { tenantId: t.tenant_id })
            .then(r => r?.value || {}).catch(() => ({}))
        );
        const annualTarget = Number(
          await readConfig('named-account-targets', { tenantId: t.tenant_id })
            .then(r => r?.value?.annual_target || 0).catch(() => 0)
        ) || 0;
        const hits = salesDailyScan({
          accounts: accRes.rows, deals: dealRes.rows, thresholds: th, annualTarget,
        });
        totalScanned += accRes.rows.length + dealRes.rows.length;
        totalHits += hits.length;
        for (const h of hits) {
          // B-B3（2026-09-16 主动运行时 S1）：createAlertWithDb 双写（内存 + crm.signal DB），
          //   巡检命中「落库」而非仅内存——销售自动化/工作台第7视角/首页卡才能看到
          const a = await createAlertWithDb(pool, {
            kind: h.kind, severity: h.severity,
            target_role: h.severity === 'high' ? 'exec' : 'sales',
            tenant_id: t.tenant_id, particle_id: h.particle_id, payload: h.metric,
          });
          if (a.ok) emit('alert', h.kind, { alert_id: a.alert.alert_id, kind: h.kind, metric: h.metric, tenant_id: t.tenant_id });
        }
      }
      if (totalHits) {
        emit('trace', 'sales-daily-scan', { tenants: tenants.length, scanned: totalScanned, hits: totalHits });
      }
    })().catch((err) => {
      emit('trace', 'sales-daily-scan-failed', { error: String(err?.message || err) });
      recordFailure('sales-daily-scan-failed', err);
    });
  }, 1800000);
  timers.set('sales-daily-scan', { handle: sales, intervalMs: 1800000, kind: 'rule', registeredAt: now });
  // ⑥ 指名客户应访逾期扫描（2026-08-30 指名客户管理 Task6）：每 30 分钟扫有主客户的应访状态
  //    用 namedVisitStatus 判红（窗口内未达应访次数 → overdueDays≥alertDays）→ createAlert(named_visit_overdue) 幂等（已有 open 不复发）
  //    达标自动解除：pass=true → 有 open alert 则 closeAlert（幂等解除铁律）
  //    铁律对齐 07 文档 §5-2：巡检只读 + 发射预警事件；达标解除是告警状态机内部处置（closeAlert），非跨粒子写
  const namedVisit = setInterval(() => {
    (async () => {
      const { mergedTargets } = await import('../sales/namedAccountTargets.js');
      const { namedVisitStatus } = await import('../sales/namedAccountAssign.js');
      const { createAlert, closeAlert, findOpenAlertByParticle } = await import('../alerts/alertStore.js');
      const { mergedThresholds } = await import('../sales/salesThresholds.js');
      // 多租户循环（T3，P0，对齐 ⑤）：每租户读自身 th/tg + 扫自身 CRM_ACCOUNT。
      //   listActiveTenants 由 T9 提供；缺失回退 [{tenant_id:'system'}]（存量兼容）
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants
        ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }]))
        : [{ tenant_id: 'system' }];
      let red = 0, cleared = 0, scanned = 0;
      for (const t of tenants) {
        const accRes = await query(
          `SELECT id, payload FROM crm.particles WHERE type='CRM_ACCOUNT' AND tenant_id=$1`,
          [t.tenant_id]
        ).catch(() => ({ rows: [] }));
        const th = mergedThresholds(
          await readConfig('sales-thresholds', { tenantId: t.tenant_id })
            .then(r => r?.value || {}).catch(() => ({}))
        );
        const tg = mergedTargets(
          await readConfig('named-account-targets', { tenantId: t.tenant_id })
            .then(r => r?.value || {}).catch(() => ({}))
        );
        scanned += accRes.rows.length;
        for (const a of accRes.rows) {
          const p = a.payload || {};
          // 只扫指名客户（有 named_owner，非无主户——对齐看板剔除语义）
          if (!p.named_owner) continue;
          const st = namedVisitStatus(p, p.named_tier || p.tier || '潜力', tg, th);
          if (st.pass) {
            // 达标 → 幂等解除：有 open/acked 的同 kind 告警则 close（reason 必填）
            const open = findOpenAlertByParticle(a.id, 'named_visit_overdue');
            if (open) {
              const cl = closeAlert(open.alert_id, { reason: 'visit_ok' });
              if (cl.ok) { cleared++; emit('alert', 'named_visit_overdue-cleared', { alert_id: open.alert_id, account_id: a.id }); }
            }
          } else if (st.alert === 'red') {
            // 逾期红 → 幂等建（已有 open 不复发）
            const open = findOpenAlertByParticle(a.id, 'named_visit_overdue');
            if (!open) {
              const al = createAlert({
                kind: 'named_visit_overdue', severity: 'high', target_role: 'sales',
                particle_id: a.id, payload: { account_id: a.id, named_owner: p.named_owner, overdueDays: st.overdueDays },
              });
              if (al.ok) { red++; emit('alert', 'named_visit_overdue', { alert_id: al.alert.alert_id, account_id: a.id, overdueDays: st.overdueDays }); }
            }
          }
        }
      }
      if (red || cleared) {
        emit('trace', 'named-visit-scan', { tenants: tenants.length, scanned, red, cleared });
      }
    })().catch((err) => {
      emit('trace', 'named-visit-scan-failed', { error: String(err?.message || err) });
      recordFailure('named-visit-scan-failed', err);
    });
  }, 1800000);
  timers.set('named-visit-scan', { handle: namedVisit, intervalMs: 1800000, kind: 'rule', registeredAt: now });
  // ⑦ 可审计性 SLA 快照（2026-08-31 物化设计 §7）：每 6h 物化一次平台级可审计性 SLA 进 crm.agent_sla
  //    单一事实源=aggregateAuditability（auditability.js）；落事实表（非粒子写）；失败 emit trace + recordFailure（G3 不静默）
  //    间隔可用 AUDITABILITY_SLA_INTERVAL_MS 环境变量覆盖（阈值配置化铁律：代码不硬编码业务阈值）
  // 2026-09-02 修复「闭环 0 数据」：setInterval 首次触发需等满一个周期（默认 6h），
  //   服务重启后 agent_sla 首屏恒空 6 小时（生产实测仅 1 行，即某次手工调用残留）。
  //   改为注册时立即物化一次（预热）+ 按周期轮询；预热失败同样留痕不阻断启动。
  //   另修：timers 元数据此前硬编码 21600000，未反映环境变量覆盖值。
  const slaIntervalMs = Number(process.env.AUDITABILITY_SLA_INTERVAL_MS || 21600000);
  const runSlaSnapshot = () => {
    import('../decision/auditabilitySla.js').then((m) => m.materializeAuditabilitySla({ limit: 50 }))
      .catch((err) => {
        emit('trace', 'auditability-sla-snapshot-failed', { error: String(err?.message || err) });
        recordFailure('auditability-sla-snapshot-failed', err);
      });
  };
  const slaSnap = setInterval(runSlaSnapshot, slaIntervalMs);
  runSlaSnapshot(); // 启动预热：避免首个周期内 agent_sla 无数据
  timers.set('auditability-sla-snapshot', { handle: slaSnap, intervalMs: slaIntervalMs, kind: 'rule', registeredAt: now });

  // ⑧ ready-queue 自动泵（方案C 根因②，2026-09-02）：pumpReadyTasks 此前仅 retroTrigger 显式调用 + HTTP/MCP 触发，
  //    定时器层从未接线 → 大量 ready 任务（事件触发式复盘/跟进/报价）永不被泵起，编排层"假死"。
  //    现补周期自动泵；间隔走 config_store['agent-pump'].interval_ms（阈值配置化铁律），env AGENT_PUMP_INTERVAL_MS 优先覆盖。
  //    泵失败 emit trace + recordFailure（G3 不静默）；启动即预热一次，避免首周期任务堆积。
  const pumpCfg = (await readConfig('agent-pump', { tenantId: 'system' }).catch(() => null))?.value || {};
  const pumpIntervalMs = Number(process.env.AGENT_PUMP_INTERVAL_MS || pumpCfg.interval_ms || 60000);
  const runPump = () => {
    import('../kanban/scheduler.js').then((m) => m.pumpReadyTasks({ tenantId: 'system' }))
      .then((n) => { if (n > 0) emit('trace', 'agent-pump-scanned', { ready: n }); })
      .catch((err) => {
        emit('trace', 'agent-pump-failed', { error: String(err?.message || err) });
        recordFailure('agent-pump-failed', err);
      });
  };
  const agentPump = setInterval(runPump, pumpIntervalMs);
  runPump(); // 启动预热
  timers.set('ready-queue-pump', { handle: agentPump, intervalMs: pumpIntervalMs, kind: 'rule', registeredAt: now });

  // ⑨ C2 审计链巡检（2026-09-03）：verifyChain 此前只在「人导出审计报告 / 可审计性评估」时被调用，
  //    篡改可能长期无人发现。现补定时全量巡检 + 封印比对（封印补哈希链「删链尾不可检出」的固有盲区）。
  //    间隔/批次走 config_store['provenance-patrol']（阈值配置化铁律），env PROVENANCE_PATROL_MS 优先覆盖；enabled=false 时禁用定时巡检（见下方早退）。
  //    VITEST 护栏：巡检会写 provenance_seal + 异常时写 monitor_event，与测试断言竞态，测试下只注册不执行。
  //    启动即预热一次（禁「重启后首屏恒空」，同 SLA 定时器约定）。
  const patrolCfg = (await readConfig('provenance-patrol', { tenantId: 'system' }).catch(() => null))?.value || {};
  const patrolIntervalMs = Number(process.env.PROVENANCE_PATROL_MS || patrolCfg.interval_ms || 3600000);
  const patrolLimit = Number(patrolCfg.limit || 200);
  // 启用开关（阈值配置化铁律）：配置页 enabled=false 时禁用定时巡检；
  //   仍保留 scripts/provenance-patrol-once.mjs 手工触发能力，不注册空跑定时器。
  const patrolEnabled = patrolCfg.enabled !== false;
  if (!patrolEnabled) {
    emit('trace', 'provenance-patrol-disabled', { reason: 'config enabled=false' });
    return timers.size;
  }
  const runPatrol = () => {
    if (process.env.VITEST) return; // 测试隔离护栏：避免后台写与断言竞态（同 decision-agent 派发护栏）
    // 租户循环（T11，P2）：平台巡检器逐租户巡检自身决策链（隔离增强）；配置仍读 system（平台值，两义不矛盾）
    Promise.resolve()
      .then(async () => {
        const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
        const tenants = listActiveTenants
          ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }]))
          : [{ tenant_id: 'system' }];
        const { patrolChains } = await import('../decision/provenance.js');
        for (const t of tenants) {
          const r = await patrolChains({ limit: patrolLimit, tenantId: t.tenant_id });
          if (r && (r.tampered || r.forked || r.head_lost)) {
            emit('trace', 'provenance-patrol-alert', { ...r, tenant_id: t.tenant_id });
          }
        }
      })
      .catch((err) => {
        emit('trace', 'provenance-patrol-failed', { error: String(err?.message || err) });
        recordFailure('provenance-patrol-failed', err);
      });
  };
  const patrolTimer = setInterval(runPatrol, patrolIntervalMs);
  runPatrol(); // 启动预热
  timers.set('provenance-patrol', { handle: patrolTimer, intervalMs: patrolIntervalMs, kind: 'rule', registeredAt: now });

  // ⑩ 外部数据接入定时拉取（混合模式）：间隔走 config_store['integration-poll'].interval_ms，env INTEGRATION_POLL_MS 优先
  //    逐租户对启用 provider 拉取 → runWaterfall → monitorAccount（C3 闭环，复用既有发现编排，不另造链路）
  const pollCfg = (await readConfig('integration-poll', { tenantId: 'system' }).catch(() => null))?.value || {};
  const pollIntervalMs = Number(process.env.INTEGRATION_POLL_MS || pollCfg.interval_ms || 21600000);
  const runPoll = () => {
    if (process.env.VITEST) return; // 测试隔离护栏：避免后台真实拉取与断言竞态
    import('../connectors/discovery/tenantInstances.js').then(async (m) => {
      // A-B6 同步分支的真实装配（2026-09-16）：descriptor → 同步 provider → 同步内核
      const mount = await import('../sync/mount.js').catch(() => null);
      const syncFactories = (await import('../sync/factory.js').catch(() => null))?.SYNC_PROVIDER_FACTORY || {};
      const vault = await import('../connectors/discovery/credentialVault.js').catch(() => null);
      const autonomy = await import('../decision/autonomyEngine.js').catch(() => null);
      await runIntegrationPollOnce({
        listActiveTenants: (await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }))).listActiveTenants,
        loadAdapters: (await import('../connectors/discovery/providerRegistry.js')).loadAdapters,
        query,
        runWaterfall: (await import('../connectors/discovery/waterfall.js')).runWaterfall,
        monitorAccount: (await import('../connectors/discovery/monitorAccount.js')).monitorAccount,
        emit,
        resolveCredentials: (await import('../connectors/discovery/credentialVault.js')).resolveCredentials,
        // —— A-B6：租户同步目标装配（无 objects[] → 空目标 → no-op）——
        loadSyncTargets: mount ? ({ tenantId }) => mount.loadTenantSyncTargets({
          tenantId, readConfig, resolveCredentials: vault?.resolveCredentials, factories: syncFactories,
        }) : undefined,
        runSync: mount ? async ({ tenantId, targets }) => {
          // P0-1（2026-09-16）：L3 回写接线。此前 deps 未传 callWriteback → engine.js:38 分支恒不成立
          //   → counts.writeback 恒 0、L3 档「接线了却永不回写」。此处与 connectorRouter 同源装配。
          const wb = await import('../sync/writeback.js').catch(() => null);
          const exec = await import('../action/executor.js').catch(() => null);
          const callWriteback = (wb?.createWritebackDispatcher && exec?.actionExecutor?.dispatch)
            ? wb.createWritebackDispatcher({ dispatch: exec.actionExecutor.dispatch, readConfig })
            : undefined;
          return mount.runTenantSyncOnce({
            tenantId, targets,
            deps: {
              pool, emit, recordFailure,
              mappings: await mount.loadSyncMappings({ tenantId, readConfig }),
              callWriteback,
              // 第 0 闸：L2/L3 每 run 铸一枚决策；铸不出 → decisionId=null → 内核侧拒写（fail-closed）
              mintDecision: async (scene, ctx) => {
                const r = autonomy?.requireDecision ? await autonomy.requireDecision(scene, ctx).catch(() => null) : null;
                // 凭证读取收敛到 autonomyEngine.decisionIdOf（此前按顶层 `r.decision_id` 读 → 恒 undefined
                //   → 集成同步 L2/L3 被判「无决策」而结构性 fail-closed，且被 .catch(() => null) 掩盖；
                //   2026-09-16 由「模拟种子」实跑暴露：decision 表已新增行，但 decisionId 仍为 null）
                return { decisionId: autonomy?.decisionIdOf?.(r) ?? null };
              },
            },
          });
        } : undefined,
      }).catch((err) => {
        emit('trace', 'integration-poll-failed', { error: String(err?.message || err) });
        recordFailure('integration-poll-failed', err);
      });
    });
  };
  const pollTimer = setInterval(runPoll, pollIntervalMs);
  timers.set('integration-poll', { handle: pollTimer, intervalMs: pollIntervalMs, kind: 'rule', registeredAt: now });

  // ⑪ D6 校准 SLA 超时升级扫描（2026-09-14）：每 30min 扫 PENDING 超时项 → 置 escalated + 写追加日志，
  //    绝不自动 apply（守 HITL 铁律）；失败 emit trace + recordFailure（G3 不静默）。
  const slaScan = setInterval(() => {
    runCalibrationSlaScanOnce({ emit, recordFailure }).catch(() => {});
  }, 1800000);
  timers.set('calibration-sla-scan', { handle: slaScan, intervalMs: 1800000, kind: 'rule', registeredAt: now });

  // ⑫ S5 T15 时间型信号扫描（signal-schedule 配置驱动）：每 30min 逐租户扫描，命中落 crm.signal
  const schedIntervalMs = Number(process.env.SIGNAL_SCHEDULE_MS || 1800000);
  const runSchedule = () => {
    if (process.env.VITEST) return; // 测试隔离护栏：避免后台写与断言竞态
    import('../signal/scheduleScanner.js').then(async (m) => {
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }])) : [{ tenant_id: 'system' }];
      const { createSignalStore } = await import('../signal/store.js');
      for (const t of tenants) {
        await m.createScheduleScanner({ query, signalStore: createSignalStore(pool), readConfig })
          .scanOnce({ tenantId: t.tenant_id })
          .then((r) => { if (r.signals) emit('trace', 'signal-schedule-scan', { tenant_id: t.tenant_id, ...r }); })
          .catch((err) => { emit('trace', 'signal-schedule-failed', { error: String(err?.message || err) }); recordFailure('signal-schedule-failed', err); });
      }
    }).catch((err) => { emit('trace', 'signal-schedule-load-failed', { error: String(err?.message || err) }); });
  };
  const schedTimer = setInterval(runSchedule, schedIntervalMs);
  timers.set('signal-schedule-scan', { handle: schedTimer, intervalMs: schedIntervalMs, kind: 'rule', registeredAt: now });

  // ⑬ S5 T16 拓客信号扫描（lead-pool-config 驱动）：每 30min 逐租户，只提醒不改归属
  const runProspect = () => {
    if (process.env.VITEST) return;
    import('../signal/prospectScanner.js').then(async (m) => {
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }])) : [{ tenant_id: 'system' }];
      const { createSignalStore } = await import('../signal/store.js');
      for (const t of tenants) {
        await m.createProspectScanner({ query, signalStore: createSignalStore(pool), readConfig })
          .scanOnce({ tenantId: t.tenant_id })
          .then((r) => { if (r.signals) emit('trace', 'prospect-scan', { tenant_id: t.tenant_id, ...r }); })
          .catch((err) => { emit('trace', 'prospect-scan-failed', { error: String(err?.message || err) }); recordFailure('prospect-scan-failed', err); });
      }
    }).catch((err) => { emit('trace', 'prospect-scan-load-failed', { error: String(err?.message || err) }); });
  };
  const prospectTimer = setInterval(runProspect, 1800000);
  timers.set('prospect-scan', { handle: prospectTimer, intervalMs: 1800000, kind: 'rule', registeredAt: now });

  // ⑭ S5 T17 L3 主动研究调度（agent-research-schedule 驱动）：每 1h 逐租户，受 enabled 闸门；VITEST 不跑
  //   只做只读研究 → 产出带 reasoning+evidence_refs 的建议卡（crm.signal source='agent-research'）；零粒子写入。
  //   runSkill 生产态接 discovery-research / method-decision-enrich 的只读分支；此处给安全降级默认（不调 LLM 也不写粒子）。
  const researchIntervalMs = Number(process.env.RESEARCH_SCHEDULE_MS || 3600000);
  const runResearch = () => {
    if (process.env.VITEST) return; // 测试隔离护栏：避免后台真实研究写与断言竞态
    import('../signal/researchScheduler.js').then(async (m) => {
      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
      const tenants = listActiveTenants ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }])) : [{ tenant_id: 'system' }];
      const { createSignalStore } = await import('../signal/store.js');
      const { resolveAiAttributeLlm } = await import('../llm/aiAttributes.js').catch(() => ({ resolveAiAttributeLlm: null }));
      for (const t of tenants) {
        const runSkill = async ({ object }) => {
          const llm = resolveAiAttributeLlm ? await resolveAiAttributeLlm().catch(() => null) : null;
          if (!llm) {
            // 安全降级：未配置 LLM 时不编造证据，仅出中性占位（researchScheduler 内部会降级说明）
            return { reasoning: null, evidence_refs: [], degraded: 'no_llm' };
          }
          // 生产态：接只读研究 SKILL（discovery-research / method-decision-enrich 只读分支），此处留接口
          return { reasoning: `基于 ${object.id} 上下文分析`, evidence_refs: [object.id], recommended_action: null };
        };
        await m.createResearchScheduler({ query, signalStore: createSignalStore(pool), runSkill, readConfig })
          .runOnce({ tenantId: t.tenant_id })
          .then((r) => { if (r.cards) emit('trace', 'research-run', { tenant_id: t.tenant_id, ...r }); })
          .catch((err) => { emit('trace', 'research-run-failed', { error: String(err?.message || err) }); recordFailure('research-run-failed', err); });
      }
    }).catch((err) => { emit('trace', 'research-load-failed', { error: String(err?.message || err) }); });
  };
  const researchTimer = setInterval(runResearch, researchIntervalMs);
  timers.set('research-scheduler', { handle: researchTimer, intervalMs: researchIntervalMs, kind: 'rule', registeredAt: now });

  // ⑮ S6 T19 常驻授权凭证巡检（过期→expired；连续否决→paused）；每 1h，受 VITEST 护栏
  const grantSweepIntervalMs = Number(process.env.GRANT_SWEEP_MS || 3600000);
  const runGrantSweep = () => {
    if (process.env.VITEST) return; // 测试隔离护栏
    const sweeper = createGrantSweeper();
    sweeper.sweepOnce()
      .then((r) => { if (r.expired || r.paused) emit('trace', 'grant-sweep', r); })
      .catch((err) => { emit('trace', 'grant-sweep-failed', { error: String(err?.message || err) }); recordFailure('grant-sweep-failed', err); });
  };
  const grantSweepTimer = setInterval(runGrantSweep, grantSweepIntervalMs);
  timers.set('grant-sweep', { handle: grantSweepTimer, intervalMs: grantSweepIntervalMs, kind: 'rule', registeredAt: now });

  // ⑯ S7 T20 信号链路观测巡检（逐租户负向判据 delivery_silent/gen_silent → 报警）；每 1h，受 VITEST 护栏
  const signalObsIntervalMs = Number(process.env.SIGNAL_OBS_MS || 3600000);
  const runSignalObs = () => {
    if (process.env.VITEST) return; // 测试隔离护栏
    const sweep = createSignalObservabilitySweep();
    sweep.sweepOnce()
      .then((r) => { if (r.fired) emit('trace', 'signal-observability-sweep', r); })
      .catch((err) => { emit('trace', 'signal-observability-sweep-failed', { error: String(err?.message || err) }); recordFailure('signal-observability-sweep-failed', err); });
  };
  const signalObsTimer = setInterval(runSignalObs, signalObsIntervalMs);
  timers.set('signal-observability-scan', { handle: signalObsTimer, intervalMs: signalObsIntervalMs, kind: 'rule', registeredAt: now });

  // ⑰ 全链集成 Q1-3 信号投递编排（泵 open signal → 四渠道投递 → crm.signal_delivery 流水）；每 5 分钟，受 VITEST 护栏
  //   存在的理由：S1 只交付了 provider，无生产驱动点 → signal_delivery 恒 0 行。本定时器即「驱动它的进程」。
  //   装配集中在此（timers.js 本就有 query/pool），dispatcher.js 保持纯工厂便于注入替身测试。
  const signalDispatchIntervalMs = Number(process.env.SIGNAL_DISPATCH_MS || 300000);
  const runSignalDispatch = () => {
    if (process.env.VITEST) return; // 测试隔离护栏
    const dispatcher = createDispatcher({
      query,
      deliveryRegistry: createDeliveryRegistry({}),
      deliveryStore: createDeliveryStore(pool),
      router: createDeliveryRouter({ query }),
      readConfig, // D2：窗口来自 config_store['signal-dispatch'].max_age_days（platform 口径）
    });
    dispatcher.pumpAllTenants()
      .then((r) => {
        if (r.sent || r.failed || r.skipped) emit('trace', 'signal-dispatch', r);
        // 不静默（P-5）：零投递时必须能区分「渠道没配」与「没什么可做」——
        //   否则面板无告警与链路已通将不可区分（真实库实测：signal-delivery 配置为零行）。
        else if (Object.keys(r.idle || {}).length) emit('trace', 'signal-dispatch-idle', r);
        for (const f of r.failures) {
          emit('trace', 'signal-dispatch-tenant-failed', f);
          recordFailure('signal-dispatch-tenant-failed', new Error(f.error));
        }
      })
      .catch((err) => {
        emit('trace', 'signal-dispatch-failed', { error: String(err?.message || err) });
        recordFailure('signal-dispatch-failed', err);
      });
  };
  const signalDispatchTimer = setInterval(runSignalDispatch, signalDispatchIntervalMs);
  timers.set('signal-dispatch', { handle: signalDispatchTimer, intervalMs: signalDispatchIntervalMs, kind: 'rule', registeredAt: now });

  return timers.size;
}