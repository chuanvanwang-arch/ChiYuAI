// test/ui/discoveryCapsule.test.js — T19 分发面契约：buddy 线索发现胶囊
// 覆盖：manifest 胶囊形状（prompts/inspirations 非空）· 图标文件真实存在 ·
//       skills 值域不变量（⊆ connector/skills）· 门户 CAPS 绑定 · 门户↔校验表 parity
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('buddy-crm-manifest.json', 'utf8'));
const portal = readFileSync('src/web/buddy-crm-portal.html', 'utf8');
const check = readFileSync('scripts/buddy-capsule-binding-check.mjs', 'utf8');
const UPLOADED = new Set(readdirSync('connector/skills'));   // 已上架技能 = 场景「绑定技能」合法值域
const CAPS = manifest.home.workModes.flatMap((m) => m.capsules || []);
const TARGET = '线索发现';

describe('buddy 线索发现胶囊（T19）', () => {
  it('① manifest 有「线索发现」胶囊且形状完整（prompts/inspirations 非空）', () => {
    const cap = CAPS.find((c) => c.name === TARGET);
    expect(cap, TARGET).toBeTruthy();
    expect(cap.en).toBe('Lead Discovery');
    expect(cap.expert).toBe('AI 原生销售管理助手');
    expect(Array.isArray(cap.prompts) && cap.prompts.length > 0).toBe(true);
    expect(Array.isArray(cap.inspirations) && cap.inspirations.length > 0).toBe(true);
    expect(cap.systemPrompt).toContain('discovery-run');   // MCP 工具名落在 prompt，不落 skills
  });

  it('② 图标文件真实存在（pack-buddy-import 的 MISSING ICONS 硬闸）', () => {
    const cap = CAPS.find((c) => c.name === TARGET);
    expect(cap.icon).toBe('assets/capsules/discovery.svg');
    expect(existsSync(cap.icon), cap.icon).toBe(true);
  });

  it('③ 全 manifest 场景/模式 skills ⊆ 已上架技能（值域不变量）', () => {
    const viol = [];
    for (const w of manifest.home.workModes) {
      for (const s of w.skills || []) if (!UPLOADED.has(s)) viol.push(`${w.name}:${s}`);
      for (const c of w.capsules || []) {
        for (const s of c.skills || []) if (!UPLOADED.has(s)) viol.push(`${c.name}:${s}`);
      }
    }
    expect(viol).toEqual([]);
  });

  it('④ 门户 CAPS 在「客户洞察」tab 含 discovery-run（MCP 工具名 + 合法 targetAgent）', () => {
    const seg = portal.slice(portal.indexOf('"客户洞察": ['), portal.indexOf('"商机推进": ['));
    expect(seg).toContain('discovery-run');
    expect(seg).toContain('decision-agent');
  });

  it('⑤ 门户每个 CAPS label 都有 BINDINGS 行（防「加了 CAPS 却没进校验表」静默分叉）', () => {
    const labels = [...portal.matchAll(/\{ label: "([^"]+)"/g)].map((m) => m[1]);
    const caps = [...check.matchAll(/cap: '([^']+)'/g)].map((m) => m[1]);
    expect(labels.filter((l) => !caps.includes(l))).toEqual([]);
    expect(check).toContain("cap: '线索发现'");
    expect(check).toContain("skill: 'discovery-run'");
  });
});
