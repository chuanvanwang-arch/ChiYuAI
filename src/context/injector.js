// src/context/injector.js — 将 assembleContext bundle 格式化为 LLM prompt 上下文块
// T1(BG-01a)：注入层消费 assembler 已装配的叙事字段（rationale / memories），
//   不再只吐 scenario_id:disposition 标签列表（标签列表 ≠ 上下文，详见决策问责统一设计 §0.2 一）。
import { chronological, formatTimelineRow } from './timelineSource.js';

const RATIONALE_MAX = 120; // 单条决策 rationale 截断预算
const MEMORY_MAX = 100;    // 单条记忆截断预算
const MEMORY_TOP = 3;      // 记忆最多注入条数（防 token 膨胀）
const TIMELINE_TOP = 8;    // 叙事时间线最多注入条数（WHEN 轴，防 token 膨胀）
const TIMELINE_ROW_MAX = 80;
// P0-3（2026-09-10）：场景知识层 LK 的注入预算。LK 此前装配后无人消费（死层），
//   本次接通 ① K→D 边；与记忆同量级控预算，避免长文本知识撑爆 prompt。
const KNOWLEDGE_TOP = 3;       // 场景知识最多注入条数
const KNOWLEDGE_ROW_MAX = 160; // 单条场景知识截断预算

function clip(text, n) {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 从 memory_log 行提取可追溯的叙事文本（payload 为对象时取常见文本键）
function memoryText(m) {
  const p = m?.payload;
  if (!p) return '';
  if (typeof p === 'string') return clip(p, MEMORY_MAX);
  return clip(p.text || p.summary || p.note || p.content || '', MEMORY_MAX);
}

export function formatForPrompt(bundle) {
  const { layers = {}, degraded = false, missing = {}, scopeModel = 'all', narrative = null } = bundle;
  const parts = [];
  const role = layers.L4?.profile;
  if (role) {
    parts.push(`角色: ${role.role_subtype || role.core_focus}`);
    if (role.permission_boundary) parts.push(`数据范围: ${role.permission_boundary}`);
  }
  parts.push(`数据范围模型: ${scopeModel}`);
  if (Array.isArray(layers.L1) && layers.L1.length) {
    parts.push(`相关知识(${layers.L1.length}): ` + layers.L1.map((x) => x.title).join('; '));
    // 方法论强调（设计 §5/§8：L1 知识底座中 行为方法独立成块，sales/manager 决策时优先可见）
    const sales = layers.L1.filter((x) => x.title && /|大漏斗|S1|S6|行为合格|拜访/.test(x.title));
    if (sales.length) parts.push(`行为方法(${sales.length}): ` + sales.map((x) => x.title).join('; '));
  }
  // P0-3（2026-09-10）：消费 layers.LK —— 场景知识层。
  //   背景：`assembler.js:258` 装配 LK 后全仓零消费者（探针 D2 lk_consumers=0），端到端哨兵
  //   实测「LK 命中 1 行但 prompt 检索不到」→ ① K→D 边在此断裂，12 条真实业务知识
  //   （ICP / 竞品 / 买手语言 / 客户异议）从未进入任何一次决策。此处接通该边。
  //   行格式为 buildKnowledgeRows 收敛后的 {kind, term, content}，三字段缺一即跳过（不注空壳）。
  if (Array.isArray(layers.LK) && layers.LK.length) {
    const picked = layers.LK.slice(0, KNOWLEDGE_TOP);
    const lines = picked
      .map((k) => {
        const label = [k?.kind, k?.term].filter(Boolean).join('/');
        const body = clip(k?.content, KNOWLEDGE_ROW_MAX);
        return body ? `· ${label ? `${label}: ` : ''}${body}` : null;
      })
      .filter(Boolean);
    if (lines.length) {
      const more = layers.LK.length > picked.length ? `，共${layers.LK.length}条，仅列${picked.length}条` : '';
      parts.push(`场景知识(${lines.length}${more}):\n${lines.join('\n')}`);
    }
  }
  if (layers.L2?.decisions?.length) {
    const decs = layers.L2.decisions
      .map((d) => {
        const base = `${d.scenario_id}:${d.disposition}`;
        // T1(BG-01a)：消费 rationale（决策「为什么」），截断防 token 膨胀
        return d.rationale ? `${base} — ${clip(d.rationale, RATIONALE_MAX)}` : base;
      })
      .join('; ');
    parts.push(`历史决策(${layers.L2.decisions.length}): ` + decs);
  }
  // T1(BG-01a)：消费记忆叙事（assembler 已取 L2.memories），注入可追溯的上下文
  if (Array.isArray(layers.L2?.memories) && layers.L2.memories.length) {
    const mems = layers.L2.memories
      .slice(0, MEMORY_TOP)
      .map((m) => { const t = memoryText(m); return t ? `· ${t}` : null; })
      .filter(Boolean);
    if (mems.length) parts.push(`关联记忆(${mems.length}):\n${mems.join('\n')}`);
  }
  // T8(BG-01b)：J7 决策七轴之 WHEN 轴 —— 叙事时间线进注入层
  // 时间线是派生视图（四源只读聚合），正序（最早→最近）呈现符合「故事」阅读顺序
  if (narrative?.available && Array.isArray(narrative.rows) && narrative.rows.length) {
    const picked = narrative.rows.slice(0, TIMELINE_TOP);
    const lines = chronological(picked).map((r) => `· ${clip(formatTimelineRow(r), TIMELINE_ROW_MAX)}`);
    if (lines.length) {
      const more = narrative.rows.length > picked.length ? `，共${narrative.rows.length}条，仅列最近${picked.length}条` : '';
      parts.push(`叙事时间线(WHEN${more}):\n${lines.join('\n')}`);
    }
  }
  if (layers.L3?.tasks?.length) {
    parts.push(`执行态(${layers.L3.tasks.length} 在办任务)`);
  }
  // 场景轨道 brief（2026-09-05 P0）：让模型能**解释**「为什么这次没有叙事时间线」，
  //   而不是黑盒沉默。只注一行 ≤80 字；仅在叙事缺失或未注入时出现，避免无意义占位。
  const rb = layers.L3?.routing_brief;
  if (rb && typeof rb === 'object') {
    const exp = rb.experiment ? `，实验中(${rb.experiment.track}=${rb.experiment.arm})` : '';
    if (!rb.narrative_injected) {
      parts.push(`场景轨道(${rb.scene}/${rb.mode} score=${Number(rb.score ?? 0).toFixed(2)}): 叙事时间线未注入(routing-excluded)${exp}`);
    } else if (!narrative?.available) {
      parts.push(`场景轨道(${rb.scene}/${rb.mode} score=${Number(rb.score ?? 0).toFixed(2)}): 叙事轨道已启用但无数据${exp}`);
    }
  }
  if (degraded) parts.push(`⚠️ 上下文已降级(${Object.keys(missing).join(',')})，建议谨慎推断`);
  return parts.length ? `【上下文】\n${parts.join('\n')}` : '';
}
