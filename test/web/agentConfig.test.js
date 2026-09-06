import { test, expect, describe } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  renderAgentConfig, renderAgentCard, renderAssembly, agentOk,
} from '../../src/portal/agentConfigRender.js';

const SPEC_SAMPLE = {
  'crm-copilot': {
    identity: { name: 'crm-copilot', derivedFrom: 'taskFlow:crm-nl-to-action', autonomy: 'recommend' },
    capabilities: {
      actions: ['data-particle-read', 'crm-deal-advance'],
      skillCalls: ['data-particle-read'],
      knowledgeScope: { layers: ['L1'], maxHops: 2 },
    },
    context: { knowledgeLevel: 2, coverage: '>=80%', coldStart: 'adaptive' },
    memory: { read: ['crm-copilot'], write: ['crm-copilot'] },
    evaluation: { metricTemplate: 'intent_to_action_accuracy', evaluator: 'stage2' },
    governance: { approvals: ['critical'], concurrency: 3, profile: 'full' },
  },
};

const ASSEMBLY_SAMPLE = [
  { agent: 'crm-copilot', assertion: 'permission_closure', ok: true, detail: 'actions ⊆ registry' },
  { agent: 'crm-copilot', assertion: 'derived_from', ok: true, detail: 'taskFlow:crm-nl-to-action' },
  { agent: 'lead-miner', assertion: 'permission_closure', ok: false, detail: 'missing: crm-account-360' },
];

describe('agentConfig 渲染纯函数（浏览器可加载子模块）', () => {
  test('agentConfigRender.js 无服务端 import（可被浏览器原生 ESM 加载）', () => {
    const src = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../../src/portal/agentConfigRender.js'),
      'utf8',
    );
    expect(src).not.toMatch(/from ['"]express['"]/);
    expect(src).not.toMatch(/from ['"][^'"]*(\.\.\/db\.js|\.\.\/decision\/|\.\.\/alerts\/)/);
    expect(src).not.toMatch(/createAgentConfigRouter/);
  });

  test('agentConfig.js 服务端文件导出 createAgentConfigRouter', async () => {
    const mod = await import('../../src/portal/agentConfig.js');
    expect(typeof mod.createAgentConfigRouter).toBe('function');
  });

  test('createAgentConfigRouter GET 聚合 specs+assembly', async () => {
    const { createAgentConfigRouter } = await import('../../src/portal/agentConfig.js');
    const router = createAgentConfigRouter({
      getSpecs: async () => ({ 'crm-copilot': SPEC_SAMPLE['crm-copilot'] }),
      getAssembly: async () => ASSEMBLY_SAMPLE,
    });
    let code = 200, body = null;
    const res = {
      status: (c) => { code = c; return { json: (p) => { body = p; } }; },
      json: (p) => { body = p; },
    };
    await router.handlers.get({}, res);
    expect(code).toBe(200);
    expect(body.agents).toEqual(['crm-copilot']);
    expect(body.specs['crm-copilot'].identity.name).toBe('crm-copilot');
    expect(body.assembly).toHaveLength(3);
  });

  test('renderAgentConfig 渲染 3 张 Agent 卡，每卡含六段式标题', () => {
    const html = renderAgentConfig({ agents: ['crm-copilot', 'deal-coach', 'lead-miner'], specs: {
      'crm-copilot': SPEC_SAMPLE['crm-copilot'],
      'deal-coach': SPEC_SAMPLE['crm-copilot'],
      'lead-miner': SPEC_SAMPLE['crm-copilot'],
    }, assembly: ASSEMBLY_SAMPLE });
    expect(html).toContain('crm-copilot');
    expect(html).toContain('deal-coach');
    expect(html).toContain('lead-miner');
    // 六段式标题
    for (const seg of ['身份', '能力', '上下文', '记忆', '评估', '治理']) {
      // 至少出现 3 次（每卡一次）
      const count = html.split(seg).length - 1;
      expect(count, `段标题 ${seg} 应每卡出现一次`).toBeGreaterThanOrEqual(3);
    }
  });

  test('renderAgentCard 单卡展示 identity/capabilities 明细', () => {
    const html = renderAgentCard(SPEC_SAMPLE['crm-copilot']);
    expect(html).toContain('crm-copilot');
    expect(html).toContain('taskFlow:crm-nl-to-action');
    expect(html).toContain('data-particle-read');
    expect(html).toContain('crm-deal-advance');
    expect(html).toContain('intent_to_action_accuracy');
  });

  test('renderAssembly 断言状态条：ok 徽标与 fail 徽标区分', () => {
    const html = renderAssembly(ASSEMBLY_SAMPLE);
    expect(html).toContain('permission_closure');
    expect(html).toContain('derived_from');
    // ok → .chip.ok / fail → .chip.fail
    expect(html).toMatch(/chip ok|chip\.ok|chip\s+ok/);
    expect(html).toMatch(/chip fail|chip\.fail|chip\s+fail/);
  });

  test('agentOk 判定：全 ok 返回 true，任一 fail 返回 false', () => {
    expect(agentOk([{ ok: true }, { ok: true }])).toBe(true);
    expect(agentOk([{ ok: true }, { ok: false }])).toBe(false);
    expect(agentOk([])).toBe(false);
  });

  test('空数据降级：无 agents 渲染空态提示', () => {
    const html = renderAgentConfig({ agents: [], specs: {}, assembly: [] });
    expect(html).toMatch(/空|empty|无配置|no agent/i);
  });
});