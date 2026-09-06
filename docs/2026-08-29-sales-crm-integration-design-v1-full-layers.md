# 销售管理体系 × CRM-ai-native 结合设计 v1（全五层完整性设计）

> 版本：v1.1 · 2026-08-29 · 状态：**待评审**  
> 前置：`docs/2026-08-29-sales-crm-integration-design.md`（v0.3 概要，聚焦"拜访质检闭环 + 两关闸 + BANTCC"）  
> 本文档在其上做**全五层增量**：补齐 P1–P6 商机阶段模型、大漏斗客户分类触点节奏、行为合格线经理看板、标准化/反思闭环，并对齐 `method-*` 家族边界。  
> v1.1 增量：§13 指名客户目标指标（目标 vs 实际对比 + 后台配置 + 落点裁决）。  
> 方法论来源：`skill: sales-knowledge-free`（开放知识库，导出 2026-08-28，前五层 54 条）+
`skill: to-b-sales-management`（ToB 销售管理体系 模型，39 项标准 / 9 大管理场景 / P1-P6 / TAORAN / SWAS / MANT 漏斗 / 关系水平 0-5 / 数值 KPI）  
> 铁律：设计先行未批准不写代码；实例化只落 CRM 域（`skills/method-*` + `docs/`），不污染 `~/.workbuddy/skills/ai-*` 通用基线。



---

## §0 结论与推荐

**定位**：全五层在 CRM-ai-native 中的转译目标 = **"销售行为管理体系"（行为合格线 + 客户分层节奏 + 商机阶段推进 + 标准化反思），以「拜访记录 → AI 质检 → 行动计划」闭环为运行载体**。

**推荐路径**：v0.3 的**方案 B（中度行为闸门）继续作为主线**，在本版补齐三个缺口——

| 缺口                  | v0.3 覆盖                  | 本文档增量（v1）                                                    |
| ------------------- | ------------------------ | ------------------------------------------------------------ |
| BANTCC 资质门控         | ✅ 已覆盖（method-bant 扩 C）   | 不动                                                           |
| 两关动作前置闸             | ✅ 已覆盖（客户参与 + 方案验证）       | 不动                                                           |
| 拜访质检闭环              | ✅ 已覆盖（value/gaps → 行动计划） | 不动                                                           |
| **P1–P6 商机阶段推进模型**  | ❌ 无                      | **新增 `method-stage-progression`**（BN-06 / 大漏斗）           |
| **大漏斗客户分类 + 触点节奏**  | ❌ 无                      | **新增 `method-funnel-classification`**（大漏斗：潜力/目标/商机 + 频度） |
| **行为合格线（21 条标准）看板** | ❌ 无                      | **新增 `method-behavior-standard` + 经理看板维度**（BH-01~07）     |
| **标准化与定期反思闭环**      | ⚠️ 部分（归档复盘）              | **升级为"标准化→复制→反思"闭环**（LG-07 / BN-07）                      |

**明确边界**（防过度设计）：L1 底层逻辑只作 L1 知识注入（解释 why，不产生闸）；L4/L5 是理论桥与关注项，不直接入闸；真正入闸的只有 L3 行为标准（21 条 → 闸）与客户分层/阶段模型（大漏斗 → 数据）。

---

## §1 现状盘点（evidence file:line）

已核实的关键代码锚点（本文档所有引用均可回溯）：

| 模块                        | 文件                                          | 锚点                                                                                                                                             | 说明                                  |
| ------------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| AI 属性评估器                  | `src/aiAttributes/evaluator.js`             | `:5` `AI_ATTR_DEFS` / `:14` `CRM_ACCOUNT` / `:20` `CRM_CONTACT` / `:27` `deterministicEval` / `:96` degraded                                   | 属性复用 `payload.ai.*` 落点          |
| Action 执行器（多闸链）           | `src/action/executor.js`                    | `:19-25` 第0闸 decision_id / `:37` 第1闸 scope / `:49` 第1.5闸 RBAC / `:60` 第2.5闸字段 / `:68` force / `:75` 写白名单 / `:82` HITL approval / `:96` handler | 闸应插入 `:82` 之后、`:96` 之前（第 3.5 闸） |
| 上下文注入 L1–L4               | `src/context/injector.js`                   | `:11-12` L1 知识(title) / `:14-15` L2 历史决策 / `:17-18` L3 执行态                                                                                     | 五层作 L1 知识源                      |
| 拜访回写操作卡                   | `docs/2026-08-27-拜访归来回写操作卡.md`              | §1 现场 6 问 / §A 输入 next 必填 / §5 24h 跟进                                                                                                          | 质检闭环入口数据基础                          |
| 拜访备战包                     | `docs/2026-08-27-新客户拜访备战包.md`               | §1 拜访前 4 件事 / §3 现场 6 问 / §4 拜访后 24h 动作                                                                                                        | 访前标准（BH-01-03 工作计划完善）           |
| method-bant               | `skills/method-bant/SKILL.md`               | B/A/N/T 四维门控 / `method-bant/methodology.json` gate_rule                                                                                        | BANTCC 扩 C 的宿主                      |
| method-opportunity-matrix | `skills/method-opportunity-matrix/SKILL.md` | V1×F1×P1 三维修排序                                                                                                                                 | 与 P1–P6 互补（阶段 vs 优先级）               |
| method-role-map           | `skills/method-role-map/SKILL.md`           | D/I/U/S 四类角色+决策链拓扑                                                                                                                             | 与"决策链"互补（角色拓扑 vs 客户感知）              |
| method-followup-engine    | `skills/method-followup-engine/SKILL.md`    | 超期催办/节点催办/转人工                                                                                                                                  | 与"接触频度"互补（催办 vs 规律节奏）               |

**结论**：CRM 域已有 `method-bant`(资质) / `method-meddicc`(赢单) / `method-opportunity-matrix`(组合排序) / `method-role-map`(角色链) / `method-risk-tradeoff`(风险) / `method-stop-loss`(止损) / `method-fact-vs-script`(事实vs话术) / `method-presales`(售前) / `method-review-gate`(评审把关) / `method-followup-engine`(催办) / `method-quote-engine`(报价) / `method-intake-routing`(线索路由) / `method-followup-engine`。**缺**：客户分层（大漏斗）、P1–P6 阶段推进、行为合格线——正是 全五层能补的。

---

## §2 全五层 → CRM 模块映射（v1 完整版）

| 层            | 转译目标                 | 挂接点                                                           | 落地机制                                                                                |
| ---------------- | -------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **L1 七大底层逻辑**    | 领域知识底座（why）          | `context/injector.js` L1                                      | 注入 system context：业绩=活动数量×质量 / 覆盖+胜率=份额 / 了解=效率 / 频度=亲疏 / 无生意客户=未来商机 / 集体判断 / 标准化复制 |
| **L2 七类行为习惯**    | Agent persona / 行为导航 | `context/roleProfiles.js`                                     | 销售角色 profile 注入七类习惯（聪明勤奋→依照套路）                                                      |
| **L3 21 条行为标准**  | 执行质量闸门 + 检查工具        | `action/executor.js` 第 3.5 闸 + `aiAttributes/evaluator.js`    | **唯一入闸层**：拜访质检 / 阶段推进前检查 / 行为合格线                                                    |
| **L4 底层逻辑详解**    | 决策 why-narrative     | `decision/provenance.js`                                      | 每次质检判定落"为什么"（理论桥梁，不产生新闸）                                                            |
| **L5 规范项目（7 项）** | 经理自检看板               | `http/*Router` + portal                                       | BN-01~07 七个指标卡（关注"什么"，不产生闸）                                                         |
| **大漏斗（客户分类）**    | 粒子属性与分层              | `evaluator.js` `CRM_ACCOUNT` + `method-funnel-classification` | 潜力/目标/商机三类 + 接触频度                                                                   |
| **P1–P6 商机阶段**   | 阶段推进状态机              | `method-stage-progression` + `CRM_DEAL.stage`                 | 阶段判定与推进门控                                                                           |
| **TAORAN 拜访记录法则** | 拜访质检标准载体             | `method-behavior-standard` + 拜访记录（visit_notes）            | T/A/O/R/A/N 六要素，质检判定依据（to-b 场景七标准 15-16）                                             |
| **SWAS 商机回顾法**    | 商机阶段回顾                | `method-stage-progression/core`                               | S(Status)/W(Win Strategy)/A(Action)/S(Setback) 四要素（to-b 场景六标准 14）                           |
| **MANT 漏斗 + 预测加权** | 商机可信度判定              | `method-stage-progression` + `evaluator.js`                   | 漏斗区域 5 档 + 加权值 0.9/0.6/0.3/0（to-b 漏斗 v9）                                                |
| **关系水平 0–5 级**    | 客户关系深度判定             | `CRM_CONTACT` `payload`                                       | L0–L5 逐级判定（to-b 场景四标准 7）                                                               |
| **人均客户数标准**       | 指名客户数目标              | `named-accounts` 看板                                          | 日均3次→75；优化至日均4次→80-100（to-b 场景一标准 2）                                                  |
| **覆盖频度数值**        | 指名客户监测阈值             | `named-accounts` 看板                                          | 商机按需 / 目标月1 / 潜力季3（to-b 场景四标准 6）                                                       |
| **销售代表 6 项 KPI**   | 月季会看板                 | 经理看板                                                      | 活动数/潜力覆盖率/目标覆盖率/客户分布/信息收集/关系（to-b 场景十一标准 32）                                        |
| **销售经理 8 项 KPI**   | 经理月季会看板               | 经理看板                                                      | 6 项 KPI + 联合拜访 + 团队人员（to-b 场景十一标准 33）                                                   |
| **业绩四档预测**        | 业绩承诺/预测               | `business-board` + 决策                                        | 确保100%/争取50%/机会10%/运气备份（to-b 场景十二标准 35）                                                |

---

## §3 增量设计一：`method-stage-progression`（P1–P6 商机阶段模型）

**目的**：补齐 CRM 域缺失的"商机阶段→可推进判定"方法论，与 `method-opportunity-matrix`（组合优先级）互补：矩阵回答"先打哪条"；阶段模型回答"这条现在到哪一步、下一步做什么"。

### 标准目录结构（对齐 method-* 家族）

```
skills/method-stage-progression/
├── SKILL.md            # 定位/适用场景/快速流程
├── methodology.json    # 机器可读：P1-P6 定义+推进条件（唯一事实源）
├── registry.json       # 注册：methodology_id/维度/rbac_roles
├── core/progression.md # 阶段推进评估流程
├── rules/gates.md      # 阶段闸规则（P1→P2 必须已建商机等）
├── references/stages.md# P1-P6 释义与 溯源
├── profiles/sales.md   # 销售视角：我在哪一步、下一步
├── profiles/manager.md # 经理视角：管线分布、阶段卡点
```

### P1–P6 阶段定义（to-b 操作版：客户行为 × 拜访目的 × 输单条件）

> 升级说明：v1 初版仅"名称+判定要点"（sales-free 理论版）。按 `to-b-sales-management`（场景五标准 10-11 / 场景六标准 13），**阶段判定必须看三列：客户当前行为、本阶段的拜访目的、输单结束条件**——阶段推进 = 客户行为变化 + 下一步拜访目的达成，输单条件用于"何时判定该商机该放弃"（止损）。

| 阶段 | 客户行为（to-b 标准） | 销售拜访目的（用户规格命名） | 输单结束条件 | 推进门（上表第 3.5 闸） |
| -- | -- | -- | -- | -- |
| P1 线索发掘 | 客户开始寻找供应商/评估需求 | **发掘线索、确认需求存在** | 无可跟进线索/需求不成立 → 输单/放弃 | 有需求事实（现场 6 问 needs 实质内容） |
| P2 需求确认 | 客户明确需求与痛点 | **与客户确认需求细节** | 需求不成立/无预算 → 输单 | 方案验证拜访判有价值（关二） |
| P3 方案匹配 | 客户评估方案匹配度 | **提供匹配方案并获得认可** | 方案不匹配/被竞品替代 → 输单 | 通过 method-bant 资质闸 + 报价引擎已出价 |
| P4 报价谈判 | 客户评估商务条款与报价 | **报价并谈判达成一致** | 价格谈不拢/商务条款不认可 → 输单 | 通过 method-review-gate 双闸门（报价复核+合同确认） |
| P5 合同确认 | 客户内部审批合同 | **合同条款达成一致并签署** | 未能达成一致 → 输单 | 合同签署事实（decision 事件 + 合同粒子） |
| P6 赢单移交 | 客户验收付款完成、项目移交 | **确保验收付款、顺利移交** | —（终态） | — |

**关键升级**：原 v1 把 P1 定为线索发掘、P6 定为赢单移交（偏内部状态）；to-b 版以**客户行为**定义阶段（客户评估→客户认可→客户评估商务→客户内部审批→客户接受交付→客户验收付款），阶段推进依据"客户行为是否变化"判断，**输单条件**天然对接既有 `method-stop-loss`（止损）——P1/P2/P3/P4 输单条件 = 止损触发点。

**SWAS 四要素强制**：每个商机必须可回答 S(Status 阶段)/W(Win Strategy 制胜策略)/A(Action 行动)/S(Setback Schedule 时间节点)，否则不视为"可推进商机"（to-b 场景六标准 14）。落点 `method-stage-progression/core`（商机回顾模板）。

### 阶段推进门控（rules/gates.md 核心规则）

```
推进 P1→P2：必须存在客户需求描述（现场 6 问中的 needs 有实质内容）
推进 P2→P3：必须存在"方案验证拜访"被质检判为有价值（关二）
推进 P3→P4：必须通过 method-bant 资质闸（BANTCC 无硬缺口）＋报价引擎已出价
推进 P4→P5：必须通过 method-review-gate 双闸门（报价复核 + 合同确认）
推进 P5→P6：必须存在合同签署事实（decision 事件 + 粒子合同记录）
```

**与 v0.3 两关闸对齐**：P2→P3 = 用户"两关"之关二（方案验证）；P3→P4 = BANTCC 资质闸。**不重复建闸**：stage-progression 是"阶段判定"，复用 v0.3 已设计的 executor 第 3.5 闸做推进拦截。

---

## §4 增量设计二：`method-funnel-classification`（大漏斗客户分类）

**目的**：把 大漏斗（潜力/目标/商机客户）转译为 CRM 的**客户分层数据 + 接触节奏规则**，解决"客户分类与接触频度"（BN-05）。

### 分类规则（客户行为 × 销售感知，LG-05 四象限转译）

| 客户行为（要不要解决） | 销售感知（识别了吗） | 分类                  | 接触节奏（规范）    |
| ----------- | ---------- | ------------------- | --------------- |
| 已行动         | 已识别        | **商机客户**（P1–P6 任阶段） | 按商机阶段推进需要       |
| 已行动         | 未识别        | **目标客户**（未觉察商机）     | 每月 ≥1 次（关系推进重点） |
| 未行动         | 已识别        | **目标客户**（有潜力认知）     | 每月 ≥1 次         |
| 未行动         | 未识别        | **潜力客户**            | 每季 ≥1 次（保持温养）   |

**落点**：`CRM_ACCOUNT.account_segment`（现有 AI 属性轴 `C_Classify`）+ `method-funnel-classification/methodology.json` 节奏规则。

**与 method-followup-engine 边界**：funnel-classification 定义"不同类客户该多久见一次"（规律节奏）；followup-engine 定义"超期了怎么办"（异常催办）。两者互补不重。

**与 method-role-map 边界**：role-map 管"客户内部谁支持/反对"（决策链拓扑）；funnel-classification 管"这个客户整体属于哪类"（客户分层）。视角不同。

---

## §5 增量设计三：`method-behavior-standard`（21 条行为合格线）

**目的**：把 L3 的 21 条行为标准转译为**可观察的检查清单**（不设评分阈值，只设"有/无"事实判定），供：

- **拜访后质检**：AI 按 21 条判本次拜访 value/gaps（v0.3 已设计属性接口，这里是标准内容层）；
- **经理周会**：行为合格线看板（21 条逐条"证据有/无"）；
- **标准化闭环**：合格行为沉淀为标准动作库。

### 21 条 → 检查项映射（BH-01~07）

| 七类习惯       | 具体行为（BH）                                            | CRM 检查项（可观察事实）                       |
| ---------- | ------------------------------------------------------- | ------------------------------------ |
| BH-01 聪明勤奋 | 01-01 时间安排饱满 / 01-02 目的明确 / 01-03 工作计划完善                | 拜访计划存在 + 目的字段非"维护关系"笼统话 / 计划在周维度     |
| BH-02 双管齐下 | 02-01 拜访所有客户 / 02-02 珍惜项目机会                             | 拜访覆盖 ≥2 类客户 / 商机未因主观胜率低被过滤           |
| BH-03 知己知彼 | 03-01 BANTCC / 03-02 关注需求 / 03-03 不做无效拜访 / 03-04 访前准备   | 6 问字段齐全 / 需求有"为什么" / 拜访有明确目的 / 有访前准备 |
| BH-04 充满信心 | 04-01 理解关系作用 / 04-02 积极发展 / 04-03 主动管理                  | 联系人覆盖广度 / 关系动作有记录                    |
| BH-05 着眼未来 | 05-01 科学分类 / 05-02 接触潜力 / 05-03 关注目标                    | 客户分层正确 / 潜力客户有接触                     |
| BH-06 善用资源 | 06-01 看到所有商机 / 06-02 识别致胜关键 / 06-03 寻求团队 / 06-04 正确看待输赢 | 商机透明（未隐藏）/ 有致胜关键字段 / 有求助记录           |
| BH-07 依照套路 | 07-01 按照标准做事 / 07-02 及时总结反省                             | 行为符合标准动作 / 拜访后有复盘记录                  |

### 落点

- `aiAttributes/evaluator.js` `CRM_CONTACT.sales_visit_gaps` → 21 条中未满足项列表（v0.3 已设计，这里是完整清单）；
- 经理看板新增 `behavior_pass_rate`：近期拜访中"价值判定=合格"占比（BN-01 活动质量）；
- **不设评分阈值**：21 条是合格线（有/无），量化打分层留给后续 calibration（防过度设计）。

### TAORAN 六要素升级（to-b 场景七标准 15-16）

> 升级：拜访质检的判定载体从"AI 按 21 条抽象价值判定"升级为 **「拜访记录必须符合 TAORAN 六要素」**。每个 `visit_notes[]` 元素须含 6 个子字段（对齐 `visit-return-writeback.mjs:113-123` 字段扩展）。

| 要素 | 含义 | 质检判定规则 |
|---|---|---|
| **T**ype | 客户类型 | 自动同步 客户类型（商机/目标/潜力）+ 商机阶段 |
| **A**ppointment | 是否预约 | 商机客户拜访原则上应有预约（无预约=缺口） |
| **O**bjective | 拜访目的与关键结果 | 按客户类型/商机阶段限定范围选择，写明可量化具体成果（对齐 BH-01-02 目的明确具体） |
| **R**esult | 拜访结果和过程描述 | 引用客户原话，不能只写主观判断（对齐 method-fact-vs-script） |
| **A**chieved | 是否达标 | ≥80% 实现=达到 / <20%=未达到 / 其他=部分达到 |
| **N**ext Step | 后续安排 | 商机客户=下一步具体行动；目标/潜力=按频度设定下次拜访时间（对齐 BH-01-01 时间安排） |

**落点升级**：

- `visit_notes[]` 每元素升级为 TAORAN 六字段（`visit-return-writeback.mjs:113-123` 字段扩展）；
- `sales_visit_value`/`sales_visit_gaps` 的判定依据 = **TAORAN 六要素达标度**（不再是 21 条抽象价值）；
- 21 条行为合格线仍作经理看板行为指标（§5 初衷不变，两者分层：TAORAN=单次拜访记录规范，21 条=跨拜访行为合格线）。

---

## §6 增量设计四：标准化与定期反思闭环（LG-07 / BN-07）

**现状**：`docs/2026-08-27-拜访归来回写操作卡.md` §6 已有"归档复盘"。本版将其升级为完整闭环：

```
销售行为 → 21 条质检 → 合格行为沉淀为标准动作库（LG-07 标准化）
标准动作库 → 注入 L1 知识（下次拜访参考）→ 新拜访执行标准
每次拜访 → 复盘记录（BH-07-02 及时总结反省）→ 标准库定期校验（BN-07）
```

**落点**：

- 标准动作库 = `skills/method-behavior-standard/references/standard-actions.md`（人工维护，AI 不自动修改——符合"不自动修改第三层定义"边界）；
- 复盘 = 拜访记录的 `review` 字段（已有 + 增补）；
- 周期校验 = 经理月会检查标准库是否仍有效（BN-07 定期反思）。

---

## §7 闸门拓扑总览（v1 完整版）

```
写通道闸链（executor.js）：
第0闸 decision_id → 第1闸 scope → 第1.5闸 RBAC → 第2.5闸 字段 → 第2闸 force/白名单 → 第3闸 HITL → 【第3.5闸 行为闸（新增）】→ handler 执行

第3.5闸（仅对 crm-deal-advance / crm-visit-plan-create / crm-quote-create）：
  ① 阶段推进闸：P1→P2 需需求 / P2→P3 需方案验证 / P3→P4 需 BANTCC / P4→P5 需双闸门 / P5→P6 需合同事实
  ② 客户节奏 soft gate：目标客户本月 ≥1 次 → 放行；未达 → 提示（不阻断）
  ③ 行为合格检查：近 3 次拜访有质检记录且至少 1 次判"有价值" → 放行；否则提示先补拜访质检
```

---

## §8 落地里程碑（P0/P1/P2）

**P0（试点，复用 v0.3）**：

1. 拜访记录填写/质检工具上线（用户进行中）；
2. `evaluator.js` 加 `sales_*` 四属性（visit_frequency_adherence / bantcc_completeness / visit_value / visit_gaps）；
3. `executor.js` 第 3.5 闸对 `crm-deal-advance` 双层拦截（资质 + 两关）。

- 验收：推进到报价前"两关"缺失被拦；无 LLM 时 visit_value 由确定性兜底算出（degraded=true）。

> **to-b 升级映射（本次补充）**：
> - P0 拜访质检工具 = TAORAN 六要素记录工具（场景七标准 16 拜访记录填写规范）；
> - P0 `sales_visit_value/gaps` = TAORAN 达标度判定（§5 TAORAN 六要素升级子段）；
> - P0 阶段推进闸 = to-b P1–P6 三列操作版推进门（§3 升级表）；
> - P1 指名客户监测 = §12.3bis 达标判定升级（覆盖频度阈值 + 缺口提示）。

**P1（扩面，本版增量）**：

1. `method-stage-progression` SKILL（P1–P6 定义 + 推进门控）；
2. `method-funnel-classification` SKILL（四象限分类 + 节奏规则）；
3. `method-behavior-standard` SKILL（21 条合格线检查项）；
4. L1 注入 L1–L3 知识；经理看板 BN-01~07 七个指标卡。

- 验收：商机阶段字段与 P1–P6 对齐；客户分类与节奏规则可用；21 条检查项在质检中可勾选。

**P2（深化）**：

1. 达成度接入 `calibration/knobs` 校准；
2. why-narrative 溯源 `decision/provenance.js`（L4 理论桥）；
3. 标准化动作库注入 L1，形成"合格行为→标准→复制"闭环（LG-07）；
4. 与 `method-bant` BANTCC 统一（C 维归一）。

---

## §9 风险与边界

- **不污染 ai-* 基线\*\*：实例化只落 `skills/method-*` / `docs/`，`grep -r "\|BANTCC\|P1.*P6\|sales_" ~/.workbuddy/skills/ai-*` 应为空（验收项）。
- **闸误杀风险**：第 3.5 闸默认 soft（提示不阻断），硬闸仅限 `crm-deal-advance` 且可配置豁免（防质检误判导致误杀）。
- **不重复建闸**：stage-progression 是"阶段判定"，复用 v0.3 第 3.5 闸做推进拦截；不新增独立闸链。
- **L4/L5 不入闸**：底层逻辑与规范项目只作知识注入/看板，不产生执行闸（防过度设计）。
- **21 条不设评分**：合格线（有/无）判定，量化分层留给 calibration（P2）。
- **知识库边界**：免费版仅前五层（54 条），第六层（BS）不在范围；本设计限于前五层。

---

## §10 文件清单（实现期产出）

| 文件                                              | 类型               | 内容                     |
| ----------------------------------------------- | ---------------- | ---------------------- |
| `skills/method-stage-progression/**`            | 新增 SKILL (P1-P6) | §3 全部文件                |
| `skills/method-funnel-classification/**`        | 新增 SKILL (大漏斗)   | §4 全部文件                |
| `skills/method-behavior-standard/**`            | 新增 SKILL (21条)   | §5 全部文件                |
| `src/aiAttributes/evaluator.js`                 | 修改               | §5 落点 + v0.3 sales\_* 属性 |
| `src/action/executor.js`                        | 修改               | 第 3.5 闸                |
| `src/context/injector.js`                       | 修改               | L1 注入 五层知识         |
| `docs/2026-08-29-sales-crm-integration-design.md` | 修改               | 并入本版 v1 内容（或引用）        |
| 经理看板（portal）                                    | 修改               | BN-01~07 七指标卡          |
| `skills/method-stage-progression/core/swas.md`  | 新增               | SWAS 商机回顾模板（S/W/A/S 四要素，to-b 场景六标准 14） |
| `skills/method-behavior-standard/core/taoran.md` | 新增              | TAORAN 六要素记录规范（to-b 场景七标准 15-16） |
| `src/web/named-accounts.html` + 路由 + `/api/board/named-accounts` | 新增 | 指名客户监测看板（§12.3 + §12.3bis 达标判定） |

---

## §11 验收标准

1. **evidence**：所有模块引用有 file:line 锚点，可回溯至 `src/` 真实代码。
2. **P1 验收（stage-progression）**：商机粒子 `stage` 值域与 P1–P6 对齐；P2→P3 无方案验证被拦（gate:'sales_action_prereq'）。
3. **P1 验收（funnel-classification）**：`CRM_ACCOUNT.account_segment` 输出 潜力/目标/商机 三值；目标客户接触节奏提示可用。
4. **P1 验收（behavior-standard）**：21 条检查项在拜访质检结果中可勾选/判定；`sales_visit_gaps` 返回未满足项列表。
5. **不污染**：`grep -r "\|BANTCC\|sales_" ~/.workbuddy/skills/ai-*` 为空。
6. **文档自查**：无占位符、无前后矛盾、范围限定 CRM-ai-native。

**to-b 升级补充验收（本次追加）**：

7. **TAORAN 验收**：`visit_notes[]` 每元素含 T/A/O/R/A/N 六字段（`visit-return-writeback.mjs:113-123` 扩展）；质检判定基于六要素达标度（§5 TAORAN 子段）。
8. **P1–P6 输单对接验收**：商机 `stage` 值域与 P1–P6 对齐；P1/P2/P3/P4 输单条件触发 `method-stop-loss` 止损（§3 升级表"输单条件"列）。
9. **关系水平验收**：`CRM_CONTACT` 可判定关系水平 L0–L5（to-b 场景四标准 7）；目标客户关系拓展建议可用（超出使用者范围，发展采购/财务/最高决策者）。
10. **覆盖阈值缺口验收**：指名客户监测按 to-b 阈值输出缺口（拜访=目标月1/潜力季3；线索=商机过滤缺口；商机=BANTCC 信息缺口；合同=P4/P5 推进卡点）——§12.3bis 达标判定升级表。

---

## 附录：知识编号引用索引（溯源）

| 内容             | 编号                           |
| -------------- | -------------------------------- |
| 业绩=活动数量×质量     | LG-01                        |
| 覆盖+胜率=份额       | LG-02 / LG-05            |
| 对客户的了解决定效率     | LG-03 / BH-03-01(BANTCC) |
| 见面频度决定关系亲疏     | LG-04 / BH-04            |
| 无生意客户→未来商机     | LG-05 / BH-05            |
| 商机胜负不能个人决定     | LG-06 / BH-06            |
| 标准化才能复制扩张      | LG-07 / BH-07            |
| 大漏斗频度          | 潜力每季1次 / 目标每月1次（规范项目 BN-05）  |
| 不做无效拜访         | BH-03-03                     |
| 访前准备           | BH-03-04                     |
| 及时总结反省         | BH-07-02                     |
| 行为标准化与定期反思     | BN-07                            |
| 25 条行为标准（21+4） | BH-01~07                     |

---

# §12 需求 1 增量：指名客户管理 + 指名客户监测（方案 A）

> 用户需求（2026-08-29 口述）：① 增加指名客户的管理（不同销售人员具有不同的客户分工和名单）；② 增加指名客户的监测（拜访次数、线索、商机、合同的监控）。
> 用户选定落点：**方案 A（单 owner_id + 看板过滤）**——最小落点，复用现有 scope 机制。

## §12.1 现状证据（evidence）

| 现有机制 | 位置 | 说明 |
|---|---|---|
| 客户粒子 owner | `src/context/scope.js:85-96` | 创建自动归属 `owner_id=actor`；`inScopeByModel('self')` 按 `owner_id` 过滤 |
| 粒子模型（通用表） | `db/schema.sql:11-28` | `particles(type, payload JSONB)`——客户/商机/联系人 owner 在 `payload.owner_id` |
| 拜访记录 | `tmp/visit-return-writeback.mjs:113-123` | 无独立 CRM_VISIT 粒子；拜访 = `payload.visit_notes[]`（数组追加，含 at/pain/needs/next） |
| 业务看板 | `src/http/routes.js:512-561` `src/web/business-board.html` | `business-board.html` fetch `/api/page/business-board` → 受控渲染；按 `CRM_DEAL/CRM_QUOTATION/CRM_CONTRACT/...` type 分组计数 |
| 商机阶段 | `src/http/routes.js:507-508` | 线索 = `CRM_DEAL.stage==='lead'`；商机 = 非 lead；合同 = `CRM_CONTRACT` |

## §12.2 增量 I1：指名客户管理（销售分工 + 名单）

**定位**：`BN-02 客户数量与商机胜率`（客户覆盖）+ `BN-05 客户分类与接触频度`（大漏斗分层）的 CRM 实例化。**一个客户一个 owner（销售分工），owner 即名单成员；不引入独立分配表**（方案 A 选型，避免建新实体）。

| 内容 | 落点 | 规则 |
|---|---|---|
| 客户创建自动归属 | `scope.js:85-96`（已实现） | 新建 `CRM_ACCOUNT` 自动 `owner_id=ctx.actor`（当前销售） |
| 客户更新校验 owner | `scope.js:94-96`（已实现） | 非 owner 更新被第 1 闸拦（scope_violation）——**指名客户天然的"分工隔离"** |
| 销售本人指名名单 | `business-board.html` 或新看板 | 按 `owner_id=当前登录销售` 过滤 → 只见自己分工的客户（BN-02 客户覆盖） |
| 经理看全团队分工 | 看板切换 owner | 经理角色按团队 owner_id 列表查看全部客户名单（BN-02/BN-05 覆盖面） |

**边界**：不做客户转移/多销售协同（方案 B 的分配表留 P2 长期）；不做强制分配数目标（BN-02 只关注覆盖面，不设阈值）。

## §12.3 增量 I2：指名客户监测（拜访次数/线索/商机/合同）

**监测指标 × 数据来源**（全部可在现有 `particles` 上按 `owner_id` 过滤聚合，无需新表）：

| 指标 | 数据来源 | 计算 |
|---|---|---|
| 拜访次数 | `CRM_ACCOUNT.payload.visit_notes[]`（写入 `visit-return-writeback.mjs:113-123`） | `visit_notes.length`；最近拜访 = 末尾 `visit_note.at` |
| 线索数 | `CRM_DEAL` `stage==='lead'` 且 `belongs_to` 该客户 | 该客户名下 lead 阶段商机数 |
| 商机数 | `CRM_DEAL` 非 lead 且 `belongs_to` 该客户 | 该客户名下非 lead 商机数 |
| 合同数 | `CRM_CONTRACT` 关联该客户 | 该客户名下合同粒子数 |

**看板落点**（方案 A 复用现有范式）：

1. **新看板页 `named-accounts.html`**：`src/web/named-accounts.html` + 路由 `GET /named-accounts.html`（受控渲染壳，对齐 `business-board.html` 范式）+ 端点 `GET /api/page/named-accounts` 或 `/api/board/named-accounts`。
2. **表头**：客户名 / 销售 owner / 拜访次数（近 30 天）/ 线索数 / 商机数 / 合同数。
3. **按 owner 过滤**：当前登录=本人（默认）；经理=可选团队成员（下拉）。

**与 溯源**：拜访次数×线索×商机×合同 = 客户数量与商机胜率（BN-02）+ 大漏斗（BN-05）的直接监测；"拜访次数=活动数量，线索/商机/合同=覆盖与胜率的可观察结果"（LG-01/LG-02）。

### §12.3bis 达标判定升级（to-b 数值阈值，方案 A 升级）

> 升级：四维监测从"纯计数"升级为 **「对照 to-b 数值阈值的达标/缺口判定」**——这是指名客户监测的核心价值：不只"有多少"，而是"达标没有、缺口在哪"。

| 指标 | 计数（§12.3） | to-b 达标阈值 | 缺口判定 |
|---|---|---|---|
| 拜访次数 | `visit_notes.length` | 目标客户 ≥1 次/月；潜力客户 ≥1 次/季（场景四标准 6） | 目标客户近 30 天=0 → **覆盖率缺口**；潜力客户近 90 天=0 → **温养缺口** |
| 线索数 | lead 数 | 客户分类正确（商机/目标/潜力，场景三标准 5） | 有需求的客户没建商机 → **商机过滤缺口**（BH-02-02 珍惜项目机会） |
| 商机数 | 非 lead 数 | 商机客户须有 BANTCC 清晰（场景五标准 11） | 商机客户 BANTCC 缺失 → **信息缺口**（BH-03-01） |
| 合同数 | `CRM_CONTRACT` 数 | 商机 P4/P5 须按时推进（场景六） | P4/P5 停留超期 → **推进卡点**（followup-engine 联动） |

**看板表头升级**（§12.3 表头追加一列）：

客户名 / 销售 owner / 拜访次数（近 30 天）＋ 达标标记 / 线索数 / 商机数 / 合同数 / **缺口提示**（按上表四类缺口，缺失才显示）

## §12.4 里程碑与验收（并入 §8/§11）

- **P1（本增量）**：`named-accounts.html` + 路由 + `/api/board/named-accounts` 端点；按 owner 过滤的客户名单 + 四维监测表。
- **验收**：① 销售 A 登录只见 owner=A 的客户（分工隔离，scope.js 天然保证）；② 拜访次数= `visit_notes` 长度、线索= lead 数、商机= 非 lead 数、合同= `CRM_CONTRACT` 数，四维数字与库中真实数据一致（`curl /api/board/named-accounts` 实测）；③ 经理视角可按团队成员切换过滤。
- **不做**（P2 长期）：客户转移/多销售协同（分配表 CRM_ACCOUNT_ASSIGNMENT）、指名客户达成率看板。

## §12.5 实现文件清单（实现期产出，并入 §10）

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/web/named-accounts.html` | 新增 | 指名客户监测看板壳（fetch `/api/board/named-accounts` → 渲染表） |
| `src/http/routes.js` | 修改 | `GET /named-accounts.html` 路由 + `/api/board/named-accounts` 端点（按 owner 过滤聚合） |
| `src/pages/S16.schema.js` 或 S15 扩展 | 修改 | 看板 schema（若走受控渲染） |
| `src/context/scope.js` | 不动 | 复用现有 owner_id 过滤（方案 A 最小改动） |

---

## §13 指名客户目标指标配置（v1.1 增量，P8 评审项）

> 用户需求（2026-08-29）：「是否有具体的指名客户应该完成的目标指标（比如重大客户，必须每周 1 次拜访？），与实际指标进行对比分析【体现在看板里面 http://localhost:3000/account-360.html】。考虑通过后台配置的方式对目标指标进行定义，还需要哪些信息需要提前进行配置，是放在基础数据门户还是配置中心？」

### §13.0 结论

1. **目标指标有据可依**：to-b 数值 KPI 已给出默认节奏（目标客户 ≥1 次/月、潜力客户 ≥1 次/季、商机客户按需，场景四标准 6）；用户提出的「重大客户每周 1 次」可纳入作为**重点客户**档默认值。三档默认：**重点 1 次/周 · 目标 1 次/月 · 潜力 1 次/季**。
2. **落点裁决：配置中心**，`CONFIG_ITEMS` 新增 **id 30「指名客户目标指标配置」**，仿 **id 29 财务应收配置**（configCenter.js:28）的 `config_store + GET|PUT /api/config/* + 第0闸决策凭证 + sysadmin` 全套范式——已有成熟先例，零新机制。
3. **目标 vs 实际对比落 account-360**：画像 Tab 内新增「目标达标」卡片区（当前客户 tier 目标频率 vs 近 30/90 天实际 `visit_notes.length`），由 `/api/page/account-360`（routes.js:770）扩展数据面输出，与 §12.3 四维监测共用同一口径。

### §13.1 为什么放配置中心而非基础数据门户（证据）

| 判据 | 证据 | 结论 |
|---|---|---|
| 边界铁律 | `businessDataCenter.js:4`：「与配置中心（configCenter.js，18 项平台/治理类）分离——本门户承载**业务主数据**」 | 产品/价格/报价规则/字典/回款政策是**对象类主数据** |
| 目标指标性质 | 拜访频率/推进节奏 = **行为/流程目标**，消费方是看板与行为合格线（L3 闸） | 属「销售方法论与决策治理」或「业务对象与流程建模」域，非主数据 |
| 成熟范式 | id 29 财务应收配置已在「业务对象与流程建模」组（configCenter.js:28），`financeReceivablesConfigRouter.js` 全套可复制 | 目标指标配置走同组 id 30，机制零新增 |
| 同源消费 | 七维/财务应收配置均通过 config_store 下发给业务端点实时消费 | 目标指标同样：`/api/board/named-accounts` 与 `/api/page/account-360` 读同一 config_store 键 |

结论：**目标指标 = 行为治理参数 → 配置中心**；基础数据门户保持「对象主数据」纯净边界。

### §13.2 目标指标模型（config_store 键 `named-account-targets`）

```jsonc
{
  "tiers": [                      // 客户分级档（默认三档，对齐大漏斗）
    { "tier": "重点", "visit_freq": { "times": 1, "window": "week" } },
    { "tier": "目标", "visit_freq": { "times": 1, "window": "month" } },
    { "tier": "潜力", "visit_freq": { "times": 1, "window": "quarter" } }
  ],
  "window_days": { "week": 7, "month": 30, "quarter": 90 },   // 滚动口径：达标判定的统计窗口
  "metrics": ["visit", "lead", "deal", "contract"],            // 四维监测指标（对齐 §12.3）
  "tier_rule": "by_payload"       // 客户档位来源：payload.tier（预留：自动判定规则 P2）
}
```

**需要提前配置的信息清单**（配置页表单字段）：

| # | 配置项 | 说明 | 默认值 |
|---|---|---|---|
| 1 | 客户分级档（tier 字典） | 重点/目标/潜力三档，可改可增 | 三档（上表） |
| 2 | 每档拜访频率目标 | `times × window`（次/周·月·季） | 重点 1/周 · 目标 1/月 · 潜力 1/季 |
| 3 | 时间窗口口径 | 滚动窗口天数（达标判定窗口） | week=7 / month=30 / quarter=90 |
| 4 | 指标口径映射 | 拜访=`visit_notes.length`、线索=lead、商机=非 lead、合同=`CRM_CONTRACT` | 固定（§12.3，不开放改） |
| 5 | 达标判定规则 | 窗口内实际 ≥ 目标次数 = 达标 | ≥1 次即达标 |
| 6 | 客户 → 档位归属 | `CRM_ACCOUNT.payload.tier`（录入/建档时填） | 空=潜力档（保守默认） |

### §13.3 account-360 目标 vs 实际对比（三栏卡片）

```
┌────────────────────────────────────────────────┐
│ 目标达标（当前客户：朝阳机械 · 档位：重点）            │
│  目标频率：1 次/周 │ 实际：近7天 2 次 │ ✅ 达标      │
│  线索目标：—      │ 实际：1 条 lead   │ 正常        │
│  商机推进：P4 ≤30天 │ 实际：上次推进 12 天 │ ✅ 在途   │
└────────────────────────────────────────────────┘
```

- **数据面**：`/api/page/account-360`（routes.js:770）响应扩容——读 `config_store['named-account-targets']` + `account.payload.tier` + `visit_notes[]` 按窗口过滤，输出 `{ target, actual, pass }` 三元组。
- **渲染面**：account-360.html（src/web，双 Tab 壳）画像 Tab 内新增「目标达标」卡片区（复用 pg-page / metric-card 样式），不新增 Tab，保持双 Tab 稳定。
- **看板联动**：§12.3 named-accounts 列表的「达标标记」列共用同一端点计算逻辑（同函数复用，不重算）。

### §13.4 实现文件清单（并入 §10/§12.5）

| 文件 | 类型 | 内容 |
|---|---|---|
| `src/http/namedAccountTargetsRouter.js` | 新增 | `GET|PUT /api/config/named-account-targets`（仿 financeReceivablesConfigRouter.js：DEFAULTS 合并 + config_store 持久化 + 第0闸决策凭证 + sysadmin 闸） |
| `src/portal/configCenter.js` | 修改 | `CONFIG_ITEMS` 追加 id 30（组：业务对象与流程建模，status ready，page `/named-account-targets.html`，endpoint `/api/config/named-account-targets`） |
| `src/web/named-account-targets.html` | 新增 | 配置页（tier × 频率 × 窗口编辑，仿 finance-receivables.html 形态，写经第0闸） |
| `src/http/routes.js` | 修改 | 挂载 router + `/named-account-targets.html` 路由；`/api/page/account-360`（:770）与 `/api/board/named-accounts` 读目标配置输出 target vs actual |
| `src/web/account-360.html` | 修改 | 画像 Tab 内新增「目标达标」卡片区（target vs actual 三元组渲染） |
| `src/web/named-accounts.html`（§12.5）及看板端点 | 修改 | 列表「达标标记」列与 account-360 共用同一计算函数 |

### §13.5 验收（P8 后写入 writing-plans）

1. `GET /api/config/named-account-targets` 返回默认三档（重点 1/周 · 目标 1/月 · 潜力 1/季），未配时 DEFAULTS 生效（幂等）。
2. `PUT` 修改档位/频率/窗口后 `config_store['named-account-targets']` 持久化且带 `decision_id` 凭证（第0闸，无决策不写）。
3. configCenter（config.html）出现 #30 卡片，可打开配置页；基础数据门户无该配置项（边界保持）。
4. account-360 画像 Tab 显示「目标达标」卡：目标频率 vs 窗口内实际拜访次数 + ✅/⚠️ 标记，数据与 `visit_notes` 长度实测一致。
5. named-accounts 看板「达标标记」列与 account-360 同一函数计算结果一致（无重复实现）。
6. `grep -r "|BANTCC|sales_" ~/.workbuddy/skills/ai-*` 为空（10-ai-* 基线不污染，铁律不变）。
