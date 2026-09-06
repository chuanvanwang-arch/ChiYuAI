// scripts/aggregate-feedback.mjs
// P0 回写吸收引擎（brainstorming 侧）：读取 feedback 列表，对复现 ≥2 次的
// (task, gap_type) 产出 SKILL/设计改进提案。仅提案，绝不自动修改/删除。
import { readFileSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';

const SUGGESTION_TEMPLATES = {
  skill: (t) =>
    `考虑为 ${t.agent} 的 agentSpec.capabilities.skillCalls 补充缺失的 SKILL，或在承接 SKILL 指令中强化对该 SKILL 的强制调用。`,
  memory: (t) =>
    `考虑将 ${t.expected} 加入 ${t.agent}.memory.read，或在 SKILL 中明确该记忆/知识读取约定。`,
  success: (t) =>
    `复核 ${t.task} 的 success 判定标准是否可达；若标准过严则在设计阶段重设可验证阈值。`,
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
    const t = {
      task,
      gap_type,
      agent: items[0].agent,
      expected: items[0].expected,
      observed: items[0].observed,
    };
    const template =
      SUGGESTION_TEMPLATES[gap_type] ||
      ((x) => `复核 ${x.task} 的 ${x.gap_type} 偏差（复现 ${items.length} 次）。`);
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
  const path = args.find((a) => !a.startsWith('--'));
  if (!path) {
    console.error('usage: node aggregate-feedback.mjs <doc>.feedback.json');
    process.exit(2);
  }
  const data = JSON.parse(readFileSync(path, 'utf8'));
  const list = Array.isArray(data) ? data : data.feedback || [];
  const proposals = aggregateFeedback(list);
  console.log(JSON.stringify({ proposals }, null, 2));
  process.exit(0);
}

const __invoked = process.argv[1]
  ? fileURLToPath(pathToFileURL(process.argv[1]).href)
  : null;
const __self = fileURLToPath(import.meta.url);
if (__invoked && __invoked.toLowerCase() === __self.toLowerCase()) {
  main();
}
