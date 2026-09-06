// src/monitor/monitorSubscriber.js — 销售决策监控持久化订阅（事件总线落库，异常隔离不阻断写）
// 设计输入：CRM-sales-decision-monitoring-design.md §4.2/§4.3（埋点采集 + 监控持久化订阅）
// 复用 bus.js 订阅机制：订阅者抛错绝不阻断业务写路径（bus.js:6-40 已保证）
import { query, queryWrite } from '../db.js';
import { on } from '../events/bus.js';

let registered = false;

// 幂等建表（启动时调用；或并入 schema.sql）
// G4 扩展：monitor_event 增 agent_id / context_facts 两列（agent 认知记录落点，Semantica 设计 §3.2/§4）
export async function ensureMonitorSchema() {
  await queryWrite(`CREATE TABLE IF NOT EXISTS crm.monitor_event (
    id BIGSERIAL PRIMARY KEY,
    domain text NOT NULL,
    event_type text,
    decision_id uuid,
    scenario_id text,
    agent_id text,
    context_facts jsonb,
    payload jsonb,
    created_at timestamptz DEFAULT now()
  )`);
  // 兼容既有已建表（无外键/幂等补列，不删不改既有行）
  await queryWrite(`ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS agent_id text`);
  await queryWrite(`ALTER TABLE crm.monitor_event ADD COLUMN IF NOT EXISTS context_facts jsonb`);
}

// 注册监控持久化订阅：把 decision 事件域落库到 monitor_event
export function registerMonitorSubscriber() {
  if (registered) return;
  registered = true;
  on('decision', async (msg) => {
    try {
      const s = msg.summary || {};
      await queryWrite(
        `INSERT INTO crm.monitor_event (domain, event_type, decision_id, scenario_id, payload)
         VALUES ('decision', $1, $2, $3, $4)`,
        [msg.type, s.decision_id ?? null, s.scenario_id ?? null, JSON.stringify(s)]
      );
    } catch (e) {
      console.error('[monitor-subscriber] persistence error:', e?.message); // 隔离：不阻断 emit
    }
  });
}