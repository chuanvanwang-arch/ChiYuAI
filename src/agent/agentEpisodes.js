// src/agent/agentEpisodes.js — C3 agent 认知记录（"agent 看到了什么 / 做了什么"落点）
// 设计输入：spec §3.2/§4（G4 扩展：monitor_event 增 agent_id/context_facts 两列）
// 复用既有 monitor_event 表（不新建表）；本模块只写扩展列，与既有决策监控订阅（decision 域）共存
import { query, queryWrite } from '../db.js';
import { emit } from '../events/bus.js';

// 记录一条 agent 认知/执行片段。失败仅 trace，绝不抛（保证 agentLoop 主链路不阻断）。
export async function recordEpisode({
  agent_id = null, phase = 'episode', context_facts = null,
  decision_id = null, scenario_id = null, payload = {},
} = {}) {
  try {
    await queryWrite(
      `INSERT INTO crm.monitor_event (domain, event_type, agent_id, context_facts, decision_id, scenario_id, payload)
       VALUES ('agent', $1, $2, $3, $4, $5, $6)`,
      [
        phase, agent_id,
        context_facts != null ? JSON.stringify(context_facts) : null,
        decision_id, scenario_id, JSON.stringify(payload || {}),
      ]
    );
    return { ok: true };
  } catch (e) {
    emit('trace', 'agent-episode-failed', { agent_id, phase, error: String(e?.message || e) });
    return { ok: false, error: String(e?.message || e) };
  }
}
