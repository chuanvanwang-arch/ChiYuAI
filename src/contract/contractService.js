// src/contract/contractService.js — 契约收集 + 静态校验（纯逻辑，DB 无关；walk/readFile 可注入）
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { extractContractBlocks, parseContractYaml } from './contractParser.js';

// 递归收集目录下所有 .md（默认实现；测试可注入）
export function defaultWalk(root) {
  const out = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const e of entries) {
      const p = join(dir, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) stack.push(p);
      else if (e.endsWith('.md')) out.push(p);
    }
  }
  return out;
}

// 静态校验：声明的 skills/memory/knowledge_scope 是否 ⊆ 注册表
export function staticCheck(contract, registry) {
  const spec = registry?.[contract.agent];
  if (!spec) {
    return {
      agent_found: false, skills_aligned: false, memory_aligned: false, knowledge_aligned: false,
      skills_issues: [`agent "${contract.agent}" 不在注册表`],
      memory_issues: [], knowledge_issues: [],
    };
  }
  const skills = spec.capabilities?.skillCalls || [];
  const mem = spec.memory?.read || [];
  const layers = spec.capabilities?.knowledgeScope?.layers || [];
  const skills_issues = (contract.skills || [])
    .filter((s) => !skills.includes(s))
    .map((s) => `skill "${s}" 不在 ${contract.agent}.skillCalls`);
  const memory_issues = (contract.memory || [])
    .filter((m) => !mem.includes(m))
    .map((m) => `memory "${m}" 不在 ${contract.agent}.memory.read`);
  const knowledge_issues = (contract.knowledge_scope?.layers || [])
    .filter((l) => !layers.includes(l))
    .map((l) => `layer "${l}" 不在 ${contract.agent}.knowledgeScope.layers`);
  return {
    agent_found: true,
    skills_aligned: skills_issues.length === 0,
    memory_aligned: memory_issues.length === 0,
    knowledge_aligned: knowledge_issues.length === 0,
    skills_issues, memory_issues, knowledge_issues,
  };
}

export function collectContracts({ docsRoot, registry, walk = defaultWalk, readFile = readFileSync } = {}) {
  const files = walk(docsRoot);
  const docs = [];
  for (const f of files) {
    let md; try { md = readFile(f, 'utf8'); } catch { continue; }
    const blocks = extractContractBlocks(md);
    if (!blocks.length) continue;
    const contracts = blocks
      .flatMap((b) => parseContractYaml(b))
      .map((c) => ({ ...c, doc_path: f, static: staticCheck(c, registry) }));
    if (contracts.length) docs.push({ doc_path: f, contracts });
  }
  return { docs };
}
