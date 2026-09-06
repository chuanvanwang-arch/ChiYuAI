// test/validate-contract.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractContractBlocks,
  parseContractYaml,
  validateContracts,
} from '../scripts/validate-contract.mjs';

const registry = JSON.parse(
  readFileSync(new URL('./fixtures/agentSpec.json', import.meta.url), 'utf8')
);

const BLOCK = `- task: "实现 agent-workbench 监控卡"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET /api/page/agent-workbench 返回 4 agent 装配状态且 SSE 刷新"`;

describe('extractContractBlocks', () => {
  it('提取单个 contract-yaml 块', () => {
    const md = '前言\n```contract-yaml\n' + BLOCK + '\n```\n尾声';
    const blocks = extractContractBlocks(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('agent: crm-copilot');
  });
  it('无块时返回空数组', () => {
    expect(extractContractBlocks('no contract here')).toEqual([]);
  });
});

describe('parseInlineMap multi-layer regression', () => {
  it('内联映射内多 layer 列表（含逗号）不误切', () => {
    const text = `- task: "t"
  agent: deal-coach
  skills: [data-particle-read]
  memory: [deal-coach, crm-copilot]
  knowledge_scope: { layers: [L1, L2] }
  success: "ok"`;
    const [c] = parseContractYaml(text);
    expect(c.knowledge_scope).toEqual({ layers: ['L1', 'L2'] });
  });
  it('deal-coach 多 layer 通过注册表交叉校验', () => {
    const text = `- task: "t"
  agent: deal-coach
  skills: [data-particle-read]
  memory: [deal-coach, crm-copilot]
  knowledge_scope: { layers: [L1, L2] }
  success: "ok"`;
    const r = validateContracts(parseContractYaml(text), { registry });
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
});

describe('parseContractYaml', () => {
  it('解析为含四个必填字段的对象', () => {
    const [c] = parseContractYaml(BLOCK);
    expect(c.task).toBe('实现 agent-workbench 监控卡');
    expect(c.agent).toBe('crm-copilot');
    expect(c.skills).toEqual(['data-particle-read']);
    expect(c.memory).toEqual(['crm-copilot']);
    expect(c.knowledge_scope).toEqual({ layers: ['L1'], max_hops: 2 });
    expect(c.success).toContain('SSE 刷新');
  });
});

describe('validateContracts 结构自检', () => {
  it('合法契约 valid=true 且无 errors', () => {
    const r = validateContracts(parseContractYaml(BLOCK));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });
  it('缺失 success 字段报错', () => {
    const bad = `- task: "t"\n  agent: a\n  skills: [s]\n  memory: [m]`;
    const r = validateContracts(parseContractYaml(bad));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.field === 'success')).toBe(true);
  });
  it('skills 非数组报错', () => {
    const bad = `- task: "t"\n  agent: a\n  skills: notalist\n  memory: [m]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad));
    expect(r.errors.some((e) => e.field === 'skills')).toBe(true);
  });
});

describe('validateContracts 注册表交叉校验', () => {
  it('合法契约通过（registry 提供）', () => {
    const r = validateContracts(parseContractYaml(BLOCK), { registry });
    expect(r.valid).toBe(true);
  });
  it('agent 不在注册表报错', () => {
    const bad = `- task: "t"\n  agent: ghost\n  skills: [s]\n  memory: [m]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some((e) => e.field === 'agent')).toBe(true);
  });
  it('skill 不在 agent.skillCalls 报错', () => {
    const bad = `- task: "t"\n  agent: crm-copilot\n  skills: [nonexistent-skill]\n  memory: [crm-copilot]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some((e) => e.field === 'skills' && e.message.includes('not in'))).toBe(true);
  });
  it('memory 不在 agent.memory.read 报错', () => {
    const bad = `- task: "t"\n  agent: crm-copilot\n  skills: [data-particle-read]\n  memory: [someone-else]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some((e) => e.field === 'memory')).toBe(true);
  });
  it('knowledge_scope.layers 不在注册表报错', () => {
    const bad = `- task: "t"\n  agent: crm-copilot\n  skills: [data-particle-read]\n  memory: [crm-copilot]\n  knowledge_scope: { layers: [L9] }\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some((e) => e.field === 'knowledge_scope')).toBe(true);
  });
});

describe('validate-contract CLI', () => {
  const CLI = fileURLToPath(new URL('../scripts/validate-contract.mjs', import.meta.url));
  const DOC_OK = fileURLToPath(new URL('./fixtures/doc-ok.md', import.meta.url));
  const DOC_BAD = fileURLToPath(new URL('./fixtures/doc-bad.md', import.meta.url));
  const REG = fileURLToPath(new URL('./fixtures/agentSpec.json', import.meta.url));
  const NODE = process.execPath;

  it('合法文档退出码 0 且 valid=true', () => {
    const out = execFileSync(NODE, [CLI, DOC_OK, '--registry', REG], { encoding: 'utf8' });
    const r = JSON.parse(out);
    expect(r.valid).toBe(true);
  });
  it('非法文档退出码 1 且含 errors', () => {
    let code = 0;
    let out = '';
    try {
      out = execFileSync(NODE, [CLI, DOC_BAD], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
      out = e.stdout;
    }
    expect(code).toBe(1);
    expect(JSON.parse(out).errors.length).toBeGreaterThan(0);
  });
  it('无参数退出码 2', () => {
    let code = 0;
    try {
      execFileSync(NODE, [CLI], { encoding: 'utf8' });
    } catch (e) {
      code = e.status;
    }
    expect(code).toBe(2);
  });
});
