// src/signal/researchScheduler.js — T17 L3 主动研究（agent-research-schedule 驱动）
// 选对象 → 跑只读 SKILL（注入 runSkill）→ 产出带 reasoning+evidence_refs 的建议卡（crm.signal source='agent-research'）
// 限额 max_objects_per_run + 预算 daily_llm_budget 双重护栏；缺证据输出降级说明而非编造；零粒子写入
import { readConfig as defaultRead } from '../config/configStore.js';

export function createResearchScheduler({ query, signalStore, runSkill, readConfig = defaultRead } = {}) {
  async function runOnce({ tenantId = 'system', now = Date.now(), budget = { used: 0 } } = {}) {
    const cfgRow = await readConfig('agent-research-schedule', { tenantId }).catch(() => null);
    const cfg = cfgRow?.value || {};
    if (cfg.enabled === false) return { researched: 0, cards: 0 };
    const maxObjects = cfg.max_objects_per_run ?? 5;
    const dailyBudget = cfg.daily_llm_budget ?? 50;
    const sel = cfg.select_rule || { type: 'CRM_ACCOUNT' };
    const { rows } = await query(
      `SELECT id, tenant_id, payload FROM crm.particles WHERE type=$1 AND tenant_id=$2 LIMIT 200`,
      [sel.type, tenantId]
    );
    let researched = 0, cards = 0;
    for (const obj of rows) {
      if (researched >= maxObjects) break;
      if (budget.used >= dailyBudget) break;       // 预算红线：降级不抛错
      budget.used += 1;
      researched += 1;
      let card;
      try {
        card = runSkill ? await runSkill({ object: obj, tenantId }) : { reasoning: null, evidence_refs: [] };
      } catch {
        card = { reasoning: null, evidence_refs: [], degraded: 'skill_failed' };
      }
      const reasoning = card?.reasoning || '证据不足，无法给出确定性建议（降级说明，非编造）';
      const evidence_refs = Array.isArray(card?.evidence_refs) ? card.evidence_refs : [];
      // 零粒子写入铁律：只落建议卡信号（signalStore.create），绝不写粒子；query 仅用于只读 SELECT
      const r = await signalStore.create({
        tenant_id: tenantId, source: 'agent-research', kind: 'suggestion_card',
        severity: 'low', target_role: 'sales', particle_id: obj.id,
        payload: { subject: `${sel.type} ${obj.id} 主动研究建议` },
        suggestion: { reasoning, evidence_refs, recommended_action: card?.recommended_action || null, degraded: card?.degraded || null },
        evidence: { research_schedule: true, budget_used: budget.used },
        dedup_key: `research:${obj.id}:${new Date(now).toISOString().slice(0, 10)}`,
      });
      if (r?.ok) cards += 1;
    }
    return { researched, cards, budget_used: budget.used };
  }
  return { runOnce };
}
