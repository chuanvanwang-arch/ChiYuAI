// test/agentLoop.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import { runWithSkill } from '../src/agent/agentLoop.js';
import { seedActions } from '../src/action/seed-actions.js';
import { seedSkills } from '../src/skills/seed.js';

// 计划原测试未注入 Action/SKILL 注册表 → dispatch 报「未知 Action」/ getSkill 返回 null；此处 beforeAll 注入
beforeAll(() => { seedActions(); seedSkills(); });

function makeTask(payload) {
  return { id: 'test-task', title: '任务', action_name: 'crm-deal-advance', payload: payload || {}, step: 'agent' };
}

describe('agentLoop（SKILL 驱动）', () => {
  it('LLM 不可用降级：默认 think 返回降级推理 + 规则回退', async () => {
    const task = makeTask({ paramAction: 'data-particle-read', staticParams: { type: 'CRM_DEAL' } });
    const out = await runWithSkill(task, { llmThink: null });
    expect(out.degraded).toBe(true);
    expect(out.steps.length).toBeGreaterThanOrEqual(1);
  });

  it('SKILL 驱动：rule 步骤零 LLM 调用（决策步骤调一次 think）', async () => {
    let thinkCalls = 0;
    const task = makeTask({ paramAction: 'crm-deal-advance', staticParams: { deal_id: 'x', to_stage: 'opportunity' } });
    // 计划原测试用默认 fallback SKILL（无推理步骤）→ think 永不调用；改用含 j_judge 步骤的 crm-deal-analyze（修复）
    task.skill_slug = 'crm-deal-analyze';
    await runWithSkill(task, {
      llmThink: async () => { thinkCalls++; return { action: null, params: {} }; },
    });
    expect(thinkCalls).toBe(1); // 仅决策步骤调一次
  });
});
