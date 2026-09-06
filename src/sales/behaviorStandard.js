// src/sales/behaviorStandard.js — 销售行为标准量化目标（纯函数，零 DB，浏览器+node 共用）
// 设计：docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md §5（method-behavior-standard 落地）
// 契约：DEFAULTS 幂等；mergedBehaviorStd 供 router GET 铺底；PUT 仅接受已知量化键
// 注：21 条行为合格线（有/无判定）是静态事实源（STANDARDS），不在 config_store 中改写；
//     config_store['behavior-standard'] 只承载「量化目标」（每天拜访次数等可配项）。

// 21 条行为标准清单（事实源对齐 skills/method-behavior-standard/core/checklist.md）
// 仅供前端展示，不可编辑（设计原则：合格线是有/无判定，不设评分阈值）
export const STANDARDS = [
  { code: '01-01', name: 'BH-01 时间安排饱满' },
  { code: '01-02', name: 'BH-01 目的明确' },
  { code: '01-03', name: 'BH-01 工作计划完善' },
  { code: '02-01', name: 'BH-02 拜访所有客户' },
  { code: '02-02', name: 'BH-02 珍惜项目机会' },
  { code: '03-01', name: 'BH-03 BANTCC' },
  { code: '03-02', name: 'BH-03 关注需求' },
  { code: '03-03', name: 'BH-03 不做无效拜访' },
  { code: '03-04', name: 'BH-03 访前准备' },
  { code: '04-01', name: 'BH-04 理解关系作用' },
  { code: '04-02', name: 'BH-04 积极发展' },
  { code: '04-03', name: 'BH-04 主动管理' },
  { code: '05-01', name: 'BH-05 科学分类' },
  { code: '05-02', name: 'BH-05 接触潜力' },
  { code: '05-03', name: 'BH-05 关注目标' },
  { code: '06-01', name: 'BH-06 看到所有商机' },
  { code: '06-02', name: 'BH-06 识别致胜关键' },
  { code: '06-03', name: 'BH-06 寻求团队' },
  { code: '06-04', name: 'BH-06 正确看待输赢' },
  { code: '07-01', name: 'BH-07 按照标准做事' },
  { code: '07-02', name: 'BH-07 及时总结反省' },
];

// 可量化行为目标（默认口径，admin 可在配置中心改写）
export const DEFAULTS = {
  daily_visit_count: 2,      // 每天拜访次数（销售日行为 KPI）
  weekly_visit_customer: 8,  // 每周拜访客户数（去重）
  weekly_new_customer: 5,    // 每周新客户数
  daily_call_count: 10,      // 每天电话量
};

// 合并读：DEFAULTS 铺底 + 已存配置覆写（键级合并，防漏字段）
export function mergedBehaviorStd(stored = {}) {
  const s = stored || {};
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) {
    if (k in s) out[k] = s[k];
  }
  return out;
}
