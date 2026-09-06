// src/context/routing.js — 场景路由（故事线 × 图谱 × 结构化）单一事实源
//
// 设计输入：docs/2026-09-01-story-graph-fusion-design.md §1.4/§2.5（批准 2026-09-02）
// 职责边界（对齐融合设计 + configCenter.js:33 阈值配置化铁律）：
//   - 「哪个场景走什么轨道」是**业务判定**，不是代码常量 → 一律读 config_store['context-routing']，
//     本文件只承载**出厂默认**（DEFAULT_ROUTING）+ 加载/回退/分类算法（loadRouting/classifyScene/resolveTracks）。
//   - 不硬编码场景名/维度名到消费侧（assembler/injector 只消费 resolveTracks 返回值）。
//   - 配置缺失 / 场景不在矩阵 → 回退全轨安全默认，不抛错、不中断装配（§1.4 兜底）。
//
// 轨道语义（对齐融合设计 §2.1 三段式束）：
//   - narrative          → 叙事时间线（WHEN 轴，assembler.js retrieveNarrative）
//   - graph_decision     → 决策因果图（/api/graph/trace，ageGraph + cte 降级）
//   - graph_entity       → 实体图（crm.edges 检索，供图谱面消费）
//   - structured         → 结构化指标（MANT/漏斗/阈值，确定性计算）
// 四轨道均为「注入轨道」，L1–L4 层级检索始终执行（层级 ≠ 轨道，保持兼容）。
import { readConfig } from '../config/configStore.js';

export const ROUTING_KEY = 'context-routing';
export const DEFAULT_TRACKS_ARR = ['narrative', 'graph_decision', 'graph_entity', 'structured'];
export const DEFAULT_L_ARR = ['L1', 'L2', 'L3', 'L4'];
export const TRACKS = DEFAULT_TRACKS_ARR;
export const L_LEVELS = DEFAULT_L_ARR;

export const MODE_GRAPH = 'GRAPH_PRIMARY';
export const MODE_STORY = 'STORY_PRIMARY';
export const MODE_BOTH = 'BOTH';

// ─── 出厂默认（唯一硬编码承载点；seed 脚本 import 本常量写入 config_store，供管理员持续调整）───
// 判定维度（§1.4 dims）：goal（理解/验证二分）、event_mix（纯决策/混合）、time_sensitivity（时间敏感）
// 权重：goal 0.4 / event_mix 0.3 / time_sensitivity 0.3（出厂建议值，管理员可经配置中心调整）
export const DEFAULT_DIMS = [
  { id: 'goal', type: 'enum', scale: ['understand', 'verify'], weight: 0.4 },
  { id: 'event_mix', type: 'enum', scale: ['pure_decision', 'mixed'], weight: 0.3 },
  { id: 'time_sensitivity', type: 'bool', weight: 0.3 },
];

// 场景矩阵（§1.3 逐项归位；key = decision_scenario.scenario_id / 既有场景键）
// tracks = 该场景注入轨道列表；dims = 该场景各判定维取值（用于 classifyScene 加权）
// 【2026-09-04 修复】消费侧 assembleContext → resolveTracks(scenarioId) 传的是**决策场景 ID**（assembler.js:177），
//   原矩阵只有门户页面键（account_insight/sales_decision_monitor…）→ 决策场景恒 UNKNOWN → 全轨兜底，配置对决策不生效。
//   修复：并入 8 个销售决策场景键 + 相关财务/把关/建档 meta 场景键（业务判定按场景性质归类，管理员可经配置中心调整）。
export const DEFAULT_SCENE_MATRIX = {
  // ── 门户/洞察页面场景（故事线·图谱·结构化 装配入口）──
  // 客户 360 洞察 / account-insight：理解全貌 + 混合事件 + 时间敏感 → 故事线为主，图谱+结构化为辅
  account_insight: { dims: { goal: 'understand', event_mix: 'mixed', time_sensitivity: true }, tracks: ['narrative', 'graph_decision', 'graph_entity', 'structured'] },
  // 销售决策监控 / sales-decision-monitor：合规审计 + 纯决策 + 时间不敏感 → 图谱主
  sales_decision_monitor: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['graph_decision'] },
  // 决策复盘 / decision-retro：因果边为主 → 图谱主
  decision_retro: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['graph_decision'] },
  // 校准处方 / calibration：证据链 + confidence → 图谱主
  calibration: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['graph_decision'] },
  // 命名客户跟踪 / named-accounts：进展跟踪靠时间线 → 故事线主 + 结构化
  named_accounts: { dims: { goal: 'understand', event_mix: 'mixed', time_sensitivity: true }, tracks: ['narrative', 'structured'] },
  // 交易诊断 / deal-diagnose（含 crm-deal-analyze）：停滞归因靠密度 + 图谱补角色 → 故事线主 + 图谱
  deal_diagnose: { dims: { goal: 'understand', event_mix: 'mixed', time_sensitivity: true }, tracks: ['narrative', 'graph_decision'] },
  // 漏斗/阶段推进 / funnel-progress：确定性计算 → 结构化主
  funnel_progress: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured'] },
  // 拜访行为达标 / behavior-standard：阈值计算 → 结构化主
  behavior_standard: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured'] },
  // 智能体派发 / agent-dispatch：能力/技能映射 → 图谱主
  agent_dispatch: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['graph_entity'] },

  // ── 销售决策场景（对齐 crm.decision_scenario；2026-09-04 并入）──
  // 线索跟进：判断要不要跟 → 叙事（线索历史）+ 结构化（BANT/阈值）
  LEAD_FOLLOW_UP: { dims: { goal: 'understand', event_mix: 'mixed', time_sensitivity: true }, tracks: ['narrative', 'structured'] },
  // 机会评估：真伪甄别 + 决策链 → 图谱（决策链因果）+ 结构化（评估维打分）
  OPP_QUALIFY: { dims: { goal: 'verify', event_mix: 'mixed', time_sensitivity: false }, tracks: ['graph_decision', 'structured'] },
  // 客户策略：角色立场策略 → 图谱（角色关系）+ 叙事（历史交互）
  CLIENT_STRATEGY: { dims: { goal: 'verify', event_mix: 'mixed', time_sensitivity: true }, tracks: ['graph_decision', 'narrative'] },
  // 方案价值：取舍边界 → 结构化（成本/覆盖）+ 图谱（依赖链路）
  SOLUTION_VALUE: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured', 'graph_decision'] },
  // 商务报价：折扣/让步边界 → 结构化（价格/阈值）+ 图谱（决策链）（报价时效属执行窗口，不主导轨道分型）
  QUOTE_PRICING: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured', 'graph_decision'] },
  // 签单前风险：风险清单 + 反对者 → 图谱（决策链角色）+ 结构化（风险阈值）
  SIGN_RISK: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: true }, tracks: ['graph_decision', 'structured'] },
  // 终局决策：续约/回款/变更 → 结构化（合同+回款指标）+ 叙事（历程）
  POST_CONTRACT: { dims: { goal: 'verify', event_mix: 'mixed', time_sensitivity: true }, tracks: ['structured', 'narrative'] },
  // 丢单复盘：归因 + 孵化 → 叙事（丢单历程）+ 图谱（因果链）
  LOSS_REVIEW: { dims: { goal: 'understand', event_mix: 'mixed', time_sensitivity: true }, tracks: ['narrative', 'graph_decision'] },
  // 商机重开：重置止损 → 结构化（止损条件）+ 图谱（决策链）
  DEAL_REOPEN: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured', 'graph_decision'] },
  // 发票/开票（七、回款开票）：财务合规 → 结构化主
  INVOICE_APPROVE: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured'] },
  // 订单/交付（七、订单交付）：承诺与交付 → 结构化主
  ORDER_APPROVE: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured'] },
  // 评审把关（S4→S5）：双闸门合规 → 结构化 + 图谱（审批链）
  REVIEW_GATE: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured', 'graph_decision'] },
  // 批量导入（T3）：确定性校验 → 结构化主
  IMPORT_BATCH: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured'] },
  // 粒子建档（meta）：来源/查重/归属校验 → 结构化主
  PARTICLE_CREATE: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured'] },
  // 属性元模型变更（meta）：影响/一致/权限 → 图谱（依赖链路）+ 结构化
  ATTR_SCHEMA_CHANGE: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['graph_decision', 'structured'] },
  // 校准参数变更（meta）：可回滚证据链 → 图谱 + 结构化
  CALIBRATION_CHANGE: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['graph_decision', 'structured'] },
  // 外部数据采集（meta）：来源合规校验 → 结构化主
  EXTERNAL_ENRICHMENT: { dims: { goal: 'verify', event_mix: 'pure_decision', time_sensitivity: false }, tracks: ['structured'] },
};

// 路由边界（§1.4 thresholds）：score >= graph → GRAPH_PRIMARY；<= story → STORY_PRIMARY；其间 BOTH
export const DEFAULT_THRESHOLDS = { graph: 0.6, story: 0.4 };

export const DEFAULT_ROUTING = {
  dims: DEFAULT_DIMS,
  scene_matrix: DEFAULT_SCENE_MATRIX,
  thresholds: DEFAULT_THRESHOLDS,
};

// ─── 加载（读配置 + 回退默认，不抛错）───
export async function loadRouting({ tenantId = 'system' } = {}) {
  try {
    const rec = await readConfig(ROUTING_KEY, { tenantId });
    const v = rec?.value;
    if (!v || typeof v !== 'object') return structuredClone(DEFAULT_ROUTING);
    return {
      dims: Array.isArray(v.dims) ? v.dims : DEFAULT_DIMS,
      scene_matrix: v.scene_matrix && typeof v.scene_matrix === 'object' ? v.scene_matrix : DEFAULT_SCENE_MATRIX,
      thresholds: { ...DEFAULT_THRESHOLDS, ...(v.thresholds && typeof v.thresholds === 'object' ? v.thresholds : {}) },
    };
  } catch {
    return structuredClone(DEFAULT_ROUTING);
  }
}

// ─── 分类（加权聚合，§1.2 算法；输入维度集与场景取值全来自配置）───
// 返回 { mode, score }：score >= thresholds.graph → GRAPH_PRIMARY；<= thresholds.story → STORY_PRIMARY；其间 BOTH。
function mapValue(dim, val) {
  // 语义（与 DEFAULT_SCENE_MATRIX 的 dims 取值同契约）：
  //   score 高 = 更接近「验证/确定性」→ GRAPH_PRIMARY；score 低 = 更接近「理解/叙事」→ STORY_PRIMARY。
  //   goal            : verify → 1（图谱端）  understand → 0（叙事端）
  //   event_mix       : pure_decision → 1（图谱擅长纯决策）  mixed → 0（混合事件需叙事补充）
  //   time_sensitivity: false → 1（时间不敏感→图谱）  true → 0（时间敏感→叙事）
  // 说明：值→分数映射属算法内置语义（维度 scale/weight 可配置，映射方向固定，
  //       与 DEFAULT_SCENE_MATRIX 中每个场景的 dims 取值配套，改动需同步场景矩阵）。
  if (dim.id === 'goal') return val === 'verify' ? 1 : 0;
  if (dim.id === 'event_mix') return val === 'pure_decision' ? 1 : 0;
  if (dim.id === 'time_sensitivity') return val === false ? 1 : 0;
  return Number(val) > 0 ? 1 : 0;
}

export function classifyScene(sceneId, cfg = DEFAULT_ROUTING) {
  const scene = cfg.scene_matrix?.[sceneId];
  const dims = Array.isArray(cfg.dims) ? cfg.dims : DEFAULT_DIMS;
  const thr = { ...DEFAULT_THRESHOLDS, ...(cfg.thresholds || {}) };
  if (!scene) return { mode: 'UNKNOWN', score: 0 };
  let score = 0;
  for (const d of dims) {
    const v = scene.dims?.[d.id];
    if (v === undefined) continue; // 场景未声明该维 → 不参与（诚实，不假设）
    const w = Number(d.weight) || 0;
    score += w * mapValue(d, v);
  }
  if (score >= Number(thr.graph)) return { mode: MODE_GRAPH, score };
  if (score <= Number(thr.story)) return { mode: MODE_STORY, score };
  return { mode: MODE_BOTH, score };
}

// ─── 选轨（§2.5；装配器消费）───
// 返回 { tracks, L, mode, scene }；场景缺失 → 全轨默认（安全兜底）。tracks/L 均由配置给出，无硬编码。
export async function resolveTracks(sceneId, { tenantId = 'system' } = {}) {
  const cfg = await loadRouting({ tenantId });
  const row = cfg.scene_matrix?.[sceneId];
  const cls = classifyScene(sceneId, cfg);
  return {
    scene: sceneId || null,
    tracks: Array.isArray(row?.tracks) && row.tracks.length ? row.tracks : TRACKS,
    L: Array.isArray(row?.L) && row.L.length ? row.L : L_LEVELS,
    mode: cls.mode,
    score: cls.score,
  };
}