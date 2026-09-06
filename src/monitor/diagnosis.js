// src/monitor/diagnosis.js — 参数诊断报告（2026-09-05 设计 §2.3）
// 综合：智能体成败归因 + 决策场景失败率 + calibration_patch PENDING 处方（risk 排序 + recommend）
// 红线：context-routing 系 knob 只展示实验数据，不产处方（patch 过滤掉）
import { query } from '../db.js';
import { getAgentSummary } from './monitorStore.js';
import { getDecisionHealth } from './monitorStore.js';

// 红线前缀；新增 routing 系 knob 须同步此处
const ROUTING_KNOBS = ['routingStrategy', 'routing', 'context-routing'];

function isRoutingKnob(k) {
  return ROUTING_KNOBS.some((p) => String(k || '').toLowerCase().includes(p.toLowerCase()));
}

export async function getParamDiagnosis({ days = 7 } = {}) {
  const [agent, decision, patchRows] = await Promise.all([
    getAgentSummary({ days }),
    getDecisionHealth({ days }),
    query(`SELECT patch_id, scenario_id, knob, target, from_value, to_value, evidence, expected_impact, risk, status, assignee, tenant_id, created_at
             FROM crm.calibration_patch WHERE status='PENDING' ORDER BY created_at DESC LIMIT 100`),
  ]);
  // 处方 → 附 recommend（确定性规则；仅非 routing knob）
  const patches = (patchRows.rows || [])
    .filter((p) => !isRoutingKnob(p.knob))
    .map((p) => {
      const risk = p.risk || 'LOW';
      const scenarioFail = decision.by_scenario.find((s) => s.scenario_id === p.scenario_id)?.fail_rate || 0;
      const recommend = risk === 'HIGH' && scenarioFail > 0.3 ? 'approve'
        : risk === 'MEDIUM' && scenarioFail > 0 ? 'approve'
        : 'reject';
      return {
        patch_id: p.patch_id, knob: p.knob, target: p.target, risk,
        from_value: p.from_value, to_value: p.to_value,
        recommend, rationale: `场景 ${p.scenario_id || '(none)'} 失败率 ${(scenarioFail * 100).toFixed(1)}%`,
      };
    });
  // 智能体建议：失败 agent → 检查 SKILL/配置
  const agentIssues = (agent.by_agent || []).filter((a) => a.failed > 0).map((a) => ({
    agent: a.agent_id, issue: `失败 ${a.failed} 次`, suggest: '检查对应 SKILL 步骤或该 agent 配置',
  }));
  // 决策建议：高失败率场景 → 检查审批链/规则
  const decisionIssues = (decision.by_scenario || []).filter((s) => s.fail_rate > 0.3).map((s) => ({
    scenario: s.scenario_id, fail_rate: s.fail_rate, suggest: '查看该场景审批链配置与决策规则',
  }));
  return {
    report_date: new Date().toISOString().slice(0, 10),
    agent: { summary: agent, suggestions: agentIssues },
    decision: { summary: decision, suggestions: decisionIssues },
    patches,
    red_lines: ['context-routing', 'context-routing 仅展示实验数据（routing_experiment），不产处方'],
  };
}
