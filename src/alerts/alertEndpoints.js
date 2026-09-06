// src/alerts/alertEndpoints.js — 预警/反馈回路 端点权威路径清单 + 处理器组装（并发隔离：不碰 routes.js）
// 设计输入：docs/2026-08-25-alert-feedback-loop-design.md §F（HTTP 端点）
// 职责：ALERT_ENDPOINTS（路径清单，挂载方按此注册）+ buildAlertHandlers()（处理器对象，含增删改查/启停/评估/指标）
// 并发隔离：并发整合会话正在重写 routes.js（monitor/connectors/门户整合）；本模块只交付清单+处理器，由挂载方统一 add，避免双写 routes.js

import { listAlertRules, setRuleEnabled } from './alertRegistry.js';
import { listAlerts, createAlert, ackAlert, closeAlert } from './alertStore.js';
import { evaluateAlertRule } from './ruleEvaluator.js';
import { computePerTierMetrics } from './feedbackMetrics.js';

// 端点权威路径清单（对齐设计 §F；挂载方（routes 整合会话）按此注册到 app）
export const ALERT_ENDPOINTS = [
  'GET /api/alerts',
  'POST /api/alerts/:id/ack',
  'POST /api/alerts/:id/close',
  'GET /api/alerts/rules',
  'POST /api/alerts/rules/:kind/enable',
  'POST /api/alerts/rules/:kind/disable',
  'POST /api/alerts/evaluate',
  'GET /api/feedback/metrics',
];

// 处理器组装：返回按端点语义组织的处理器对象（供挂载方 app.get/post 引用）
export function buildAlertHandlers() {
  return {
    // GET /api/alerts
    list({ kind, status } = {}) {
      return { items: listAlerts({ kind, status }) };
    },

    // POST /api/alerts/:id/ack
    ack(alertId) {
      return ackAlert(alertId);
    },

    // POST /api/alerts/:id/close
    close(alertId, { reason } = {}) {
      return closeAlert(alertId, { reason });
    },

    // GET /api/alerts/rules
    rules() {
      return { rules: listAlertRules() };
    },

    // POST /api/alerts/rules/:kind/enable|disable（mode: 'enable' | 'disable'）
    setRule(kind, mode) {
      return setRuleEnabled(kind, mode === 'disable' ? false : true);
    },

    // POST /api/alerts/evaluate（纯逻辑验收面：body {rule, event}）
    evaluate({ rule, event } = {}) {
      return evaluateAlertRule(rule, event);
    },

    // POST /api/alerts（直接用 createAlert 落 store；挂载方若需可加）
    create(params = {}) {
      return createAlert(params);
    },

    // GET /api/feedback/metrics（per-tier 指标；本地返回内存决策空集，DB 查询留 PG）
    feedbackMetrics(decisions = []) {
      return computePerTierMetrics(decisions);
    },
  };
}