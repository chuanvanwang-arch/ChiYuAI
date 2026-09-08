# 对话驱动决策建议（8 大决策 × S1-S8 阶段）设计

- 日期：2026-09-08
- 状态：**已批准**（用户 2026-09-08 逐项确认）
- 设计输入：brainstorming SKILL（P0-P10 流程）
- 目标：捕获销售员（sales）在 **MCP 通道**与**平台内操作**的对话与诉求，无论其是否明确提出决策请求，均按「8 大销售决策场景 × S1-S8 阶段」坐标给出决策建议。

---

## 0. 现状盘点（源码级证据）

| 维度 | 现状 | 证据 |
|---|---|---|
| 8 大销售决策 | `decision_scenario` 已有 8 行销售场景：一、线索 `LEAD_FOLLOW_UP`／二、机会评估 `OPP_QUALIFY`／三、客户策略 `CLIENT_STRATEGY`／四、方案价值 `SOLUTION_VALUE`／五、商务报价 `QUOTE_PRICING`／六、签单前风险 `SIGN_RISK`／七、终局决策 `POST_CONTRACT`／八、丢单复盘 `LOSS_REVIEW`；另有 `DEAL_REOPEN` + 4 个 meta + 4 个财务/闸门场景 | `db/seed.sql:227-320` |
| 商机阶段 | S1 线索发掘 → S6 赢单移交 + S7 输单／S8 丢单 | `src/sales/stageTaxonomy.js:5-8` |
| 决策产生方式 | **事件驱动**：粒子事件/ontology-sync → 事件触发器 → agent + SKILL 派发，非对话驱动 | `src/agent/eventTrigger.js:1-60` |
| 对话载体 | **缺失**：无对话表；Copilot 目前仅是 S02 的 `goal-form`（NL → 页面生成） | `src/pages/S02.schema.js:15`；`db/schema.sql` 无对话表 |
| MCP 通道 | Action Registry 暴露（读直连 + 写两阶段 `confirm_token`），无「诉求/建议」类工具 | `src/mcp/tools.js:41-121` |
| 决策状态 | `REQUIRED`/`HUMAN`/`AUTONOMOUS`/`ESCALATED`/`CONFIRMED`；`DISPOSABLE_STATES={REQUIRED,HUMAN,AUTONOMOUS}`；`REQUIRED` 计入 escalated | `src/decision/disposition.js:17`、`src/monitor/monitorStore.js:67` |
| 智能体 | 6 个：intake-router／quote-engine／followup-agent／review-gate／decision-retro／decision-agent | `src/agent/agentSpec.js:3-89` |

**结论**：缺口不在「8 大决策」（已有），而在**对话捕获层**与**对话 → 决策坐标的映射层**。

---

## 1. 已确认前提（用户决策，不可偏离）

| # | 决策项 | 结论 |
|---|---|---|
| D1 | 决策坐标口径 | **8 大销售场景 × S1-S8 阶段**（复用 `decision_scenario` 现有 8 行 + `stageTaxonomy`） |
| D2 | 捕获载体 | **对话原文不落库**（尊重用户选择：只拦 MCP，不建对话表） |
| D3 | 可溯性 | **落 decision 锚点**：每次建议落 `crm.decision` 一行（场景 + 阶段 + 诉求摘要 + 条件体检结果），不存对话原文 |
| D4 | 坐标判定机制 | **规则兜底 + LLM 精排**（确定性优先，LLM 只处理模糊层） |
| D5 | 实施路径 | **方案 A 拦截式中间件**：MCP gateway + 平台内写操作入口挂同一层 advisor |
| D6 | 变更批准 | 三项全批准：① 新增 `state='ADVISED'` ② 新增 SKILL `method-dialog-router` ③ 扩 `intake-router.skillCalls` |

---

## 2. 架构总览

统一内核：`advise({ utterance, ctx }) → 建议卡`。

五层链路：

1. 销售对话与诉求（MCP 通道 · 平台内操作）
2. 坐标判定（8 大场景 × S1-S8 阶段，规则兜底 + LLM 精排）
3. 条件体检（场景 `eval_dimensions` + 历史先例 + 七维度）
4. 决策建议卡（推荐处置 + 依据 + 缺口）
5. 落 decision 锚点（采纳后带 `decision_id` 过第 0 闸）

---

## 3. §1 拦截点矩阵

| # | 通道 | 拦截位置 | 触发时机 | 附加产出 |
|---|---|---|---|---|
| 1 | MCP 写 | `src/mcp/gateway.js:114` `mcpWritePhase1` | 返回表单 + `confirm_token` 时 | 表单 + 建议卡（含红线提示与是否需审批） |
| 2 | MCP 读 | `src/mcp/gateway.js:243` `mcpReadDirect` | 读结果返回时 | 结果 + 建议卡（仅高置信规则命中，可关闭） |
| 3 | MCP 主动 | 新增 read 工具 `crm-decision-advise` | 外部智能体主动问 | 建议卡（`persist` 默认 false，不落锚点） |
| 4 | 平台内对话 | `src/http/routes.js:2139` `/api/page/from-nl` | NL 解析出页面时 | 页面 + 建议卡 |
| 5 | 平台内写 | `src/action/executor.js` 第 0 闸前置 | 写操作过闸前 | 建议卡（缺口未补齐时提示，**不阻断**既有闸） |

1/2/4/5 为被动拦截，3 为主动调用。

---

## 4. §2 坐标判定（规则兜底 + LLM 精排）

### 4.1 阶段判定（确定性优先）

1. 上下文带实体（`deal_id`/`account_id`）→ 读粒子 `stage`（`stageTaxonomy`）。
2. 无实体 → 取该销售近 7 天活跃商机。
3. 仍无 → 默认 `S1`。

### 4.2 场景判定（配置化映射表）

映射表落 `config_store['dialog-scenario-map']`，**禁硬编码**（项目铁律：阈值与行业差异化 100% 后台配置化）。出厂默认：

| 诉求关键词 | 场景 | 典型阶段 |
|---|---|---|
| 报价／折扣／降价／账期／付款 | `QUOTE_PRICING` | S4 |
| 样品／寄样／试用／演示 | `SOLUTION_VALUE` | S3 |
| 方案／定制／需求变更 | `SOLUTION_VALUE` | S3 |
| 拜访／跟进／联系／谁拍板 | `CLIENT_STRATEGY` | S2-S3 |
| 预算／竞品／值不值得跟 | `OPP_QUALIFY` | S2 |
| 合同／签单／风险／卡住 | `SIGN_RISK` | S5 |
| 回款／续约／交付变更 | `POST_CONTRACT` | S6 |
| 丢单／输单／复盘／再跟 | `LOSS_REVIEW`／`DEAL_REOPEN` | S7／S8 |
| 新线索／跟不跟 | `LEAD_FOLLOW_UP` | S1 |

### 4.3 交叉校验与置信度

- **交叉校验**：场景 × 阶段须合法。「寄样品」在 S2 → `SOLUTION_VALUE`；在 S4 → 降级为 `QUOTE_PRICING` 的让步条件。
- **置信度分级**：
  - `high`：唯一命中 + 阶段已知 → 直接出建议。
  - `low`：多命中／无命中／阶段未知 → 交 LLM 精排（1 次调用，温度 0，输出 JSON）。
  - 精排超时或失败 → 降级 C 档（只补信息），**fail-open 不阻断业务**。

---

## 5. §3 条件体检与建议卡三档

取 `decision_scenario.eval_dimensions`（每场景已配置的带权评判条件，`db/seed.sql:229-320`）逐项测值，叠加先例（`decision_precedent_rel`）与七维度成熟度。

| 档位 | 触发条件 | 建议卡内容 |
|---|---|---|
| **A 明确处置** | required 条件齐 + 证据充分度 ≥ 阈值 | 场景/阶段 + 推荐 disposition（APPROVE/REJECT/ESCALATE/OVERRIDE/EXCEPTION）+ 依据 + 先例引用 |
| **B 风险提示** | required 条件齐但触碰红线（如 `margin_redline`） | 红线名 + 必须走的审批流（`CRM_APPROVAL_FLOW`）+ `decision_id` |
| **C 只补信息** | required 条件缺失或置信度低 | 缺什么（按权重降序）+ 追问话术，**不给处置** |

### 红线硬约束

- `QUOTE_PRICING`/`SIGN_RISK` 为 `default_tier=HIGH`（`db/seed.sql:253,257`），**折扣/签单类诉求一律 B 档以上，不得自治**（`autonomous_allowed=FALSE`）。
- 报价诉求必须提示走系统审批流，杜绝 off-system 私下报价。

---

## 6. §4 已批准变更（三项）

| # | 变更 | 内容 | 风险与缓解 |
|---|---|---|---|
| ① | 新增 `decision.state='ADVISED'` | 建议态专用，**不进** `DISPOSABLE_STATES`，避免污染待处置队列与 escalated 统计 | 低；需 grep 全量 `state` 分支确认无遗漏 |
| ② | 新增 SKILL `method-dialog-router` | 承载规则表加载 + LLM 精排提示词（`src/skills/seed.js`） | 中；**必须补齐 `steps[]`**（`src/skills/registry.js:69` 注明未补 steps 执行会崩） |
| ③ | 扩 `agentSpec.js` | `intake-router.skillCalls` 增加 `method-dialog-router`（`src/agent/agentSpec.js:8`） | 低；需同步跑契约校验脚本 |

> 说明：三项均属项目内 `method-*` SKILL 与 agentSpec，**不涉及** `~/.workbuddy/skills/ai-*` 十大能力基线（该基线按用户长期要求保持不变）。

---

## 7. §5 落锚点与采纳闭环

1. **落锚点**：建议产出即写 `crm.decision` 一行——`scenario_id`、`trigger_context{场景, 阶段, 诉求摘要}`、`conditions_evaluated`、`disposition`（建议值）、`decider_type='agent'`、`state='ADVISED'`。**对话原文零落库**。
2. **采纳**：客户端带 `decision_id` 调写工具 → gateway 第 0 闸校验通过 → 执行写 → 回写 `human_disposition`／`human_decider_*`，状态推进。
3. **否决**：保留 `ADVISED` 行 + 写 `feedback`，成为「建议被否」样本。
4. **沉淀**：`ADVISED` **不入**先例源（对齐 `decisionRepo.js:521` 的 `CONFIRMED/AUTONOMOUS` 口径），避免未经验证的建议污染先例库。

---

## 8. §6 任务拆分与生命契约

### 8.1 任务清单

| 任务 | 内容 | 承接 agent |
|---|---|---|
| T0（前置） | 注册 SKILL `method-dialog-router` + 补 `steps[]` + 扩 `intake-router.skillCalls` + 新增 `state='ADVISED'` | 工程变更（无独立契约） |
| T1 | 对话坐标判定内核（场景 × 阶段） | intake-router |
| T2 | 建议卡内核与场景分派（条件体检装配 + 三档判定） | decision-agent |
| T3 | 报价类场景建议（`QUOTE_PRICING`，毛利红线/折扣对等） | quote-engine |
| T4 | 跟进/客户策略/丢单类场景建议（`CLIENT_STRATEGY`/`LOSS_REVIEW`/`DEAL_REOPEN`） | followup-agent |
| T5 | 签单风险与评审类场景建议（`SIGN_RISK`/`REVIEW_GATE`） | review-gate |
| T6 | MCP 通道接入（gateway + `crm-decision-advise`） | decision-agent |
| T7 | 平台内接入（`from-nl` + executor 前置） | decision-agent |
| T8 | 落锚点与采纳闭环 | decision-agent |
| T9 | 配置化与复盘闭环 | decision-retro |

> 设计修正说明：初版把建议生成全部压给 `decision-agent`。契约自检（`scripts/validate-contract.mjs` 双向一致性断言）暴露该设计未覆盖 quote-engine／followup-agent／review-gate 三个专业 agent。**改为按场景分派**：decision-agent 做通用装配，报价/跟进/评审三类场景分别由其专业 agent 产出，与各 agent 既有职责（`agentSpec.js:16-56`）一致。

### 8.2 生命契约

```contract-yaml
- task: "T1 对话坐标判定内核（场景×阶段）"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-dialog-router, data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "8 大场景各 ≥3 条口语化样本，坐标判定准确率 ≥90%；无命中时降级为 C 档仅补信息且不抛错"
- task: "T2 建议卡内核与场景分派"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-enrich, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "8 大场景各 1 条样本产出建议卡，含 disposition/依据/缺口三段；缺口项必须来自该场景 eval_dimensions 且 required 优先"
- task: "T3 报价类场景建议"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [method-quote-engine, data-particle-read]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "QUOTE_PRICING 诉求触发毛利红线/折扣对等体检，超红线时建议卡必含 B 档风险提示与审批流指向"
- task: "T4 跟进/客户策略/丢单类场景建议"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine, method-funnel-classification, data-particle-read]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "CLIENT_STRATEGY/LOSS_REVIEW/DEAL_REOPEN 诉求产出拜访节奏与关键人策略建议，且引用客户分类结果"
- task: "T5 签单风险与评审类场景建议"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1, L2], maxHops: 4 }
  success: "SIGN_RISK/REVIEW_GATE 诉求产出风险清单与放行条件，tier=HIGH 时不得给出自治处置"
- task: "T6 MCP 通道接入（gateway + crm-decision-advise）"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "MCP 写 phase1 响应含 advice 字段；tools/list 可见 crm-decision-advise 且调用返回建议卡"
- task: "T7 平台内接入（from-nl + executor 前置）"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-enrich, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "POST /api/page/from-nl 返回 advice 字段；executor 写在缺口未补齐时返回 advice 且不阻断既有第 0 闸"
- task: "T8 落锚点与采纳闭环"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute, data-particle-create]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "建议落库 state=ADVISED 且 monitorStore escalated 计数不变；采纳后 decision_id 可过第 0 闸；否决可写 feedback"
- task: "T9 配置化与复盘闭环"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "场景映射表与阈值可在配置中心修改并生效；每日复盘产出采纳率与 Top3 缺口"
```

**契约说明**：T1 由 `intake-router` 承接（路由职责），须调用 `method-dialog-router` 与 `data-particle-read`，读 `intake-router` 记忆（L1-L2，≤3 跳）；T2/T6/T7/T8 由 `decision-agent` 承接；T3／T4／T5 分别由报价、跟进、评审专业 agent 承接；T9 由 `decision-retro` 承接。

### 8.3 契约自检状态

```bash
node scripts/validate-contract.mjs docs/2026-09-08-dialog-driven-decision-advice-design.md --registry src/agent/agentSpec.js
```

- **当前状态**：`valid: false`，仅剩 1 项——T1 的 `method-dialog-router` 尚未注册进 `intake-router.skillCalls`。
- **预期**：T0 完成后复跑应 `valid: true`。该失败是设计顺序导致（契约先写、注册随后），非契约缺陷。

---

## 9. 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| `ADVISED` 状态污染待处置统计 | escalated 计数虚高 | 独立枚举 + 回归断言 `monitorStore` escalated 不变（T5 success 已含） |
| 新 SKILL 缺 `steps[]` 崩溃 | 调用即崩 | T1 实施前先补 `steps[]`，按 `src/skills/registry.js:69` 注释执行 |
| 拦截层拖慢 MCP 响应 | 每次对话多一次链路 | 规则路径 <50ms；LLM 精排仅低置信触发；读通道附加建议可关闭 |
| 建议噪音（每次对话都打扰） | 销售疲劳 | 三档分级：C 档只问缺口，A/B 档才给处置 |
| 坐标判定不准致错误建议 | 误导销售 | 规则优先 + 置信度门控；低置信一律 C 档不出处置 |
| 对话不落库导致无法审计「为什么给这个建议」 | 复盘缺口 | `trigger_context` 存场景/阶段/诉求摘要（结构化），不存原文 |

---

## 10. 非目标（本期不做）

- 不建对话表、不落对话原文（D2）。
- 不自动执行建议（仅 `autonomous_allowed=TRUE` 的 LEAD_FOLLOW_UP／POST_CONTRACT／LOSS_REVIEW／DEAL_REOPEN 可交 autonomyEngine 判定，其余一律 HITL）。
- 不改 `context-routing`（`config_center id36`，禁止修改）。
- 不新增粒子类型、不改业务域模型（多租户架构纯度）。

---

## 闭环回写

| 任务 | 缺口类型 | 观测 | 期望 | 时间 | 级别 |
|---|---|---|---|---|---|
| （实施后由 workbench 写入） | | | | | |
