# 指标三分类深入落地设计（预警 / 展示 / 控制）

> 日期：2026-08-30 ｜ 依据：用户「这些指标，需要结合平台功能进行深入落地，哪些指标需要预警提醒、哪些需要在工作台展示、哪些需要进行控制（不达成就不能推动下一步业务）。全部识别清楚后进行系统调整。请还是需要参考两个外部SKILL」
> 外部 SKILL：`sales-knowledge-free`（开放知识库）+ `to-b-sales-management`（模型，9 大场景 28 项标准 11 项流程）
> 前置：2026-08-30 已完成「13 项缺失初始值补齐（Task #38）+ A-D 接线（Task #39-#42）」，本轮在其上做三分类系统调整

---

## §0 结论

把 sales-thresholds **13 键 + 阶段闸（5 条）+ 商机三要素** 全部落入 **A（预警提醒）/ B（工作台展示）/ C（硬性控制）** 三分类：

- **A 类 10 项**：写事件 + 每日巡检双轨触发，全部复用既有纯函数（零新增业务逻辑，只加调度壳）
- **B 类 8 项**：S02 首页作战室主导 + named-accounts.html 同步，**零新增数据通道**（boardSummary 已注入 cov* 六键，本轮只做前端消费）；顺手修 2 处硬编码 80（铁律违规）
- **C 类 6 项**：P1→P4 保持 hard；**P4→P5 / P5→P6 升级 hard**（闸内保留证据兜底）；**新增商机创建三要素闸**（读 `bantcc.*`，与 P3→P4 同源）

**零新增阈值键**：所有数值继续走 `config_store['sales-thresholds']` 唯一事实源。

---

## §1 A 类：预警提醒（10 项，事件 + 巡检双轨）

### 1.1 指标清单

| # | 告警 kind | 判定（阈值键） | 触发 | 现状 |
|---|---|---|---|---|
| A1 | `coverage_gap_target` | 目标客户 > `coverage.target_month_days`(30) 天未拜访 | 巡检 | gap 提示未入 alert |
| A2 | `coverage_gap_potential` | 潜力客户 > `coverage.potential_quarter_days`(90) 天未拜访 | 巡检 | gap 提示未入 alert |
| A3 | `lost_contact` | > `coverage.lost_contact_days`(90) 天无任何拜访 | 巡检 | gap 提示（D 接线）未入 alert |
| A4 | `deal_stuck` | 阶段停留 > `stage.stuck_days`(30) 天 | 已生效 ✅ | alertRegistry 已有 |
| A5 | `forecast_breach` | 销售潜力 < `funnel.forecast_breach_ratio`(1.0) | 已生效 ✅ | alertRegistry 已有 |
| A6 | `funnel_jitter` | 抖动率 > `funnel.jitter_max`(0.3) | 巡检 | baseline 已就绪，只差判定接线 |
| A7 | `commit_red` | 承诺准确率 < `funnel.commit.yellow_low`(0.8) 红带 | 巡检 | commitAccuracy 已就绪 |
| A8 | `funnel_unhealthy` | 销售潜力 < `funnel.health_min_ratio`(1.0) | 巡检 | funnelHealth 已就绪 |
| A9 | `visit_shortfall` | 日/周拜访 < `coverage.daily/weekly_visits_target`(3/15) | 巡检+写事件 | 工作台 warn，未入 alert |
| A10 | `info_collect_lag` | 信息收集进度落后（周新增客户 < `coverage.info_collect_weekly`(5)） | 巡检 | 无 |

### 1.2 触发机制

- **写事件触发（保留现网）**：alertHook 订阅 bus `particle` 域，A4/A5 已生效；A1-A3/A6-A8/A10 是「时间推移型」，纯事件驱动会漏报。
- **每日巡检（新增）**：timers.js 新增 `sales-daily-scan` 定时器（对齐 lead-pool-recycle 既有模式）：
  - 周期：30 分钟（与 crm-risk-scan 同粒度，满足"每日"语义且故障恢复快）
  - 逻辑：读 accounts/deals/contracts → `deriveRhythmDays` 得窗口 → 逐账户算覆盖率缺口 → `funnelHealth`/`commitAccuracy`/`jitterRate` 算漏斗三指标 → 命中 `createAlert` 落库 + `emit('alert')` SSE 转播
  - **只读 + 告警**：不与 `sales-daily-scan` 写粒子（对齐 07 文档 §5-2「定时扫描直接写粒子即违 D4」反模式——巡检只发射预警，处置走写 Action）

**新增 alertRegistry 规则 4 条**：

```js
{ kind: 'coverage_gap',     match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { target_days: 30, potential_days: 90 } },
{ kind: 'lost_contact',     match: { particleTypes: ['CRM_ACCOUNT'], actions: ['daily_scan'] }, check_params: { lost_days: 90 } },
{ kind: 'funnel_unhealthy', match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan', 'forecast_update'] }, check_params: { health_min: 1.0 } },
{ kind: 'commit_red',       match: { particleTypes: ['CRM_DEAL'], actions: ['daily_scan', 'forecast_update'] }, check_params: { yellow_low: 0.8 } },
```

（check_params 出厂建议值，运行时可被 config_store['sales-thresholds'] 覆盖——同 financeAlertHook 动态读模式）

---

## §2 B 类：工作台展示（8 项，S02 主导 + named-accounts 同步）

### 2.1 指标清单

| # | 指标 | 阈值键 | 现状 | 本轮 |
|---|---|---|---|---|
| B1 | 今日拜访/电话 vs 标准 | `coverage.daily_visits_target`(3) | 展示走 id31 个人目标 | S02 新增 标准比对 |
| B2 | 本周拜访数 vs 15 | `coverage.weekly_visits_target`(15) | ✅ 展示 | 保留 |
| B3 | 客户数 vs 60/75 | `coverage.customer_count_min/target`(60/75) | ❌ cov* 注入未消费 | S02 + named-accounts 消费 |
| B4 | 信息收集进度 vs 每周5 | `coverage.info_collect_weekly`(5) | ❌ 未展示 | S02 新增 |
| B5 | 21 条合格率 | `ui.behavior_pass_rate_ok`(80) | 展示但**硬编码 80** | 两处改读配置（铁律修复） |
| B6 | 漏斗健康/抖动/承诺准确率 | `funnel.*` | funnel-quality.html 有，首页未接 | S02 管道区 kpi-strip 补三项 |
| B7 | TAORAN 三档统计 | `taoran.*`(80/20) | ❌ classifyTaoranAchieved 已就绪未展示 | S02 行为达标区统计 |
| B8 | 客户分类分布 | — | ✅ 档位列 | 保留 |

### 2.2 承接机制

- **S02 schema**（src/pages/S02.schema.js）：`My Behavior` collapse 区新增「标准」progress-card 组（B1/B2/B3/B4 + TAORAN 三档计数）+ 管道区 kpi-strip 补 B6 三项
- **named-accounts.html**：renderKpis 补 cov* KPI（B3/B4）；`renderBehaviorCard` 与 `renderBoard` 的 `>= 80` 改读 `summary.behaviorPassRateThreshold`（boardSummary 注入）
- **routes.js:756**：首页 `>= 80` 改读 `readThreshold(thresholds, 'ui.behavior_pass_rate_ok')`
- **数据源**：boardSummary 已注入 cov* 六键（上轮 C 接线），本轮只做前端消费，**零新增数据通道**

---

## §3 C 类：硬性控制（6 项）

| # | 闸 | 现状 | 本轮 |
|---|---|---|---|
| C1 | P1→P2 需求事实 ≥2（`gate.p1_p2_min_need_facts`） | ✅ hard | 保留 |
| C2 | P2→P3 方案验证（sales_visit_value） | ✅ hard | 保留 |
| C3 | P3→P4 BANTCC ≥`bantcc.pass`(0.6) + 报价事实 | ✅ hard | 保留 |
| C4 | P4→P5 review-gate + 合同/下单时间 | ⚠️ soft | **升级 hard**，闸内保留证据兜底 |
| C5 | P5→P6 合同签署 + 全款 | ⚠️ soft | **升级 hard**，闸内保留证据兜底 |
| C6 | **商机创建三要素**（预算/时间表/责任人） | ❌ 无闸 | **新增 hard**：读 `bantcc.*` |

### 3.1 C4/C5 升级（executor.js STAGE_GATES）

- 语义变化：`hard: false → hard: true`，check 函数**不变**（证据兜底保留——`contract_facts/signed_at/contract_no/order_date/paid_at/payment_received` 任一存在即过关）
- 防误杀依据（用户已确认「沿用现有通道+闸内兜底」）：证据录入通道已存在（review-gate agent 写 decision / contract 创建回写 / payment 事件），且兜底判据覆盖「人工直接录事实」路径
- 拦截语义：缺口转 `gaps[]`（此前进 `warnings[]`）→ hard 判定生效可拦截推进

### 3.2 C6 商机三要素闸（新增，executor.js 第 3.5 闸区）

- 触发条件：`data-particle-create` + `particleType === 'CRM_DEAL'` + `params.payload.stage`（或 state）非 `lead`（lead 阶段是线索，不在此闸）
- 校验字段（用户确认读 `bantcc.*` 六维，与 P3→P4 同源）：
  - B 维度：`payload.bantcc.budget_ok === true` 或 `budget` 非空
  - A 维度：`payload.bantcc.authority_ok === true` 或 `authority` 非空
  - T 维度：`payload.bantcc.timetable_ok === true` 或 `schedule`/`timeline` 非空
  - 兼容 `payload.ai.bantcc_completeness` 且 ≥ `bantcc.pass`（已有评估则整维兜底）
- 拦截：`{ ok:false, gate:'sales_deal_prereq', error:'商机三要素缺失（预算/时间表/责任人）' }` + emit trace
- 阈值读 `bantcc.pass`（不新增键）

### 3.3 证据链保障（防误杀）

- 三个硬闸（C3/C4/C6）均有兜底判据：C6 兼容 `ai.bantcc_completeness` 已评估值；C4/C5 任一事实存在即过关
- 不设「录入入口」= 人工通过 `data-particle-create`/既有写 Action 录事实即满足闸条件

---

## §4 改动文件清单

| 层 | 文件 | 改动 |
|---|---|---|
| 调度 | `src/scheduler/timers.js` | 新增 sales-daily-scan 定时器（巡检壳，复用纯函数，只读+告警不写粒子） |
| 告警 | `src/alerts/alertRegistry.js` | 新增 4 规则（coverage_gap/lost_contact/funnel_unhealthy/commit_red） |
| 控制 | `src/action/executor.js` | STAGE_GATES C4/C5 `hard:false→true` + 第 3.5 闸区新增 C6 商机三要素闸 |
| 展示 | `src/pages/S02.schema.js` | My Behavior 区新增「标准」progress-card 组 + 管道 kpi-strip 补漏斗三指标 |
| 展示 | `src/web/named-accounts.html` | renderKpis 补 cov* KPI；21 条合格率改读配置 |
| 展示 | `src/http/routes.js` | 首页 21 条合格率硬编码 80 → 读配置 |

## §5 测试计划（TDD，红→绿）

| 文件 | 用例 |
|---|---|
| `test/scheduler/salesDailyScan.test.js` | 巡检构造：覆盖率缺口/流失警戒/漏斗不健康/承诺红带命中 createAlert；达标无告警；阈值随配置变化 |
| `test/alerts/alertRegistry-sales.test.js` | 4 新规则注册、check_params 出厂默认、enable/disable |
| `test/action/sales-deal-prereq.test.js` | C6：三要素齐全创建过闸；缺任一二三各拦截；lead 阶段豁免；bantcc.* 旧字段兼容 |
| `test/action/executor-gate-hard.test.js` | C4/C5 hard 升级：缺口可拦截（此前 soft 只警告）；证据兜底任一存在过闸 |
| `test/pages/S02-sales-standard.test.js` | S02 schema 新增区/组件合法、数据绑定正确 |
| `test/http/named-accounts-cov.test.js` | boardSummary cov* 注入 + 前端展示数据可用；21 条合格率阈值随配置 |

## §6 边界（明确不纳入本轮）

- **经理层动作类指标**（联合拜访 5-10/周、日报 7 项、周会议程、低业绩者识别）→ 另立任务
- `funnel.month_new_bid_ratio`（无对应判定函数）→ 保持看板标准，不强行接线
- 商机三要素**人工录入入口**（前端表单）→ 另立任务；本轮只做后端闸（录入走现有 `data-particle-create`/写 Action）
- 巡检不做跨粒子写（对齐 07 文档 §5-2：定时扫描直接写粒子即违 D4 反模式）

---

## §A 生命契约（双轨）

```contract-yaml
- task: "timers 新增 sales-daily-scan 巡检定时器"
  agent: crm-copilot
  skills: [ai-event-driven-evolution]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "timers.js 含 sales-daily-scan 且触发 createAlert 落库 + SSE alert 域转播；测试 salesDailyScan 红→绿通过"
- task: "alertRegistry 新增 4 条 告警规则"
  agent: crm-copilot
  skills: [ai-feedback-loop]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "alertRegistry 含 coverage_gap/lost_contact/funnel_unhealthy/commit_red；check_params=出厂建议值；测试全绿"
- task: "executor C4/C5 hard 升级 + C6 商机三要素闸"
  agent: crm-copilot
  skills: [ai-native-action-design]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "STAGE_GATES P4→P5/P5→P6 hard=true 且缺口可拦截；data-particle-create CRM_DEAL 非 lead 校验三要素缺任一拦截；证据兜底过闸不被误杀；测试红→绿"
- task: "S02 schema 新增 标准达标区"
  agent: crm-copilot
  skills: [ai-portal-page-generation]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "S02 含「标准」collapse 区与漏斗三指标 kpi-strip；schema 校验通过；回归测试全绿"
- task: "named-accounts.html + routes.js 前端消费 cov* 与 21 条合格率配置化"
  agent: crm-copilot
  skills: [ai-portal-page-generation]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "named-accounts renderKpis 展示 cov*；21 条合格率两处硬编码 80 改读配置；测试全绿"
```

**契约说明：** 5 个 Task 均由 `crm-copilot` 承接，调用对应方法论 SKILL、读取 crm-copilot 记忆（L1，≤2 跳）；成功标准均可验证（定时器存在 + 告警落库 + 闸拦截 + 页面渲染 + 配置化）。

---

## 闭环回写（P10）

| Task | 监控点 | 反馈来源 |
|---|---|---|
| sales-daily-scan | 定时器注册、告警落库、SSE 转播 | workbench task-monitor |
| alertRegistry 4 规则 | 规则可见、命中判定 | alert-rules 页面 |
| executor C4/C5/C6 | 阶段闸拦截 trace、商机创建拦截 trace | reasoning-trace |
| S02 区 | schema 校验、页面渲染 | page 测试 |
| cov* 消费 + 配置化 | 页面 KPI 数值、阈值随配置变化 | named-accounts 测试 |