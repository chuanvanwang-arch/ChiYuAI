// src/pages/S33-workbench.schema.js — S33 待办工作台（四视角，/todo）
// 设计输入：docs/superpowers/plans/2026-08-26-ai-10-gap-repair-plan.md Task G3-T1 + 08 门户 §5
// 定位：成品页四视角 = 待我审批 / 我处理的 / 我发起的 / 抄送我的。
// 受控契约：
//   - 与既有 S01/S13 同构（type/workspace + navigation/to + layout + components 带 dataBinding）
//   - 「按当前人筛」由服务端 /workbench?view= 注入（schema 声明视角语义 + 状态过滤 eq；
//     actor 值不硬编码进 schema——运行时 actor 匹配是服务端职责，schema 仅声明受控筛选形）
//   - 状态字段仅 eq（CRM_APPROVAL_INSTANCE.status / CRM_APPROVAL_TASK.status ∈ STATE_FIELDS_PER_TYPE）
//   - 渲染器不改：服务端注入 {components:{table:[rows]}} 后 renderPage 消费
import { validatePageSchema } from '../page/validator.js';

// 四视角组件：同名 table kind + view 语义标记（服务端据此做 actor 过滤 + 组装行数据）
const viewTables = [
  {
    kind: 'table',          // 受控组件（COMPONENT_KINDS 护栏）
    view: 'approval',       // 待我审批：CRM_APPROVAL_TASK.status='todo' AND approver 匹配当前人/角色
    title: '待我审批',
    dataBinding: {
      source: 'particle', particleType: 'CRM_APPROVAL_TASK',
      filters: [{ field: 'status', op: 'eq', value: 'todo' }],   // 状态字段仅 eq（护栏②）
      columns: ['title', 'approver', 'opinion', 'seq', 'created_at'], metrics: [],
      rowActions: [           // 行内审批操作（ Action 白名单 + 渲染器声明式按钮）
        { action: 'crm-approval-approve', label: '批准', confirm: '确认批准该审批任务？' },
        { action: 'crm-approval-reject', label: '拒绝', confirm: '确认拒绝该审批任务？' },
      ],
    },
  },
  {
    kind: 'table',          // 受控组件（COMPONENT_KINDS 护栏）
    view: 'processing',     // 我处理的：tasks.status='running'（由服务端把 actor/status 过滤转成行）
    title: '我处理的',
    dataBinding: {
      source: 'particle', particleType: 'CRM_APPROVAL_TASK',
      filters: [{ field: 'status', op: 'eq', value: 'running' }],
      columns: ['title', 'actor', 'chain_id', 'created_at'], metrics: [],
    },
  },
  {
    kind: 'table',          // 受控组件（COMPONENT_KINDS 护栏）
    view: 'initiated',      // 我发起的：CRM_APPROVAL_INSTANCE.submitter=当前人（服务端注入行）
    title: '我发起的',
    dataBinding: {
      source: 'particle', particleType: 'CRM_APPROVAL_INSTANCE',
      filters: [],                                           // status 不做硬过滤：发起人视角看全状态
      columns: ['title', 'submitter', 'status', 'current_node_name', 'created_at'], metrics: [],
    },
  },
  {
    kind: 'table',          // 受控组件（COMPONENT_KINDS 护栏）
    view: 'cc',             // 抄送我的：tasks/approval cc 字段匹配当前人（服务端注入行）
    title: '抄送我的',
    dataBinding: {
      source: 'particle', particleType: 'CRM_APPROVAL_INSTANCE',
      filters: [],
      columns: ['title', 'cc', 'status', 'created_at'], metrics: [],
    },
  },
  {
    kind: 'table',          // 受控组件（COMPONENT_KINDS 护栏）
    view: 'follow',         // 待跟进：业务粒子跟进/待审批/回款核对（服务端注入行）
    title: '待跟进',
    dataBinding: {
      source: 'particle', particleType: 'CRM_DEAL',
      filters: [],
      columns: ['deal', 'customer', 'stage', 'due', 'action'], metrics: [],
    },
  },
  {
    kind: 'table',          // 受控组件（COMPONENT_KINDS 护栏）
    view: 'tuning',         // 参数调优（P1 2026-09-05）：calibration_patch PENDING 处方（服务端注入行）
    title: '参数调优',
    dataBinding: {
      source: 'particle', particleType: 'CRM_KNOWLEDGE',  // 占位粒子：真实数据源为校准表（服务端注入），仅过值域护栏
      filters: [],
      columns: ['title', 'target', 'from_value', 'to_value', 'risk', 'created_at'], metrics: [],
      rowActions: [
        { action: 'crm-tune-approve', label: '批准', confirm: '确认批准该参数调优处方并生效？' },
        { action: 'crm-tune-reject', label: '驳回', confirm: '确认驳回该参数调优处方？' },
      ],
    },
  },
  {
    kind: 'table',          // 受控组件（COMPONENT_KINDS 护栏）
    view: 'signals',        // 第7视角：信号（2026-09-16 主动运行时 S1）：crm.signal 统一收口（服务端注入行）
    title: '信号',
    dataBinding: {
      source: 'particle', particleType: 'CRM_KNOWLEDGE',  // 占位粒子：真实数据源为 crm.signal（服务端注入），仅过值域护栏
      filters: [],
      columns: ['title', 'kind', 'severity', 'status', 'target_role', 'created_at'], metrics: [],
      rowActions: [
        { action: 'crm-signal-ack', label: '确认', confirm: '确认该信号已处置？' },
        { action: 'crm-signal-close', label: '否决', confirm: '确认否决该信号？' },
      ],
    },
  },
];

export const schema = {
  type: 'workspace',
  title: '待办工作台',
  navigation: { to: '/my-todo' },
  layout: { columns: 2, theme: 'light' },
  components: viewTables,
};

// 启动即校验（非法立即失败，不静默）
const v = validatePageSchema(schema);
if (!v.ok) throw new Error('S33 schema 非法: ' + v.errors[0]);