# 报价政策断链接入 + 需求分级与书面确认（P0 合并设计）

> 设计输入：2026-09-08 对话驱动决策建议设计（§5 已规定"B 档 = 红线 + 必须走审批流 + decision_id"，本设计补全其未落地部分）
> 铁律约束：不新增粒子类型、不改业务域模型（§10 非目标）；写操作经决策第 0 闸 + HITL，绝不自动执行写。

## 0. 现状盘点（源码级证据）

| 已建成 | 证据锚点 | 未被消费处 |
|---|---|---|
| 毛利红线（配置化阈值） | `scenarioAdvisors.js:5` `margin_floor_pct:20`、`:19-24` 红线判定；`adviseService.js:43` 真实调用 | 用**出厂默认 20%**，不从租户取数 |
| 报价商务规则包粒子 | `particleModel.js:166-178` 含 `price_bands/floor`、`margin_redline`、`tier_discount`；seed 已播种（system + jiadian） | 仅被门户 `offerPolicyRender` 消费，决策链路零引用 |
| 价格透视纯函数 | `offerPolicyRender.js:114-147` `resolvePriceBands/costTotal/marginView`，返回 `{cost, marginRate, floor, redline, pass}` | 决策侧重写了一套默认逻辑，未复用 |
| 审批流 action | `seed-actions.js:1267` `crm-approval-start`（`confirm:'critical'`） | `adviceCard.js:75` 只返回 `approval_flow` **字符串**，未提供发起路径 |
| 红线→审批语义 | `adviceCard.js:46/65/75` `tier='B'`、`disposition='ESCALATE'`、`approval_flow:'CRM_APPROVAL_FLOW'` | 同上为字符串，无 `decision_id` 唤起 |
| 需求证据粒子 | `particleModel.js:270-287` `CRM_METHODOLOGY_EVIDENCE`（`subject_id/methodology_id/dim_key/met/evidence_ref/source`） | 无任何"需求分级"维消费；`ROLE_MAP` 无刚需/期望字段（`methodologyExtractor.js:33` 明注"系统无对应字段"）|
| 策略冻结快照 | `policyVersion.js:29-32` `POLICY_KEYS`（7 键）；`:27` 注"增键即改版本语义，预期行为" | 报价授权未入快照，历史判定依据不可追溯 |

**结论**：痛点②④的根因是**断链**（建模已全、决策侧不取数），而非未建模；痛点①缺"需求分级 + 书面确认态"载体，可用现有 `CRM_METHODOLOGY_EVIDENCE` 承载。工作量远小于从零入模。

## 1. 已确认前提（用户决策，不可偏离）

| # | 决策 | 内容 |
|---|---|---|
| D1 | 事实源 | 复用 `CRM_OFFER_POLICY`（基线与毛利红线）+ 新增 config 键 `price-authority`（角色×折扣档位授权矩阵）|
| D2 | 红线行为 | 强提示 + 预填发起参数；**不自动写**，实际发起仍由客户端/销售走 `crm-approval-start`（带 HITL token）|
| D3 | 需求载体 | `CRM_METHODOLOGY_EVIDENCE`（`methodology_id='REQUIREMENT'`）+ 配置化维度清单，零改域模型 |
| D4 | 实施路径 | 方案 A：一份设计、两 Phase、9 任务，分阶段验收 |
| D5 | 快照纳入 | `price-authority` **纳入 `POLICY_KEYS`**（授权是决策依据，须可追溯；版本语义变化为预期行为，见 `policyVersion.js:27`）|
| D6 | 待核实项 | 决策上下文是否携带当前用户角色，实施期确认；缺失则降级为"按折扣档位提示需审批"，不判具体角色 |

## 2. 架构总览

```
对话 utterance
  → intake-router 坐标判定 (scenario × stage)               [T5 采 MUST 级需求证据]
  → followup-agent 跟进域需求采集                             [T5b 采 SHOULD/NICE 级证据]
  → quote-engine 报价事实采集
       ├─ 读租户 active CRM_OFFER_POLICY → offerPolicyFacts.margin/dealPrice   [T2]
       └─ price-authority → discountAuthorityCheck(role, discountRate)          [T1]
  → decision-agent 建议卡三档 + 红线细项 + prefilled(crm-approval-start)        [T3]
       └─ 体检读 CRM_METHODOLOGY_EVIDENCE(REQUIREMENT) 判 MUST 缺口           [T6]
  → review-gate 红线审批终审衔接                             [T8 消费 prefilled 依据]
  → decision-retro 配置化接线 + 复盘可检索案例                                 [T4][T7]
```

**共享纯函数层**：`offerPolicyFacts.js` 抽出自 `offerPolicyRender` 的 `resolvePriceBands/costTotal/marginView`，portal 与 decision 共用，消除重复实现（`offerPolicyRender.js:137-147` 原逻辑迁移，不删原调用点）。

## 3. §1 配置键定义

### 3.1 `price-authority`（租户可覆盖，system 模板；入 `POLICY_KEYS`）

```json
{
  "roles": [
    { "role": "sales_rep", "max_discount_pct": 5,  "requires_approval_above_pct": 5 },
    { "role": "sales_manager", "max_discount_pct": 15, "requires_approval_above_pct": 15 },
    { "role": "sales_director", "max_discount_pct": 30, "requires_approval_above_pct": 30 }
  ],
  "default_max_discount_pct": 5,
  "note": "discountRate 超出角色 max_discount_pct → redline discount_authority_exceeded"
}
```

### 3.2 `requirement-dimensions`（租户/行业可配）

```json
{
  "must":   [ { "dim_key": "budget_approved",   "label": "预算已批",   "evidence_required": true } ],
  "should": [ { "dim_key": "decision_chain",    "label": "决策链明确", "evidence_required": false } ],
  "nice":   [ { "dim_key": "timeline_clear",    "label": "上线窗口",   "evidence_required": false } ]
}
```

每条需求落一行 `CRM_METHODOLOGY_EVIDENCE`：`methodology_id='REQUIREMENT'`、`dim_key=维度键`、`met=是否满足`、`evidence_ref=书面批文附件 id`、`source=manual`。

## 4. §2 坐标判定与消费接线

| 任务 | 接线要点 |
|---|---|
| T1 | 新增 `discountAuthorityCheck(role, discountRate, cfg)`：`discountRate > role.max_discount_pct` → 推 `redlines: discount_authority_exceeded`；缺失 role/cfg 时 fail-open 不阻断 |
| T2 | `gatherQuoteFacts` 改 async；取租户 `subtype=standard` 且 active 的 `CRM_OFFER_POLICY`（商机显式关联优先，否则默认；无则出厂兜底）；调 `offerPolicyFacts.marginView` 得 `pass/floor/redline` |
| T3 | `buildAdviceCard` 红线项补 `gap_value`（如"低于红线 3.2 个百分点 / 超 sales_rep 权限 10 折"）+ `required_approval_flow` + `prefilled:{action:'crm-approval-start', payload:{scenario_id, deal_id, reason, policy_ref}}`；**不调用** `crm-approval-start`，不生成 `decision_id` |
| T4 | 毛利红线来源优先级：租户 `CRM_OFFER_POLICY.margin_redline` > `advisorConfig.margin_floor_pct` > 出厂 20%；`price-authority` 改后 advise 结果随之变化 |
| T5 | `intake-router` 暴露 MUST 级需求采集入口（对话/NL），写入 `CRM_METHODOLOGY_EVIDENCE`；维度清单由 `requirement-dimensions` 驱动 |
| T5b | `followup-agent` 在跟进拜访中采集 SHOULD/NICE 级需求维度（决策链明确、拜访节奏）并写证据；未采集时 `met=null` 不阻断 |
| T6 | 条件体检读 `evidence` 判 `must` 维度：`evidence_ref` 空或 `met≠true` → `requiredMissing` → C 档只补信息（痛点①"预算批文未上传"从实证个案变常态闸门）|
| T7 | 复盘输出 `MUST 未确认数 Top3` 与红线命中率，产出可检索业务案例（非 draft_patches）|
| T8 | `crm-review-gate-approve` 终审读取 `prefilled` 红线依据；无依据或依据与报价不符时拒绝终审，确保审批结论可溯源 |

## 5. §3 任务拆分与生命契约

```contract-yaml
- task: "T1 折扣授权矩阵 price-authority 配置键与判定"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [method-quote-engine, data-particle-read]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "按角色判定折扣是否越权并产出 redline 项 discount_authority_exceeded；未配置时走出厂兜底且 fail-open 不阻断"
- task: "T2 报价事实采集接入租户 CRM_OFFER_POLICY"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [method-quote-engine, data-particle-read]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "QUOTE_PRICING 建议卡的 margin/floor 取自租户 active 政策，与门户 marginView 同价判定一致"
- task: "T3 建议卡红线细项与一键发起参数"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-enrich, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "红线卡含差距数值+required_approval_flow+crm-approval-start 预填参数；系统不自动写、不生成 decision_id"
- task: "T4 政策来源优先级与配置化接线"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "毛利红线优先级=租户政策>advisorConfig>出厂20%；配置中心改 price-authority 后 advise 结果随之变化"
- task: "T5 MUST 级需求维度清单配置化与采集入口"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing, data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "租户可配 MUST/SHOULD/NICE 维度清单；MUST 级采集写入 CRM_METHODOLOGY_EVIDENCE(methodology_id=REQUIREMENT)"
- task: "T5b 跟进域 SHOULD/NICE 级需求维度采集"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine, data-particle-create, crm-asset-attach]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "跟进拜访产出含决策链/拜访节奏 evidence 写入 CRM_METHODOLOGY_EVIDENCE；未采集时 met=null 不阻断"
- task: "T6 书面确认态进入条件体检与闸门"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-enrich, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "MUST 维度缺 evidence_ref 或 met≠true 即判 required 缺口→C档；补传书面批文后转 A/B 档"
- task: "T7 复盘沉淀可检索案例"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "每日复盘输出 MUST 未确认数 Top3 与红线命中率，产出可检索业务案例"
- task: "T8 红线审批终审衔接"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1, L2], maxHops: 4 }
  success: "审批实例可携带红线依据摘要；依据缺失或与报价不符时 review-gate 拒绝终审"
```

**契约说明**：报价类由 `quote-engine` 承接（T1/T2，同键 `ct-quote-calc`），建议卡与体检由 `decision-agent`（T3/T6，同键 `ct-decision`），配置化与复盘由 `decision-retro`（T4/T7，同键 `ct-retro-decision`），需求采集由 `intake-router`（T5）与 `followup-agent`（T5b）分 MUST/SHOULD-NICE 两级，`review-gate` 承接红线审批终审（T8）；全部 skill 属各 agent `skillCalls` 子集，记忆与 L1-L2 层均在既有声明内，无需改 `agentSpec`。

## 6. §4 风险登记

| 风险 | 影响 | 缓解 |
|---|---|---|
| `price-authority` 入 `POLICY_KEYS` 改策略版本语义（所有后续决策解析出新版本，新旧不可比） | 历史决策版本断裂 | 预期行为（D5）；快照已含该键，可追溯"当时生效口径" |
| 政策多包并存（standard/ka/payment）选包歧义 | 取错基线 | 优先级：商机显式关联 > 租户 `subtype=standard` 且 active > 出厂兜底 |
| `price_bands` 自由文本 JSON 解析失败 | 红线误判 | 复用 `resolvePriceBands` 返回 null → fail-open，记 `margin_source:'unknown'`，不计红线 |
| 决策上下文未必携带当前用户角色（D6 待核实） | 权限判定失效 | 实施期确认；缺失则降级"按折扣档位提示需审批"，不判具体角色 |
| `marginView` 迁移至共享层后 portal 行为变化 | 门户透视口径漂移 | 共享层为纯函数，portal 与 decision 同引用；T2 success 含"与门户 marginView 同价判定一致"回归断言 |

## 7. 非目标（本期不做）

- 不新增粒子类型、不改业务域模型（多租户架构纯度）。
- 不自动执行写：红线仅提示 + 预填，发起必须经 `crm-approval-start` HITL token。
- 不改 `context-routing`（`config_center id36`，禁止修改）。
- 不动 `~/.workbuddy/skills/ai-*` 十大能力基线。
- 不建对话表、不落对话原文。

## 闭环回写

| 任务 | 缺口类型 | 观测 | 期望 | 时间 | 级别 |
|---|---|---|---|---|---|
