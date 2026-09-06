// src/contract/contractParser.js — 契约解析内核（纯函数，零副作用）。
// 从 scripts/validate-contract.mjs 平移，作为监控台契约消费单一事实源。
import { CONTRACT_IDS } from '../agent/contractIds.js';

export function stripQuotes(s) {
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

export function parseInlineList(v) {
  const inner = v.slice(1, v.lastIndexOf(']')).trim();
  if (!inner) return [];
  return inner
    .split(',')
    .map((s) => stripQuotes(s.trim()))
    .filter(Boolean);
}

// 按顶层逗号切分（不在 [] / {} / "" 内部切），避免内联列表 [L1, L2] 被误拆
function splitTopLevel(s) {
  const out = [];
  let depth = 0, inStr = false, cur = '';
  for (const ch of s) {
    if (inStr) { cur += ch; if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; cur += ch; continue; }
    if (ch === '[' || ch === '{') depth++;
    else if (ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

export function parseInlineMap(v) {
  const inner = v.slice(1, v.lastIndexOf('}')).trim();
  const obj = {};
  if (!inner) return obj;
  splitTopLevel(inner).forEach((pair) => {
    const ci = pair.indexOf(':');
    if (ci === -1) return;
    const k = pair.slice(0, ci).trim();
    const val = pair.slice(ci + 1).trim();
    obj[k] =
      val.startsWith('[')
        ? parseInlineList(val)
        : val.startsWith('"') && val.endsWith('"')
          ? stripQuotes(val)
          : /^-?\d+$/.test(val)
            ? Number(val)
            : val;
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
  const REQUIRED = ['task', 'agent', 'skills', 'memory', 'success'];
  const errors = [];
  if (!Array.isArray(contracts)) contracts = [];
  contracts.forEach((c, i) => {
    const where = c && c.task ? `task "${c.task}"` : `contract #${i + 1}`;
    if (c == null) {
      errors.push({ where, field: '(root)', message: 'contract is null' });
      return;
    }
    for (const f of REQUIRED) {
      if (c[f] === undefined || c[f] === null || c[f] === '') {
        errors.push({ where, field: f, message: `missing required field "${f}"` });
      }
    }
    if (c.skills !== undefined && !Array.isArray(c.skills))
      errors.push({ where, field: 'skills', message: 'skills must be a list' });
    if (c.memory !== undefined && !Array.isArray(c.memory))
      errors.push({ where, field: 'memory', message: 'memory must be a list' });
    if (registry && c.agent !== undefined) {
      const spec = registry[c.agent];
      if (!spec) {
        errors.push({ where, field: 'agent', message: `agent "${c.agent}" not found in registry` });
      } else {
        const skills = spec.capabilities?.skillCalls || [];
        const mem = spec.memory?.read || [];
        const layers = spec.capabilities?.knowledgeScope?.layers || [];
        (c.skills || []).forEach((s) => {
          if (!skills.includes(s))
            errors.push({ where, field: 'skills', message: `skill "${s}" not in ${c.agent}.skillCalls` });
        });
        (c.memory || []).forEach((mm) => {
          if (!mem.includes(mm))
            errors.push({ where, field: 'memory', message: `memory "${mm}" not in ${c.agent}.memory.read` });
        });
        (c.knowledge_scope?.layers || []).forEach((l) => {
          if (!layers.includes(l))
            errors.push({ where, field: 'knowledge_scope', message: `layer "${l}" not in ${c.agent}.knowledgeScope.layers` });
        });
      }
    }
  });
  // D2 防护（2026-09-01）：契约键 ↔ 运行时映射双向一致，仅在传入 registry 时校验
  // （不传 registry 的纯结构校验场景不受影响，保持向后兼容）。
  // 目的：杜绝契约文档与 src/agent/contractIds.js 再次漂移——漂移会令矩阵重回"永远不绿"。
  if (registry) {
    const seen = new Set();
    contracts.forEach((c, i) => {
      const where = c && c.task ? `task "${c.task}"` : `contract #${i + 1}`;
      const agent = c?.agent;
      if (!agent || !CONTRACT_IDS[agent]) return;
      seen.add(agent);
      if (c.contract_task_id !== CONTRACT_IDS[agent]) {
        const actual = c.contract_task_id === undefined ? '缺失' : `"${c.contract_task_id}"`;
        errors.push({
          where, field: 'contract_task_id',
          message: `契约键应为 "${CONTRACT_IDS[agent]}"（src/agent/contractIds.js），实际为 ${actual}`,
        });
      }
    });
    // 反向断言仅对"确实承载 agent 名册契约块"的文档生效——
    // 与名册无关的设计文档（agent 为历史名或业务域外）不强制要求覆盖全部登记 agent。
    // 2026-09-01 修复（实现与注释不符）：原判据 `seen.size > 0` 会把「只覆盖 1 个名册 agent 的
    // 单域设计文档」误判为名册类文档，强制其补齐其余 4 个 agent 的契约块（不可满足）。
    //   例：MCP 凭证解析优化设计只由 followup-agent 承接 → 被要求凭空造 4 个无关任务。
    // 修正判据：覆盖 >=2 个名册 agent 才认定为"名册类文档"（名册文档必然多 agent）；
    //   覆盖 0 个（历史名/业务域外）与覆盖 1 个（单域设计）均豁免反向断言，
    //   但两者的 contract_task_id 正向断言（上面 forEach）照常生效，不会漏检漂移。
    if (seen.size > 1) {
      for (const agent of Object.keys(CONTRACT_IDS)) {
        if (!seen.has(agent)) {
          errors.push({
            where: '(contractIds)', field: 'contract_task_id',
            message: `agent "${agent}" 已登记契约键 "${CONTRACT_IDS[agent]}"，但文档中无对应契约块`,
          });
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function loadRegistry(p) {
  if (!p) return null;
  const { readFileSync } = await import('node:fs');
  if (p.endsWith('.json')) return JSON.parse(readFileSync(p, 'utf8'));
  const { pathToFileURL } = await import('node:url');
  const mod = await import(pathToFileURL(p).href);
  return mod.agentSpecs || mod.default?.agentSpecs || mod.default || null;
}
