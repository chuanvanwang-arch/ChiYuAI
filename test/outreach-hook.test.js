// test/outreach-hook.test.js — P1-1a 三处装配 + P1-1b 钩子生成（TDD）
import { describe, it, expect, beforeAll } from 'vitest';
import { getSkill } from '../src/skills/registry.js';
import { seedSkills } from '../src/skills/seed.js';
import { seedActions } from '../src/action/seed-actions.js';
import { getAction } from '../src/action/registry.js';
import { agentSpecs } from '../src/agent/agentSpec.js';

let module;
beforeAll(async () => {
  seedSkills();
  seedActions();
  module = await import('../src/skills/methodOutreachHook.js');
});

describe('method-outreach-hook 三处装配', () => {
  it('SKILL 已登记（seed.js registry 元数据）', () => {
    const s = getSkill('method-outreach-hook');
    expect(s).not.toBeNull();
    expect(s.slug).toBe('method-outreach-hook');
  });

  it('Action Registry 已注册 method-outreach-hook（seed-actions.js method-* 数组）', () => {
    const a = getAction('method-outreach-hook');
    expect(a).not.toBeNull();
    expect(a.kind).toBe('read'); // 方法论壳：只读知识，零写（第 0 闸由壳内步骤各自过）
    expect(a.namespace).toBe('method');
  });

  it('承载 agent 已声明 actions+skillCalls（agentSpec.js capabilities 闭包）', () => {
    // 三处同改（装配铁律）：skillCalls ⊆ actions ⊆ Action Registry
    const host = Object.values(agentSpecs).find(
      (s) => s.capabilities?.actions?.includes('method-outreach-hook')
    );
    expect(host, '至少一个 agent 声明 method-outreach-hook').toBeTruthy();
    expect(host.capabilities.skillCalls).toContain('method-outreach-hook');
  });
});

describe('outreach hook generation (P1-1b)', () => {
  it('可溯源钩子 → 产出 hook+anchor+confidence', async () => {
    const { generateHook } = module;
    const out = await generateHook({
      deal: { name: 'S 集团', industry: '低代码平台', size: '500 人' },
      signal: { type: 'tender', ts: Date.now(), url: 'https://tender.example/13115' },
      contact: { name: '周IT', title: 'IT 总监', decision_power: 'recommend' },
    });
    expect(out.hook).toBeDefined();
    expect(out.hook.split(' ').length).toBeLessThanOrEqual(30);
    expect(out.anchor.url).toContain('tender.example');
    expect(out.verifiable.every((v) => v.ok)).toBe(true);
    expect(out.verifiable_all).toBe(true);
    expect(out.confidence).toBe(0.9);
  });

  it('无锚点可引用 → 拒生成（fail-closed）', async () => {
    const { generateHook } = module;
    await expect(generateHook({ deal: { name: 'X' }, signal: {}, contact: {} })).rejects.toThrow(/锚点|anchor/);
  });

  it('超 30 词钩子 → 拒出（fail-closed，对齐 CitationGuard）', async () => {
    const { generateHook } = module;
    // 按空格分词 > 30 词（中文无空格不分词，用英文空格串构造超长钩子；verify 端按空格分词计数）
    const longHook = Array.from({ length: 35 }, (_, i) => `word${i}`).join(' ');
    // 直接测 buildFallbackHook 受 MAX_WORDS 保护的网关：走 generateHook 且 llm 返回超长串
    await expect(generateHook({
      deal: { name: 'S 集团', industry: '低代码平台', size: '500 人' },
      signal: { type: 'tender', ts: Date.now(), url: 'https://tender.example/13115' },
      contact: { title: 'IT 总监' },
      llm: { genHook: async () => longHook },
    })).rejects.toThrow(/30 词/);
  });
});
