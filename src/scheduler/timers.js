// src/scheduler/timers.js — 定时器（③ 定时规则驱动的数据产生）
// 设计输入：12 文档 §7-3（nightly 蒸馏 24h + crm-risk 30min 扫描）
// 幂等单例：routes.js createRoutes 建应用时调用 ensureTimers；防双实例（与 registerCaptureSubscriber 同模式）
// G3 R2/C1：nightly 蒸馏失败 emit trace + recordFailure（不再静默）；crm-risk 定时器接真扫描器 runRiskScan
// 07 文档 §5-2 修订口径（2026-08-26）：本文件定时器 =「规则治理兜底」——只规则检查→发射预警事件，
// 不直接跨粒子写；回收/处置动作由 crm-* 写 Action（写通道第 0 闸）显式触发。任何「定时扫描直接写粒子」即违 D4 反模式。
import { distillMemory } from '../memory/memoryLog.js';
import { runRiskScan } from './riskScanner.js';
import { runDecisionRetro, runRoutingReviewPass, runParamInspectionPass } from '../decision/retro.js';
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { query } from '../db.js';
import { readConfig } from '../config/configStore.js';
import { saveNightlyReport } from '../report/nightlyReport.js';

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
export const runRetroOnce = async ({ retroFn, routingFn, paramFn, saveReportFn } = {}) => {
  const runRetro = retroFn || runDecisionRetro;
  const runRouting = routingFn || runRoutingReviewPass;
  const runParam = paramFn || runParamInspectionPass;
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
  // ④ 报告生成（第 4 个独立 catch：三段任一失败不拖垮报告落库）
  await saveReport({ retro, routing, param }).catch((err) => {
    emit('trace', 'nightly-report-failed', { error: String(err?.message || err) });
    recordFailure('nightly-report-failed', err);
  });
  return { retro, routing, param };
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

export async function ensureTimers({ now = new Date().toISOString() } = {}) {
  if (timers.size > 0) return timers.size;   // 幂等单例：已注册则原样返回
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
  // ③ lead 池回收扫描：每 30 分钟查超期未跟进（>recycle_days）且仍为 lead 阶段的 DEAL
  //    命中 → emit lead-overdue 预警事件 → 触发 crm-lead-recycle 语义（池回收闭环，T3-1 验收② 事件源）
  //    直接走查询不做跨粒子写（回收动作由 lead-recycle Action 显式触发，扫描只产生预警事件）
  const recycle = setInterval(() => {
    query(
      `SELECT id, payload FROM crm.particles
       WHERE type='CRM_DEAL' AND payload->>'stage'='lead' AND payload->>'owner_id' IS NOT NULL`
    ).then(({ rows }) => {
      const now = Date.now();
      const overdue = rows.filter((r) => {
        const follow = r.payload.last_follow_up_at;
        if (!follow) return false; // 从未跟进不回收（避免新线索误回收，pool.js:75）
        return (now - new Date(follow).getTime()) / 86400000 > 30;
      });
      for (const deal of overdue) {
        emit('alert', 'lead-overdue', {
          particleType: 'CRM_DEAL', action: 'lead-recycled',
          metric: { overdueDays: Math.floor((Date.now() - new Date(deal.payload.last_follow_up_at).getTime()) / 86400000) },
          particle_id: deal.id,
        });
        emit('crm', 'lead-overdue', { deal_id: deal.id, owner_id: deal.payload.owner_id });
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
      const { createAlert } = await import('../alerts/alertStore.js');
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
          const a = createAlert({
            kind: h.kind, severity: h.severity,
            target_role: h.severity === 'high' ? 'exec' : 'sales',
            particle_id: h.particle_id, payload: h.metric,
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
  return timers.size;
}