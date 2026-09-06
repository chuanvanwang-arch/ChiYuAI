// test/alert.test.js — 子系统五 预警/反馈回路 纯逻辑测试（无 PG 依赖，本地全绿）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md（§A-§I 已批准）
// T1-T6 累积 describe 块；DB 集成（crm.alert/alert_rule 表）留 PG 环境验收
import { describe, it, expect, beforeEach } from 'vitest';

// ───────────────────────── T1 · alertRegistry + ruleEvaluator ─────────────────────────
import {
  listAlertRules, setRuleEnabled, resetAlertRegistry,
} from '../src/alerts/alertRegistry.js';
import { evaluateAlertRule } from '../src/alerts/ruleEvaluator.js';

beforeEach(() => {
  resetAlertRegistry();
});

describe('T1 · alertRegistry 内存规则表 + ruleEvaluator 纯函数判定', () => {
  it('种子 5 类业务告警（payment_due 已启用——T3-8 INVOICE 粒子落地）', () => {
    const rules = listAlertRules();
    expect(rules.map(r => r.kind)).toEqual(
      expect.arrayContaining(['deal_stuck', 'lead_overdue', 'forecast_breach', 'approval_bottleneck', 'payment_due']),
    );
    const payment = rules.find(r => r.kind === 'payment_due');
    expect(payment.enabled).toBe(true);
  });

  it('setRuleEnabled 启停生效；未知 kind 拒绝', () => {
    const r1 = setRuleEnabled('deal_stuck', false);
    expect(r1.ok).toBe(true);
    expect(listAlertRules().find(r => r.kind === 'deal_stuck').enabled).toBe(false);
    const r2 = setRuleEnabled('no-such-kind', false);
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('rule_not_found');
  });

  it('evaluateAlertRule：stuck_days 超限→hit+payload；未超限→hit:false；粒子不匹配→hit:false', () => {
    const rule = listAlertRules().find(r => r.kind === 'deal_stuck');
    const hit = evaluateAlertRule(rule, {
      particleType: 'CRM_DEAL', action: 'stage_update', metric: { stuckDays: 45 },
    });
    expect(hit.hit).toBe(true);
    expect(hit.payload).toHaveProperty('stuckDays', 45);

    const miss = evaluateAlertRule(rule, {
      particleType: 'CRM_DEAL', action: 'stage_update', metric: { stuckDays: 10 },
    });
    expect(miss.hit).toBe(false);

    const wrongParticle = evaluateAlertRule(rule, {
      particleType: 'CRM_ACCOUNT', action: 'stage_update', metric: { stuckDays: 45 },
    });
    expect(wrongParticle.hit).toBe(false);
  });

  it('resetAlertRegistry 清空后回落种子（13 条：5 类业务 + S05 应收 2 + 巡检 5 + 指名应访逾期 1，alertRegistry.js）', () => {
    resetAlertRegistry();
    expect(listAlertRules()).toHaveLength(13);
    expect(listAlertRules().some(r => r.kind === 'named_visit_overdue')).toBe(true);
  });
});

// ───────────────────────── T2 · alertStore 处置状态机 ─────────────────────────
import {
  createAlert, listAlerts, ackAlert, closeAlert, resetAlertStore,
} from '../src/alerts/alertStore.js';

describe('T2 · alertStore 处置状态机（open→ack→close，close 必填 reason，幂等拒绝）', () => {
  beforeEach(() => {
    resetAlertStore();
  });

  it('createAlert 合法 → open + 字段齐备', () => {
    const r = createAlert({
      kind: 'deal_stuck', severity: 'high', l2c_stage: 'opportunity',
      target_role: 'sales', particle_id: 'deal-1', payload: { stuckDays: 45 },
    });
    expect(r.ok).toBe(true);
    expect(r.alert.status).toBe('open');
    expect(r.alert.kind).toBe('deal_stuck');
    expect(r.alert.severity).toBe('high');
    expect(r.alert.target_role).toBe('sales');
  });

  it('createAlert 缺 target_role 拒绝', () => {
    const r = createAlert({ kind: 'deal_stuck', severity: 'high' });
    expect(r.ok).toBe(false);
  });

  it('ack → acked；acked 再 ack 幂等拒绝；closed 拒绝', () => {
    const a = createAlert({ kind: 'lead_overdue', severity: 'medium', target_role: 'sales' }).alert;
    const r1 = ackAlert(a.alert_id);
    expect(r1.alert.status).toBe('acked');
    const r2 = ackAlert(a.alert_id);
    expect(r2.ok).toBe(false); // 幂等拒绝
    const c = closeAlert(a.alert_id, { reason: 'overdue cleared' });
    expect(c.alert.status).toBe('closed');
    const r3 = ackAlert(a.alert_id);
    expect(r3.ok).toBe(false); // closed 不可 ack
  });

  it('close 必填 reason；缺 → 拒绝；closed 再 close 幂等拒绝', () => {
    const a = createAlert({ kind: 'approval_bottleneck', severity: 'medium', target_role: 'ops' }).alert;
    const r1 = closeAlert(a.alert_id);
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('closed_reason_required');
    const r2 = closeAlert(a.alert_id, { reason: 'bottleneck cleared' });
    expect(r2.alert.status).toBe('closed');
    const r3 = closeAlert(a.alert_id, { reason: 'again' });
    expect(r3.ok).toBe(false); // 幂等拒绝
  });

  it('listAlerts 按 kind/status 过滤 + resetAlertStore 清空', () => {
    createAlert({ kind: 'deal_stuck', severity: 'high', target_role: 'sales' });
    createAlert({ kind: 'payment_due', severity: 'low', target_role: 'finance' });
    expect(listAlerts({ kind: 'deal_stuck' })).toHaveLength(1);
    expect(listAlerts({ status: 'open' })).toHaveLength(2);
    resetAlertStore();
    expect(listAlerts()).toHaveLength(0);
  });
});

// ───────────────────────── T3 · feedbackMetrics per-tier 指标纯函数 ─────────────────────────
import { computePerTierMetrics } from '../src/alerts/feedbackMetrics.js';

describe('T3 · feedbackMetrics per-tier 指标纯函数（自主率/升级率/推翻率/平均时延）', () => {
  it('给定决策数组 → 四指标 per-tier 正确', () => {
    const decisions = [
      { tier: 't1', outcome: 'autonomous', created_at: 1000, completed_at: 1030 },
      { tier: 't1', outcome: 'escalated', created_at: 2000, completed_at: 2030 },
      { tier: 't1', outcome: 'autonomous', created_at: 3000, completed_at: 3030, overturned: true },
      { tier: 't2', outcome: 'autonomous', created_at: 4000, completed_at: 4010 },
    ];
    const { metricsByTier } = computePerTierMetrics(decisions);
    expect(metricsByTier.t1.autonomy_rate).toBeCloseTo(2 / 3);
    expect(metricsByTier.t1.escalation_rate).toBeCloseTo(1 / 3);
    expect(metricsByTier.t1.overturn_rate).toBeCloseTo(1 / 3);
    expect(metricsByTier.t1.avg_decision_latency_s).toBe(30);
    expect(metricsByTier.t2.autonomy_rate).toBe(1);
    expect(metricsByTier.t2.avg_decision_latency_s).toBe(10);
  });

  it('空数组 → 空对象', () => {
    expect(computePerTierMetrics([])).toEqual({ metricsByTier: {} });
  });

  it('缺 tier 字段 → unknown 桶', () => {
    const { metricsByTier } = computePerTierMetrics([{ outcome: 'escalated', created_at: 1, completed_at: 4 }]);
    expect(metricsByTier.unknown.escalation_rate).toBe(1);
    expect(metricsByTier.unknown.avg_decision_latency_s).toBe(3);
  });
});

// ───────────────────────── T4 · 写时触发接线（particle 域 → evaluator → createAlert → SSE alert 域）─────────────────────────
import { on, emit } from '../src/events/bus.js';
import { createSseHub } from '../src/events/sse.js';
import { registerAlertHook, unregisterAlertHook } from '../src/alerts/alertHook.js';
import { listAlerts, resetAlertStore } from '../src/alerts/alertStore.js';
import { resetAlertRegistry } from '../src/alerts/alertRegistry.js';

describe('T4 · 写时触发接线（粒子写事件 → 规则判定 → 告警落库 + SSE alert 域转播）', () => {
  beforeEach(() => {
    resetAlertRegistry();
    resetAlertStore();
    unregisterAlertHook();
  });

  it('deal_stuck 超限 → open 告警 + SSE alert 域收到', () => {
    registerAlertHook();
    const writes = [];
    const fakeRes = {
      write: (s) => writes.push(s),
      flushHeaders: () => {}, on: () => {},
    };
    const hub = createSseHub();
    hub.connect(fakeRes);
    emit('particle', 'stage_update', {
      particleType: 'CRM_DEAL', action: 'stage_update', metric: { stuckDays: 45 },
    });
    expect(listAlerts({ kind: 'deal_stuck' })).toHaveLength(1);
    expect(writes.some((s) => s.includes('event: alert'))).toBe(true);
    hub.close();
  });

  it('已启用规则（payment_due）→ invoice_create 命中产生告警', () => {
    registerAlertHook();
    emit('particle', 'invoice_create', {
      particleType: 'CRM_INVOICE', action: 'invoice_create', metric: { dueDays: 10 },
    });
    const alerts = listAlerts();
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.some(a => a.kind === 'payment_due')).toBe(true);
  });

  it('unregisterAlertHook 后 → 不再产生告警（退订生效）', () => {
    registerAlertHook();
    unregisterAlertHook();
    emit('particle', 'stage_update', {
      particleType: 'CRM_DEAL', action: 'stage_update', metric: { stuckDays: 45 },
    });
    expect(listAlerts()).toHaveLength(0);
  });
});

// ───────────────────────── T5 · alertEndpoints 端点模块化（权威路径清单 + 处理器组装）─────────────────────────
// 并发隔离：routes.js 由整合会话统一挂载；本模块只交付「路径清单 + 处理器可组装」，零污染 routes.js
import {
  ALERT_ENDPOINTS, buildAlertHandlers,
} from '../src/alerts/alertEndpoints.js';

describe('T5 · alertEndpoints 端点模块化（路径清单权威 + 处理器可组装）', () => {
  it('端点路径清单齐备（告警/处置/规则启停/评估验收/反馈指标）', () => {
    expect(ALERT_ENDPOINTS).toEqual(
      expect.arrayContaining([
        'GET /api/alerts',
        'POST /api/alerts/:id/ack',
        'POST /api/alerts/:id/close',
        'GET /api/alerts/rules',
        'POST /api/alerts/rules/:kind/enable',
        'POST /api/alerts/rules/:kind/disable',
        'POST /api/alerts/evaluate',
        'GET /api/feedback/metrics',
      ]),
    );
  });

  it('处理器可组装：evaluate handler 对 deal_stuck 超限事件 → hit:true', () => {
    const handlers = buildAlertHandlers();
    expect(typeof handlers.evaluate).toBe('function');
    const r = handlers.evaluate({
      rule: { kind: 'deal_stuck', match: { particleTypes: ['CRM_DEAL'], actions: ['stage_update'] }, check_params: { stuck_days: 30 }, enabled: true },
      event: { particleType: 'CRM_DEAL', action: 'stage_update', metric: { stuckDays: 45 } },
    });
    expect(r.hit).toBe(true);
    expect(r.payload.stuckDays).toBe(45);
  });

  it('处理器可组装：list 过滤 + ack/close 处置链路通（内存 store）', () => {
    const handlers = buildAlertHandlers();
    const c = handlers.create({ kind: 'deal_stuck', severity: 'high', target_role: 'sales', payload: { stuckDays: 45 } });
    expect(c.ok).toBe(true);
    const list = handlers.list({ kind: 'deal_stuck' });
    expect(list.items).toHaveLength(1);
    const ack = handlers.ack(c.alert.alert_id);
    expect(ack.alert.status).toBe('acked');
    const close = handlers.close(c.alert.alert_id, { reason: '推进完成' });
    expect(close.alert.status).toBe('closed');
  });
});