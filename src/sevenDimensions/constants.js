// src/sevenDimensions/constants.js — 七维常量（D3 唯一源）
// 设计输入：docs/2026-08-26-frontend-config-pages-master-blueprint.md S20 + D3 决策
//          Oleg Shilovitsky（OpenBOM）产品情境七维度 → CRM 决策场景完整性校验
// 唯一事实源：业务页/配置页/engine 全部从此导入，禁止另写维表
export const SEVEN_DIMS = [
  { key: 'identity',          label: '身份',       desc: '客户/商机跨系统唯一身份是否一致' },
  { key: 'structure',         label: '结构',       desc: '客户-商机-报价-合同-订单图谱关系可达' },
  { key: 'semantics',         label: '语义',       desc: '赢单/丢单/有效商机等术语跨域定义一致' },
  { key: 'time_config',       label: '时间与配置', desc: '决策生效时间窗/产品线/配置版本' },
  { key: 'decision_history',  label: '决策历史',   desc: '历史否决方案/先例是否被检索' },
  { key: 'operational_state', label: '运行状态',   desc: '当前销售运行态(库存/交付/竞品动态)' },
  { key: 'governance',        label: '治理',       desc: '谁可批/谁负责/自主边界' },
];

// 维度键（顺序固定 = 校验输出表顺序）
export const DIM_KEYS = SEVEN_DIMS.map((d) => d.key);