import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// test -> crm-native-cli -> packages -> 仓库根（三级）
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('包骨架', () => {
  it('package.json 声明 bin=crm-cli 且 engines.node>=22.20.0', () => {
    const p = JSON.parse(readFileSync(join(root, 'packages/crm-native-cli/package.json'), 'utf8'));
    expect(p.name).toBe('crm-native-cli');
    expect(p.bin['crm-cli']).toBe('src/cli.js');
    expect(p.type).toBe('module');
    expect(p.engines.node).toBe('>=22.20.0');
  });

  it('connector/cli.json 五段齐备且 statusMatchJson 为 valid', () => {
    const c = JSON.parse(readFileSync(join(root, 'connector/cli.json'), 'utf8'));
    for (const k of ['init', 'auth', 'unAuth', 'status', 'versionCheck']) {
      expect(c[k], `缺字段 ${k}`).toBeTruthy();
    }
    expect(c.statusMatchJson).toEqual({ status: 'valid' });
    expect(c.init.win32).toContain('npm install -g crm-native-cli');
    expect(c.status.win32).toBe('crm-cli auth status');
  });

  it('既有 MCP 通道文件未被删除', () => {
    expect(existsSync(join(root, 'connector/connector-meta.json'))).toBe(true);
    expect(existsSync(join(root, 'connector/mcp.json'))).toBe(true);
  });
});
