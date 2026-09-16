// src/page/schema.js — 门户 NL→Page 协议常量（受控 Schema 值域）
// 设计输入：ai-portal-page-generation（三段式 NL→受控 Schema→渲染器；4 粒子护栏；Action 白名单）
// 值域对齐：src/particles/particleModel.js 9 真粒子（CRM_* 前缀）；src/action/whitelist.js 写白名单

// 页面类型（v0.1 MVP）：dashboard/table/form/detail/intake/workspace
export const PAGE_TYPES = ['dashboard', 'table', 'form', 'detail', 'intake', 'workspace'];

// 组件类型（v0.1 受控集 + stage3 T3-12 H29 扩展：subtable 子表格 / select 选择器；
//   G1 T6 元模型抽屉扩展：attr-field 属性字段受控组件；
//   数字化指标重设计（2026-08-28）：kpi-strip 大数字指标带 / pipeline 六段管道 / progress-card 进度条卡）
export const COMPONENT_KINDS = [
  'metric-card', 'table', 'goal-form', 'result-card', 'reasoning-trace', 'subtable', 'select', 'attr-field',
  'kpi-strip', 'pipeline', 'progress-card', 'collapse', 'contract-matrix',
  'tabs', 'task-monitor', 'target-card',
];

// 数据源契约（数字化指标重设计 §3.2）：
//   particle  —— 明细/表格，单粒子类型，走四护栏（值域/状态字段/快照字段/Action 白名单）
//   aggregate —— 派生指标组件（kpi-strip/pipeline/progress-card），跨多粒子聚合，
//                单值 particleType 无法诚实表达，故改用 sources[] 数组 + metrics[] 必填
export const DATA_SOURCES = ['particle', 'aggregate'];

// 聚合型组件：声明式消费派生指标，不走单粒子四护栏，但仍校验 sources 值域与 metrics 必填
export const AGGREGATE_KINDS = ['kpi-strip', 'pipeline', 'progress-card'];

// attr-field 组件属性类型值域（对齐 particleModel.js 19 类型集；validator 引用）
export const ATTR_FIELD_TYPES = [
  'text', 'personal-name', 'email-address', 'phone-number', 'domain', 'location',
  'number', 'currency', 'percent', 'date', 'timestamp', 'select', 'multi-select',
  'boolean', 'rating', 'url', 'record-reference', 'actor-reference', 'interaction',
];

export const THEMES = ['light', 'dark'];

// 过滤算子：状态字段仅 eq（无序枚举不可 lt/gt/range）；数值字段可 lt/lte/gt/gte
export const FILTER_OPS = ['eq', 'lt', 'lte', 'gt', 'gte', 'contains'];

// 聚合函数：存量快照字段仅 latest（不可 sum/avg 跨记录）；状态字段不可聚合
export const AGG_FUNCS = ['count', 'sum', 'avg', 'latest'];

// 粒子值域（对齐 particleModel.js 9 真粒子 + stage3 L2C 业务闭环粒子；旧值如 DEAL/ACCOUNT/废弃拆分模型直接拒绝，非静默映射）
export const PARTICLE_TYPES_ENUM = [
  'CRM_DEAL', 'CRM_ACCOUNT', 'CRM_CONTACT', 'CRM_PRODUCT', 'CRM_PRICE_LIST',
  'CRM_PERSON', 'CRM_ORGANIZATION', 'CRM_KNOWLEDGE', 'CRM_UNSTRUCTURED_ASSET',
  'CRM_QUOTATION', 'CRM_CONTRACT', 'CRM_PAYMENT_PLAN', 'CRM_PAYMENT_RECORD',
  'CRM_INVOICE', 'CRM_ORDER',
  // —— 审批域六层粒子 + 运行态（对齐 particleModel.js:148-187；G3 待办工作台四视角消费）——
  'CRM_APPROVAL_FLOW', 'CRM_APPROVAL_VERSION', 'CRM_APPROVAL_NODE',
  'CRM_APPROVAL_APPROVER', 'CRM_APPROVAL_CONDITION', 'CRM_APPROVAL_LINK',
  'CRM_APPROVAL_INSTANCE', 'CRM_APPROVAL_TASK',
];

// Action 白名单（对齐子系统三：读全量 + 写白名单；页面按钮只映射此处，禁 NL 生成未注册动作）
// stage3 T3-12 扩展：门户组件（subtable/select 等）可绑定的阶段3 写 Action（移池/回款/发票/订单推进）
export const ACTION_WHITELIST = {
  read: ['data-particle-read', 'crm-account-360'],
  write: ['crm-deal-advance', 'data-particle-create', 'data-particle-update', 'crm-lead-pick', 'crm-lead-recycle', 'crm-lead-return', 'crm-lead-move', 'crm-payment-plan-create', 'crm-payment-record-create', 'crm-invoice-reconcile', 'crm-order-advance', 'crm-approval-approve', 'crm-approval-reject',
    // 参数调优签批（P1 2026-09-05 设计 §2.4）：my-todo「参数调优」视角行内按钮 →
    //   /api/my-todo/tune-approve|tune-reject（内部复用 approvePatch/rejectPatch，第0闸透传）
    'crm-tune-approve', 'crm-tune-reject',
    // 信号处置（2026-09-16 主动运行时 S1）：工作台第7视角「信号」行内按钮 →
    //   crm-signal-ack（确认=status→acked）/ crm-signal-close（否决=status→closed），写 crm.signal，经第0闸
    'crm-signal-ack', 'crm-signal-close'],
};

// 权威导航枚举（navigation.to 必须 ∈ 此集，否则拒绝渲染）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md §1.2（导航枚举扩展）
// 既有 10 项前台 + 本蓝图新增（业务详情 + 配置中心 G1–G4；详情路径用 :id 占位范式）
export const CANONICAL_NAV = [
  '/dashboard', '/deals', '/accounts', '/contacts', '/products', '/pricelists',
  '/persons', '/organizations', '/knowledge', '/workspace',
  // —— 本蓝图新增：业务详情 + 前台扩展 ——
  '/home', '/agents', '/my-todo', '/business-board', '/decision-graph',
  // —— S36 漏斗质量看板（受控页签，设计 2026-08-30 funnel-design §5.3）——
  '/funnel-quality',
  '/accounts/:id', '/accounts/:id/insight', '/deals/:id', '/quotations/:id', '/contracts/:id',
  '/orders/:id', '/payments/:id', '/invoices/:id', '/particles/:id',
  // —— 本蓝图新增：配置中心（G1 平台与访问）——
  '/config/llm', '/config/users', '/config/rbac', '/config/connectors', '/config/system',
  // —— G2 销售方法论与决策治理 ——
  '/config/decision-scenarios', '/config/seven-dim', '/config/skills',
  '/config/decision-quality', '/config/memory',
  // —— G3 业务对象与流程建模 ——
  '/config/meta-attr', '/config/ontology', '/config/business-tier',
  '/config/approvals', '/config/pool',
  // —— G4 智能体与运行 ——
  '/config/agents', '/config/portal-pages', '/config/alerts',
];

// 状态字段（无序枚举）：filter 仅 eq；禁止聚合
export const STATE_FIELDS_PER_TYPE = {
  CRM_DEAL: ['stage'],            // lead/opportunity/quoted/contracted/ordered/paid/lost/disqualified
  CRM_ACCOUNT: ['stage'],         // potential/active/dormant/lost
  CRM_CONTACT: ['status'],        // active/departed
  // 审批运行态（G3 待办工作台：待我审批筛 status='todo'；实例态筛 approving 等；均无序枚举仅 eq）
  CRM_APPROVAL_INSTANCE: ['status'],  // pending_submit/approving/approved/rejected/canceled
  CRM_APPROVAL_TASK: ['status'],      // todo/approved/rejected/transferred
};

// 存量快照字段：聚合仅 latest（不可 sum/avg 跨记录）
export const SNAPSHOT_FIELDS_PER_TYPE = {
  // 存量快照字段：聚合仅 latest（不可 sum/avg 跨记录）。
  // 语义边界：快照 = 库存类现状（qty/price）；业务流式指标（商机金额 amount）可跨记录加总，不属于快照。
  CRM_PRODUCT: ['qty', 'price'],  // 产品存量/价格（库存类现状）
};