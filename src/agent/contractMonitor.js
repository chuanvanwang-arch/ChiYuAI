// src/agent/contractMonitor.js — 解析设计契约 + 按 contract_task_id 关联运行期 episode 做三维度判定
import { query } from '../db.js';
import { readFileSync } from 'node:fs';
import { readConfig } from '../config/configStore.js';
import {
  extractContractBlocks,
  parseContractYaml,
} from '../../scripts/validate-contract.mjs';

// join key：契约块 contract_task_id（稳定短键）↔ episode context_facts.contract_task_id
// D2 修复（2026-09-01）：旧实现用契约块 task 标题做 JOIN，而调度器产出的是 `intake:<uuid>:…`，
// 两者永不相等 → 真实运行 episode 无法进入矩阵，矩阵只反映开发期手工演示数据。
// 现优先取契约块稳定键，无键的旧块回退标题（向后兼容）。
const JOIN_KEY = 'task';
const KEY_FIELD = 'contract_task_id';
const DEFAULT_WINDOW_DAYS = 30;

// 契约块 → JOIN 键（稳定键优先，回退标题）
// D3 修复（2026-09-02）：episode 写入路径仍用中文 task 标题（短键未渗透到调度器），
// 现 joinKeyOf 同时返回 [稳定键, 中文标题]，computeCompliance 按任一键命中即算 JOIN 成功。
export function joinKeyOf(contract) {
  const keys = [];
  const stable = contract?.contract_task_id;
  if (stable) keys.push(stable);
  const title = contract?.task;
  if (title && !keys.includes(title)) keys.push(title);
  return keys;
}

export function parseContractsFromDoc(docPath) {
  const md = readFileSync(docPath, 'utf8');
  return extractContractBlocks(md).flatMap((b) => parseContractYaml(b));
}

function asFacts(e) {
  const cf = e?.context_facts;
  if (!cf) return {};
  if (typeof cf === 'string') { try { return JSON.parse(cf); } catch { return {}; } }
  return cf;
}

// 纯函数：契约 + 该契约已采集 episodes + 人工 success 标记（来自 agent_contract_feedback gap_type='success'）→ 三维度判定
// successMarker 为 null 时 success 保持 'pending'；为 'pass'/'fail' 时回写为矩阵 success 列（驱动前端 ✓/✗）。
export function judgeContract(contract, episodes = [], successMarker = null) {
  const skillEps = episodes.filter((e) => ['loop-started', 'loop-done'].includes(e.phase));
  const skillOk = (contract.skills || []).every((s) =>
    skillEps.some((e) => asFacts(e).skill === s));
  const ctxEps = episodes.filter((e) => e.phase === 'context-injected');
  const readLayers = new Set(ctxEps.flatMap((e) => {
    const kl = asFacts(e).knowledge_layers_read;
    return Array.isArray(kl) ? kl : [];
  }));
  const required = (contract.knowledge_scope?.layers || []);
  const memoryOk = required.every((l) => readLayers.has(l));
  return {
    task: contract[JOIN_KEY],
    agent: contract.agent,
    skill_ok: skillOk,
    memory_ok: memoryOk,
    success: successMarker || 'pending',
  };
}

export async function computeCompliance(docPath) {
  const contracts = parseContractsFromDoc(docPath);
  // 时间窗（阈值配置化铁律）：只统计窗口内 episode，令开发期手工演示数据自然过期，
  // 避免矩阵长期显示"假绿"。配置键 config_store['contract-monitor'].window_days，缺省 30 天。
  const cfg = (await readConfig('contract-monitor', { tenantId: 'system' }).catch(() => null))?.value || {};
  const windowDays = Number.isFinite(Number(cfg.window_days)) ? Number(cfg.window_days) : DEFAULT_WINDOW_DAYS;
  const res = await query(
    `SELECT event_type AS phase, context_facts, payload
     FROM crm.monitor_event
     WHERE domain='agent' AND context_facts->>'contract_task_id' IS NOT NULL
       AND created_at >= now() - make_interval(days=>$1)`,
    [windowDays]
  );
  const byTask = new Map();
  for (const r of res.rows) {
    const id = r.context_facts?.contract_task_id;
    if (!id) continue;
    if (!byTask.has(id)) byTask.set(id, []);
    byTask.get(id).push({ phase: r.phase, context_facts: r.context_facts, payload: r.payload });
  }
  // episode 查询：按任一候选键（短键 ∪ 中文标题）聚合 → 给契约块查 episodes
  const allKeys = new Set();
  for (const c of contracts) for (const k of joinKeyOf(c)) allKeys.add(k);
  const epByKey = new Map();
  for (const k of allKeys) {
    const eps = [];
    for (const r of res.rows) {
      const id = r.context_facts?.contract_task_id;
      if (id === k) eps.push({ phase: r.phase, context_facts: r.context_facts, payload: r.payload });
    }
    if (eps.length) epByKey.set(k, eps);
  }
  // 人工 success 标记回写：读取 agent_contract_feedback(gap_type='success')，按 contract_task_id 关联矩阵
  const fb = await query(
    `SELECT contract_task_id, observed FROM crm.agent_contract_feedback WHERE gap_type='success'`
  );
  const successByTask = new Map();
  for (const r of fb.rows) {
    if (r.contract_task_id) successByTask.set(r.contract_task_id, r.observed);
  }
  return contracts.map((c) => {
    const keys = joinKeyOf(c);
    // 任一候选键命中 episodes 即视为该契约已采集
    let eps = [];
    for (const k of keys) eps = eps.concat(epByKey.get(k) || []);
    return judgeContract(c, eps, successByTask.get(keys[0]) || successByTask.get(keys[1]) || null);
  });
}
