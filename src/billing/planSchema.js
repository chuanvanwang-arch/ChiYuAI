// src/billing/planSchema.js — 套餐档位 schema 校验（纯函数，零 DB、可单测）
// 背景：2026-09-05 套餐编辑从「整档 JSON 文本框」升级为结构化表单，后端从「仅角色闸」补齐 schema 校验，
//       杜绝 plan_id 重复 / 负数价格 / 未登记权益键 / 非法超量模式 落入 config_store['billing-plans']。
// 白名单口径：KNOWN_ENTITLEMENTS = Action requiresEntitlement 声明全集 ∪ 现网套餐在用键（守护测试
//   test/billing/planSchema.test.js 会解析 src/action/seed-actions.js 防漂移；新增功能模块须同步此处）。

export const KNOWN_ENTITLEMENTS = [
  'core_crm',
  'ai_agents',
  'customer_360',
  'decision_autonomy',
  'event_automation',
  'approval_flow',
  'llm_config',
  'mcp_access',
  'advanced_reporting',
  'audit_provenance',
  'industry_config',
  'rbac_advanced',
  'memory',
  // 2026-09-06 本地旗舰版专属部署/底座能力（仅进权益目录与矩阵展示，不绑定任何 Action 的 requiresEntitlement → 无线上闸门）
  'local_integration',
  'distributed_db',
  'vector_store',
];

// 权益目录（key → 对外展示名）：landing 权益矩阵 / 管理台勾选框的唯一标签源。
// 铁律：展示文案属单一事实源，前端不得硬编码标签；新增权益必须同时补此处标签。
export const ENTITLEMENT_LABELS = {
  core_crm: '核心 CRM（客户/商机/合同/报价/回款）',
  ai_agents: 'AI 智能体四件套（intake / quote / followup / review）',
  customer_360: '客户 360 洞察',
  decision_autonomy: '决策自治层（autonomyEngine + D 层）',
  event_automation: '事件触发自动化（SSE + agent-event-trigger）',
  approval_flow: '审批流配置（CRM_APPROVAL_FLOW）',
  llm_config: '多租户 LLM 配置',
  mcp_access: 'MCP 接入（crm-native :3001/mcp）',
  advanced_reporting: '高级报表 / 对账看板',
  audit_provenance: '决策溯源 / 审计（C1–C4 + 哈希链）',
  industry_config: '行业配置化（每租户自有 + 上线引导）',
  rbac_advanced: '高级 RBAC（data_scope 域级）',
  memory: '客户记忆生命周期',
  local_integration: '本地系统集成（对接既有企业系统 / SSO / 数据中台）',
  distributed_db: '分布式数据库集群（高可用 / 水平扩展）',
  vector_store: '向量库构建（embedding 检索底座）',
};

/** 权益目录（按 KNOWN_ENTITLEMENTS 顺序），供对外接口下发：{ key, label }[]。 */
export function entitlementCatalog() {
  return KNOWN_ENTITLEMENTS.map((key) => ({ key, label: ENTITLEMENT_LABELS[key] || key }));
}

// 严格 ≥0 的金额/数值字段（-1 也非法）
const NON_NEG_NUM_FIELDS = ['base_fee', 'token_overage_unit_price'];
// 允许 -1=「不限」哨兵的字段（口径与 db/seed-billing-config.sql 一致：included_seats 同语义已单独校验）
const UNLIMITED_SENTINEL_FIELDS = ['seat_unit_price', 'included_tokens'];
// landing 卡片结构化展示字段（向后兼容：无值时不渲染，不阻断保存）
const OPTIONAL_STR_FIELDS = ['tag_text']; // ≤30 字 tag_text：卡片角标（如「首月免费」「企业首选」）
const OPTIONAL_NUM_FIELDS = ['original_price']; // ≥0 数字，> seat_unit_price 时展示划线原价

function isBlank(v) { return v === undefined || v === null || v === ''; }

/** 校验单个套餐，返回 { ok, errors[], plan_id }。seenIds 用于跨档位 plan_id 查重。 */
export function validatePlan(plan, seenIds = new Set()) {
  const errors = [];
  const p = plan || {};
  const id = String(p.plan_id ?? '').trim();
  if (!/^[a-z0-9_-]{2,40}$/.test(id)) {
    errors.push(`plan_id 非法（须为小写字母/数字/-/_ 组合，2-40 位）：${JSON.stringify(p.plan_id ?? '')}`);
  } else if (seenIds.has(id)) {
    errors.push(`plan_id 重复：${id}`);
  }
  if (isBlank(p.name) || !String(p.name).trim()) errors.push('name 必填');
  for (const f of NON_NEG_NUM_FIELDS) {
    if (isBlank(p[f])) continue; // 可缺省，保存时按 0 处理
    const n = Number(p[f]);
    if (!Number.isFinite(n) || n < 0) errors.push(`${f} 须为 ≥0 数字，当前 ${JSON.stringify(p[f])}`);
  }
  for (const f of UNLIMITED_SENTINEL_FIELDS) {
    if (isBlank(p[f])) continue; // 可缺省，保存时按 0 处理
    const n = Number(p[f]);
    if (!Number.isFinite(n) || (n < 0 && n !== -1)) errors.push(`${f} 须为 ≥0 数字或 -1（不限），当前 ${JSON.stringify(p[f])}`);
  }
  if (!isBlank(p.included_seats)) {
    const n = Number(p.included_seats);
    if (!Number.isInteger(n) || n < -1) {
      errors.push(`included_seats 须为 ≥-1 整数（-1=不限，0=不含席位，N=含 N 席），当前 ${JSON.stringify(p.included_seats)}`);
    }
  }
  if (!isBlank(p.token_hard_cap)) {
    const n = Number(p.token_hard_cap);
    if (!Number.isFinite(n) || n <= 0) errors.push(`token_hard_cap 须为 >0 数字或留空（不限），当前 ${JSON.stringify(p.token_hard_cap)}`);
  }
  if (!isBlank(p.token_overage_mode) && !['bill', 'block', 'none'].includes(p.token_overage_mode)) {
    errors.push(`token_overage_mode 只允许 'bill'（超量计费）| 'block'（超量停用）| 'none'（不限量/不计费），当前 ${JSON.stringify(p.token_overage_mode)}`);
  }
  if (p.entitlements != null) {
    if (!Array.isArray(p.entitlements)) {
      errors.push('entitlements 须为字符串数组');
    } else {
      const unknown = p.entitlements.filter((k) => !KNOWN_ENTITLEMENTS.includes(k));
      if (unknown.length) errors.push(`entitlements 含未登记权益键：${unknown.join(',')}（白名单：${KNOWN_ENTITLEMENTS.join(',')}）`);
    }
  }
  // features：套餐卡项目列表（landing.html 卡片 <ul> 由其动态重建）。
  // 严格形态 = 字符串数组；保留对旧 string 的兼容读（不回写）。
  if (p.features != null) {
    if (Array.isArray(p.features)) {
      for (const f of p.features) {
        if (typeof f !== 'string' || !f.trim()) errors.push(`features 数组项须为非空字符串：${JSON.stringify(f)}`);
        else if (f.length > 200) errors.push(`features 数组项过长（>200 字）：${f.slice(0, 30)}…`);
      }
    } else if (typeof p.features === 'string') {
      // 兼容：旧 string 自动按 / 或 + 切分（读路径不报错；写入端 schema 已收紧为数组）
    } else {
      errors.push('features 须为字符串数组');
    }
  }
  if (p.enabled != null && typeof p.enabled !== 'boolean') errors.push('enabled 须为布尔值');
  return { ok: errors.length === 0, errors, plan_id: id };
}

/** 校验整个 plans 数组（跨档位查重 + 逐档校验），返回 { ok, errors[] } */
export function validatePlans(plans) {
  const errors = [];
  const seen = new Set();
  for (const p of Array.isArray(plans) ? plans : []) {
    const r = validatePlan(p, seen);
    if (r.plan_id) seen.add(r.plan_id);
    for (const e of r.errors) errors.push(`[${r.plan_id || '未命名档位'}] ${e}`);
  }
  return { ok: errors.length === 0, errors };
}
