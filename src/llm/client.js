// src/llm/client.js — 消费 config_store('llm') 构建 LLM 推理函数（agentLoop 的 llmThink 注入槽）
// 设计：GET/PUT /api/config/llm 落 config_store；本模块为唯一消费方。
//       使「首次 PUT 后生效」成立：agentLoop.runWithSkill 在未显式注入 llmThink 时自动取用本函数；
//       未配置/不可用 → 返回 null → agentLoop 回退 defaultThink（llm_disabled 降级，行为不变）。
// 安全：api_key 经 secret.js 解密后仅用于本次请求 Authorization，不落日志。
import { decryptSecret } from './secret.js';
import { readConfig } from '../config/configStore.js';
import { getDefault, getByName, getAllActive, hydrate } from './llmConfigStore.js';
import { recordTokens } from '../alerts/tokenAccounting.js';
// P0-1：LLM 出口统一预检/计量（替代原 if(metering && metering.tenantId) 条件式调用）
import { enforceQuotaFor, recordUsage } from '../billing/metering.js';

// provider → 默认 chat/completions 基址（azure 由 config.base_url 覆盖）
const PROVIDER_BASE = {
  siliconflow: 'https://api.siliconflow.cn/v1/chat/completions',
  deepseek: 'https://api.deepseek.com/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

const TTL = 15_000; // 配置缓存 15s，平衡「PUT 后快速生效」与「避免每次请求打库」
let cache = { at: 0, cfg: null };

// 读取 LLM 配置（可注入 readConfig 以便单测；生产走 configStore，平台级 system）
// 修复：原形参名 readConfig 遮蔽模块导入的 readConfig，导致默认匿名函数内调用 undefined 抛错、
//       所有生产调用（getLlmJson() 无参）恒降级。改为 injectedReadConfig 避免遮蔽。
async function readLlmConfig(injectedReadConfig) {
  if (injectedReadConfig) return injectedReadConfig();
  const r = await readConfig('llm', { tenantId: 'system' });
  return r?.value || null;
}

// 端点归一：允许后台只填基址（如 https://api.siliconflow.cn/v1 或 .../v1/），自动补齐 /chat/completions
function normalizeBase(url) {
  if (!url) return null;
  const s = String(url).trim().replace(/\/+$/, '');
  if (!s) return null;
  return /\/chat\/completions$/.test(s) ? s : `${s}/chat/completions`;
}

// 轮询 cursor（模块级）；round-robin / failover 每次 pick 一条，跨多次 getLlmJson 调用轮换
let rrIndex = 0;

// 从 llm_config 表按 opts 选取一条（表不存在/查询失败 → null，交由回退源处理）
async function pickFromTable({ name, strategy = 'default' }) {
  try {
    if (name) return hydrate(await getByName(name));
    if (strategy === 'round-robin' || strategy === 'failover') {
      const all = await getAllActive();
      if (all.length === 0) return hydrate(await getDefault());
      const c = all[rrIndex % all.length];
      rrIndex += 1; // 跨调用递增 → 同一跑批内多 cluster 分散到不同配置，规避单 key 限流
      return hydrate(c);
    }
    return hydrate(await getDefault());
  } catch {
    return null; // 表未建/不可用 → 回退单条源
  }
}

// 回退源：注入的 readConfig（单测）或 config_store('llm') 单条（过渡期兼容）。
// 新表为空/未迁移/表不存在时保证既有能力不倒退。
async function fallbackCfg(injectedReadConfig) {
  try {
    const raw = await readLlmConfig(injectedReadConfig);
    if (raw && raw.provider && raw.model) {
      const apiKey = raw.api_key ? decryptSecret(raw.api_key) : null;
      const base = normalizeBase(raw.base_url || PROVIDER_BASE[raw.provider]);
      // 契约保持原语义：只要求 base 有效；apiKey 可为 null（兼容免密/本地端点），
      // 不可额外加「必须有 key」的条件——否则无 key 的既有配置会被误判为不可用而降级
      if (base) {
        return { ...raw, apiKey, base, name: raw.name || 'legacy-config-store', __source: 'config_store' };
      }
    }
  } catch { /* 回退源不可用 → null */ }
  return null;
}

// 双源：llm_config 表（多条，优先）→ 注入/默认 config_store('llm') 单条（兜底）
// 注意：opts.readConfig 是既有单测的注入契约（test/llm/client.test.js），必须透传，否则注入失效
async function pickCfg(opts) {
  const picked = await pickFromTable(opts || {});
  return picked || (await fallbackCfg((opts || {}).readConfig));
}

// 载入生效配置（多配置：name 指定 / strategy 轮询或默认）；未配置/不可用 → null
// 缓存策略：default 走 15s TTL 单配置缓存；round-robin|failover 每次 pick 递增 rrIndex（不缓存，保证轮换生效）
async function loadActiveCfg(opts = {}, refresh = false) {
  const strategy = opts.strategy || 'default';
  if (strategy === 'default' && !refresh && cache.cfg && Date.now() - cache.at < TTL) return cache.cfg;
  let cfg = null;
  try {
    cfg = await pickCfg(opts);
  } catch {
    cfg = null; // 配置读取失败 → 不阻断主流程，保持降级语义
  }
  if (strategy === 'default') cache = { at: Date.now(), cfg };
  return cfg;
}

// 返回 llmThink(task, {step, prior}) 函数，或 null（未配置/不可用）
export async function getLlmThink(opts = {}) {
  const cfg = await loadActiveCfg(opts, opts.refresh);
  const metering = opts.metering || null;
  return cfg ? makeThink(cfg, metering) : null;
}

// 返回 llmJson(systemPrompt, userPrompt, opts) → JSON 对象 | null（未配置 / 调用失败 / 输出不可解析）
// 供非 agentLoop 的推理消费方（如 AI 属性批量评估）复用同一份配置、加解密与超时语义。
// round-robin|failover 策略下：单次调用超时/失败自动换下一条配置重试一次（根治限流连续超时降级）。
export async function getLlmJson(opts = {}) {
  const cfg = await loadActiveCfg(opts, opts.refresh);
  if (!cfg) return null;
  const metering = opts.metering || null;
  const attempts = (opts.strategy === 'round-robin' || opts.strategy === 'failover') ? 2 : 1;
  return async (systemPrompt, userPrompt, o = {}) => {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      const c = i === 0 ? cfg : await loadActiveCfg(opts, true);
      if (!c) break;
      try {
        const text = await callChat(c, [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ], { timeoutMs: o.timeoutMs ?? 20000, maxTokens: o.max_tokens, metering });
        return parseJsonObject(text);
      } catch (e) { lastErr = e; }
    }
    return null; // 调用失败/超时 → 由调用方降级
  };
}

// 强制失效缓存（PUT 后调用可立即生效，不必等 TTL）
export function resetLlmCache() { cache = { at: 0, cfg: null }; }

// 单次 chat/completions 调用：返回首条消息文本；HTTP 非 2xx / 超时 → 抛
// metering：{ tenantId, actor, action, decision_id } 时解析 usage 回写 token_accounting（fail-open 不阻断主流程）
export async function callChat(cfg, messages, { timeoutMs = 20000, maxTokens, metering = null } = {}) {
  const body = {
    model: cfg.model,
    messages,
    temperature: cfg.temp ?? 0.7,
    max_tokens: maxTokens ?? cfg.max_tokens ?? 1024,
  };
  // P0-1（2026-09-06）：预检不再因缺 metering 静默跳过——无 tenantId 时记 system + 告警（方案 B 不阻断）
  const quota = await enforceQuotaFor(metering, 'llm');
  const meterTenantId = quota.tenantId;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(cfg.base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}`);
    const j = await r.json();
    // P0-1（2026-09-06）：无条件计量，不再要求 metering.tenantId 存在；缺租户记 system + 告警（不阻断）
    await recordUsage({
      metering, source: 'llm', action: 'llm-chat', usage: j?.usage || null,
      tenantId: meterTenantId,
    });
    return j?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(task, step, prior) {
  const intent = task?.payload?.intent || {};
  const q = task?.payload?.query || task?.payload?.staticParams?.query || '';
  const priorLog = (prior || []).map((p) => `- ${p.step}: ${p.decision} ${p.result?.ok ? 'ok' : ''}`).join('\n');
  return [
    `销售智能体推理任务。SKILL 步骤：${JSON.stringify(step)}`,
    `意图：${JSON.stringify(intent)}`,
    `查询：${q}`,
    priorLog ? `已执行步骤：\n${priorLog}` : '已执行步骤：无',
    '请判断本步骤应执行的 Action 及参数，或给出分析（不执行）。输出严格 JSON：{"action":<action名或null>,"params":<对象>,"reasoning":<字符串>}。',
  ].join('\n');
}

function makeThink(cfg, metering) {
  return async function llmThink(task, o = {}) {
    try {
      const text = await callChat(cfg, [
        { role: 'system', content: '你是 CRM 销售智能体推理器，仅输出 JSON：{"action":<string|null>,"params":<object>,"reasoning":<string>}。' },
        { role: 'user', content: buildPrompt(task, o.step || {}, o.prior || []) },
      ], { timeoutMs: 20000, maxTokens: undefined, metering });
      return parseThink(text);
    } catch (e) {
      if (e?.isQuota) return { action: null, params: {}, reasoning: `[额度已用完] ${e.message}`, degraded: true, quotaExceeded: true, degradeReason: 'token_quota' };
      // LLM 不可用 → 降级（不影响确定性 rule 步骤；reasoning 步骤 action=null）
      return { action: null, params: {}, reasoning: `[LLM 调用失败，降级] ${e.message}`, degraded: true, degradeReason: 'llm_error' };
    }
  };
}

// 从模型输出文本中提取第一个 JSON 对象（无则 null）
function parseJsonObject(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    const obj = m ? JSON.parse(m[0]) : null;
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}

function parseThink(text) {
  try {
    const m = String(text).match(/\{[\s\S]*\}/);
    const obj = m ? JSON.parse(m[0]) : null;
    if (obj && typeof obj === 'object') {
      return {
        action: obj.action ?? null,
        params: obj.params && typeof obj.params === 'object' ? obj.params : {},
        reasoning: obj.reasoning || '',
        degraded: false,
      };
    }
  } catch { /* 解析失败 → 降级 */ }
  return { action: null, params: {}, reasoning: '[LLM 输出不可解析，降级]', degraded: true, degradeReason: 'llm_parse' };
}
