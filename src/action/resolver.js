// src/action/resolver.js — 能力清单生成（agents.md 风格，R5 单一事实源）
// 从 Action Registry 聚合生成能力清单，无手写维护；供门户 NL→Page 按钮映射 / 新 agent L1 注入 / MCP 接入
// 设计输入：ai-native-action-design 实践心得（resolver 从 registry 自动生成，区分 Action/SKILL/粒子）
import { listActions, listNamespaces } from './registry.js';

// 聚合 registry → 结构化能力清单
export function resolveCapabilityManifest() {
  const namespaces = listNamespaces();
  const actions = listActions().map(a => ({
    name: a.name,
    namespace: a.namespace,
    kind: a.kind,
    agentTool: !!a.agentTool,
    needsApproval: !!a.needsApproval,
    force: !!a.force,
    version: a.version || '1.0.0',
    owner: a.owner || 'crm-native',
  }));
  return { namespaces, actions };
}

// 输出 agents.md 风格 markdown（按 namespace 分组，标注写/读/force/needsApproval）
export function formatManifest() {
  const m = resolveCapabilityManifest();
  const lines = ['# 能力清单（自动生成，来源 Action Registry）', ''];
  lines.push('## Action（原子动词，R1-R6）', '');
  for (const ns of m.namespaces) {
    const nsActions = m.actions.filter(a => a.namespace === ns);
    lines.push(`### ${ns}`);
    for (const a of nsActions) {
      const kindMark = a.kind === 'write' ? '写' : '读';
      const flags = [
        a.agentTool ? 'agentTool' : '',
        a.needsApproval ? 'needsApproval' : '',
        a.force ? 'force' : '',
      ].filter(Boolean).join(',');
      lines.push(`- ${a.name}(${kindMark})${flags ? ` [${flags}]` : ''} — v${a.version} owner=${a.owner}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}