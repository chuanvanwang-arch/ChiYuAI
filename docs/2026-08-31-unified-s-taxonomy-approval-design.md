# 统一术语 S1-S8 + 分业务审批规则 + AI/人把关矩阵 设计（v2）

> 日期：2026-08-31 · 状态：**DESIGN — 已批准（2026-08-31 用户同意）** · 实施计划：`docs/superpowers/plans/2026-08-31-unified-s-taxonomy-approval-plan.md`
> 方法论基座：`docs/2026-08-29-sales-crm-integration-design-v1-full-layers.md`（CRM 集成设计 v1，全五层）
> 范围：① 统一方法论/数据库/审批流/人机协同 四层术语为 S1-S8；② 落地参考文档的 P1–P6 阶段推进闸（第 3.5 闸）+ 大漏斗 + 21 条；③ 在其上定义分业务审批规则（R1-R4）；④ 明确 AI 判定 vs 人把关；⑤ 并入用户示例规则类型（阶段门禁 / 漏斗转化率 KPI / 分级审批）。

---

## §0 背景与目标

### 0.1 与 CRM 集成设计 v1 的关系

本设计是参考文档 v1 的 **"术语统一 + 审批引擎接线"实现层**，不重复定义方法论：

- 参考文档 v1 的 **P1–P6 阶段模型、第 3.5 闸拓扑、大漏斗、21 条行为合格线** = 方法论内容（事实源）。
- 本设计的 **S1-S8** = 统一代码术语。按用户指令"按 S1-S2 来"，P1-P6 退为**内容别名**，四层（方法论/数据库/审批流/人机协同）一律用 S 码。
- 参考文档 v1 §7 第 3.5 闸已规划：`crm-deal-advance` 等写通道的"阶段推进闸 + 客户节奏 soft + 行为合格检查"。本设计将其**从 P 命名重写为 S 命名并接线到真实引擎**。

### 0.2 现状三套互不映射的术语（根因，已实查）

| # | 术语集 | 落点 | 当前取值 |
|---|---|---|---|
| A | 方法论阶段 | `skills/method-stage-progression/methodology.json:5-12` | `P1`..`P6` |
| B | 数据库存储 | `particleModel.js:11` | `lead/opportunity/quoted/contracted/ordered/paid/lost/disqualified` |
| C | 审批流引用 | `executor.js:178-268` `STAGE_GATES`；`seed.sql:286` `crm.approval_flow` | `P1→P2`；`deal/quote/contract/invoice` |

**后果**：`salesStageGate`（`executor.js:88-109,170-280`，即参考文档的第 3.5 闸）用 `P1→P2` 匹配真实 `payload.stage`（`opportunity` 等）→ **永不匹配 → 闸恒放行**，参考文档规划的 5 条阶段闸沦为死代码。真实生效闸仅 `ruleEngine`（`ruleEngine.js:9-28`：只进不退 + 输单填因）。

### 0.3 目标

1. 单一事实源 S1-S8，四层 100% 一致。
2. DB 纯重命名 `payload.stage` → S1-S8（用户拍板方案 B）。
3. 落地参考文档 5 条阶段推进闸（S 码）+ 大漏斗 + 21 条质检。
4. 分业务审批规则 R1-R4 + AI/人把关矩阵 + 分级审批 + 阶段门禁 + 漏斗 KPI。

---

## §1 统一 S 术语定义（四层一致）

### §1.1 S 阶段定义（S1-S8，含参考文档 P1-P6 内容与 溯源）

| S 码 | 中文 | 旧 A(P1-P6) | 旧 B(存储) | 阶段判定要点（参考 §3） | 溯源 |
|---|---|---|---|---|---|
| **S1** | 线索发掘 | P1 | `lead` | 客户有潜在需求/项目信号，未确认采购行动 | LG-05 |
| **S2** | 需求确认 | P2 | `opportunity` | 已确认需求且我方有初步方案方向 | BH-03-02 |
| **S3** | 方案匹配 | P3 | `quoted` | 方案已验证能解决客户问题（关二） | BH-03-01 |
| **S4** | 报价谈判 | P4 | `contracted` | 已发报价/方案，进入价格与条款博弈 | BN-06 |
| **S5** | 合同确认 | P5 | `ordered` | 合同条款确认、法务/审批通过 | BH-06 |
| **S6** | 赢单移交 | P6 | `paid` | 已签单，移交实施/交付 | LG-07 |
| **S7** | 输单 | — | `lost` | 丢给竞品/无预算（任意阶段可进） | — |
| **S8** | 丢单 | — | `disqualified` | 不合格线索关闭（任意阶段可进） | — |

**单一事实源文件**：新增 `src/sales/stageTaxonomy.js`，导出 `S_STAGES`、`S_ALIAS`（旧→新）、`S_LABEL`、`S_TRANSITIONS`（合法 S→S 边，含退出边）、`S_GATE_DEFS`（§2 五闸内容）。`particleModel.js:11` 的 `flow` 改读此文件；`salesStageGate`、UI、`crm.approval_flow` 全部引用 S 码。

### §1.2 四层术语统一映射

| 层 | 统一前 | 统一后 | 改动落点 |
|---|---|---|---|
| 方法论 | `P1`..`P6` | `S1`..`S6` | `method-stage-progression/*`、大漏斗、21 条 SKILL |
| 数据库 | `lead/.../disqualified` | `S1`..`S8` | `particleModel.js:11`、`seed.sql`、`payload.stage`、所有读取处 |
| 审批流 | `P1→P2`；`deal/quote/contract/invoice` | 触发边 `S2→S3` 等；规则 id `R1-R4` | `executor.js:178-268`、`crm.approval_flow`、`src/approval/*` |
| 人机协同 | 无统一键 | 每审批要点绑 `Sx`+`Ry`+`AI|HUMAN` | §3 矩阵 → 引擎 CONDITION(AI)/APPROVER(人) |

### §1.3 DB 落地策略（纯重命名，方案 B）

- 8 条幂等 `UPDATE ... SET payload = jsonb_set(payload,'{stage}','"S3"') WHERE type='CRM_DEAL' AND payload->>'stage'='quoted';`（无 DELETE）。
- `STAGE_SCENARIO`（`seed-actions.js:159-167`）键改 `S1`..`S8`；UI 下拉（`deal-detail.html`/`S07.schema.js`）改 S 码 + `S_LABEL`。
- 测试断言 `payload.stage==='opportunity'` → `'S2'`；`scripts/seed-approval-demo.mjs` 回归。

---

## §2 阶段推进门控（第 3.5 闸，来自参考文档 §3/§7，映射 S 码）

> 即 `salesStageGate`（`executor.js:88-109`）。参考文档 §7：第 3.5 闸含 ① 阶段推进闸 ② 客户节奏 soft ③ 行为合格检查；**默认 soft（提示不阻断），仅 `crm-deal-advance` 为 hard 且可配置豁免**（参考 §9）。本设计将其从 P 命名重写为 S 命名并接真实引擎。

### §2.1 五条阶段推进闸（核心，S 码）

| 推进边 | 硬条件（参考 §3） | AI 判定（自动） | 人把关 |
|---|---|---|---|
| **S1→S2** | 必须存在客户需求描述（现场 6 问 needs 有实质内容） | 需求字段非空+非笼统 → PASS | 缺失 → 提示补客户需求 |
| **S2→S3** | 必须存在"方案验证拜访"被质检判为有价值（关二） | 关联拜访质检 `visit_value=有价值` → PASS | 无 → 提示先补方案验证拜访 |
| **S3→S4** | 通过 `method-bant` 资质闸（BANTCC 无硬缺口）＋报价引擎已出价 | BANTCC 完整度 ≥ 阈值 + 报价粒子存在 → PASS/FLAG | FLAG（资质缺口）→ 销售经理确认 |
| **S4→S5** | 通过 `method-review-gate` 双闸门（报价复核 + 合同确认） | 报价复核通过 + 合同要素完整 → PASS/FLAG | FLAG（偏离/未复核）→ 法务/VP |
| **S5→S6** | 必须存在合同签署事实（decision 事件 + 合同粒子记录） | 合同粒子/签署事件存在 → PASS | 无 → 硬阻断（用户要求"不能推进"） |

> 阈值（BANTCC 完整度、质检价值阈值等）走 `config_store['sales-thresholds']`（既有模式），不硬编码。

### §2.2 客户节奏 soft gate（大漏斗，参考 §4）

- 目标客户（`CRM_ACCOUNT.account_segment=目标`）本月接触 ≥1 次 → 放行；未达 → **提示（不阻断）**。
- 潜力客户每季 ≥1 次、商机客户按阶段推进需要——节奏规则存 `method-funnel-classification/methodology.json`，由 AI 计算接触频度并提示。

### §2.3 行为合格检查（21 条，参考 §5）

- 近 3 次拜访有质检记录且至少 1 次判"有价值" → 放行；否则提示先补拜访质检。
- 21 条 = 合格线（有/无）事实判定，落 `evaluator.js` `CRM_CONTACT.sales_visit_gaps`，**不设评分阈值**（参考 §9）。

### §2.4 阶段门禁（强制附件，用户示例类型，可配置）

阶段门禁是 §2.1 的**具体实例化**（证据存在性硬闸）。用户示例：

| 门禁 | 触发边 | 强制附件 | AI 判定 | 人把关 |
|---|---|---|---|---|
| G-S3 | `S2→S3` | 客户技术评审通过证明 | 关联证明附件存在性（类型标签）→ 有放行/无硬阻断 | 经理补件后重推；例外留痕 |
| G-S5 | `S4→S5` | 客户内部审批完成截图 | 关联截图附件存在性 → 有放行/无硬阻断 | 同上 |

- **按用户要求硬阻断**（"否则不能推进"），覆盖参考文档 soft 默认——此类门禁显式 hard。
- 附件类型/触发边走配置（可增删），不止于上述两项示例。

---

## §3 分业务审批规则（R1-R4，用户"不同业务审批规则"）+ 分级审批

### §3.1 规则与 S 阶段触发绑定

| 规则 | 业务 | 触发边 | 性质 | 默认审批人 |
|---|---|---|---|---|
| **R1** | 商机推进审批（deal） | `S2→S3` | 单/会签 | 销售经理 |
| **R2** | 报价审批（quote） | `S3→S4` | 折扣超阈值→总监 | 销售经理 / 总监 |
| **R3** | 合同审批（contract） | `S4→S5` | 偏离→法务+VP | 法务 / VP |
| **R4** | 回款/发票审批（invoice） | `S5→S6` | 超信用→财务VP | 财务 VP |

> `crm.approval_flow` 现有 4 行（`seed.sql:286`）改为 R1-R4，触发边字段由业务类型名改为 `from_stage=Sx, to_stage=Sy`。

### §3.2 逐规则审批要点 + AI 判定 vs 人把关矩阵

#### R1 商机推进审批（deal）— S2→S3

| 审批要点 | AI 判定（自动） | 人把关（担责） |
|---|---|---|
| 需求真实性（BANTCC N/T） | 自动打分 ≥ 阈值 → PASS；缺失标记 | FLAG→经理确认；战略客户经理必签 |
| 方案方向合规 | 冲突行业词表扫描 | 例外推进经理留痕 |
| **阶段门禁 G-S3** | 客户技术评审证明存在性（硬门禁） | 经理补件/例外留痕 |

#### R2 报价审批（quote）— S3→S4

| 审批要点 | AI 判定（自动） | 人把关（担责） |
|---|---|---|
| 折扣率 vs 授权线（默认 15%） | ≤ → PASS；> → FLAG | 超阈值 → 销售总监 |
| 毛利率 vs 底线（默认 20%） | ≥ → PASS；< → FLAG | 低毛利 → 总监+VP（战略渗透价） |
| 报价单完整性 | 要素缺失/与方案不一致标注 | — |
| 历史基线比对 | 偏离同客户历史 >2σ 标记 | 异常折扣总监复核 |

#### R3 合同审批（contract）— S4→S5

| 审批要点 | AI 判定（自动） | 人把关（担责） |
|---|---|---|
| 要素完整性 | 缺失要素红字标注 → FLAG | — |
| 模板偏离 | 条款偏离自动标注 | 偏离模板 → 法务 |
| 法务合规 | 合规词库扫描 → FLAG | 合规风险 → 法务+合规 |
| 金额授权 | ≤ 授权 → PASS；> → FLAG | 超授权 → VP |
| **阶段门禁 G-S5** | 客户内部审批截图存在性（硬门禁） | 经理补件/例外留痕 |

#### R4 回款/发票审批（invoice）— S5→S6

| 审批要点 | AI 判定（自动） | 人把关（担责） |
|---|---|---|
| 信用额度 | ≤ 额度 → PASS；> → FLAG | 超信用 → 财务 VP |
| 回款计划 | 与合同账期不一致标注 | 例外账期 → 财务总监 |
| 交付资源 | 资源冲突检测 → FLAG | 冲突 → 交付负责人 |
| 回款健康度 | 坏账风险评分 → FLAG | 高风险 → 财务 VP |

### §3.3 分级审批（金额阈值升级，用户示例类型）

审批人随**金额阈值**逐级升级，映射引擎审批节点数（阈值走 `config_store['approval-thresholds']`）：

| 档位 | 金额区间 | 审批链（引擎节点） | 适用 |
|---|---|---|---|
| T1 | ≤ ¥100万 | 经理单签（1 APPROVER） | R2/R3/R4 |
| T2 | ¥100万–500万 | 经理+总监（2 APPROVER 会签/顺序） | R2/R3/R4 |
| T3 | > ¥500万 或 标记"重大项目" | 经理→总监→总裁（3 APPROVER 顺序签，复用 §5 B1） | R2/R3/R4 |

### §3.4 引擎拓扑（CONDITION=AI，APPROVER=人）

每条规则 = 一个 `CRM_APPROVAL_FLOW`：

```
START → COND{A}（AI 自动校验）→ [PASS] → APP1（人） → END
                                  ↘ [FLAG] → APP2（人，升级） → END
```

- `COND{A}`：AI 判定节点（无人工），`route()` 按校验结果选分支（复用 §5 的 C1）。
- `APP1`：常规审批人；`APP2`：升级审批人（仅 AI FLAG 时进入）。
- 多节点串联（T2/T3）走 §5 的 B1 节点推进。

---

## §4 漏斗转化率考核 KPI（用户示例类型，监控/辅导层，非门禁）

转化率由 **AI 计算**（按 S 段跃迁事件统计），低于健康线**标记预警**，由**人（销售经理）辅导改善**。阈值配置化（`config_store['funnel-kpi']`），出厂默认取自行业基准（）：

| 转化边 | 健康线（≥） | 计算方 | 改善方 |
|---|---|---|---|
| S1→S2 | 60% | AI | 人（经理辅导） |
| S2→S3 | 50% | AI | 人（经理辅导） |
| S3→S4 | 40% | AI | 人（经理辅导） |
| S4→S5 | 70% | AI | 人（经理辅导） |

> 埋点：每次 `advanceStage` 写阶段跃迁事件（复用决策第 0 闸 `requireDecision`），AI 按窗口聚合；看板复用 `sales-behavior-board` / `pipeline` 呈现。

---

## §5 与审批引擎缺口修复的关系（纳入本设计）

第一轮实查发现审批引擎两缺口，本设计一并修复：

- **B1 节点推进状态机**：`advanceTask`（`engine.js:154-167`）一审完即 `APPROVED`，从不推进 `current_node`。修复：抽 `advanceToNextNode(inst, fd, ctx)`，节点签完→`route()` 取下一节点；END/null→`APPROVED`，否则切 `current_node`+生成新任务。R2/R3/R4 多签链（经理→总监→总裁）依赖此修复。
- **C1 条件路由接线**：CONDITION 节点无审批人→`auto_pass` 直接 `APPROVED`（`engine.js:107-115`），`route()` 条件分支永不被触发。修复：抽 `materializeNode(startNode, fd, ctx)` 递归，CONDITION 按 `route()` 求值选分支后递归进入目标节点（带 visited 环保护）。§3.4 的 AI 判定节点（COND{A}）正是 CONDITION 节点，由此真正生效。

---

## §6 实施任务拆解 + 生命契约

```contract-yaml
- task: "T1 单一事实源 stageTaxonomy.js（含 GATE_DEFS）"
  agent: review-gate
  skills: [method-stage-progression, method-funnel-classification, method-behavior-standard, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "S_STAGES/S_ALIAS/S_LABEL/S_TRANSITIONS/S_GATE_DEFS 导出；particleModel.js:11 改读；四层引用 S 码"
```
```contract-yaml
- task: "T2 DB 纯重命名迁移（S1-S8）"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "8 条幂等 UPDATE 旧值→S1-S8；seed.sql/STAGE_SCENARIO/UI 同步；无 DELETE"
```
```contract-yaml
- task: "T3 方法论 SKILL 改 S 码"
  agent: review-gate
  skills: [method-stage-progression, method-funnel-classification, method-behavior-standard]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "method-stage-progression/methodology.json+stages.md+gates.md 全 P1-P6→S1-S6；大漏斗/21 条同步；advance_gate 对齐 S 边"
```
```contract-yaml
- task: "T4 第3.5闸接线（五闸+节奏+21条，死代码激活）"
  agent: review-gate
  skills: [method-stage-progression, method-funnel-classification, method-behavior-standard, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "salesStageGate 用 S 码匹配真实 payload.stage；S1→S2..S5→S6 五闸按 §2.1 触发；默认 soft、crm-deal-advance hard、可豁免；大漏斗节奏+21条质检接入"
```
```contract-yaml
- task: "T5 审批规则 R1-R4 + 引擎 CONDITION/APPROVER 拓扑"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "crm.approval_flow 4 行改 R1-R4 带 from/to_stage；每条 = START→COND(AI)→APP1/APP2(人)；阈值走 config_store"
```
```contract-yaml
- task: "T6 B1 节点推进 + C1 条件路由（引擎缺口修复）"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "三节点顺序流末节点签完才 APPROVED；含 CONDITION 流按 ctx 走分支不再 auto_pass"
```
```contract-yaml
- task: "T7 阶段门禁 + 漏斗KPI + 分级审批接线"
  agent: review-gate
  skills: [method-stage-progression, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "salesStageGate 增 required_attachments(G-S3/G-S5)硬门禁；funnel-kpi 埋点+看板预警(S1→S2≥60%等)；R2/R3/R4 按金额 T1/T2/T3 生成节点数；阈值全走 config_store"
```
```contract-yaml
- task: "T8 迁移脚本 + 全链路回归"
  agent: review-gate
  skills: [data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 1 }
  success: "scripts/seed-approval-demo.mjs 扩展：S 码种子 + R1-R4 模拟 + 五闸/门禁/分级/漏斗 用例；全绿可重跑"
```

---

## §7 迁移与回归方案

1. **顺序**：T1→T2→T3→T4→T5→T6→T7→T8。
2. **幂等**：所有 UPDATE / `ON CONFLICT DO NOTHING` 固定 UUID；可重跑。
3. **零信任**：仅追加/更新，无 DELETE；生产库 `plm` 迁移前先 `pg_dump` 备份。
4. **回归基线**：现有 `scripts/seed-approval-demo.mjs` 16/16 须保留；新增 S 码、R1-R4、五闸、门禁、分级、漏斗用例。
5. **回滚**：`S_ALIAS` 留存旧值映射，必要时反向 `jsonb_set` 回退。

---

## §8 风险与边界（对齐参考文档 §9）

- **不污染 ai-* 基线**：实例化只落 `skills/method-*` / `docs/`，`grep -r "\|BANTCC\|sales_" ~/.workbuddy/skills/ai-*` 应为空。
- **闸误杀风险**：第 3.5 闸默认 soft（提示不阻断），hard 仅 `crm-deal-advance` 且可配置豁免；阶段门禁 G-S3/G-S5 按用户要求显式 hard。
- **阶段门禁例外**：G-S3/G-S5 硬阻断默认不可绕过；经理例外放行须留痕（决策第 0 闸），禁静默跳过。
- **不重复建闸**：stage-progression 是"阶段判定"，复用第 3.5 闸做推进拦截；不新增独立闸链。
- **L4/L5 不入闸**：底层逻辑与规范项目只作知识注入/看板，不产生执行闸。
- **21 条不设评分**：合格线（有/无）判定，量化分层留给 calibration。
- **审批引擎与配置型仍两套实现**：本设计让两者共用 S 码触发键与同一 R1-R4 规则定义，但配置型（简单 stages）与粒子驱动（完整拓扑）仍并存；彻底合并属更大重构，本期不纳入。
