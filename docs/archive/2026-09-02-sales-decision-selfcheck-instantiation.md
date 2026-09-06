> ⛔ **已合并 / 已归档（2026-09-02）**
> 本文已并入 **`docs/2026-09-02-cognitive-decision-unified-design.md`**（认知驱动决策子系统 · 统一设计 v3）。
> 本文**仅作历史留档**，一切以合并文档为准。重评修正点：①§4 `required_dims` 初值与 KMD 规格冲突，已按三原则统一裁定（见合并文档 §7.2）②§3.4 计划新增 `stage_code` 未注意表内**已有 `stage` 列**（中文显示标签，`sevenDimRender.js:67` 消费）→ 保留 `stage` 另加 `stage_code` ③实施顺序重排（T2 提前至 P1-B4，且依赖 P-1 供给层复通）。
> §2.3 的 `STAGE_SCENARIO` 错位修复**已完成并验证**，不重复实施。

# 2B 销售决策自检框架 · 领域实例化设计

> 输入文档：`# 2B销售全流程决策自检框架.txt`（用户提供，2026-09-02）
> 上游设计：`docs/2026-09-02-cognitive-architecture-redesign.md`（**v2 三层 K-M-D × 九尺子内嵌 × 闭环回流**）
> 本文件定位：**把上游的跨域方法论落到 2B 销售领域**，给出阶段对齐、聚焦矩阵、字段设计、接口与实施路线。
> 状态：**设计阶段，未实施**（除 §2.3 的 P0 缺陷修复，属 bug 修复豁免）

---

## §0 执行摘要

这份文档补上了上游设计缺的**最后一块：领域语义**。上游 v2 只回答了"系统该有哪三层、哪九把尺子内嵌到决策过程、哪三条腿闭环回流"，没回答"2B 销售的每个阶段该用哪几把尺子、每项要素该长什么样"。

四句话说清本轮结论：

1. **文档七阶段与平台 S1–S8 几乎 1:1 对齐**——对齐过程照出一个 P0 真缺陷：`STAGE_SCENARIO` 自 S3 起整体错位一格，导致方案阶段决策全被记成报价决策、丢单决策退回机会评估（**已修复并验证**）。
2. **文档给出了"阶段化聚焦矩阵"**——每阶段只需重点核查 2–4 个要素、2–4 把尺子。这把"九尺子平权打分"变成"按阶段加权打分"，同时**反推出 12 个场景的 `required_dims` 初值**（回答上游遗留问题 Q1）。
3. **文档第四部分的"决策三件套"暴露一个新缺口**——平台有结论（disposition），但**没有风险清单、没有止损条件**，而 `QUOTE_PRICING` / `SIGN_RISK` 两个场景的方法论里已经挂着 `STOP_LOSS` 却无字段承载。
4. **v2 同步修订**：上游 v1 的"T 思维层独立 / R 评判层独立"被本轮用户明确否决——八要素并入 D 作为内涵、九尺子并入 D 作为内嵌检查（产物是错误归因 chip，截图样式）；闭环新增三条腿（复盘 / 后见之明 / 证实性偏差）。本设计的所有"思维层 T / T 层物化"等措辞在 v2 修订中已统一改为"D 层 / D 层物化"。

---

## §1 文档五部分拆解：各自贡献什么

| 文档部分 | 内容 | 对平台的贡献 | 平台现状 |
|---|---|---|---|
| 第一部分 | 8 要素 × 销售决策自检提问（通用模板） | 每要素的**领域提问句式**，可直接变成 UI 占位提示与 LLM 提示词 | ❌ 无，D 层字段待建 |
| 第二部分 | 9 尺子 × 销售场景自检问题 + **风险提示（常见销售坑）** | 每把尺子的**领域判据语句**——"客户说价格贵只看表面"这类坑，是评分器的反面样本库 | ❌ 无任何评分器 |
| 第三部分 | **七阶段各阶段的要素重点 + 尺子重点** | ⭐ **阶段化聚焦矩阵**（本设计 §3），解决"九尺子何时该加权" | ❌ 无，`required_dims` 全空 |
| 第四部分 | 决策输出**三件套**（结论 / 风险清单 / 止损条件）+ 事后复盘 | ⭐ 新增两个字段 + 复盘闭环（本设计 §5、§7） | ⚠️ 有结论，缺风险清单与止损 |
| 第五部分 | 极简自检卡 7 问 | ⭐ 现场快速自测 UI（本设计 §6） | ❌ 无 |

**术语统一**：文档第二部分标题行第 4 把尺子作"相关性"，展开段落亦为"相关性"；上游架构文档 §6.2 误写为"关联性"。**统一采用"相关性"**，上游文档同步修正。

---

## §2 七阶段对齐：文档阶段 ↔ 平台 S 码 ↔ 决策场景

### 2.1 对齐结果

平台阶段编码来自 `src/sales/stageTaxonomy.js:5-9` 单一事实源（S1 线索发掘 / S2 需求确认 / S3 方案匹配 / S4 报价谈判 / S5 合同确认 / S6 赢单移交 / S7 输单 / S8 丢单）。

| 文档阶段 | 平台阶段 | 决策场景 | 场景已有方法论 |
|---|---|---|---|
| 阶段1 线索 | S1 线索发掘 | `LEAD_FOLLOW_UP` | BANT, MEDDICC, OPP_MATRIX |
| 阶段2 机会评估 | S2 需求确认 | `OPP_QUALIFY` | MEDDICC, OPP_MATRIX, ROLE_MAP |
| 阶段3 方案与竞争 | S3 方案匹配 | `SOLUTION_VALUE` | OPP_MATRIX, RISK_TRADEOFF |
| 阶段4 商务谈判报价 | S4 报价谈判 | `QUOTE_PRICING` | RISK_TRADEOFF, STOP_LOSS |
| 阶段5 签单前风险 | S5 合同确认 | `SIGN_RISK` | RISK_TRADEOFF, STOP_LOSS |
| 阶段6 交付回款续约 | S6 赢单移交 | `POST_CONTRACT` | RISK_TRADEOFF, OPP_MATRIX |
| 阶段7 丢单/停滞 | S7 输单 / S8 丢单 | `LOSS_REVIEW` | FACT_VS_TALK, OPP_MATRIX |

**跨阶段场景**：`CLIENT_STRATEGY`（ROLE_MAP / FACT_VS_TALK / MEDDICC）——文档阶段2 的"视角：覆盖客户内部支持者、反对者、把关人、决策者"，本设计绑定为 **S2 的并行场景**，不走阶段推进自动触发（由客户角色策略页人工发起）。

**治理类场景**（非销售业务）：`ATTR_SCHEMA_CHANGE` / `CALIBRATION_CHANGE` / `EXTERNAL_ENRICHMENT` / `TRACE_DBG_SCEN` —— 不绑阶段、不设聚焦矩阵、不参与业务质量评分。判定依据：**有无 `stage_code`**。

### 2.2 语义自洽性交叉验证

错位判定不是靠语义直觉，有两处硬证据：

- `stageTaxonomy.js:39-45` 的闸门定义：`S3→S4` 是 `bantcc_quote`（报价口径）、`S4→S5` 是 `review_contract`（合同评审）。按闸门语义，推进到 **S5** 时应产生的是**合同/签前风险**决策（`SIGN_RISK`），而旧映射给 S5 的是 `POST_CONTRACT`（签约后）——**语义相反**。
- 生产库实测（`crm_native`，2026-09-02）：`decision` 表场景分布中 `SOLUTION_VALUE` / `CLIENT_STRATEGY` / `POST_CONTRACT` **均为 0 行**，而 `OPP_QUALIFY` 5 行、`QUOTE_PRICING` 2 行——与"方案阶段被记成报价阶段"的错位后果吻合。

### 2.3 P0 缺陷与修复（**已完成**）

**缺陷**：`src/action/seed-actions.js:31-34` 的 `STAGE_SCENARIO` 自 S3 起整体错位一格，且缺 S8 键。

```js
// 修复前
{ S1:'LEAD_FOLLOW_UP', S2:'OPP_QUALIFY', S3:'QUOTE_PRICING',
  S4:'SIGN_RISK', S5:'POST_CONTRACT', S6:'POST_CONTRACT', S7:'LOSS_REVIEW' }  // 无 S8
```

**后果**（三条，均为可观测）：
1. S3 方案匹配阶段的推进，决策被记成 `QUOTE_PRICING`（报价定价）→ `SOLUTION_VALUE` 场景**从未被任何阶段触发过**。
2. S8 丢单缺键 → `seed-actions.js:554` 的 `|| 'OPP_QUALIFY'` 兜底生效，**丢单被记成机会评估决策**。
3. S5、S6 同为 `POST_CONTRACT`，签前风险判断无独立场景承载。

**修复**（`src/action/seed-actions.js:29-38`）：

```js
const STAGE_SCENARIO = {
  S1: 'LEAD_FOLLOW_UP', S2: 'OPP_QUALIFY', S3: 'SOLUTION_VALUE',
  S4: 'QUOTE_PRICING', S5: 'SIGN_RISK', S6: 'POST_CONTRACT',
  S7: 'LOSS_REVIEW', S8: 'LOSS_REVIEW',
};
```

**验证**（`tmp/verify-stage-fix.mjs`，只读生产库）：8/8 阶段全部命中 `decision_scenario` 中已存在的有效场景，无 fallback；7 个业务场景全部被阶段触发。
**回归**：`test/action.test.js` + `test/stage-config.test.js` + `test/decision.test.js` → **47/47 全绿**。

> 遗留（非缺陷，纳入 T2）：`STAGE_SCENARIO` 目前是 `seed-actions.js` 的模块私有常量，而阶段语义的单一事实源在 `stageTaxonomy.js`。T2 将其**上移到 `stageTaxonomy.js`** 并 export，消除第二套命名（对齐 `stageTaxonomy.js:1-3` 文件头声明）。

---

## §3 阶段化聚焦矩阵（本设计核心）

文档第三部分为每个阶段指定了**要素重点**与**尺子重点**。这是平台此前完全缺失的一层知识。

### 3.1 八要素 × 七阶段

| 要素 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | 合计 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 目的 | ● | | ● | | | ● | | 3 |
| 问题 | | ● | | | ● | | | 2 |
| 信息 | ● | | | | ● | | | 2 |
| 概念 | | | ● | | | | | 1 |
| 假设 | ● | | ● | ● | | ● | | 4 |
| 推论 | | | | | | | | **0** |
| 视角 | | ● | | ● | | | ● | 3 |
| 意涵 | | ● | | ● | ● | | ● | 4 |

### 3.2 九尺子 × 七阶段

| 尺子 | S1 | S2 | S3 | S4 | S5 | S6 | S7 | 合计 |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| 清晰性 | | | | ● | | ● | | 2 |
| 准确性 | ● | ● | | | | | | 2 |
| 精确性 | ● | | | ● | | | | 2 |
| 相关性 | | | ● | | | | | 1 |
| 深度 | | | ● | | | | ● | 2 |
| 广度 | | ● | | | ● | | | 2 |
| 逻辑性 | | ● | | ● | | ● | | 3 |
| 重要性 | ● | | ● | | | | ● | 3 |
| 公平性 | | ● | | | ● | | | 2 |

### 3.3 三个可直接落地的推论

**推论 A —— 假设是第一要素。** 八要素中"假设"被 4 个阶段列为核心（S1/S3/S4/S6），频率最高。这与上游审计"假设完全缺失是最大缺口"的判断**相互印证**。→ D 层 `assumptions` 列优先级最高。

**推论 B —— 推论是通用项，不是阶段项。** "推论"在七阶段清单中一次都没被列为重点，但出现在第五部分极简卡第 3 问（"我的推论是否证据足够？有没有脑补？"）。判定：**推论不参与阶段加权，作为全阶段必评的基础项**（与"信息"同层级——信息也只在 S1/S5 显式列出，但显然是全阶段基础）。
→ 评分模型分三档：**基础项（信息、推论，全阶段必评）+ 阶段重点项（加权 ×1.5）+ 其余项（×1.0，仍评但不加权）**。

**推论 C —— 尺子覆盖不均，需"补盲"提示。** `相关性` 只在 S3、`概念` 只在 S3、`深度` 只在 S3/S7 被强调。若严格按加权，S1/S5 的深度就无人管。→ 加权**不等于豁免**：聚焦项权重 ×1.5，非聚焦项仍按 ×1.0 计入总分，不做归零。

### 3.4 存储：单一事实源在场景表，不走 config_store

聚焦矩阵与必填维**落在 `crm.decision_scenario`**，不新增 config_store 项——避免双源。

| 新增列 | 类型 | 说明 |
|---|---|---|
| `stage_code` | TEXT | 绑定阶段（S1–S8）；治理类场景为 `NULL`（判定业务/治理的唯一依据） |
| `focus_elements` | TEXT[] | 聚焦八要素，取值域见 §3.5 |
| `focus_rulers` | TEXT[] | 聚焦九尺子 |

`required_dims` 列**已存在**（当前 12 场景全为空），T2 回填，不新建。

`config_store` 只存**权重与及格线**两类可调数值（`rubric-weights` / `rubric-thresholds`），守阈值配置化铁律。

### 3.5 取值域（必须与代码常量同源）

```
八要素：purpose, question, information, concepts, assumptions, inference, viewpoints, implications
九尺子：clarity, accuracy, precision, relevance, depth, breadth, logic, significance, fairness
七轴维：identity, structure, semantics, time_config, decision_history, operational_state, governance
```

单一事实源落在新文件 `src/decision/rubricSpec.js`，与 `src/sevenDimensions/constants.js`、`src/decision/edgeDimensionSpec.js` 同级；**禁止在 SQL、HTML、配置里散落字面量**。

---

## §4 `required_dims` 初值推导（回答上游 Q1）

上游 §4.1 指出 12 个场景 `required_dims` 全空 → 七维拦截从未触发。本设计用**阶段聚焦要素 → 七轴维度**的推导链给出初值。

**推导规则**（可审计，非拍脑袋）：

| 文档强调的要素/尺子 | 推导出的必填维 | 依据 |
|---|---|---|
| 信息：客户业务、组织角色、竞争情报 | `identity`, `semantics`, `structure` | 主体是谁 / 什么业务 / 组织长什么样 |
| 视角：客户内部支持者、反对者、把关人、决策者 | `structure`, `operational_state` | 角色结构 + 当前态度 |
| 精确性：预算区间、决策人、项目时间、异议点 | `time_config`, `operational_state` | 时间参数 + 运行态事实 |
| 意涵与后果：烂尾、回款失败、连锁影响 | `operational_state`, `governance` | 运营风险 + 治理约束 |
| 深度/相关性：表象背后原因、客户选型标准 | `semantics`, `decision_history` | 语义 + 历史先例 |
| 复盘/丢单：未来预算、痛点、内线资源 | `decision_history`, `semantics` | 历史 + 语义 |

**初值表**（`on_missing` 先全设 `warn`，不阻断——守"修复不放大约束"教训）：

| 场景 | 阶段 | `required_dims` | 推导来源 |
|---|---|---|---|
| `LEAD_FOLLOW_UP` | S1 | `identity, structure, semantics, time_config` | 信息（客户业务/组织角色）+ 精确性（决策人/项目时间） |
| `OPP_QUALIFY` | S2 | `identity, structure, decision_history, operational_state` | 视角（四类角色）+ 问题（赢率→先例）+ 准确性 |
| `SOLUTION_VALUE` | S3 | `semantics, structure, decision_history` | 概念（刚需/期望/锦上添花）+ 深度 + 相关性 |
| `QUOTE_PRICING` | S4 | `semantics, time_config, operational_state, governance` | 精确性（预算/时间）+ 视角（毛利/法务/交付）+ 清晰性 |
| `SIGN_RISK` | S5 | `structure, operational_state, governance, decision_history` | 信息（反对者/交付/验收/预算审批）+ 广度 + 公平性 |
| `POST_CONTRACT` | S6 | `time_config, operational_state, governance` | 清晰性（合同内外边界）+ 逻辑性（回款节点） |
| `LOSS_REVIEW` | S7/S8 | `decision_history, semantics, operational_state` | 深度（未来预算/痛点/内线）+ 重要性 |
| `CLIENT_STRATEGY` | —（绑 S2） | `structure, operational_state` | 视角（客户内部角色地图） |
| 治理类 4 场景 | — | `[]`（保持空） | 非业务场景，不参与七维拦截 |

**纪律**：初值由 AI 按语义推导，**标注"待业务复核"**；`on_missing` 全部先设 `warn`（不阻断），跑满一个评分周期后按 P2 阶段用真实数据校准（对应用户 2026-08-30 明确的阈值配置化铁律 + 2026-09-01 "修缺陷不放大约束"教训）。

---

## §5 决策三件套 → D 层新增字段

文档第四部分第 4 步要求每次决策输出三件套。逐项对照：

| 三件套 | 平台现状 | 本设计 |
|---|---|---|
| ① 决策结论 | ✅ `disposition` + `rationale` | 不新增；`rationale` 保留为自由文本 |
| ② 关键风险清单 | ❌ 无 | **新增 `risk_register` JSONB** |
| ③ 止损条件 | ❌ 无（`QUOTE_PRICING`/`SIGN_RISK` 的 `methodology_ids` 已挂 `STOP_LOSS` 却无字段承载） | **新增 `stop_loss` JSONB** |

**v2 修订**：本节标题从原"决策三件套 → 新增字段"改为"决策三件套 → **D 层**新增字段"。八要素是 D 决策的内涵结构，不是 T 独立层（用户本轮明确）。

### 5.1 `crm.decision` 新增列（8 个 JSONB = D 层内涵）

| 列名 | 承载 | 结构 |
|---|---|---|
| `intent` | 目的 + 问题 | `{ purpose, hidden_goal, question, sub_questions[] }` |
| `assumptions` | 假设 | `[{ id, text, basis, falsifiable_by, risk_if_wrong }]` |
| `inference` | 推论 | `{ chain: [{ evidence, via_assumption, conclusion }], conclusion }` |
| `viewpoints` | 视角 | `[{ stance, holder, covered }]`——**单独建列**（上游 Q2，视角是一等公民，并入 inference 会丢） |
| `implications` | 意涵与后果 | `[{ type: positive/negative, text, probability, mitigation }]` |
| `risk_register` | 风险清单 | `[{ risk, severity: high/mid/low, evidence, mitigation, owner }]` |
| `stop_loss` | 止损条件 | `{ condition, deadline, trigger, owner, status: armed/triggered/released }` |
| `rubric` | 九尺子评分物化（**v2：内嵌决策过程的产物**） | `{ scores: {clarity:..}, weighted_total, level, degraded[], scored_at }` |

**不新增列**（复用既有）：信息 → `conditions_evaluated` + 上下文快照；概念 → `methodology_ids`。

**v2 修订**：上一版把 `rubric` 当作"R 评判层独立物化"；v2 修订为"九尺子**内嵌 D 决策过程**的产物"——`rubric` 列与八要素列同级，作为 D 决策生成时同步产出的内容（不是事后独立评分）。

### 5.2 迁移纪律（**踩坑铁律，必须遵守**）

> **禁止**把新列写进 `db/schema.sql` 的 `CREATE TABLE IF NOT EXISTS crm.decision (...)` 段内——旧库表已存在时**不会补列**，随后依赖该列的索引会让**整文件单事务的 `db/migrate.js` 全量回滚**（2026-08-31 生产库实测 `column "stable_key" does not exist`）。
> **必须**在 `db/migrate.js` 向后兼容段追加独立 `ALTER TABLE crm.decision ADD COLUMN IF NOT EXISTS ...`（既有 `skill_registry.updated_by`、`particles.stable_key` 同模式）。
> `decision_scenario` 的 3 个新列同理。

### 5.3 写入口径

- 写入点：`createDecision`（`src/decision/decisionRepo.js:44`）主干内，与 `assembleContextV2` 调用同级，**fail-open**（物化失败仅 `emit trace` + `recordFailure`，不阻断决策）。
- 空值策略：允许 `null`，九尺子评分时"无证据"计 0 分——**不静默、不用默认值美化**（反假绿铁律）。
- 补齐通道：`POST /api/decision/:id/thinking` 人工补录，**不 DELETE、不覆盖**，append 到 `decision_provenance` 留痕。

### 5.4 九尺子内嵌决策过程（**v2 修订**）

| 旧设计（v1） | 新设计（v2） |
|---|---|
| 九尺子是 R 独立层，与 T 八要素平级 | 九尺子是 D 决策生成时的**内嵌检查**，产物为错误归因 chip + 评分 |
| 监控台单独开"评判视图" | 监控台 chip 直接落在场景列表（截图样式：`输入不及时 1` / `维度不对 1` / `先例污染 1` / `字段不一致 1` / `边选择不对 1`） |
| 评分时机：决策生成后 | 评分时机：**决策生成同步触发** |

**评分器组成**：
- 确定性 6 项：精确性（3）、深度（4）、相关性（5）、逻辑性（6）、重要性（7）、广度（8）→ 纯规则计算，零 token
- LLM 3 项：清晰性（1）、准确性（2）、公平性（9）→ 走 `src/llm/client.js`，配置开关控制，默认关闭
- 降级纪律：LLM 不可用 → `degraded=true` + 该项标 `warn`，**不阻断、不静默、不用假分填充**

**chip 聚合规则**（场景级）：
```
场景 S 下的所有决策 rubric 评分 → 按尺子分组 → 同 chip 类合并计数
例：S4 QUOTE_PRICING 下 2 个决策
  - D1：精确性 1 分 → chip "条件粗略" 1
  - D2：相关性 2 分 → chip "必填缺 1" 1、相关性 1 分 → chip "维度不对" 1
  → 场景列表显示：条件粗略 1 / 必填缺 1 / 维度不对 1
```

---

## §6 极简自检卡：7 问 → 读模型，不新增列

文档第五部分 7 问逐一映射到已设计的字段，**不新增任何列**——做成读模型：

| # | 卡片提问（文档原文） | 数据源 | 判定 |
|---|---|---|---|
| 1 | 我真实目标是什么？核心要解决什么问题？ | `intent.purpose` + `intent.question` | 两者非空 → pass |
| 2 | 信息来源可靠完整吗？哪些是事实，哪些是假设？ | `conditions_evaluated`（事实）+ `assumptions`（假设） | 有假设台账且标注 `basis` → pass |
| 3 | 我的推论是否证据足够？有没有脑补？ | `inference.chain` | 每条 conclusion 有 evidence + via_assumption → pass |
| 4 | 我看到了哪些视角？漏掉了谁？ | `viewpoints` | ≥3 个 stance 且含反方 → pass |
| 5 | 这么做会带来什么连锁后果风险？ | `implications` | 含 negative 且带 mitigation → pass |
| 6 | 9 把尺子快扫 | `rubric.scores` | 加权总分 ≥ 及格线 → pass |
| 7 | 风险是什么？止损点在哪里？ | `risk_register` + `stop_loss` | 止损已 `armed` 且带 deadline → pass |

接口：`GET /api/decision/:id/selfcheck`（只读，返回 7 问 × pass/warn/fail + 证据指针）。
UI：监控台决策详情抽屉内新增"自检卡"折叠区，复用 `common.css` 的 `.panel/.sect` 类与 `tokens.css` 语义变量（UI 一致性铁律，**零硬编码色值**）。

---

## §7 闭环回流：决策改写 K + M（三条腿）

**v2 修订**：本节标题从原"复盘闭环：接上游 I6 学习回写"扩为"闭环回流：决策改写 K + M（三条腿）"。v1 只设计了 I6 处方回写，v2 补全三条腿（用户本轮明确："决策反过来改写记忆与知识"——成功强化 / failure 改写 / 复盘生成新知识）。

文档第四部分第 5 步 + 认知文档「决策结果反馈 → 更新记忆与知识」+ 用户本轮强调「决策结果会重塑我们对过去记忆的解读」「决策的复盘，会生成新的知识」。

### 7.1 第一条腿：I4 复盘 → 新知识生成（D→K）

**触发链**：

```
决策 outcome 落地（业务结果回写）
   ↓
定时或批量触发 retro（`src/decision/retro.js`）
   ↓
回看当初目的 / 信息 / 假设 / 推论
   ↓
找出错误假设与缺失信息
   ↓
写 decision_provenance.entry_type='RETRO'
   ├─ assumption_review: [{ assumption_id, verdict: held|falsified, evidence }]
   ├─ missing_information: [{ dim, what, would_have_changed }]
   ├─ conclusion_quality: 'as_expected' | 'better' | 'worse'
   └─ knowledge_update: [{ target, patch }]  ← 提案，不直接生效
   ↓
若 assumption_review 中出现 falsified → 自动登记为反面先例
   写 decision_precedent_rel(decision_id, precedent_id, negative_precedent=true)
   供九尺子 9 公平性 / 4 深度 在决策生成时检索反面证据
```

**落库策略：写 `decision_provenance`，不新增列**（append-only 留痕，天然满足"禁 DELETE + 可追溯"）。

**与 I7 的边界**：本条腿**只生成知识更新提案**，必须经 I7 处方批准流程（`src/calibration/*`，走 createDecision 真实决策行 `CALIBRATION_CHANGE`）才落到 `decision_scenario`——**AI 不直接改生产配置**。

### 7.2 第二条腿：I5 后见之明 → 改写记忆（D→M）

用户本轮强调：「成功了，就强化原有经验记忆；失败了，会重新改写对当时场景的记忆」。

**机制**：

| 决策结果 | 改写动作 | 写入位置 |
|---|---|---|
| 成功 (outcome=success) | 强化原记忆 tag | `memory_log.kind='HINDSIGHT_BOOST'` + `particles.tag += [verified]` |
| 失败 (outcome=failure) | 改写场景记忆 tag | `memory_log.kind='HINDSIGHT_REWRITE'` + `particles.tag += [rewritten:hindsight]` |
| 推翻（信息不实）| 标注存疑 | `memory_log.kind='HINDSIGHT_QUESTION'` + `particles.tag += [questioned:hindsight]` |

**纪律**：
- tag 改写**append 到 `tag_history`**，原 tag 不删除
- 检索时按 tag 时间加权（`weight = recency × boost_factor`），让新 tag 自然浮现
- 写时向量化时携带新 tag，**让检索自然加权**

**与 B4（记忆只有单层）的关系**：I5 落地后会驱动 L-User / L-Org 分层——同一决策的改写在 L-Workspace 是工作流、L-User 是个人偏好、L-Org 是组织模式。

### 7.3 第三条腿：I6 证实性偏差 → 一致性校验（D→D）

用户本轮强调：「决策的复盘，会生成新的知识，存入长期记忆，成为下一次决策的输入」。

**机制**：

```
决策时：记录 decision.disposition + decision.inference
   ↓
（时间推移，外部事实变化）
   ↓
复盘时：回看同一决策，产出新判定
   ↓
比对：决策时 vs 回看时 是否一致？
   ├─ 一致 → 写 decision_provenance.entry_type='HINDSIGHT_CHECK', verdict='consistent'
   └─ 不一致 → 写 decision_provenance.entry_type='HINDSIGHT_CHECK',
                payload={decision_disposition, retro_disposition, deviation_cause}
   ↓
偏差率 > 阈值（30%）→ 自动生成 calibration_patch 处方
   ├─ 偏差来源：八要素哪一项被高估 / 低估？
   ├─ 提案：required_dims 调整 / 聚焦矩阵修订 / 根因分类扩码
   └─ 待 I7 审批
```

**新知识生成**：偏差本身沉淀为场景知识（如 `required_dims` 加一项 `operational_state`），成为下次决策的输入——**闭环回路的最后一步**。

### 7.4 三条腿的统一纪律

| 纪律 | 说明 |
|---|---|
| append-only | 所有写入不 DELETE、不覆盖；改写走 `tag_history`、补录走 provenance |
| 失败降级留痕 | 任何腿触发失败 → `decision_provenance.entry_type='RETRO_FAILURE'` + emit trace |
| 反假绿 | 没有真实 outcome → 不触发 I4/I5/I6（避免空复盘污染） |
| 反 AI 编造 | 知识更新提案 ≠ 直接生效；必须经 I7 处方审批 |

### 7.5 I6（旧称）回写：处方生成与批准链（P2）

> 此段对应上游架构文档 §4.5 I7。本节沿用"§7 I6 回写"作为承接原 v1 标题的副节，实际接口编号已统一为 **I7 知识回写**。

`knowledge_update` 中的 patch **只生成 `calibration_patch` 处方**，必须经处方批准流程（`src/calibration/*`，走 createDecision 真实决策行 `CALIBRATION_CHANGE`）才落到 `decision_scenario`——**AI 不直接改生产配置**。

---

## §8 数据模型变更汇总

### 8.1 `crm.decision_scenario` 新增 3 列 + 回填

```sql
ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS stage_code       TEXT;
ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS focus_elements   TEXT[];
ALTER TABLE crm.decision_scenario ADD COLUMN IF NOT EXISTS focus_rulers     TEXT[];
```

回填 12 场景的 `stage_code` / `focus_elements` / `focus_rulers` / `required_dims`（值见 §3.1、§3.2、§4）。

### 8.2 `crm.decision` 新增 8 列

见 §5.1，8 个 JSONB，逐个独立 `ADD COLUMN IF NOT EXISTS`。

### 8.3 新表 `crm.decision_rubric_score`（append-only）

```sql
CREATE TABLE IF NOT EXISTS crm.decision_rubric_score (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  decision_id   UUID NOT NULL,
  rubric_key    TEXT NOT NULL,
  score         SMALLINT NOT NULL,
  max_score     SMALLINT NOT NULL DEFAULT 4,
  level         TEXT NOT NULL,
  weight        NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  evidence      JSONB,
  scorer        TEXT NOT NULL,
  degraded      BOOLEAN NOT NULL DEFAULT false,
  scored_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

每次重评**新增一行**，不 UPDATE、不 DELETE。

### 8.4 `config_store` 新增 2 项

| key | 内容 | 默认建议值 |
|---|---|---|
| `rubric-thresholds` | 九尺子及格线 + 加权总分及格线 | 单尺子 2/4 及格，加权总分 ≥ 2.5 |
| `rubric-weights` | 阶段重点 ×1.5 / 基础项 ×1.0 / 其余 ×1.0 | 见 §3.3 推论 B、C |

**禁止硬编码**（阈值配置化铁律）；代码只经读取函数消费。

---

## §9 接口清单（只读为主，对齐 `/api/monitor/*` 家族口径）

| 方法 | 路径 | 用途 | 鉴权 |
|---|---|---|---|
| GET | `/api/decision/:id/selfcheck` | 极简自检卡 7 问 | 与决策详情一致 |
| GET | `/api/decision/:id/rubric` | 九尺子评分明细 + 阶段加权 | 同上 |
| GET | `/api/decision/:id/thinking` | 八要素物化内容 | 同上 |
| GET | `/api/monitor/scenario-chips` | 场景列表 chip 聚合（九尺子内嵌产物） | 与决策详情一致 |
| POST | `/api/decision/:id/thinking` | 人工补录思维要素（append 留痕） | 决策第 0 闸 + HITL |
| POST | `/api/decision/:id/retro` | 提交复盘（写 provenance RETRO） | 决策第 0 闸 + HITL |
| POST | `/api/decision/:id/hindsight-check` | 触发证实性偏差校验（写 provenance HINDSIGHT_CHECK） | 决策第 0 闸 + HITL |
| GET | `/api/config/stage-focus` | 阶段聚焦矩阵（读 `decision_scenario`） | sysadmin |
| PUT | `/api/config/stage-focus` | 修改聚焦矩阵/必填维 | sysadmin + 第 0 闸 |

**所有写操作必经决策第 0 闸 + HITL 确认**（零信任铁律）。

---

## §10 实施路线图（每 Task 一 commit）

| Task | 内容 | 依赖 | 状态 |
|---|---|---|---|
| **T1** | 修 `STAGE_SCENARIO` 错位 + S8 补键 | — | ✅ **已完成**（本次） |
| **T2** | `decision_scenario` 加 3 列 + 回填 12 场景；`STAGE_SCENARIO` 上移到 `stageTaxonomy.js` | T1 | 待实施 |
| **T3** | `decision` 加 8 列（`db/migrate.js` 向后兼容段） | — | 待实施 |
| **T4** | D 层物化：`createDecision` 写 6 个思维列 + `risk_register` + `stop_loss`，fail-open | T3 | 待实施 |
| **T5** | D 层九尺子内嵌：确定性 6 项 + LLM 3 项（默认关）+ 阶段加权；落 `decision_rubric_score` + `rubric` | T2, T3, T4 | 待实施 |
| **T6** | 自检卡 API + 监控台"自检卡"折叠区 | T4, T5 | 待实施 |
| **T7** | 监控台"阶段视图"：七阶段 × 决策质量热力 | T5 | 待实施 |
| **T8** | 复盘闭环：`POST /retro` → provenance RETRO → 反面先例登记 | T4 | 待实施 |
| **T9** | I7 学习回写：处方生成 + 批准链（AI 不直接改配置） | T8 | 待实施 |

**范围提示**：T2–T9 属方案 B（上游已定）的领域实例化部分，与上游 P0–P3 并行推进；T2 属上游 P2（知识回填），本设计因聚焦矩阵需要**提前到 P0**——没有 `stage_code` 就没有阶段加权，没有 `required_dims` 就没有"相关性"尺子可评。

---

## §11 验收口径（硬指标，可复测）

| # | 验收项 | 判定方式 |
|---|---|---|
| V1 | 8 个阶段全部映射到有效业务场景，无 fallback | `tmp/verify-stage-fix.mjs` 全 PASS |
| V2 | 每个业务场景 `required_dims` 非空 | `SELECT count(*) FROM decision_scenario WHERE stage_code IS NOT NULL AND jsonb_array_length(required_dims)=0` = **0** |
| V3 | 七维拦截真的会触发 | 造一条缺 `time_config` 的 S4 决策 → 快照 `supplied_dims` 应低于 `required_dims` 且 `degraded=true` |
| V4 | 思维物化率 | 新建决策中 `intent`/`assumptions` 非空的占比 > 0（当前 0/12） |
| V5 | 九尺子能出分 | 确定性 6 项在零 LLM 下全部有分，LLM 3 项 `degraded=true` 且标注，不假填充 |
| V6 | 止损可观测 | `QUOTE_PRICING` 决策的 `stop_loss.status` 有值，且超时未处理能在监控台被检出 |
| V7 | 复盘留痕 | 提交 retro 后 `decision_provenance` 新增 `entry_type='RETRO'` 行，且 falsified 假设生成反面先例 |
| V8 | 全量回归 | `npx vitest run` 全绿（基线 398/398，新增用例后同步更新基线） |

---

## §12 铁律核对与风险

### 12.1 铁律核对

| 铁律 | 本设计遵守情况 |
|---|---|
| 设计先行、未批准不写实现 | ✅ T2–T9 未实施；T1 属 bug 修复豁免 |
| 阈值配置化 | ✅ 权重/及格线走 `config_store`，无硬编码 |
| 零 DELETE | ✅ rubric 评分 append-only；补录走 provenance，不覆盖 |
| 单一事实源 | ✅ 聚焦矩阵落 `decision_scenario`，不进 config_store；取值域落 `rubricSpec.js` |
| 迁移纪律 | ✅ 全部走 `ALTER TABLE ADD COLUMN IF NOT EXISTS` |
| UI 一致性 | ✅ 自检卡复用 `common.css` / `tokens.css`，零硬编码色值 |
| 反假绿 | ✅ 空值计 0 分、LLM 降级标 `degraded` 不填充、验收 V3/V5 要求实测触发 |
| AI 不直接改生产配置 | ✅ I6 只生成处方，批准后才落库 |
| 禁 `git add -A` | ✅ 每 Task 显式路径提交 |

### 12.2 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| `required_dims` 由 AI 推导可能与业务实际不符 | 七维拦截误报 | 初值全设 `warn` 不阻断；标注待复核；P2 用真实评分数据校准 |
| 阶段加权后，非聚焦尺子被忽视（如 S1 无"深度"加权） | 质量盲区 | 非聚焦项按 ×1.0 计入，**不归零**（§3.3 推论 C） |
| D 层 6 列全靠调用方自觉填写 | 物化率可能长期为 0 | V4 监控物化率；`createDecision` 侧提供结构化入参，LLM 摘要走后置补录通道 |
| LLM 3 项评分主观性 | 评分不可复现 | 默认关；开启后必须留 `scorer='llm'` + `evidence`，可人工覆写 |

---

## §13 待确认

| # | 问题 | 我的建议 |
|---|---|---|
| DQ1 | `required_dims` 初值是否照单全收？ | 先按 §4 填入并全设 `warn`，跑一个周期后按数据校准 |
| DQ2 | `LOSS_REVIEW` 同时绑 S7 输单与 S8 丢单，是否要拆成两个场景？ | 暂不拆（文档阶段7 合并处理）；若复盘需求分化再拆 |
| DQ3 | 止损条件到期未处理，是否自动触发工作流？ | P0 只做"可观测+告警"，不自动改商机状态；自动动作放 P2 |
| DQ4 | 极简自检卡是否开放给销售一线自助使用（非只读）？ | P0 只读；写入仍走第 0 闸 + HITL |
