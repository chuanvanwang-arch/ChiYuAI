// test/connectors/discovery/industryDiscovery.test.js
// §12.2/§12.4 行业 handbook Step 4C **三面**一致性
//
// 三面：
//   PLATFORM = 平台侧技能（随 plugin-platform-admin.zip 分发，**tracked**）
//   LOCAL    = 本地运行时技能（.workbuddy/ 被 .gitignore:134 忽略 ⇒ 生效但不入库）
//   RUNBOOK  = 上线 runbook（docs/runbooks/，**tracked**；2026-09-11 补 Step 4C，消除已声明的第三面分叉）
//
// ⚠ 不得对本地侧断言 Step 4B / Step 4.5 —— 本地侧章节结构为 `Step 1..9`（`## 2.`–`## 15.`），
//    **从未有** 4B/4.5（grep 零命中）；两文档本非同构，为对齐而臆造补写属越界。
//    runbook 同理由：其编号体系为 `## N.`，故 Step 4C 落为 `## 4.5`（不臆造 4B）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const PLATFORM = 'plugin-platform-admin/skills/industry-onboarding/SKILL.md';
const LOCAL = '.workbuddy/skills/new-industry-onboarding/SKILL.md';
const RUNBOOK = 'docs/runbooks/2026-09-03-new-industry-onboarding.md';

describe('行业 handbook Step 4C（§12.2/§12.4）', () => {
  it('① 平台侧：Step 4C 存在，且既有 Step 4B / Step 4.5 未被破坏', () => {
    const src = readFileSync(PLATFORM, 'utf8');
    expect(src).toMatch(/Step 4C/);
    expect(src).toMatch(/discovery-rules/);
    expect(src).toMatch(/付费源/);
    expect(src).toMatch(/Step 4B/);
    expect(src).toMatch(/Step 4\.5/);
  });

  it('② 本地侧（运行时技能）：Step 4C 同款指引存在', () => {
    const src = readFileSync(LOCAL, 'utf8');
    expect(src).toMatch(/Step 4C/);
    expect(src).toMatch(/discovery-rules/);
    expect(src).toMatch(/付费源/);
  });

  it('③ 三面关键铁律一致：D1 三档 + 系统候选 + 第 0 闸', () => {
    for (const f of [PLATFORM, LOCAL, RUNBOOK]) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/system-candidate/);
      expect(src, f).toMatch(/第\s*0\s*闸/);
    }
  });

  it('④ 第三面 runbook（tracked）：Step 4C 同款指引存在', () => {
    // ⚠ 鉴别力基线：HEAD 版 runbook 对以下四词命中数全为 0（`Step 4C`/`discovery-rules`/`付费源`/`system-candidate`）
    //    ⇒ 断言非恒真；删节必红（已用变异 M9 证实）。
    const src = readFileSync(RUNBOOK, 'utf8');
    expect(src).toMatch(/Step 4C/);
    expect(src).toMatch(/discovery-rules/);
    expect(src).toMatch(/付费源/);
    expect(src).toMatch(/system-candidate/);
    // 编号体系保真：runbook 用 `## 4.5`，不臆造 `Step 4B`
    expect(src).toMatch(/^## 4\.5 .*Step 4C/m);
    expect(src).not.toMatch(/Step 4B/);
  });
});
