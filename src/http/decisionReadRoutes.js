// B6 监控台真实化后端（设计 §10 / §11 B6/B7）：决策读模型路由，全部走真实库，禁止演示数据。
// 统一挂载点：src/http/routes.js 末尾 import { registerDecisionReadRoutes } 并调用。
import { pool } from '../db.js';
import { resolveMe } from './auth.js';
import { scopeOf } from './tenantScope.js';
import { buildSelfCheck } from '../decision/selfcheck.js';
import { buildStory } from '../decision/storyBuilder.js';
import { loadRubricConfig } from '../decision/rubricScorer.js';
import { buildPreContext, getThinkingTemplate } from '../decision/thinkingTemplates.js'; // P0-② 思维要素拆解·写前骨架 + 批量模板（config-center 只读总览）
import {
  submitRetro, reinforceMemory, rewriteMemory,
  recordHindsightBaseline, hindsightCheck, deviationRate,
  qSkillComposite, registerQSkillSampler,
} from '../decision/closureLoop.js'; // P2 闭环回流（§9 / §11.4）
import { emit } from '../events/bus.js';
import { recordFailure } from '../monitor/monitorStore.js';
import { getConceptChecklist, getRuleKnowledge } from '../knowledge/methodologyInjection.js'; // P3 D1 Knowledge 注入（methodology_dimension + decision_rule 双载体）
import { buildMethodologyEvidenceView } from '../decision/methodologyExtractor.js'; // P3 D1 续：当前方法论证据视图（与 ②a-2 同口径，只读）
import { effectiveSkillSet, setSkillEnabled, promoteSkill } from '../skill/skillScope.js'; // P3 D2 三层作用域
import { registerPropagationRoutes } from './propagationRoutes.js'; // 参数传播中枢（继承/下发/推广 + 第0闸）
import { hasRole, hasAnyRole, TENANT_LEVEL_ROLES } from './middleware/rbac.js'; // §15 权限重分组闸
import { conceptVector, compareRecall } from '../knowledge/embed.js'; // P3 D3 可插拔 embedding
import { registerDistillationTimer } from '../memory/distillScheduler.js'; // P3 D4 30 天蒸馏定时器

function asObj(v) {
  if (v == null) return {};
  if (typeof v === 'string') { try { return JSON.parse(v); } catch { return {}; } }
  return v;
}

function safeParseArray(v) {
  if (v == null) return null;
  try {
    const p = typeof v === 'string' ? JSON.parse(v) : v;
    return Array.isArray(p) ? p : null;
  } catch {
    return null;
  }
}

/**
 * 注册决策读模型路由（自检卡 / 九尺子明细 / 八要素思维 / 场景 chip 真实聚合）。
 * @param {import('express').Express} app
 */
export function registerDecisionReadRoutes(app) {
  // 参数传播中枢（继承 / 强制下发 / 上行推广），全部经决策第0闸 + HITL；pool 取模块级导入
  registerPropagationRoutes(app, pool);
  // P0-② 思维要素拆解·写前骨架（设计 §8.3 / §10）：决策表单打开即返回 8 要素填空骨架 + 七维供给提示。
  // 真实 DB 读取（decision_scenario 配置）+ 可选 assembleContextV2({phase:'pre',persist:false}) 七维供给；
  // 不产生任何写操作，fail-open（装配失败仅留痕，骨架仍返回）。
  app.get('/api/decision/pre-context', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const scenarioId = String(req.query.scenario_id || '').trim();
      if (!scenarioId) return res.status(400).json({ error: 'scenario_id 必填' });
      const { rows } = await pool.query(
        `SELECT scenario_id, stage, stage_code, focus_elements, focus_rulers, required_dims,
                rubric_pass_line, retro_required, methodology_ids
         FROM crm.decision_scenario
         WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system')
         ORDER BY (tenant_id=$2) DESC LIMIT 1`,
        [scenarioId, scopeOf(me)]
      );
      const scenario = rows[0] || {};
      // 七维供给（Pre 装配）：实体/查询由调用方传入（可选）；无则仅返回思维骨架
      let preContext = null;
      const entitiesRaw = req.query.entities ? safeParseArray(req.query.entities) : null;
      const queryText = req.query.query ? String(req.query.query) : null;
      if (entitiesRaw || queryText) {
        try {
          const { assembleContextV2 } = await import('../context/assembleContextV2.js');
          preContext = await assembleContextV2({
            scenario_id: scenarioId,
            entities: entitiesRaw || [],
            query: queryText,
            trigger_context: {},
            tenant_id: scopeOf(me),
            phase: 'pre',
            persist: false,
          });
        } catch (e) {
          emit('trace', 'pre-context-assembly-failed', { scenario_id: scenarioId, error: String(e?.message || e) });
          recordFailure('pre-context-assembly-failed', e);
          preContext = null; // 装配失败不阻断骨架返回
        }
      }
      const out = buildPreContext(scenarioId, {
        scenario: {
          stage: scenario.stage || null,
          focus_elements: scenario.focus_elements,
          focus_rulers: scenario.focus_rulers,
          required_dims: scenario.required_dims,
          rubric_pass_line: scenario.rubric_pass_line,
          retro_required: scenario.retro_required,
        },
        preContext: preContext
          ? { prompt_block: preContext.prompt_block, supplied_dims: preContext.supplied_dims, dim_coverage: preContext.dim_coverage }
          : null,
      });
      // 【P3 D1】Knowledge 注入：把 methodology_dimension 34 行按本场景 methodology_ids 注入 Pre 装配，
      // 决策表单的概念清单与落库 concept_refs 同源（消除 N4/F2 双轨）。fail-open：无 methodology_ids 则清单为空。
      let concept_checklist = null;
      try {
        concept_checklist = await getConceptChecklist(scenarioId, pool);
      } catch (e) {
        emit('trace', 'pre-context-knowledge-failed', { scenario_id: scenarioId, error: String(e?.message || e) });
        recordFailure('pre-context-knowledge-failed', e);
        concept_checklist = null; // 知识注入失败不阻断骨架
      }
      // 【P3 D1 续】Knowledge 注入第三载体：decision_rule（启用规则清单）。
      // 与 evaluateRules 同源（仅 enabled），fail-open 不阻断骨架（消除 N4/F2 残留）。
      let rule_knowledge = null;
      try {
        rule_knowledge = await getRuleKnowledge(pool);
      } catch (e) {
        emit('trace', 'pre-context-rule-knowledge-failed', { scenario_id: scenarioId, error: String(e?.message || e) });
        recordFailure('pre-context-rule-knowledge-failed', e);
        rule_knowledge = null;
      }
      // 【P3 D1 续】当前方法论证据视图：概念清单 + 启用规则 + 当前证据 三件套收口。
      // 与 autonomyEngine ②a-2 同口径（只读、fail-open），决策者在写前即看到证据现状（不落库）。
      let methodology_evidence = {};
      try {
        const subjectId = entitiesRaw && entitiesRaw.length
          ? (entitiesRaw[0]?.id || entitiesRaw[0]?.particle_id || (typeof entitiesRaw[0] === 'string' ? entitiesRaw[0] : null))
          : null;
        if (subjectId) {
          methodology_evidence = await buildMethodologyEvidenceView(pool, {
            subjectId,
            methodologyIds: Array.isArray(scenario.methodology_ids) ? scenario.methodology_ids : [],
            tenant: scopeOf(me),
          });
        }
      } catch (e) {
        emit('trace', 'pre-context-evidence-failed', { scenario_id: scenarioId, error: String(e?.message || e) });
        recordFailure('pre-context-evidence-failed', e);
        methodology_evidence = {};
      }
      res.json({
        ok: true,
        ...out,
        concept_checklist, // { methodology_ids, checklist:[{methodology_id,dim_key,label,weight,required}], summary }
        rule_knowledge,    // [{ code, match_type, match_payload, check_payload, scope_hint }]（启用中的公司常设规则 = Knowledge）
        methodology_evidence, // { dim_key: { met, value, source, evidence_ref, evidence_reason } }（当前证据现状，读时派生+落库断言）
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // P0-② 批量思维模板（配置中心只读总览）：逐销售场景返回 8 要素拆解
  app.get('/api/decision/thinking-templates', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const { rows } = await pool.query(
        `SELECT scenario_id, stage, description FROM crm.decision_scenario WHERE stage <> 'meta' ORDER BY stage`
      );
      const items = rows.map((r) => {
        const t = getThinkingTemplate(r.scenario_id);
        return {
          scenario_id: r.scenario_id,
          stage: r.stage,
          scenario_note: t.scenario_note || r.description || '',
          generic: t.generic,
          elements: t.elements,
        };
      });
      res.json({ ok: true, items });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // B7 极简自检卡 7 问（读模型，不写库）
  app.get('/api/decision/:id/selfcheck', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const { rows } = await pool.query(
        `SELECT decision_id, intent, conditions_evaluated, assumptions, inference, viewpoints,
                implications, risk_register, stop_loss, rubric
         FROM crm.decision WHERE decision_id=$1 AND tenant_id=$2`,
        [req.params.id, scopeOf(me)]
      );
      if (!rows.length) return res.status(404).json({ error: 'decision 不存在' });
      res.json(buildSelfCheck(rows[0]));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 九尺子评分明细 + 阶段加权（真实 rubric + decision_rubric_score 明细）
  app.get('/api/decision/:id/rubric', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const d = await pool.query(
        `SELECT decision_id, scenario_id, rubric FROM crm.decision WHERE decision_id=$1 AND tenant_id=$2`,
        [req.params.id, scopeOf(me)]
      );
      if (!d.rows.length) return res.status(404).json({ error: 'decision 不存在' });
      const cfg = await loadRubricConfig(pool);
      const details = await pool.query(
        `SELECT rubric_key, score, max_score, level, weight, evidence, scorer, degraded, scored_at
         FROM crm.decision_rubric_score WHERE decision_id=$1 ORDER BY rubric_key`,
        [req.params.id]
      );
      res.json({
        decision_id: req.params.id,
        scenario_id: d.rows[0].scenario_id,
        rubric: asObj(d.rows[0].rubric),
        config: { pass_line: cfg.pass_line, llm_enabled: cfg.llm_enabled },
        details: details.rows,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // 八要素思维卡（真实物化内容）
  app.get('/api/decision/:id/thinking', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const { rows } = await pool.query(
        `SELECT decision_id, intent, assumptions, inference, viewpoints, implications,
                risk_register, stop_loss, concept_refs
         FROM crm.decision WHERE decision_id=$1 AND tenant_id=$2`,
        [req.params.id, scopeOf(me)]
      );
      if (!rows.length) return res.status(404).json({ error: 'decision 不存在' });
      const row = rows[0];
      const story = buildStory(row);
      res.json({
        decision_id: row.decision_id,
        elements: {
          intent: asObj(row.intent),
          assumptions: asObj(row.assumptions),
          inference: asObj(row.inference),
          viewpoints: asObj(row.viewpoints),
          implications: asObj(row.implications),
          risk_register: asObj(row.risk_register),
          stop_loss: asObj(row.stop_loss),
          concept_refs: asObj(row.concept_refs),
        },
        story,
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // B6 场景 chip 真实聚合：每个场景真实决策数 + 平均 rubric level（非演示数据）
  app.get('/api/monitor/scenario-chips', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const chips = await pool.query(
        `SELECT s.scenario_id, s.stage, s.stage_code, s.required_dims, s.focus_elements, s.focus_rulers,
                s.rubric_pass_line, s.retro_required,
                COUNT(d.decision_id) FILTER (WHERE d.tenant_id=$1) AS decision_count,
                AVG((d.rubric->>'weighted_total')::numeric) FILTER (WHERE d.rubric IS NOT NULL) AS avg_rubric
         FROM crm.decision_scenario s
         LEFT JOIN crm.decision d ON d.scenario_id = s.scenario_id
         GROUP BY s.scenario_id, s.stage, s.stage_code, s.required_dims, s.focus_elements, s.focus_rulers,
                  s.rubric_pass_line, s.retro_required
         ORDER BY s.stage_code NULLS LAST, s.scenario_id`,
        [scopeOf(me)]
      );
      res.json({
        ok: true,
        chips: chips.rows.map((c) => ({
          scenario_id: c.scenario_id,
          stage: c.stage,
          stage_code: c.stage_code,
          decision_count: Number(c.decision_count || 0),
          avg_rubric: c.avg_rubric != null ? Number(c.avg_rubric).toFixed(2) : null,
          required_dims: asObj(c.required_dims),
          focus_elements: asObj(c.focus_elements),
          focus_rulers: asObj(c.focus_rulers),
          rubric_pass_line: c.rubric_pass_line,
          retro_required: c.retro_required,
        })),
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ───────────── P2 闭环回流写操作（第0闸 + HITL：必须登录人类触发） ─────────────

  // C1+C2+C3+C3′：提交复盘（三通道分流 + 反面先例登记 + 记忆影响 + 知识处方 PENDING）
  app.post('/api/decision/:id/retro', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录（HITL 要求）' });
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const r = await submitRetro(req.params.id, body, { created_by: me.username || me.id || 'human' });
      emit('trace', 'decision-retro-submitted', { decision_id: req.params.id, by: me.username || me.id });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // C2 后见之明：reinforce / rewrite（append-only，原记忆不动）
  app.post('/api/decision/:id/memory/:action', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录（HITL 要求）' });
      const { action } = req.params;
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      let r;
      if (action === 'reinforce') r = await reinforceMemory(req.params.id, body);
      else if (action === 'rewrite') r = await rewriteMemory(req.params.id, body);
      else return res.status(400).json({ error: 'action 须为 reinforce|rewrite' });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // C3 证实性偏差校验：先记录基线，再提交复盘期观测
  app.post('/api/decision/:id/hindsight-baseline', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录（HITL 要求）' });
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      res.json(await recordHindsightBaseline(req.params.id, { belief: body.belief, confidence: body.confidence }));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.post('/api/decision/:id/hindsight-check', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录（HITL 要求）' });
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      const r = await hindsightCheck(req.params.id, { belief_now: body.belief_now, confidence_now: body.confidence_now });
      if (r.need_baseline) return res.status(409).json({ error: '该决策尚未记录 hindsight 基线，请先 POST /hindsight-baseline', need_baseline: true });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // 监控读：偏差率 + Q(Skill,T) 复合判据（真实数据驱动，非演示）
  app.get('/api/decision/monitor/deviation', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      res.json({ ok: true, deviation: await deviationRate({ windowDays: Number(req.query.windowDays) || 90 }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  app.get('/api/decision/monitor/q-skill', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      res.json({ ok: true, window_days: Number(req.query.windowDays) || 90, skills: await qSkillComposite({ windowDays: Number(req.query.windowDays) || 90 }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── P3 D2 Skill 三层作用域 ──
  // 生效 Skill 集合（system/workspace/user 归并，user>workspace>system）
  app.get('/api/skill/scope', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const r = await effectiveSkillSet(pool, { workspace: scopeOf(me), user: me.username || me.id });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
  // 推广路径：user 试跑成熟 → workspace / system（写操作，需登录 + emit 留痕）
  // §15.5：tenant→system / user→system 属穿透层级（上下贯通）→ 强制 ADMIN；workspace/tenant 层按租户级三角色
  app.post('/api/skill/scope/promote', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录（HITL 要求）' });
      const body = typeof req.body === 'object' && req.body ? req.body : {};
      if (body.to === 'system' && !hasRole(me, 'ADMIN')) {
        return res.status(403).json({ error: '推广到 system 层（上下贯通）必须 ADMIN 权限（§15.5）' });
      }
      if (body.to !== 'system' && !hasAnyRole(me, TENANT_LEVEL_ROLES)) {
        return res.status(403).json({ error: '需要 tan_admin/sysadmin/ADMIN 权限（§15.1）' });
      }
      const r = await promoteSkill(pool, {
        skill: body.skill,
        from: 'user',
        to: body.to,
        by: me.username || me.id,
        note: body.note || null,
      });
      res.json(r);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  // ── P3 D3 可插拔 embedding（只读暴露，便于 A/B 召回对比）──
  app.get('/api/knowledge/concept-vectors', async (req, res) => {
    try {
      const me = resolveMe(req);
      if (!me?.ok) return res.status(401).json({ error: '未登录' });
      const scenarioId = String(req.query.scenario_id || '').trim();
      if (!scenarioId) return res.status(400).json({ error: 'scenario_id 必填' });
      const { checklist } = await getConceptChecklist(scenarioId, pool);
      const vectors = checklist.map((c) => ({
        methodology_id: c.methodology_id,
        dim_key: c.dim_key,
        vector: conceptVector(c.methodology_id, c.dim_key, c.label),
      }));
      res.json({ ok: true, scenario_id: scenarioId, count: vectors.length, vectors });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // C5 定时器注册即预热（§11.4）：启动时立即播种一次 Q 序列；注册失败仅留痕，不阻断启动。
  try {
    registerQSkillSampler();
  } catch (e) {
    recordFailure('q-skill-sampler-register', e);
  }
  // P3 D4 30 天蒸馏定时器注册即预热（蒸馏逻辑见 memoryLog#distillMemory，append-only 不删）
  try {
    registerDistillationTimer({ pool });
  } catch (e) {
    recordFailure('distill-timer-register', e);
  }
}
