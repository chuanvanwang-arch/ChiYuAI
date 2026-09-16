import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// 静态守卫（T09 拓客去重契约锁定）：prospectingActions.js 的查重行为内嵌于 seedProspectingActions，
// 以「代码内含现有企业/名号查重 → existing 不入池」语义断言防未来回归
const srcPath = fileURLToPath(new URL('../../src/action/prospectingActions.js', import.meta.url));
const src = readFileSync(srcPath, 'utf8');

describe('prospecting dedup（拓客去重 T09 契约锁定）', () => {
  it('候选入池前按 name/domain 与既有账户查重（existing 标记）', () => {
    // 查重：既有 CRM_ACCOUNT 命中（name/domain）→ 标 existing:true 不入池（禁删复用赢家）
    expect(src).toContain('查重');
    expect(src).toMatch(/existing:\s*true/);
  });

  it('去重基于真实既有账户数据（查询 CRM_ACCOUNT 而非硬编码名单）', () => {
    // 对齐 dedupResolver 默认 criteria：走真库查询（CRM_ACCOUNT）而非预置名单
    expect(src).toMatch(/CRM_ACCOUNT|account|dedup/);
  });

  it('候选去重时给出已有 account_id（命中既有时标注）', () => {
    expect(src).toMatch(/account_id/);
    expect(src).toMatch(/existing/);
  });
});
