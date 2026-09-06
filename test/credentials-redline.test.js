// test/credentials-redline.test.js — 凭证补完三通道 + 绝对禁明文红线（Task 5）
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { verifyTokenPrefix } from '../src/mcp/auth.js';

const REDLINE = 'AI 永远不在对话中接收或显示密钥明文';

describe('凭证模板/命令不含明文', () => {
  it('.env.example 含 CRM_API_TOKEN= 且等号后无实际值', () => {
    const s = readFileSync('scripts/.env.example', 'utf8');
    expect(s).toContain('CRM_API_TOKEN=');
    expect(s).not.toMatch(/CRM_API_TOKEN=\S{8,}/);
  });
  it('setup-credentials.ps1 含 CRM_API_TOKEN 且无非明文 token', () => {
    const s = readFileSync('scripts/setup-credentials.ps1', 'utf8');
    expect(s).toContain('CRM_API_TOKEN');
    expect(s).not.toMatch(/CRM_API_TOKEN\s*=\s*"[A-Za-z0-9]{8,}/);
  });
});

describe('绝对禁明文红线字串落地', () => {
  it('≥9 个 skills/*/SKILL.md 含红线字串', () => {
    const dir = 'skills';
    const hits = readdirSync(dir).filter(d => {
      try { return readFileSync(join(dir, d, 'SKILL.md'), 'utf8').includes(REDLINE); } catch { return false; }
    });
    expect(hits.length).toBeGreaterThanOrEqual(9);
  });
});

describe('verifyTokenPrefix · 仅校验前 4 位（不接触明文）', () => {
  it('前缀匹配返回 true，不匹配返回 false', () => {
    process.env.CRM_API_TOKEN = 'abcdEFGHIJKL';
    expect(verifyTokenPrefix('abcd')).toBe(true);
    expect(verifyTokenPrefix('zzzz')).toBe(false);
    delete process.env.CRM_API_TOKEN;
  });
});
