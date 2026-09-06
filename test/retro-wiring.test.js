// test/retro-wiring.test.js — 复盘智能体接线 + 契约闭环 JOIN 键修复（2026-09-01）
// 锁定四类行为：① retro 分诊 ② 主 SKILL 派生与契约键 ③ agent 授权走 skillCalls 闭包 ④ 矩阵按稳定键 JOIN
import { describe, it, expect } from 'vitest';
import { classifyRequirement } from '../src/agent/classify.js';
import { routeThroughIntake, primarySkillFor } from '../src/kanban/scheduler.js';
import { judgeContract } from '../src/agent/contractMonitor.js';
import { CONTRACT_IDS } from '../src/agent/contractIds.js';
import { seedSkills } from '../src/skills/seed.js';
import { getSkill, canExecuteSkill, agentSkillAllowed } from '../src/skills/registry.js';

describe('D1 复盘分诊', () => {
  it('复盘意图命中 retro（且不被「重大」量级词抢走）', () => {
    expect(classifyRequirement('复盘本月重大决策质量并给出整改处方').intent).toBe('retro');
    expect(classifyRequirement('重大战略客户年度复盘').intent).toBe('retro');
  });

  it('常规意图不受 retro 规则影响', () => {
    expect(classifyRequirement('给蒙电100台做报价测算').intent).toBe('quote');
    expect(classifyRequirement('跟进本周逾期商机').intent).toBe('followup');
    expect(classifyRequirement('重大战略客户商机').intent).toBe('major');
  });

  it('路由到 decision-retro 并注入契约键与主 SKILL', () => {
    const r = routeThroughIntake({ id: 't1', payload: { intent: 'retro' } });
    expect(r.targetAgent).toBe('decision-retro');
    expect(r.payload.contract_task_id).toBe('ct-retro-decision');
    expect(r.payload.skill_slug).toBe('decision-retrospective');
  });
});

describe('D4 主 SKILL 派生', () => {
  it('各 agent 派生到方法论/专属 SKILL（跳过 data-particle-* 等基础步骤）', () => {
    expect(primarySkillFor('quote-engine')).toBe('method-quote-engine');
    expect(primarySkillFor('followup-agent')).toBe('method-followup-engine');
    expect(primarySkillFor('intake-router')).toBe('method-intake-routing');
    expect(primarySkillFor('review-gate')).toBe('method-review-gate');
    expect(primarySkillFor('decision-retro')).toBe('decision-retrospective');
  });

  it('未登记 agent 回落 fallback', () => {
    expect(primarySkillFor('nope')).toBe('crm-skill-fallback');
  });

  it('SKILL 注册表含两个新增执行体 SKILL', () => {
    seedSkills();
    expect(getSkill('decision-retrospective')).toBeTruthy();
    expect(getSkill('data-particle-read')).toBeTruthy();
  });
});

describe('agent 授权走 skillCalls 闭包（非人类 role_tag）', () => {
  it('agent 可调用自己声明的 SKILL', () => {
    expect(agentSkillAllowed('decision-retro', 'decision-retrospective')).toBe(true);
    expect(agentSkillAllowed('quote-engine', 'method-quote-engine')).toBe(true);
  });

  it('agent 越权调用未声明 SKILL 被拒', async () => {
    expect(agentSkillAllowed('quote-engine', 'decision-retrospective')).toBe(false);
    seedSkills();
    const g = await canExecuteSkill(getSkill('decision-retrospective'), { actor: 'quote-engine' });
    expect(g.ok).toBe(false);
    expect(g.reason).toContain('skillCalls');
  });

  it('agent 执行已声明 SKILL 通过闸门（无需 CRM_PERSON 角色）', async () => {
    seedSkills();
    const g = await canExecuteSkill(getSkill('decision-retrospective'), { actor: 'decision-retro' });
    expect(g.ok).toBe(true);
  });
});

describe('D2 矩阵按稳定契约键 JOIN', () => {
  const contract = {
    task: '复盘智能体：决策复盘 + 整改处方生成（决策质量闭环）',
    contract_task_id: 'ct-retro-decision',
    agent: 'decision-retro',
    skills: ['decision-retrospective'],
    knowledge_scope: { layers: ['L1', 'L2'] },
  };
  const eps = [
    { phase: 'loop-started', context_facts: { skill: 'decision-retrospective', contract_task_id: 'ct-retro-decision' } },
    { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1', 'L2', 'L4'], contract_task_id: 'ct-retro-decision' } },
  ];

  it('有稳定键时按键 JOIN，缺失键的 episode 不误判', () => {
    const r = judgeContract(contract, eps);
    expect(r.skill_ok).toBe(true);
    expect(r.memory_ok).toBe(true);
  });

  it('契约无稳定键时回退按 task 标题 JOIN（向后兼容）', () => {
    const legacy = { ...contract };
    delete legacy.contract_task_id;
    const byTitle = eps.map((e) => ({ ...e, context_facts: { ...e.context_facts, contract_task_id: legacy.task } }));
    expect(judgeContract(legacy, byTitle).skill_ok).toBe(true);
  });

  it('契约键集合与 agentSpecs 一一对应', () => {
    // 2026-09-03 对齐源码单一事实源 src/agent/contractIds.js：原断言漏 decision-agent（6 键误列 5）
    expect(Object.keys(CONTRACT_IDS).sort()).toEqual(
      ['decision-agent', 'decision-retro', 'followup-agent', 'intake-router', 'quote-engine', 'review-gate'].sort(),
    );
  });
});
