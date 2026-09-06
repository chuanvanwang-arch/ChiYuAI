// test/skills-action-mapping.test.js — G5-T1/T2 06 SKILL Action 明细收口（防漂移）
// 设计输入：docs/superpowers/plans/2026-08-26-ai-10-gap-repair-plan.md Task G5-T1/T2
// 判据：
// ① 12 个 SKILL.md（4 agent + 8 method）均有「Action 读清单」+「Action 写清单」两节
// ② 清单中列出的 Action 名 ⊆ seedActions() 注册集合（防文档与表面漂移）
// ③ 无 delete/remove Action（×4 CRUD 爆炸红线零命中）
// ④ MCP tools.js 暴露工具 ⊆ 注册集（G5-T2 联动：外部调用 = SKILL 消费面）
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { seedActions } from '../src/action/seed-actions.js';
import { listActions } from '../src/action/registry.js';
import { buildMcpTools } from '../src/mcp/tools.js';

// SKILL.md 清单（4 agent + 8 method = 12）
const SKILL_FILES = [
  'crm-native', 'crm-query', 'crm-write', 'crm-risk',
  'method-bant', 'method-meddicc', 'method-opportunity-matrix', 'method-role-map',
  'method-risk-tradeoff', 'method-stop-loss', 'method-fact-vs-script', 'method-presales',
];

function skillPath(slug) {
  return fileURLToPath(new URL(`../skills/${slug}/SKILL.md`, import.meta.url));
}

function readSkill(slug) {
  return readFileSync(skillPath(slug), 'utf8');
}

// 提取 SKILL.md 中「Action 读清单 / Action 写清单」节内容
function extractActionLists(md) {
  const read = [];
  const write = [];
  const re = /## Action (读|写)清单[\s\S]*?(?=## |$)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    const side = m[1] === '读' ? read : write;
    const body = m[0].replace(/## Action [读写]清单/, '');
    // 提取代码块中的 Action 名（行首 `action` 或行内反引号 `xxx-yyy`）
    for (const line of body.split('\n')) {
      const hits = [...line.matchAll(/`([a-z][a-z0-9-]+)`/g)];
      for (const h of hits) {
        const name = h[1];
        if (name.startsWith('crm-') || name.startsWith('data-')) side.push(name);
      }
    }
  }
  return { read: [...new Set(read)], write: [...new Set(write)] };
}

describe('G5-T1 12 SKILL.md Action 明细收口', () => {
  seedActions();
  const allNames = listActions().map((a) => a.name);
  const names = new Set(allNames);

  for (const slug of SKILL_FILES) {
    it(`[${slug}] 有读清单+写清单两节，且清单 Action ⊆ 注册集`, () => {
      const md = readSkill(slug);
      expect(md).toContain('## Action 读清单');
      expect(md).toContain('## Action 写清单');
      // 两节齐备：读清单至少 1 Action；写清单一侧可显式「只读/经 crm-write 转发」（R5 同名不同侧）——
      // 非空校验改为「写清单存在标记」，避免纯读技能（crm-query/crm-risk）误判全空
      const lists = extractActionLists(md);
      expect(lists.read.length).toBeGreaterThan(0);
      // 防漂移：清单名 ⊆ 注册集（读/写两侧都查，写一侧可为转发提示）
      for (const name of [...lists.read, ...lists.write]) {
        expect(names.has(name)).toBe(true);
      }
    });
  }

  it('无 delete/remove Action（×4 CRUD 红线零命中）', () => {
    expect(allNames.some((n) => /delete|remove/.test(n))).toBe(false);
  });
});

describe('G5-T2 MCP tools 与注册集互查（外部调用 = SKILL 消费面）', () => {
  it('tools.js 暴露工具名 ⊆ seedActions 注册集（业务工具；crm_login 为独立 auth 工具）', () => {
    seedActions();
    const { tools } = buildMcpTools({ seed: true });
    const names = new Set(listActions().map((a) => a.name));
    // 业务工具（read/write/read_sensitive）全部来自 Action Registry；auth 工具（crm_login）有意独立于 registry
    for (const t of tools.filter((t) => t.kind !== 'auth')) {
      expect(names.has(t.name)).toBe(true);
    }
    expect(tools.some((t) => t.name === 'crm_login' && t.kind === 'auth')).toBe(true);
    // 读/写/敏感读三分组齐备
    const kinds = new Set(tools.map((t) => t.kind));
    expect(kinds.has('read')).toBe(true);
    expect(kinds.has('write')).toBe(true);
  });

  it('listMcpTools 业务工具与 registry 数量一致（无独立 Action 集；auth 工具单列）', () => {
    seedActions();
    const { tools } = buildMcpTools({ seed: true });
    // 2026-09-04：暴露写判据与 tools.js 保持一致——data-* substrate 默认不上 MCP，
    //   仅 Action 显式 mcpExpose===true 才单点放开（data-particle-create）。
    // 2026-09-04 修正（前序既有缺陷，非本次引入）：本断言原先漏掉 tools.js:45 的
    //   lifecycle!=='reserved' 过滤，把 30 个死表面（read 7 + read_sensitive 4 + write 19）计入
    //   → 断言恒差 30。测试公式必须与暴露面同口径，否则数量对齐契约失效。
    const visible = (a) => a.lifecycle !== 'reserved';
    const exposedWrite = (a) => a.kind === 'write'
      && (!a.name.startsWith('data-') || a.mcpExpose === true);
    const reg = listActions()
      .filter((a) => visible(a) && (a.kind !== 'write' || exposedWrite(a))).length;
    // 读+敏感读全暴露（reserved 除外） + 暴露写（data-* 默认排除，mcpExpose 例外）→ 数量对齐
    const readN = listActions().filter((a) => a.kind === 'read' && visible(a)).length;
    const sensN = listActions().filter((a) => a.kind === 'read_sensitive' && visible(a)).length;
    const bizWriteN = listActions().filter((a) => visible(a) && exposedWrite(a)).length;
    expect(tools.filter((t) => t.kind !== 'auth').length).toBe(readN + sensN + bizWriteN);
    expect(reg).toBe(readN + sensN + bizWriteN);
    expect(tools.filter((t) => t.kind === 'auth').map((t) => t.name)).toEqual(['crm_login']);
  });
});