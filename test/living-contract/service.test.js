// test/living-contract/service.test.js
import { describe, it, expect } from 'vitest';
import { collectContracts, staticCheck } from '../../src/contract/contractService.js';

const REG = {
  'crm-copilot': {
    capabilities: { skillCalls: ['data-particle-read', 'data-particle-create'], knowledgeScope: { layers: ['L1'] } },
    memory: { read: ['crm-copilot'] },
  },
};
const MD = `前言
\`\`\`contract-yaml
- task: "对齐的契约"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "ok"
\`\`\`
\`\`\`contract-yaml
- task: "skill 越界的契约"
  agent: crm-copilot
  skills: [ghost-skill]
  memory: [crm-copilot]
  success: "ok"
\`\`\`
尾注`;

describe('collectContracts', () => {
  it('glob 出两块契约并附 doc_path', () => {
    const walk = () => ['docs/x.md'];
    const readFile = (p) => (p === 'docs/x.md' ? MD : '');
    const { docs } = collectContracts({ docsRoot: 'docs', registry: REG, walk, readFile });
    expect(docs).toHaveLength(1);
    expect(docs[0].doc_path).toBe('docs/x.md');
    expect(docs[0].contracts).toHaveLength(2);
  });
  it('无 contract-yaml 的文档被跳过', () => {
    const { docs } = collectContracts({ docsRoot: 'docs', registry: REG, walk: () => ['a.md'], readFile: () => 'no contract' });
    expect(docs).toHaveLength(0);
  });
});

describe('staticCheck', () => {
  it('skills⊆skillCalls → skills_aligned=true', () => {
    const r = staticCheck({ agent: 'crm-copilot', skills: ['data-particle-read'], memory: ['crm-copilot'] }, REG);
    expect(r.skills_aligned).toBe(true);
    expect(r.memory_aligned).toBe(true);
  });
  it('skill 不在 skillCalls → skills_aligned=false 且 issues 标注', () => {
    const r = staticCheck({ agent: 'crm-copilot', skills: ['ghost-skill'], memory: ['crm-copilot'] }, REG);
    expect(r.skills_aligned).toBe(false);
    expect(r.skills_issues[0]).toContain('ghost-skill');
  });
  it('agent 不在注册表 → agent_found=false', () => {
    const r = staticCheck({ agent: 'ghost', skills: [], memory: [] }, REG);
    expect(r.agent_found).toBe(false);
    expect(r.skills_aligned).toBe(false);
  });
});
