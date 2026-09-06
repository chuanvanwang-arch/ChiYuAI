// src/web/sourceClassify.js — 数据来源四查纯函数（前端 ①/②/③/④ 徽标判定）
// 设计输入：docs/specs/2026-08-25-12-data-origin-full-plan.md §7-2（阶段3前台必做）
//           + docs/specs/2026-08-25-ai-native-crm-overall-design.md §8.7（字段采集四查）
// 铁律：判定纯函数（无 PG/无 IO），页面与测试共用同一事实源，杜绝前后端双写口径漂移；
//       ② AI 属性一律读 payload.ai.*（轴/置信度/理由），未生成为 pending（needsReview 语义）；
//       ④ 外部 = sourcedFrom 出边命中（auto_weak 来源语义 + relation_confidence 透传）。
import { AI_ATTR_DEFS } from '../aiAttributes/evaluator.js';

// 四类徽标顺序（前端展示与验收固定顺序）
export const SOURCE_ORDER = ['manual', 'ai', 'rule', 'external'];

export const SOURCE_LABELS = {
  manual: '① 人工填写',
  ai: '② AI 自动生成',
  rule: '③ 规则派生',
  external: '④ 外部采集',
};

// AI 能力轴中文标签（01 设计 §2.3 五轴）
export const AXIS_LABELS = {
  S_Sight: '看见', C_Classify: '分类', J_Judge: '判断',
  F_Forecast: '预测', A_Alert: '预警', B_Brief: '简报', C_Compliance: '合规',
};

// 规则维护字段：由确定性管道写入，前端只读展示
const RULE_FIELDS = new Set([
  'stage_changed_at', 'stage_history', 'interaction_index', 'updated_at',
  'created_at', 'deal_count', 'last_interaction',
]);

// 主判定入口：
// classifyAttrSource(field, payload, { edges }) → { kind, sourceLabel, ai, pending, extConfidence }
export function classifyAttrSource(field, payload, { edges = [] } = {}) {
  // ② 优先：AI_ATTR_DEFS 声明 或 已在 payload.ai.*
  if (AI_ATTR_DEFS && Object.values(AI_ATTR_DEFS).some(typeDefs => (typeDefs || {})[field])) {
    return classifyAi(field, payload);
  }
  if (payload?.ai?.[field]) {
    return classifyAi(field, payload);
  }

  // ④ 外部：sourcedFrom 出边命中（连接器写入的来源语义）
  const ext = edges.find(e => e.edgeType === 'sourcedFrom');
  if (ext) {
    return {
      kind: 'external', sourceLabel: SOURCE_LABELS.external,
      extConfidence: ext.meta?.relation_confidence ?? 0.5,
    };
  }

  // ③ 规则维护字段
  if (RULE_FIELDS.has(field)) {
    return { kind: 'rule', sourceLabel: SOURCE_LABELS.rule };
  }

  // ① 默认人工（前端填写；连接器写回的事实字段仍可被人工覆盖，见验收口径）
  return { kind: 'manual', sourceLabel: SOURCE_LABELS.manual };
}

function classifyAi(field, payload) {
  const ai = payload?.ai?.[field];
  if (ai) {
    return {
      kind: 'ai', sourceLabel: SOURCE_LABELS.ai,
      ai: {
        axis: ai.axis, source: ai.source, confidence: ai.confidence,
        rationale: ai.rationale, generated_at: ai.generated_at, degraded: ai.degraded,
      },
    };
  }
  // 已声明但未生成 → pending（needsReview：置信度 < 0.6 语义由 evaluator 保证）
  const def = Object.values(AI_ATTR_DEFS).map(d => d[field]).find(Boolean);
  return {
    kind: 'ai', sourceLabel: SOURCE_LABELS.ai, pending: true,
    ai: def ? { axis: def.axis, source: def.source, confidence: def.confidence } : undefined,
  };
}