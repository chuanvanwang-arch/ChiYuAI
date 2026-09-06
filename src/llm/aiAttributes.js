// src/llm/aiAttributes.js — AI 属性批量 LLM 适配器（一次调用算完一个粒子的全部 AI 属性）
// 设计：B 方案（批量单调用）——每条粒子仅 1 次 chat 请求，而非「每属性 1 次」；
//       未配置 / 调用失败 / 超时 / 输出不可解析 / 类型不符 → 返回 null 或缺失该 key，
//       由 aiAttributes/evaluator.js 对缺失项回退 deterministicEval 并保留 degraded 标记。
// 纪律：本模块只做「提示词 ↔ JSON」适配，不写库、不抛；任何失败都必须可降级。
import { getLlmJson } from './client.js';
import { AI_ATTR_DEFS } from '../aiAttributes/evaluator.js';
import { emit } from '../events/bus.js';

// 整批失败的观测口径（G3 可观测化：降级必须有痕迹，禁止静默兜底）
function reportFailure(type, keys, reason) {
  emit('trace', 'ai-attr-llm-failed', { type, keys, reason });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TIMEOUT_MS = 30_000;
// 三条硬约束（实测 SiliconFlow/DeepSeek-V4-Flash 得来）：①不许返回 null（会退化成兜底，等于没接）；
// ②百分数必须 0-100 不得写 0-1 比例；③依据须注明数据是否充分。
const SYSTEM_PROMPT = [
  '你是 CRM 数据评估器。仅输出一个 JSON 对象，键为给定属性名，值为 {"value":<按指定类型>,"rationale":<不超过40字的中文依据>}。',
  '硬约束：',
  '1. 每个属性都必须给出具体取值，禁止输出 null——数据不足时基于已有字段做保守推断，并在 rationale 开头注明「数据有限」。',
  '2. 标注为「0-100」的属性取 0 到 100 的百分数（62 表示 62%），禁止写成 0.62 这类小数比例。',
  '3. 不要输出解释、不要输出多余文本，只输出 JSON。',
].join('\n');

// 属性语义 + 取值类型（提示词用 + 结果校验用；与 evaluator.js 的 AI_ATTR_DEFS 键一一对应）
const ATTR_SPEC = {
  CRM_DEAL: {
    revenue_forecast: { type: 'number', hint: '预计成交金额（元，可结合金额与赢率推算）' },
    win_probability_adjusted: { type: 'number', hint: '修正后赢率，0-100 的百分数（62 表示 62%，禁止写 0.62）' },
    age_in_stage: { type: 'number', hint: '当前阶段停留天数' },
    stuck_warning: { type: 'boolean', hint: '是否停滞告警（true/false）' },
    engagement_trend: { type: 'string', hint: '互动趋势，只能取：上升/持平/下降' },
    funnel_velocity: { type: 'number', hint: '漏斗推进速度（阶段/月，可给小数）' },
  },
  CRM_ACCOUNT: {
    account_segment: { type: 'string', hint: '客户分层，只能取：战略/重点/普通/长尾' },
    customer_health_score: { type: 'number', hint: '客户健康分，0-100 的整数（禁止写 0-1 比例）' },
    churn_risk: { type: 'string', hint: '流失风险，只能取：低/中/高' },
    business_verified: { type: 'boolean', hint: '工商信息是否已核实（true/false）' },
  },
  CRM_CONTACT: {
    relationship_heatmap: { type: 'string', hint: '关系热度，只能取：高/中/低' },
    stakeholder_influence: { type: 'string', hint: '影响力，只能取：决策者/影响者/使用者/其他' },
  },
};

function buildPrompt(type, keys, defs, summaryText) {
  const lines = keys.map((k) => {
    const spec = ATTR_SPEC[type]?.[k] || {};
    return `- ${k}（${spec.hint || '按语义评估'}，类型 ${spec.type || 'string'}，轴 ${defs[k]?.axis || '-'}）`;
  });
  return [
    `请评估 ${type} 粒子的以下 AI 属性：`,
    lines.join('\n'),
    '',
    `粒子数据（JSON）：${String(summaryText).slice(0, 4000)}`,
    '',
    '输出示例：{"revenue_forecast":{"value":120000,"rationale":"金额与阶段匹配"}}',
  ].join('\n');
}

// 值类型校验：不符 → 丢弃该属性（调用方回退确定性兜底），避免脏值冒充 AI 产出
function coerce(kind, v) {
  if (v === null || v === undefined) return undefined;
  if (kind === 'boolean') return typeof v === 'boolean' ? v : undefined;
  if (kind === 'number') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  const s = String(v).trim();
  return s ? s : undefined;
}

// 返回 null（未配置/不可用）或 async (summaryText, {type, keys}) => { [key]: {value, rationale} } | null
export async function resolveAiAttributeLlm(opts = {}) {
  const json = await getLlmJson({ refresh: opts.refresh, readConfig: opts.readConfig }).catch(() => null);
  if (!json) return null;

  return async function evaluateBatch(summaryText, { type, keys } = {}) {
    const defs = AI_ATTR_DEFS[type] || {};
    const target = (keys || Object.keys(defs)).filter((k) => defs[k]);
    if (!target.length) return null;

    // 一次调用 + 失败重试 1 次（应对瞬时限流/网络抖动；重试仍失败则整条回退兜底）
    let out = await json(SYSTEM_PROMPT, buildPrompt(type, target, defs, summaryText), { timeoutMs: TIMEOUT_MS });
    if (!out) {
      await sleep(1500);
      out = await json(SYSTEM_PROMPT, buildPrompt(type, target, defs, summaryText), { timeoutMs: TIMEOUT_MS });
      if (!out) {
        reportFailure(type, target, 'llm_unavailable_or_unparsable_after_retry');
        return null;
      }
    }

    const result = {};
    for (const k of target) {
      const item = out[k];
      if (!item || typeof item !== 'object') continue;
      const value = coerce(ATTR_SPEC[type]?.[k]?.type || 'string', item.value);
      if (value === undefined) continue; // 类型不符 → 该属性回退兜底
      result[k] = { value, rationale: String(item.rationale || `LLM 评估 ${k}`).slice(0, 200) };
    }
    if (!Object.keys(result).length) {
      reportFailure(type, target, 'all_values_discarded_by_type_check');
      return null;
    }
    return result;
  };
}
