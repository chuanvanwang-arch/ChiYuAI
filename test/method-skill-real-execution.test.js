// test/method-skill-real-execution.test.js — method-* 真 SKILL 步骤落地验收（2026-09-01）
// 锁定：① 3 个 method-* 已补 steps[]（非降级单步）② 真执行路径 stepsMissing=false
//       ③ agentLoop 透传的 taskPayload 抵达 action handler（deal 定向）
// 隔离 actionExecutor，避免依赖测试库 CRM_DEAL 状态（读 action 的 DB 查询由 .catch 兜底）。
import { describe, it, expect, vi, beforeAll } from 'vitest';

const dispatchMock = vi.fn(async (name, params, ctx) => ({
  ok: true,
  result: { action: name, params, taskPayloadDealId: ctx?.taskPayload?.deal_id || null },
}));
vi.mock('../src/action/executor.js', () => ({
  actionExecutor: { dispatch: (...a) => dispatchMock(...a) },
}));

const { seedSkills } = await import('../src/skills/seed.js');
const { executeSkill, getSkill } = await import('../src/skills/registry.js');
const { seedActions } = await import('../src/action/seed-actions.js');
const { getAction } = await import('../src/action/registry.js');
const { agentSpecs } = await import('../src/agent/agentSpec.js');

beforeAll(() => {
  seedSkills();
  seedActions();
});

describe('三体 method-* 已补真实 steps[]', () => {
  for (const slug of ['method-quote-engine', 'method-followup-engine', 'method-review-gate']) {
    it(`${slug} 含 3 步（read→方法论 action→j_judge），非降级`, () => {
      const s = getSkill(slug);
      expect(s).toBeTruthy();
      expect(Array.isArray(s.steps) && s.steps.length).toBe(3);
      expect(s.steps[0].action).toBe('data-particle-read');
      expect(s.steps[1].action).toMatch(/^crm-(quote-estimate|followup-schedule|review-gate-evaluate)$/);
      expect(s.steps[2].decision).toBe('j_judge');
    });
  }
  it('intake-router 的 method-intake-routing 仍维持 route_only（不补方法步骤）', () => {
    const s = getSkill('method-intake-routing');
    // 无 steps → 走降级单步；路由痕迹由 scheduler.recordIntakeRouteEpisode 单独落（D7）
    expect(Array.isArray(s.steps) && s.steps.length > 0).toBe(false);
  });
});

describe('新 read action 已注册', () => {
  for (const name of ['crm-quote-estimate', 'crm-review-gate-evaluate', 'crm-followup-schedule']) {
    it(`${name} 注册为 read action`, () => {
      const a = getAction(name);
      expect(a).toBeTruthy();
      expect(a.kind).toBe('read');
    });
  }
});

describe('真执行路径：stepsMissing=false 且 taskPayload 透传', () => {
  it('quote-engine：executeSkill 运行后 stepsMissing=false', async () => {
    dispatchMock.mockClear();
    const skill = getSkill('method-quote-engine');
    const ctx = { actor: 'quote-engine', tenantId: 'system', taskPayload: { deal_id: 'DEAL-1' } };
    const out = await executeSkill(skill, { id: 't', payload: { deal_id: 'DEAL-1' } }, {
      ctx,
      llmThink: async () => ({ reasoning: '推荐方案B', degraded: false }),
    });
    expect(out.stepsMissing).toBe(false);
    expect(out.steps.length).toBe(3);
    // taskPayload 经 agentLoop 透传到 action handler（deal 定向）
    const estimateCall = dispatchMock.mock.calls.find((c) => c[0] === 'crm-quote-estimate');
    expect(estimateCall).toBeTruthy();
    expect(estimateCall[2].taskPayload?.deal_id).toBe('DEAL-1');
  });

  it('review-gate：evaluate 步骤被真实派发且 stepsMissing=false', async () => {
    dispatchMock.mockClear();
    const skill = getSkill('method-review-gate');
    const ctx = { actor: 'review-gate', tenantId: 'system', taskPayload: { deal_id: 'DEAL-2' } };
    const out = await executeSkill(skill, { id: 't', payload: { deal_id: 'DEAL-2' } }, {
      ctx,
      llmThink: async () => ({ reasoning: 'pass', degraded: false }),
    });
    expect(out.stepsMissing).toBe(false);
    const evalCall = dispatchMock.mock.calls.find((c) => c[0] === 'crm-review-gate-evaluate');
    expect(evalCall).toBeTruthy();
    expect(evalCall[2].taskPayload?.deal_id).toBe('DEAL-2');
  });

  it('followup-agent：schedule 步骤被真实派发且 stepsMissing=false', async () => {
    dispatchMock.mockClear();
    const skill = getSkill('method-followup-engine');
    const ctx = { actor: 'followup-agent', tenantId: 'system', taskPayload: { deal_id: 'DEAL-3' } };
    const out = await executeSkill(skill, { id: 't', payload: { deal_id: 'DEAL-3' } }, {
      ctx,
      llmThink: async () => ({ reasoning: '标记超时', degraded: false }),
    });
    expect(out.stepsMissing).toBe(false);
    const schedCall = dispatchMock.mock.calls.find((c) => c[0] === 'crm-followup-schedule');
    expect(schedCall).toBeTruthy();
    expect(schedCall[2].taskPayload?.deal_id).toBe('DEAL-3');
  });
});

// ─────────── 2026-09-02 补齐：CRM 三核心业务方法由「仅元数据」升级为真执行 ───────────
describe('CRM 三核心业务方法已补 steps[]', () => {
  const CASES = [
    ['method-stage-progression', 'crm-stage-progression-evaluate', 'CRM_DEAL'],
    ['method-funnel-classification', 'crm-funnel-classify', 'CRM_DEAL'],
    ['method-behavior-standard', 'crm-behavior-check', 'CRM_ACCOUNT'],
  ];
  for (const [slug, action, readType] of CASES) {
    it(`${slug} 含 3 步（read ${readType} → ${action} → j_judge），非降级`, () => {
      const s = getSkill(slug);
      expect(s, `${slug} 未注册`).toBeTruthy();
      expect(Array.isArray(s.steps) && s.steps.length).toBe(3);
      expect(s.steps[0].action).toBe('data-particle-read');
      expect(s.steps[0].params.type).toBe(readType);
      expect(s.steps[1].action).toBe(action);
      expect(s.steps[2].decision).toBe('j_judge');
    });
  }
});

describe('三核心落点 read action 已注册', () => {
  for (const name of ['crm-stage-progression-evaluate', 'crm-funnel-classify', 'crm-behavior-check']) {
    it(`${name} 注册为 read action`, () => {
      const a = getAction(name);
      expect(a, `${name} 未注册`).toBeTruthy();
      expect(a.kind).toBe('read');
    });
  }
});

describe('三核心真执行：stepsMissing=false 且落点 action 被派发', () => {
  const RUNS = [
    ['method-stage-progression', 'crm-stage-progression-evaluate', 'quote-engine', { deal_id: 'DEAL-S' }],
    ['method-funnel-classification', 'crm-funnel-classify', 'followup-agent', { deal_id: 'DEAL-F' }],
    ['method-behavior-standard', 'crm-behavior-check', 'followup-agent', { account_id: 'ACC-B' }],
  ];
  for (const [slug, action, actor, payload] of RUNS) {
    it(`${slug} 执行后 stepsMissing=false，${action} 被派发且实体定向透传`, async () => {
      dispatchMock.mockClear();
      const skill = getSkill(slug);
      const out = await executeSkill(skill, { id: 't', payload }, {
        ctx: { actor, tenantId: 'system', taskPayload: payload },
        llmThink: async () => ({ reasoning: 'ok', degraded: false }),
      });
      expect(out.stepsMissing).toBe(false);
      expect(out.steps.length).toBe(3);
      const call = dispatchMock.mock.calls.find((c) => c[0] === action);
      expect(call, `${action} 未被派发`).toBeTruthy();
      expect(call[2].taskPayload).toMatchObject(payload);
    });
  }
});

describe('agent 授权闭包：三核心 SKILL 已被对应 agent 声明', () => {
  it('quote-engine 声明 method-stage-progression（S3→S4 闸门 bantcc_quote 同源）', () => {
    const spec = agentSpecs['quote-engine'];
    expect(spec.capabilities.skillCalls).toContain('method-stage-progression');
    // 权限闭包（agents.js 断言 3）：skillCalls ⊆ actions
    expect(spec.capabilities.actions).toContain('method-stage-progression');
  });
  it('followup-agent 声明 funnel-classification + behavior-standard（拜访节奏/质检同源）', () => {
    const spec = agentSpecs['followup-agent'];
    expect(spec.capabilities.skillCalls).toContain('method-funnel-classification');
    expect(spec.capabilities.skillCalls).toContain('method-behavior-standard');
    expect(spec.capabilities.actions).toContain('method-funnel-classification');
    expect(spec.capabilities.actions).toContain('method-behavior-standard');
  });
});

describe('反假绿护栏：agent 执行体数据访问缺陷防回潮', () => {
  const readSeedActions = async () => {
    const fs = await import('node:fs/promises');
    return fs.readFile(new URL('../src/action/seed-actions.js', import.meta.url), 'utf8');
  };
  it('SQL 一律用 crm.particles（2026-09-02 修复：crm.particle 单数表名使 action 恒失败且被静默吞错）', async () => {
    const src = await readSeedActions();
    // 负向先行断言：'crm.particle' 后非 's' 才命中（避免误伤复数表名）
    expect(src).not.toMatch(/crm\.particle(?!s)/);
  });
  it('禁止静默吞错：不得再出现 .catch(() => ({ rows: [] }))', async () => {
    const src = await readSeedActions();
    expect(src).not.toMatch(/\.catch\(\(\)\s*=>\s*\(\{\s*rows:\s*\[\]\s*\}\)\)/);
  });
});
