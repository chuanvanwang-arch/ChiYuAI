// scripts/demo-contract-loop.mjs — 演示「生产侧契约 → 运行期埋点 → 消费侧判定 → 回写 → 改进提案」闭环（无 DB 依赖）
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { judgeContract } from '../src/agent/contractMonitor.js';
import { mirrorFeedback } from '../src/agent/feedbackStore.js';

const tmp = mkdtempSync(join(tmpdir(), 'loop-'));
const docPath = join(tmp, 'demo-design.md');
writeFileSync(docPath, '# DEMO\n');

// 1) 运行期 episode（由 agentLoop 写入，此处模拟）
const episodes = [
  { phase: 'loop-started', context_facts: { skill: 'data-particle-read', contract_task_id: 'T-DEMO' } },
  { phase: 'context-injected', context_facts: { knowledge_layers_read: ['L1'], contract_task_id: 'T-DEMO' } },
];
const contract = { task: 'T-DEMO', agent: 'crm-copilot', skills: ['data-particle-read'], knowledge_scope: { layers: ['L1'] } };
const r = judgeContract(contract, episodes);
console.log(`[判定] skill_ok=${r.skill_ok} memory_ok=${r.memory_ok} success=${r.success}`);

// 2) 制造一次 skill 缺失 → 回写 feedback（复现 2 次以触发提案）
const gap = { contractTaskId: 'T-GAP', agent: 'crm-copilot', gapType: 'skill', observed: 'none', expected: 'data-particle-read', severity: 'high' };
mirrorFeedback(docPath, gap);
mirrorFeedback(docPath, gap);

// 3) aggregate-feedback.mjs 产出需批准提案（用绝对路径，避免 cwd 依赖）
const aggScript = fileURLToPath(new URL('../scripts/aggregate-feedback.mjs', import.meta.url));
const fbPath = docPath.replace(/\.md$/, '.feedback.json');
const out = execFileSync(process.execPath, [aggScript, fbPath], { encoding: 'utf8' });
console.log('[闭环提案]\n' + out);
