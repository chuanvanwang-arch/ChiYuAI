# Brainstorming SKILL 重建设计实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把用户级 `~/.workbuddy/skills/brainstorming/SKILL.md` 升级为「设计期埋点 + 运行期闭环」的方法论中枢，使每份设计自带可监控契约（living contract），并新增轻量校验器与反馈聚合器支撑闭环。

**Architecture:** 三件套——① 重写 `SKILL.md`（保留 HARD-GATE / 一次一题 / 2-3 方案 / P6–P9，新增 P0 回写预检、§A 契约 schema、§B 闭环机制、§C 校验器约定）；② `scripts/validate-contract.mjs`（抽取 `contract-yaml` 块→解析→执行 §A 自检→输出 `{valid,errors}`，支持 `--registry` 交叉校验）；③ `scripts/aggregate-feedback.mjs`（读 `*.feedback.json`，对复现 ≥2 次的 `(task,gap_type)` 产出 SKILL 改进提案，仅提案、需批准）。契约四字段 `agent/skills/memory/success` 对齐 `src/agent/agentSpec.js` 的 `skillCalls / memory.read / knowledgeScope.layers`，但契约保持通用、CRM 仅作参考实例。

**Tech Stack:** Node 22 ESM（`.mjs`）、vitest 3、零外部依赖（内置极简 YAML 解析，覆盖本契约 schema）。

**Spec:** `docs/specs/2026-08-29-brainstorming-redesign-design.md`（已批准）

---

## 文件结构

| 动作 | 路径 | 职责 |
|------|------|------|
| Modify | `~/.workbuddy/skills/brainstorming/SKILL.md` | 重写 skill 正文，内嵌 P0 / §A / §B / §C |
| Create | `scripts/validate-contract.mjs` | 契约抽取+解析+自检+CLI（可导入供测试） |
| Create | `scripts/aggregate-feedback.mjs` | 反馈聚合→改进提案引擎+CLI |
| Create | `test/validate-contract.test.js` | vitest：解析/结构/注册表/CLI 行为 |
| Create | `test/aggregate-feedback.test.js` | vitest：复现计数→提案 |
| Create | `test/fixtures/agentSpec.json` | 注册表 JSON 夹具（crm 三 agent 子集） |

> 注：因沙箱无私有库凭证，所有 `git commit` 由用户本地执行；计划内 commit 步骤仅给出命令，不实际运行。

---

## Task 1: 校验器核心 —— 抽取 + 极简 YAML 解析 + 结构自检

**Files:**
- Create: `scripts/validate-contract.mjs`
- Test: `test/validate-contract.test.js`

- [ ] **Step 1: 写失败测试（抽取 + 解析 + 结构自检）**

```js
// test/validate-contract.test.js
import { describe, it, expect } from 'vitest';
import { extractContractBlocks, parseContractYaml, validateContracts } from '../scripts/validate-contract.mjs';

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
    expect(r.errors.some(e => e.field === 'success')).toBe(true);
  });
  it('skills 非数组报错', () => {
    const bad = `- task: "t"\n  agent: a\n  skills: notalist\n  memory: [m]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad));
    expect(r.errors.some(e => e.field === 'skills')).toBe(true);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/validate-contract.test.js`
Expected: FAIL（模块不存在 / 函数未定义）

- [ ] **Step 3: 写最小实现**

```js
// scripts/validate-contract.mjs
// 极简 YAML 解析：仅覆盖本契约 schema（列表项 + 标量/内联数组/内联映射）。
// 通用 skill 不依赖任何外部 YAML 库。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED = ['task', 'agent', 'skills', 'memory', 'success'];

export function stripQuotes(s) {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseInlineList(v) {
  const inner = v.slice(1, v.lastIndexOf(']')).trim();
  if (!inner) return [];
  return inner.split(',').map(s => stripQuotes(s.trim())).filter(Boolean);
}

export function parseInlineMap(v) {
  const inner = v.slice(1, v.lastIndexOf('}')).trim();
  const obj = {};
  if (!inner) return obj;
  inner.split(',').forEach(pair => {
    const ci = pair.indexOf(':');
    if (ci === -1) return;
    const k = pair.slice(0, ci).trim();
    const val = pair.slice(ci + 1).trim();
    obj[k] = val.startsWith('[') ? parseInlineList(val)
      : (val.startsWith('"') && val.endsWith('"') ? stripQuotes(val) : val);
  });
  return obj;
}

export function parseValue(v) {
  if (v.startsWith('[')) return parseInlineList(v);
  if (v.startsWith('{')) return parseInlineMap(v);
  return stripQuotes(v);
}

export function extractContractBlocks(md) {
  const re = /```contract-yaml\s*\n([\s\S]*?)```/g;
  const out = [];
  let m;
  while ((m = re.exec(md)) !== null) out.push(m[1]);
  return out;
}

export function parseContractYaml(text) {
  const lines = text.split(/\r?\n/);
  const contracts = [];
  let cur = null;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const listMatch = /^-\s+(.*)$/.exec(raw);
    if (listMatch) {
      cur = {};
      contracts.push(cur);
      const rest = listMatch[1];
      const idx = rest.indexOf(':');
      if (idx === -1) continue;
      cur[rest.slice(0, idx).trim()] = parseValue(rest.slice(idx + 1).trim());
      continue;
    }
    const kv = /^\s+([A-Za-z_][A-Za-z_]*):\s*(.*)$/.exec(raw);
    if (kv && cur) {
      cur[kv[1]] = parseValue(kv[2].trim());
    }
  }
  return contracts;
}

export function validateContracts(contracts, { registry } = {}) {
  const errors = [];
  if (!Array.isArray(contracts)) contracts = [];
  contracts.forEach((c, i) => {
    const where = c && c.task ? `task "${c.task}"` : `contract #${i + 1}`;
    if (c == null) { errors.push({ where, field: '(root)', message: 'contract is null' }); return; }
    for (const f of REQUIRED) {
      if (c[f] === undefined || c[f] === null || c[f] === '') {
        errors.push({ where, field: f, message: `missing required field "${f}"` });
      }
    }
    if (c.skills !== undefined && !Array.isArray(c.skills)) errors.push({ where, field: 'skills', message: 'skills must be a list' });
    if (c.memory !== undefined && !Array.isArray(c.memory)) errors.push({ where, field: 'memory', message: 'memory must be a list' });
    if (registry && c.agent !== undefined) {
      const spec = registry[c.agent];
      if (!spec) {
        errors.push({ where, field: 'agent', message: `agent "${c.agent}" not found in registry` });
      } else {
        const skills = spec.capabilities?.skillCalls || [];
        const mem = spec.memory?.read || [];
        const layers = spec.capabilities?.knowledgeScope?.layers || [];
        (c.skills || []).forEach(s => { if (!skills.includes(s)) errors.push({ where, field: 'skills', message: `skill "${s}" not in ${c.agent}.skillCalls` }); });
        (c.memory || []).forEach(mm => { if (!mem.includes(mm)) errors.push({ where, field: 'memory', message: `memory "${mm}" not in ${c.agent}.memory.read` }); });
        (c.knowledge_scope?.layers || []).forEach(l => { if (!layers.includes(l)) errors.push({ where, field: 'knowledge_scope', message: `layer "${l}" not in ${c.agent}.knowledgeScope.layers` }); });
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

export async function loadRegistry(p) {
  if (!p) return null;
  if (p.endsWith('.json')) return JSON.parse(readFileSync(p, 'utf8'));
  const mod = await import(pathToFileURL(p).href);
  return mod.agentSpecs || mod.default?.agentSpecs || mod.default || null;
}

async function main() {
  const args = process.argv.slice(2);
  const docPath = args.find(a => !a.startsWith('--'));
  const regIdx = args.indexOf('--registry');
  const registry = regIdx !== -1 ? await loadRegistry(args[regIdx + 1]) : null;
  if (!docPath) {
    console.error('usage: node validate-contract.mjs <doc.md> [--registry path]');
    process.exit(2);
  }
  const md = readFileSync(docPath, 'utf8');
  const contracts = extractContractBlocks(md).flatMap(b => parseContractYaml(b));
  const result = validateContracts(contracts, { registry });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.valid ? 0 : 1);
}

// 仅在 CLI 直接运行时执行（被 import 时不触发）
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/validate-contract.test.js`
Expected: PASS（4 个 describe 全绿）

- [ ] **Step 5: 提交**

```bash
git add scripts/validate-contract.mjs test/validate-contract.test.js
git commit -m "feat: add contract validator core (extract+parse+structural self-check)"
```

---

## Task 2: 注册表交叉校验（对齐 agentSpec）

**Files:**
- Create: `test/fixtures/agentSpec.json`
- Test: `test/validate-contract.test.js`（追加）

- [ ] **Step 1: 写失败测试（注册表交叉）**

```js
// 追加到 test/validate-contract.test.js
import { readFileSync } from 'node:fs';

const registry = JSON.parse(readFileSync(new URL('./fixtures/agentSpec.json', import.meta.url), 'utf8'));

describe('validateContracts 注册表交叉校验', () => {
  it('合法契约通过（registry 提供）', () => {
    const r = validateContracts(parseContractYaml(BLOCK), { registry });
    expect(r.valid).toBe(true);
  });
  it('agent 不在注册表报错', () => {
    const bad = `- task: "t"\n  agent: ghost\n  skills: [s]\n  memory: [m]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some(e => e.field === 'agent')).toBe(true);
  });
  it('skill 不在 agent.skillCalls 报错', () => {
    const bad = `- task: "t"\n  agent: crm-copilot\n  skills: [nonexistent-skill]\n  memory: [crm-copilot]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some(e => e.field === 'skills' && e.message.includes('not in'))).toBe(true);
  });
  it('memory 不在 agent.memory.read 报错', () => {
    const bad = `- task: "t"\n  agent: crm-copilot\n  skills: [data-particle-read]\n  memory: [someone-else]\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some(e => e.field === 'memory')).toBe(true);
  });
  it('knowledge_scope.layers 不在注册表报错', () => {
    const bad = `- task: "t"\n  agent: crm-copilot\n  skills: [data-particle-read]\n  memory: [crm-copilot]\n  knowledge_scope: { layers: [L9] }\n  success: "ok"`;
    const r = validateContracts(parseContractYaml(bad), { registry });
    expect(r.errors.some(e => e.field === 'knowledge_scope')).toBe(true);
  });
});
```

- [ ] **Step 2: 创建夹具**

```json
{
  "crm-copilot": {
    "capabilities": {
      "skillCalls": ["data-particle-read", "data-particle-create"],
      "knowledgeScope": { "layers": ["L1"], "maxHops": 2 }
    },
    "memory": { "read": ["crm-copilot"] }
  },
  "deal-coach": {
    "capabilities": {
      "skillCalls": ["data-particle-read"],
      "knowledgeScope": { "layers": ["L1", "L2"], "maxHops": 3 }
    },
    "memory": { "read": ["deal-coach", "crm-copilot"] }
  },
  "lead-miner": {
    "capabilities": {
      "skillCalls": ["data-particle-read"],
      "knowledgeScope": { "layers": ["L1", "L2"], "maxHops": 3 }
    },
    "memory": { "read": ["lead-miner"] }
  }
}
```

- [ ] **Step 3: 运行测试，确认通过**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/validate-contract.test.js`
Expected: PASS（含新增 5 例全绿）

- [ ] **Step 4: 提交**

```bash
git add test/fixtures/agentSpec.json test/validate-contract.test.js
git commit -m "test: add registry cross-check for contract validator"
```

---

## Task 3: 校验器 CLI 与退出码

**Files:**
- Test: `test/validate-contract.test.js`（追加 CLI 行为测试）

- [ ] **Step 1: 写失败测试（CLI 退出码 + 输出）**

```js
// 追加到 test/validate-contract.test.js
import { execFileSync } from 'node:child_process';

const CLI = new URL('../scripts/validate-contract.mjs', import.meta.url).pathname;
const DOC_OK = new URL('./fixtures/doc-ok.md', import.meta.url).pathname;
const DOC_BAD = new URL('./fixtures/doc-bad.md', import.meta.url).pathname;
const REG = new URL('./fixtures/agentSpec.json', import.meta.url).pathname;

describe('validate-contract CLI', () => {
  it('合法文档退出码 0 且 valid=true', () => {
    const out = execFileSync('node', [CLI, DOC_OK, '--registry', REG], { encoding: 'utf8' });
    const r = JSON.parse(out);
    expect(r.valid).toBe(true);
  });
  it('非法文档退出码 1 且含 errors', () => {
    let code = 0, out = '';
    try { out = execFileSync('node', [CLI, DOC_BAD], { encoding: 'utf8' }); }
    catch (e) { code = e.status; out = e.stdout; }
    expect(code).toBe(1);
    expect(JSON.parse(out).errors.length).toBeGreaterThan(0);
  });
  it('无参数退出码 2', () => {
    let code = 0;
    try { execFileSync('node', [CLI], { encoding: 'utf8' }); }
    catch (e) { code = e.status; }
    expect(code).toBe(2);
  });
});
```

- [ ] **Step 2: 创建 CLI 测试夹具文档**

`test/fixtures/doc-ok.md` 内容（含一段合法契约）：
````markdown
# 示例设计
```contract-yaml
- task: "实现 agent-workbench 监控卡"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET /api/page/agent-workbench 返回 4 agent 装配状态且 SSE 刷新"
```
````

`test/fixtures/doc-bad.md` 内容（缺 success）：
````markdown
# 坏设计
```contract-yaml
- task: "t"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
```
````

- [ ] **Step 3: 确认 Task 1 的 `main()` 与 `import.meta.url` 守卫已就位（已包含）**

无需新增实现；`main()` 已读取 `--registry` 与文档路径，输出 `JSON.stringify(result)` 并以 `result.valid ? 0 : 1` 退出；无参数时 `process.exit(2)`。

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/validate-contract.test.js`
Expected: PASS（含 3 个 CLI 测试）

- [ ] **Step 5: 提交**

```bash
git add test/fixtures/doc-ok.md test/fixtures/doc-bad.md test/validate-contract.test.js
git commit -m "test: add CLI exit-code behavior for contract validator"
```

---

## Task 4: 反馈聚合器 —— 复现 ≥2 次产出改进提案

**Files:**
- Create: `scripts/aggregate-feedback.mjs`
- Test: `test/aggregate-feedback.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/aggregate-feedback.test.js
import { describe, it, expect } from 'vitest';
import { aggregateFeedback } from '../scripts/aggregate-feedback.mjs';

const feedback = [
  { task: 't1', agent: 'crm-copilot', gap_type: 'skill', observed: 'x', expected: 'y', ts: '2026-08-29T10:00:00+08:00', severity: 'warn' },
  { task: 't1', agent: 'crm-copilot', gap_type: 'skill', observed: 'x', expected: 'y', ts: '2026-08-29T11:00:00+08:00', severity: 'error' },
  { task: 't2', agent: 'deal-coach', gap_type: 'memory', observed: 'a', expected: 'b', ts: '2026-08-29T10:30:00+08:00', severity: 'warn' },
];

describe('aggregateFeedback', () => {
  it('仅对复现 ≥2 次产出提案', () => {
    const props = aggregateFeedback(feedback);
    expect(props).toHaveLength(1);
    expect(props[0].task).toBe('t1');
    expect(props[0].gap_type).toBe('skill');
    expect(props[0].occurrences).toBe(2);
    expect(props[0].requiresApproval).toBe(true);
  });
  it('提案含可落地的建议文案', () => {
    const [p] = aggregateFeedback(feedback);
    expect(p.proposal).toContain('skill');
  });
  it('空输入返回空数组', () => {
    expect(aggregateFeedback([])).toEqual([]);
  });
});
```

- [ ] **Step 2: 运行测试，确认失败**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/aggregate-feedback.test.js`
Expected: FAIL（模块/函数未定义）

- [ ] **Step 3: 写最小实现**

```js
// scripts/aggregate-feedback.mjs
// P0 回写吸收引擎（brainstorming 侧）：读取 feedback 列表，对复现 ≥2 次的
// (task, gap_type) 产出 SKILL/设计改进提案。仅提案，绝不自动修改/删除。
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SUGGESTION_TEMPLATES = {
  skill: (t) => `考虑为 ${t.agent} 的 agentSpec.capabilities.skillCalls 补充缺失的 SKILL，或在承接 SKILL 指令中强化对该 SKILL 的强制调用。`,
  memory: (t) => `考虑将 ${t.expected} 加入 ${t.agent}.memory.read，或在 SKILL 中明确该记忆/知识读取约定。`,
  success: (t) => `复核 ${t.task} 的 success 判定标准是否可达；若标准过严则在设计阶段重设可验证阈值。`,
};

export function aggregateFeedback(feedback, { threshold = 2 } = {}) {
  if (!Array.isArray(feedback)) return [];
  const groups = new Map();
  for (const f of feedback) {
    if (!f || !f.task || !f.gap_type) continue;
    const key = `${f.task}::${f.gap_type}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const proposals = [];
  for (const [key, items] of groups) {
    if (items.length < threshold) continue;
    const [task, gap_type] = key.split('::');
    const t = { task, gap_type, agent: items[0].agent, expected: items[0].expected, observed: items[0].observed };
    const template = SUGGESTION_TEMPLATES[gap_type] || ((x) => `复核 ${x.task} 的 ${x.gap_type} 偏差（复现 ${items.length} 次）。`);
    proposals.push({
      task,
      gap_type,
      occurrences: items.length,
      agent: t.agent,
      proposal: template(t),
      requiresApproval: true,
    });
  }
  return proposals;
}

async function main() {
  const args = process.argv.slice(2);
  const path = args.find(a => !a.startsWith('--'));
  if (!path) {
    console.error('usage: node aggregate-feedback.mjs <doc>.feedback.json');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(data) ? data : (data.feedback || []);
  const proposals = aggregateFeedback(list);
  console.log(JSON.stringify({ proposals }, null, 2));
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
```

- [ ] **Step 4: 运行测试，确认通过**

Run: `cd D:/system/CRM-ai-native && node node_modules/vitest/vitest.mjs run test/aggregate-feedback.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/aggregate-feedback.mjs test/aggregate-feedback.test.js
git commit -m "feat: add feedback aggregation engine (recurring-gap proposals)"
```

---

## Task 5: 重写 brainstorming SKILL.md（内嵌 P0 / §A / §B / §C）

**Files:**
- Modify: `~/.workbuddy/skills/brainstorming/SKILL.md`（完整重写）

- [ ] **Step 1: 备份并读取现有文件（已读，覆盖写入）**

- [ ] **Step 2: 写入新 SKILL.md 全文**

```markdown
---
name: brainstorming
description: "You MUST use this before any creative work - creating features, building components, adding functionality, or modifying behavior. Explores user intent, requirements and design before implementation. Upgraded to also emit a monitorable living contract (agent/skills/memory/success) and drive a closed loop of SKILL/design improvement from runtime feedback."
---

# Brainstorming Ideas Into Monitorable Designs

Turn ideas into fully formed, *monitorable* designs through collaborative dialogue. A design is not finished when it is approved — it is finished when the agents that execute it can be verified against what you promised.

This skill introduces a **living contract**: every design task declares what SKILL the executing agent must call, what memory/knowledge it must read, and what success looks like. The agent workbench (`/agents`, `agent-workbench.html`) validates that contract at runtime and writes feedback; the next session reads that feedback and proposes SKILL/design improvements — **for your approval only**.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but you MUST present it and get approval.

## Checklist (P0–P10)

1. **P0 回写预检** — read `<doc>.feedback.json` and the spec's `## 闭环回写`; if gaps exist, list them as open items.
2. **P1 探索上下文** — files, docs, agentSpec / agent registry, recent commits.
3. **P2 澄清提问** — one at a time, multiple-choice preferred.
4. **P3 提出 2-3 方案** — with trade-offs and your recommendation.
5. **P4 呈现设计** — in sections; each task embeds a living contract (§A).
6. **P5 批准闸门** — HARD-GATE unchanged.
7. **P6 写设计文档** — embed dual-track contract (machine block + prose).
8. **P7 规格自检** — include contract validity (run `scripts/validate-contract.mjs`, §C).
9. **P8 用户评审** — user reviews the written spec.
10. **P9 移交 writing-plans** — tasks inherit the same contract.
11. **P10 闭环回写** — workbench monitors → writes feedback → next P0 absorbs → proposes SKILL improvements (approval-gated).

## Process Flow

```
P0 回写预检 → P1 探索 → P2 澄清 → P3 方案 → P4 呈现(含契约)
   → P5 批准 → P6 写文档(含契约) → P7 自检(契约有效) → P8 用户评审
   → P9 移交 writing-plans → P10 闭环回写 → (下一轮 P0 吸收)
```

**The terminal state is invoking writing-plans.** Do NOT invoke frontend-design, mcp-builder, or any other implementation skill. The ONLY skill you invoke after brainstorming is writing-plans.

## The Process

**Understanding the idea:**

- Check the current project state first (files, docs, recent commits).
- Identify the **executing agent(s)** and their **registry** (e.g., `agentSpec.js`) early — you will need them to write a valid contract in P4.
- If the request spans multiple independent subsystems, decompose first (one spec → plan → implementation per subsystem).
- Ask questions one at a time; prefer multiple choice.

**Exploring approaches:**

- Propose 2-3 different approaches with trade-offs; lead with your recommendation.

**Presenting the design:**

- Present in sections scaled to complexity; ask after each section.
- **Each task must carry a living contract** (§A): show the `contract-yaml` block + one-line prose. This is what makes the design monitorable.

**Design for isolation and clarity:**

- Break the system into smaller, well-bounded units; same rule applies to design tasks — each task should map to one agent and one verifiable success criterion.

**Working in existing codebases:**

- Follow existing patterns; include targeted improvements only where they serve the current goal.

## §A Living Contract（生命契约）— 双轨

Each design task MUST carry:

1. A machine block fenced as ```` ```contract-yaml ````.
2. A one-line prose restatement.

```contract-yaml
- task: "实现 agent-workbench 监控卡"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET /api/page/agent-workbench 返回 4 agent 装配状态且 SSE 刷新"
```
**契约说明：** 本任务由 `crm-copilot` 承接，必须调用 `data-particle-read` SKILL、读取 `crm-copilot` 记忆（L1，≤2 跳）；成功标准为接口返回 4 个智能体装配态且 SSE 实时刷新。

**Field semantics:**

| 字段 | 必填 | 含义 | 对齐既有模型 |
|------|------|------|--------------|
| `task` | 是 | 任务标题/ID | 与 writing-plans 任务粒度一致 |
| `agent` | 是 | 承接智能体 key | 注册表 key（如 crm-copilot / deal-coach / lead-miner，可扩展） |
| `skills` | 是 | 预期调用的 SKILL 列表 | 必须是该 agent `skillCalls` 子集 |
| `memory` | 是 | 预期读取的记忆/知识 | 对齐 `memory.read` |
| `knowledge_scope` | 否 | 知识层与跳数约束 | 对齐 `knowledgeScope` |
| `success` | 是 | 可验证成功标准（判定式） | workbench 据其做布尔判定 |

**Self-check (P7 mandatory):** each task requires `agent + skills + memory + success`; `agent` must resolve in the registry; each `skill` ⊆ `agent.skillCalls`; each `memory` ∈ `agent.memory.read`; `knowledge_scope.layers` ⊆ `agent.knowledgeScope.layers`. Any failure → design not approved, return to P4.

**Generality:** the four fields are parameterized. The CRM `agentSpec.js` roster is a **reference instance** only — do NOT hardcode CRM-specific nouns as normative in this skill.

## §B Closed-Loop Mechanism (workbench ↔ brainstorming)

- **Monitoring (workbench side):** parse `contract-yaml` blocks; per task track: (1) did the agent call the declared `skills`? (2) did it read the declared `memory`/knowledge? (3) did `success` pass?
- **Feedback record:** on any miss/failure, append:
```json
{ "task": "...", "agent": "...", "gap_type": "skill|memory|success", "observed": "...", "expected": "...", "ts": "...", "severity": "warn|error" }
```
  Write to `<design-doc>.feedback.json` (machine, idempotent upsert by `task+gap_type`) and mirror into the spec's `## 闭环回写` table (human).
- **Absorption & suggestion (P0):** read `*.feedback.json`; if the same `(task, gap_type)` recurs ≥ 2 times → produce a **SKILL improvement proposal** (e.g., add `skillCalls` to agentSpec, strengthen a SKILL's call instruction, add a memory-read convention). Present as a proposal; **requires explicit user approval before any change**. Never modify a SKILL file or perform DELETE without approval.

## §C Validator Convention

Before finishing P7, run:

```bash
node scripts/validate-contract.mjs <doc.md> [--registry src/agent/agentSpec.js]
```

It extracts all `contract-yaml` blocks, parses them, and runs the §A self-check. Exit code 0 = valid, 1 = invalid (with JSON `{valid,errors}`). Without `--registry` it performs structural checks only; with a registry it also cross-checks skill/memory/layer membership.

To aggregate recurring feedback into proposals (P0), run:

```bash
node scripts/aggregate-feedback.mjs <doc>.feedback.json
```

## Key Principles

- **One question at a time** - Don't overwhelm with multiple questions.
- **Multiple choice preferred** - Easier to answer than open-ended when possible.
- **YAGNI ruthlessly** - Remove unnecessary features from all designs.
- **Explore alternatives** - Always propose 2-3 approaches before settling.
- **Incremental validation** - Present design, get approval before moving on.
- **Design-time instrumentation** - A task without a contract is not monitorable; a design without a contract is incomplete.
- **Approval-gated loop** - Closed-loop suggestions are proposals only; never auto-apply or delete.

## Visual Companion

A browser-based companion for showing mockups, diagrams, and visual options during brainstorming. Available as a tool — not a mode. Accepting the companion means it's available for questions that benefit from visual treatment; it does NOT mean every question goes through the browser.

**Offering the companion:** When you anticipate upcoming visual questions, offer it once for consent:
> "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)"

**This offer MUST be its own message.** Wait for the user's response before continuing. If they decline, proceed with text-only brainstorming.

**Per-question decision:** Even after the user accepts, decide FOR EACH QUESTION whether to use the browser or the terminal. Use the browser for content that IS visual (mockups, wireframes, layout comparisons, architecture diagrams); use the terminal for text (requirements, conceptual choices, tradeoff lists, A/B/C/D options, scope decisions).

If they agree, read the detailed guide before proceeding:
`skills/brainstorming/visual-companion.md`
```

- [ ] **Step 3: 用校验器验证设计文档（验收锚点）**

Run: `cd D:/system/CRM-ai-native && node scripts/validate-contract.mjs docs/specs/2026-08-29-brainstorming-redesign-design.md`
Expected: `{ "valid": true, "errors": [] }`（设计文档内契约块合法）

Run: `node scripts/validate-contract.mjs docs/specs/2026-08-29-brainstorming-redesign-design.md --registry src/agent/agentSpec.js`
Expected: `valid: true`（契约 agent=crm-copilot / skill=data-particle-read / memory=crm-copilot / layer L1 均在注册表内）

- [ ] **Step 4: 提交**

```bash
git add ~/.workbuddy/skills/brainstorming/SKILL.md
git commit -m "feat: redesign brainstorming skill with living contract + closed loop"
```

> 注：`~/.workbuddy` 通常不在本仓库 git 内；若用户将其纳入 dotfiles 版本管理，按各自仓库提交。本步骤仅记录意图。

---

## Task 6: 端到端闭环演示（验收 §5.4 #2）

**Files:**
- Create: `tmp/loop-demo.feedback.json`（演示用，非交付物）

- [ ] **Step 1: 构造一条复现 ≥2 的 feedback**

```json
[
  { "task": "实现 agent-workbench 监控卡", "agent": "crm-copilot", "gap_type": "skill", "observed": "未调用 data-particle-read", "expected": "调用 data-particle-read", "ts": "2026-08-29T11:05:00+08:00", "severity": "warn" },
  { "task": "实现 agent-workbench 监控卡", "agent": "crm-copilot", "gap_type": "skill", "observed": "仍未调用 data-particle-read", "expected": "调用 data-particle-read", "ts": "2026-08-29T12:05:00+08:00", "severity": "error" }
]
```

- [ ] **Step 2: 运行聚合器，确认产出提案**

Run: `cd D:/system/CRM-ai-native && node scripts/aggregate-feedback.mjs tmp/loop-demo.feedback.json`
Expected: 输出含 `proposals[0].task="实现 agent-workbench 监控卡"`、`gap_type="skill"`、`occurrences=2`、`requiresApproval=true`，且 `proposal` 文本指向强化 `data-particle-read` 调用。

- [ ] **Step 3: 走查 P0 逻辑**

确认：下次 brainstorming 会话在 P0 读取该 feedback.json → 因同 `(task, gap_type)` 复现 2 次 → 在 §4.3 呈现 SKILL 改进提案（提案形式，需批准）。闭环演示完成。

- [ ] **Step 4: 清理演示文件（可选）**

```bash
rm -f tmp/loop-demo.feedback.json
```
（如用户希望保留演示证据可跳过。）

---

## 自审（Self-Review）

**1. 规格覆盖：** §1 定位/通用性 → SKILL.md §A「Generality」段；§2 流程 P0–P10 → Checklist + Process Flow；§3 契约 schema → §A；§4 闭环 → §B；§5.3 校验器 → §C + Task 1–3；§5.4 验收 #2 → Task 6。全部有对应 task。

**2. 占位符扫描：** 无 TBD/TODO；所有代码步骤均含完整代码；无「类似 Task N」引用（各 task 自包含）。

**3. 类型一致性：** `validateContracts(contracts, {registry})`、`aggregateFeedback(feedback, {threshold})`、`extractContractBlocks`/`parseContractYaml` 在 Task 1 定义、Task 2–3 复用签名一致；`knowledge_scope.layers` 在自检中映射至 `knowledgeScope.layers`（camelCase，已在 SKILL.md §A 注明对齐）。CLI 守卫 `import.meta.url === file://${process.argv[1]}` 在 Task 1/4 一致。

**4. 通用性：** 契约与校验器不硬编码 CRM；SKILL.md 仅以 CRM 作参考实例，符合 D4。
