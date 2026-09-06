> ⛔ **已合并 / 已归档（2026-09-02）**
> 本文已并入 **`docs/2026-09-02-cognitive-decision-unified-design.md`**（认知驱动决策子系统 · 统一设计 v3）。
> 本文**仅作历史留档**，一切以合并文档为准。重评修正点：①§7「先做方案 A（只补三字段）」**被推翻**——无 L0 原料与供给层复通，先建字段也是空壳，顺序已重排为 P-1 供给层 → P0 原料层 → P1 结构层 ②§4 尺子名「关联性」统一为「**相关性**」③§6 的 `decision_rule`/`policy_version`/`assertions` 空表定性为「待填」，合并文档 Q5 沿用。
> §3 八要素覆盖矩阵、§5 根因分类器视角盲区**结论全部成立**，已并入合并文档 §2.7 / §5。

# 认知科学视角的决策子系统审计：知识、记忆与决策三件套对照

- 日期：2026-09-02
- 输入：《人类知识、记忆与决策的关系》（记忆→知识→决策闭环、决策 8 要素、9 大评判尺子）
- 被审对象：`D:\system\CRM-ai-native` 决策子系统（生产库 `crm_native` @5433，实测时间 2026-09-02 08:2x）
- 方法：以文档的三个框架为尺，逐条映射到真实表结构与代码调用点，用生产库实测行数判定"有没有真的在跑"

---

## §0 结论摘要

| # | 结论 | 硬证据 |
|---|------|--------|
| C1 | **闭环在"知识层"和"学习层"断裂**。系统有记忆、会决策，但没有沉淀知识、不会学习 | `decision_rule` 0 行、`policy_version` 0 行、`assertions` 0 行、`calibration_patch` 0 行、`decision_retro_report` 0 行 |
| C2 | **决策 8 要素只落地 2/8**（信息、概念）。目的/问题/假设/推论/视角/意涵六个零落地 | `decision` 表 33 列无一列对应；唯一文本字段 `rationale` 填充的是探针文案（"§7 验收复核探针"） |
| C3 | **9 大评判尺子零落地**。现有 `metrics.js` 是"事后结果统计"，与"思维质量评判"是正交的两层 | `src/calibration/metrics.js:60-83` 全部为覆写率/疲劳/延迟类指标 |
| C4 | **七轴最高只跑到 4/7，从未满轴** | `decision_context_snapshot.supplied_dims` 分布：1(3条)/2(5条)/3(6条)/4(12条)，无一条 ≥5 |
| C5 | **根因归因只能看到"供给层"，看不到"推理层"** | `rootCauseClassifier.js:11-19` 七类根因的 `layer` 字段全部落在 粒子库/M/K，无一类落在推理过程 |

> 一句话：这套系统目前是一个**有记忆、能记录决策、但缺知识沉淀与思维过程留痕**的系统。它能回答"这次决策用了哪些记忆"，**不能回答"这次推理是怎么走出来的、走得好不好"**。

---

## §1 框架与系统的三层对照

文档提供三样东西，与项目现有体系是**三层正交**，不是重复：

| 层 | 文档来源 | 回答的问题 | 项目现状 |
|---|---------|-----------|---------|
| L1 供给完整性 | （项目自有）决策七轴 | 这次决策调用了哪些**记忆** | ✅ 已实现，但最高 4/7 |
| L2 思维过程 | 文档第二部分：决策 8 要素 | 这次**推理怎么走** | ❌ 完全缺失 |
| L3 思维质量 | 文档第三部分：9 大评判尺子 | 这次**思考好不好** | ❌ 完全缺失 |
| L4 结果统计 | （项目自有）校准指标 | 决策**事后怎么样** | ⚠️ 有代码，无数据 |

**关键判断**：L1 与 L4 是"外部可观测"的，L2 与 L3 是"内部过程"的。补齐 L2/L3 不等于重复造轮子——它们是当前系统**唯一无法回答的一层**。

---

## §2 第一层实证：记忆 → 知识 → 决策 → 反馈 → 学习

文档的闭环：`记忆 → 形成知识 → 做出决策 → 结果反馈 → 更新记忆与知识`。

生产库实测（`crm_native`）：

| 闭环环节 | 承载表 | 实测行数 | 判定 |
|---------|--------|---------|------|
| 记忆 | `particles` / `memory_log` / `memory_note` / `memory_snapshot` | 71 / 36 / **1** / **0** | ⚠️ 有数据，但策展笔记与快照近乎为空，30 天蒸馏未跑过 |
| 知识 | `decision_scenario` / `decision_rule` / `policy_version` / `assertions` | 12 / **0** / **0** / **0** | ❌ 场景骨架在，规则/策略版本/事实断言全空 |
| 决策 | `decision` / `decision_context_snapshot` / `decision_provenance` | 12 / 26 / 8 | ⚠️ 有记录，但 12 条中多数为验证探针 |
| 反馈 | `decision_outcome` / `decision_precedent_rel` / `decision.feedback` | 4 / 4 / 7 fill | ⚠️ 稀疏 |
| 学习 | `calibration_patch` / `decision_retro_report` | **0** / **0** | ❌ 闭环末端从未触发 |

**字段填充率（`decision` 表 n=12）**：

| 字段 | 有值数 | 含义 |
|------|-------|------|
| `outcome` | **0 / 12** | 业务结果 100% 未回填 |
| `outcome_verified` | 4 / 12 | 结果核验仅 1/3 |
| `feedback` | 7 / 12 | 反馈覆盖约 58% |
| `root_cause` | 7 / 12 | 归因覆盖约 58% |
| `trigger_context`（非空对象） | **4 / 12** | **8 条决策连"因何触发"都没记** |
| `rationale` > 40 字符 | 6 / 12 | 半数理由短于一句话 |
| `confidence` | 3 / 12（且全为 0.6） | 置信度要么空、要么恒定值，**无一次真实区分度** |

### 2.1 知识层的真实形态

`decision_scenario` 是唯一有内容的知识载体。以 `OPP_QUALIFY` 为例（生产库实测）：

- `eval_dimensions`：8 条 `{cond, label, weight}` → 对应 8 要素中的**「信息」**
- `methodology_ids`：`["MEDDICC","OPP_MATRIX","ROLE_MAP"]` → 对应 8 要素中的**「概念」**
- `required_dims`：`[]` → **七轴约束为空**，即七轴校验对该场景无强制力
- `trigger`：`{event: qualify, stage: opportunity, entity: DEAL}` → 部分对应**「问题」**

**判定**：知识层承载的是"要检查哪些条件"和"用哪套方法论"，**没有承载"为什么做这个决策、基于什么假设、会导致什么后果"**。这正是文档所说"知识≠原始记忆"的反面——系统存的是素材清单与理论名，不是加工过的判断模型。

### 2.2 学习层：执行器在，触发为零

`src/calibration/knobs/index.js:16-31` 注册了 13 类旋钮（threshold / weight / required_dims / confidence / edge_binding / outcome_threshold / strictness / meta_attr_map / particle_attr_add / k_edge_add / source_refresh / dim_order / **precedent_distill**）。

**判定**：旋钮执行器齐备（含"先例蒸馏" `precedent_distill`），但 `calibration_patch` 0 行 → **13 类旋钮从未被真实处方触发过一次**。文档说的"决策复盘生成新知识，成为下一次决策的输入"这一环，代码通路存在，运行时从未跑通。

---

## §3 第二层：决策 8 要素 × `decision` 表 33 列 覆盖矩阵

`decision` 表 33 列（生产库实测）：`decision_id, scenario_id, trigger_context, involved_entities, conditions_evaluated, effective_policy_version, disposition, decider_type, decider_id, decider_role, rationale, referenced_precedents, business_tier, outcome, feedback_link, state, embedding, created_at, decided_at, updated_at, human_disposition, human_decided_at, human_decider_id, human_decider_role, attribution, context_snapshot_id, confidence, confidence_source, confidence_at, outcome_verified, feedback, root_cause, tenant_id`

| # | 8 要素 | 现有落点 | 状态 | 说明 |
|---|--------|---------|------|------|
| 1 | **目的** Purpose | 无 | ❌ 缺失 | 无 `intent`/`goal` 字段。`business_tier` 是分级不是目的；无法回答"这次决策想达成什么" |
| 2 | **问题** Question at issue | `scenario_id` + `trigger_context` | ⚠️ 弱 | 场景 id 只标识类别，不记录"本次待决的具体议题"；`trigger_context` 4/12 为空 |
| 3 | **信息** Information | `conditions_evaluated` + `involved_entities` + `referenced_precedents` | ✅ 已有 | 八要素中落地最完整的一项，且带权重（`eval_dimensions`） |
| 4 | **概念** Concepts | `scenario.methodology_ids` | ✅ 已有 | MEDDICC / OPP_MATRIX / ROLE_MAP 等，作为场景级引用 |
| 5 | **假设** Assumptions | 无 | ❌ 缺失 | **最危险的缺口**。文档："假设出错，即便事实正确，结论依然错误"。系统记录了全部事实，却不记录从事实到结论之间的那座桥 |
| 6 | **推论** Inference | `rationale`（text） | ⚠️ 弱 | 唯一承载字段，但是自由文本非结构化。实测填充为探针文案（"P0 接线验证探针"、"line-fix verify"），无法做质量评判 |
| 7 | **视角** Point of View | `decider_type` / `decider_role` / `tenant_id` | ⚠️ 部分 | 记录了"谁在决策"，未记录"站在什么立场/框架"。`human_disposition` 提供事后第二视角 |
| 8 | **意涵与后果** Implications | 无 | ❌ 缺失 | 文档："很多决策失误，是没有思考深层连锁后果"。系统只在 `outcome` 事后记录实际结果（且 0/12 有值），决策时**从不要求预判后果** |

**覆盖率：2 完整（信息、概念）+ 3 弱覆盖（问题、推论、视角）+ 3 完全缺失（目的、假设、意涵）= 8 要素中 6 项不构成可评判数据。**

### 3.1 为什么"假设"缺口最致命

对照文档的因果链：`信息 →（假设）→ 推论 → 意涵`。

系统现状：
- 信息 ✅ 打分了（`conditions_evaluated` 带 weight）
- 假设 ❌ 无字段
- 推论 ⚠️ 自由文本
- 意涵 ❌ 无字段

**后果**：当决策被证明是错的（如被人工 OVERRIDE），系统能定位到"哪条信息没满足"，但**无法定位"是不是假设本身错了"**。这直接解释了 §5 的根因盲区。

---

## §4 第三层：9 大评判尺子 × 现有指标

| 尺子 | 现有对应 | 状态 |
|------|---------|------|
| 清晰性 | 无 | ❌ |
| 准确性 | `outcome_verified` / `attribution.accuracy_signal` | ⚠️ 有结果判，无过程判 |
| 精确性 | 无 | ❌ |
| 深度 | 无 | ❌ |
| 关联性 | 无（七轴 `supplied_dims` 是"覆盖"不是"关联"） | ❌ |
| 逻辑性 | 无 | ❌ |
| 重要性 | `eval_dimensions.weight` | ⚠️ 有权重，但权重是静态配置的，不是本次推理的聚焦判断 |
| 广度 | 七轴覆盖（1–4/7） | ⚠️ 形式相近但语义不同：七轴是"记忆调用了几个抽屉"，广度是"考虑了几个不同视角" |
| 公平性 | 无 | ❌ |

现有 `src/calibration/metrics.js:60-83` 输出的 16 项指标全部属于 L4 结果统计：

`sample_size / autonomous_count / escalated_count / reviewed_count / autonomy_rate / escalate_rate / autonomy_override_rate / escalated_override_rate / escalation_fatigue_rate / human_latency_p50_ms / reversal_rate / precedent_coverage_avg / avg_confidence_gap_to_threshold / weight_sensitivity_{method,coverage,similarity} / sufficient_sample`

**判定**：这些指标回答"决策产出后的行为表现"，**不回答"思考过程的质量"**。两者正交，不可相互替代。

---

## §5 根因分类器的视角盲区

`src/decision/rootCauseClassifier.js:11-19` 定义七类根因，`layer` 字段显示归因落点：

| 根因码 | 名称 | layer | 旋钮 |
|--------|------|-------|------|
| `FIELD_MISMATCH` | 字段不一致 | 粒子库 | META_ATTR_MAP |
| `INFO_INCOMPLETE` | 信息不完整 | 粒子库/K | PARTICLE_ATTR_ADD |
| `INPUT_STALE` | 输入不及时 | 粒子库 | SOURCE_REFRESH |
| `DIM_MISSING` | 维度不对/缺维度 | M/seven-dim | REQUIRED_DIMS |
| `EDGE_MISSING` | 边选择不对 | M/edge_bindings | EDGE_BINDING |
| `NEED_DIM_ORDER` | 优化次序/补齐维度 | M/K | DIM_ORDER |
| `DATA_QUALITY_PRECEDENT` | 参考先例/标杆污染 | K | PRECEDENT_DISTILL |

**七类全部落在"喂进去的东西不对"这一层**。没有任何一类能表达：
- 目的模糊 / 目标混淆（8 要素 #1）
- 问题定义错误（8 要素 #2）
- **假设错误**（8 要素 #5）
- 视角单一（8 要素 #7）
- 未评估连锁后果（8 要素 #8）

**后果**：当 L 维度全齐、E 边全齐、信息无缺失，但决策仍然错了时，分类器只能落到 `DATA_QUALITY_PRECEDENT`（"先例污染"）或 `NEED_DIM_ORDER`（"补齐维度"）——这是**把推理缺陷误判为数据缺陷**，是国家审计视角下的系统性错分。

这也解释了为什么 `NO_DECISION` 类的失败在现有体系里无法归因。

---

## §6 缺口清单与建议动作

| 优先级 | 缺口 | 证据 | 建议动作 |
|-------|------|------|---------|
| **P0** | 决策不记录**假设** | `decision` 33 列无 assumption 字段；七类根因无假设类 | 新增 `decision.assumptions jsonb`（数组，每项含 `claim`/`source`/`confidence`/`falsified_by`）。写入必经决策第 0 闸 |
| **P0** | 决策不记录**目的与问题** | `rationale` 实测为探针文案；`trigger_context` 4/12 非空 | 新增 `decision.intent jsonb`（goal / success_criteria / competing_goals）+ `question_at_issue text` |
| **P0** | 决策不预判**意涵后果** | `outcome` 0/12，且只在事后 | 新增 `decision.implications jsonb`（每项含 `kind: risk\|benefit` / `chain` / `severity`），决策时必填 |
| **P1** | **9 尺子**零落地 | `metrics.js` 全部为结果统计 | 新增 `decision_rubric` 表（或 `decision.rubric jsonb`），9 维 0–3 分；及格线走 `config_store`（遵守阈值配置化铁律，禁止硬编码） |
| **P1** | 根因盲区 | `rootCauseClassifier.js:11-19` layer 全在供给层 | 扩展根因分类，新增推理层三码：`PURPOSE_AMBIGUOUS` / `ASSUMPTION_FALSIFIED` / `IMPLICATION_UNEVALUATED`，对应 knob 指向 rubric 阈值与必填校验 |
| **P1** | 知识层为空 | `decision_rule` 0 / `policy_version` 0 / `assertions` 0 | 明确知识层是否归属 `decision_scenario`；若 `decision_rule` 无用则下线或补 seed，避免"空表伪装成模块" |
| **P2** | 学习层从未触发 | `calibration_patch` 0 行，13 类旋钮全未触发 | 打通 `feedback → root_cause → autoSuggest → patch` 触发链（当前断点疑似在处方生成到批准之间） |
| **P2** | 置信度无区分度 | 3 条有值且全为 0.6，9 条 null | 排查 `confidence_source='computed'` 的计算路径；恒定值说明输入分支未生效 |
| **P2** | 记忆策展未跑 | `memory_note` 1 / `memory_snapshot` 0 | 30 天蒸馏任务未接线或从未执行，需确认调度入口 |

---

## §7 落地路径建议（三档，供选型）

| 方案 | 范围 | 触及面 | 适用判断 |
|------|------|-------|---------|
| **A · 最小可评判** | 只补 P0 三字段（intent / assumptions / implications）+ 根因三码 | `decision` 表加 3 列 + `rootCauseClassifier` 扩码 + 写入校验 | 想先解决"决策错了查不出为什么" |
| **B · 完整思维层** | A + 9 尺子 rubric + 配置化及格线 + 决策质量页 | 新增表/配置 + 前端页 + 评判链路 | 想把"思维质量"变成可持续运营的指标 |
| **C · 全闭环** | B + 学习层触发链打通 + 知识层补实 | 触及校准、蒸馏、调度三个子系统 | 想让系统真正"会学习" |

**建议**：先做 A。A 是 B、C 的地基——没有 intent/assumptions/implications 三个结构化字段，9 尺子无对象可评，学习层也无知识可沉淀。

---

## §8 待确认

1. `decision_rule` / `policy_version` / `assertions` 三张空表，是**尚未填充**还是**设计上已废弃**？若废弃应下线，避免"空表伪装成已实现模块"（与本系统此前"看板全绿不等于回路通"的教训同源）。
2. 9 尺子的评分主体是谁？规则判定（确定性、不烧 token）还是 LLM 判定（需评估成本与稳定性）？建议混合：清晰性/精确性/逻辑性走规则，深度/广度/公平性走 LLM。
3. 补齐 L2/L3 后，`supplied_dims` 的口径是否需要扩展？当前七轴只量"记忆调用"，是否要新增"思维完整度"独立指标与之并列？
4. 《人类知识、记忆与决策的关系》是否计划作为方法论输入沉淀进 `ai-memory-lifecycle` SKILL？文档第一部分（记忆失真、后见之明、证实性偏差）与该 SKILL 强相关，且属跨域通用方法论，不违反"10 大能力清单不变动"铁律。
