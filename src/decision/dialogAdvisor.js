// src/decision/dialogAdvisor.js — 对话 → 决策坐标（8 大场景 × S1-S8 阶段）
// 设计：docs/2026-09-08-dialog-driven-decision-advice-design.md §2
// 铁律：纯函数、不碰 DB、不抛错（无命中降级返回 null 场景，由调用方走 C 档）
import { STAGE_DEFAULT_SCENARIO } from '../sales/stageTaxonomy.js';

// 出厂默认映射（真值源在 config_store['dialog-scenario-map']，后台可改；此处仅作缺配置兜底）
export const DEFAULT_SCENARIO_MAP = [
  // '折' 覆盖口语（「8 折」「打 8 折」）；命中明细按长词优先去重，避免与 '折扣' 重复计数
  { scenario_id: 'QUOTE_PRICING',   keywords: ['报价', '折扣', '降价', '价格', '账期', '付款', '让价', '折'], stages: ['S4', 'S5'] },
  { scenario_id: 'SOLUTION_VALUE',  keywords: ['样品', '寄样', '试用', '演示', '方案', '定制', '需求变更'], stages: ['S3'] },
  { scenario_id: 'CLIENT_STRATEGY', keywords: ['拜访', '跟进', '联系', '谁拍板', '关键人', '决策链'], stages: ['S2', 'S3'] },
  { scenario_id: 'OPP_QUALIFY',     keywords: ['预算', '竞品', '值不值得', '真需求', '陪标'], stages: ['S2'] },
  { scenario_id: 'SIGN_RISK',       keywords: ['合同', '签单', '风险', '卡住', '反对'], stages: ['S5'] },
  { scenario_id: 'POST_CONTRACT',   keywords: ['回款', '续约', '交付变更', '验收'], stages: ['S6'] },
  { scenario_id: 'LOSS_REVIEW',     keywords: ['丢单', '输单', '复盘', '放弃'], stages: ['S7', 'S8'] },
  { scenario_id: 'DEAL_REOPEN',     keywords: ['重新跟', '再跟', '重开'], stages: ['S7', 'S8'] },
  { scenario_id: 'LEAD_FOLLOW_UP',  keywords: ['新线索', '跟不跟', '询盘'], stages: ['S1'] },
];

export function matchScenario(utterance, map = DEFAULT_SCENARIO_MAP) {
  const text = String(utterance || '');
  if (!text.trim()) return [];
  const out = [];
  for (const e of map) {
    // 长词优先：短词若已被命中的长词包含则跳过（如 '折扣' 命中后不再计 '折'），保证命中明细不虚高
    const ordered = [...(e.keywords || [])].sort((a, b) => b.length - a.length);
    const hits = [];
    for (const k of ordered) {
      if (text.includes(k) && !hits.some((h) => h.includes(k))) hits.push(k);
    }
    if (hits.length) out.push({ scenario_id: e.scenario_id, hits, stages: e.stages || [] });
  }
  // 命中多的排前（同数量保持表序，保证可复现）
  return out.sort((a, b) => b.hits.length - a.hits.length);
}

function resolveCoordinateRaw({ utterance = '', stage = null, map = DEFAULT_SCENARIO_MAP } = {}) {
  const matches = matchScenario(utterance, map);
  if (matches.length === 1) {
    return {
      scenario_id: matches[0].scenario_id,
      stage: stage || null,
      confidence: stage ? 'high' : 'low',
      reason: `关键词命中 ${matches[0].hits.join('/')}` + (stage ? '' : '（阶段未知）'),
      candidates: matches,
    };
  }
  if (matches.length > 1) {
    // 多命中：优先取 stages 含当前阶段的场景
    const inStage = stage ? matches.find((m) => (m.stages || []).includes(stage)) : null;
    if (inStage) {
      return {
        scenario_id: inStage.scenario_id, stage, confidence: 'high',
        reason: `多命中，按阶段 ${stage} 选定（${inStage.hits.join('/')}）`, candidates: matches,
      };
    }
    return {
      scenario_id: matches[0].scenario_id, stage, confidence: 'low',
      reason: `多命中且阶段不匹配，取首选项（${matches.map((m) => m.scenario_id).join('/')}）`, candidates: matches,
    };
  }
  // 无关键词命中：阶段兜底
  if (stage && STAGE_DEFAULT_SCENARIO[stage]) {
    return {
      scenario_id: STAGE_DEFAULT_SCENARIO[stage], stage, confidence: 'low',
      reason: `无关键词命中，取阶段 ${stage} 默认场景`, candidates: [],
    };
  }
  return { scenario_id: null, stage: stage || null, confidence: 'low', reason: '无关键词命中且无阶段', candidates: [] };
}

// 交叉校验：诉求在所处阶段应归属的场景（如「寄样品」在 S4 属报价让步条件）
// 返回 { scenario_id, adjusted, reason }；adjusted=true 表示已按阶段修正
export function crossCheckStage({ scenario_id, stage, utterance = '' } = {}) {
  if (!stage) return { scenario_id, adjusted: false, reason: '无阶段，不做交叉校验' };
  const concession = ['样品', '寄样', '试用', '演示'].some((k) => String(utterance).includes(k));
  if (concession && (stage === 'S4' || stage === 'S5')) {
    return { scenario_id: 'QUOTE_PRICING', adjusted: true, reason: '样品/试用在报价谈判阶段属让步条件' };
  }
  return { scenario_id, adjusted: false, reason: '无需修正' };
}

// 对外唯一入口：先规则定位，再按阶段交叉校验
export function resolveCoordinate(input = {}) {
  const raw = resolveCoordinateRaw(input);
  const cc = crossCheckStage({ scenario_id: raw.scenario_id, stage: raw.stage, utterance: input.utterance });
  if (cc.adjusted) {
    return { ...raw, scenario_id: cc.scenario_id, reason: `${raw.reason}；交叉校验：${cc.reason}` };
  }
  return raw;
}
