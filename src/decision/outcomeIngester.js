// src/decision/outcomeIngester.js — T16 J2 反馈回路：业务事件 → 决策结果 自动回写
// 订阅业务事件总线（crm / payment / approval 域），按 crm.outcome_event_map 规则匹配
// → 调 writeOutcome 幂等回写 decision_outcome + decision.outcome_verified。
// 设计约束：订阅者异常隔离（绝不阻断业务写路径）；无法关联决策的 event 跳过而非报错。
import { query, queryWrite } from '../db.js';
import { on } from '../events/bus.js';
import { writeOutcome } from './outcome.js';

// 从事件 payload 解析目标 decision_id（按 rule.matcher）
// matcher 支持：
//   { decision_id_field: 'decision_id' } → 取 payload[decision_id_field] 作为 decision_id（最常见，系统/人工回执直带）
//   { decision_id: 'xxx' }               → 静态绑定（固定场景/测试用）
// 其余（按实体关联 involved_entities）留 TODO，当前返回 null → 该规则跳过。
export function resolveDecisionId(rule, payload = {}) {
  const m = rule.matcher || {};
  if (m.decision_id_field && payload[m.decision_id_field]) return payload[m.decision_id_field];
  if (m.decision_id) return m.decision_id;
  return null;
}

// 处理单条业务事件：查命中规则（event_type = `${domain}.${type}` 且 enabled）→ 解析 decision_id → writeOutcome
// 返回写入的 outcome 行数组（供测试/可观测）。单规则失败隔离，不阻断其他规则。
export async function handleBusinessEvent(domain, type, payload = {}, { query: q = query, write = queryWrite } = {}) {
  const eventType = `${domain}.${type}`;
  const rules = await q(
    `SELECT * FROM crm.outcome_event_map WHERE event_type=$1 AND enabled=true`,
    [eventType]
  );
  const results = [];
  for (const rule of rules.rows) {
    const decisionId = resolveDecisionId(rule, payload);
    if (!decisionId) continue; // 无法关联决策 → 跳过（不阻断事件分发）
    try {
      const row = await writeOutcome(
        decisionId,
        { outcome_type: rule.outcome_type, source: `event:${eventType}`, payload },
        { query: q, write }
      );
      results.push(row);
    } catch (e) {
      console.error('[outcomeIngester] writeOutcome failed:', e?.message);
    }
  }
  return results;
}

// 进程级订阅句柄（幂等注册）
let unsubscribers = [];
export function registerOutcomeIngester() {
  if (unsubscribers.length) return; // 幂等
  for (const domain of ['crm', 'payment', 'approval']) {
    unsubscribers.push(
      on(domain, (msg) => {
        handleBusinessEvent(msg.domain, msg.type, msg.summary).catch(() => {});
      })
    );
  }
}
export function unregisterOutcomeIngester() {
  unsubscribers.forEach((u) => u && u());
  unsubscribers = [];
}
