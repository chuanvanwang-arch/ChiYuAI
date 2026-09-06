// test/living-contract/parser.test.js
import { describe, it, expect } from 'vitest';
import {
  stripQuotes, parseInlineList, parseInlineMap, parseValue,
  extractContractBlocks, parseContractYaml, validateContracts,
} from '../../src/contract/contractParser.js';
import * as cli from '../../scripts/validate-contract.mjs';

describe('contractParser 符号导出', () => {
  it('新路径导出全部解析函数', () => {
    expect(typeof extractContractBlocks).toBe('function');
    expect(typeof parseContractYaml).toBe('function');
    expect(typeof validateContracts).toBe('function');
    expect(typeof parseInlineMap).toBe('function');
  });
  it('原 scripts/validate-contract.mjs 仍 re-export 同名符号（既有 test/validate-contract.test.js 不破）', () => {
    expect(typeof cli.extractContractBlocks).toBe('function');
    expect(typeof cli.parseContractYaml).toBe('function');
    expect(typeof cli.validateContracts).toBe('function');
  });
});

describe('probe 可选内联映射解析', () => {
  it('解析含中文 expect_contains 的 probe 块', () => {
    const text = `- task: "t"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  probe: { type: http_get, path: /api/page/agent-workbench, expect_status: 200, expect_contains: "装配" }
  success: "ok"`;
    const [c] = parseContractYaml(text);
    expect(c.probe).toEqual({ type: 'http_get', path: '/api/page/agent-workbench', expect_status: 200, expect_contains: '装配' });
  });
  it('probe 缺失不影响 REQUIRED 校验（可选字段）', () => {
    const text = `- task: "t"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "ok"`;
    const r = validateContracts(parseContractYaml(text));
    expect(r.valid).toBe(true);
  });
});
