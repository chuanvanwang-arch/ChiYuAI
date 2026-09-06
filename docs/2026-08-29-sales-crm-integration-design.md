# 销售管理体系 × CRM-ai-native 结合总体设计（概要设计）

> 版本：v0.3 概要设计 · 2026-08-29（整合"拜访质检闭环 + 两关前置报价闸 + 商机探测/待办 + 上下文完备性闸门 + 数字身份"）
> 状态：待评审（用户选定"先只做设计文档"；v0.1 后用户补充业务闭环口述，已并入 §5）
> 存放：`D:/system/CRM-ai-native/docs/2026-08-29-sales-crm-integration-design.md`
> 方法论来源：销售管理体系开放知识库（`skill: sales-knowledge-free`，导出 2026-08-28，前五层共 54 条）；用户业务闭环口述（2026-08-29）

## §0 结论与推荐

结合的本质：把 的"行为标准与方法论"转译为 CRM-ai-native 智能体的**运行时约束（evaluator 闸门）+ 领域知识底座（context L1 注入）**，并以**「拜访动作 → AI 质检 → 下一拜访计划」的行为闭环**作为数据入口与驱动引擎，使"One Agent per Customer"具备可量化、可追溯、可优化的销售行为合格线。

**推荐路径：方案 B（中度行为闸门）起步**，P0 第一项为**拜访记录填写/质检工具**（用户正在开发、即将上线），阶段推进闸为**双层**——（a）资质门控复用 `method-bant` BANTCC；（b）动作完成度门控（用户"两关"：客户参与确认 + 方案验证）。理由：方案 A 不改行为约束、收益浅；方案 C 架构级改造、周期长且当前无必要。

## §1 背景与目标

- 用户（王川）是 Agent2B 平台产品 owner 与 AI-native 架构师，主导 CRM-ai-native（AI 原生销售管理平台，参考 Kavak「One Customer, One Agent, One VM」模型，Stage 1 十 Task 基础 MVP）。
- 是经作者复审的 B2B 销售管理方法论：七大底层逻辑 / 七类行为习惯 / 21 条行为标准 / 大漏斗 / BANTCC。
- 用户正在做的"拜访记录填写"功能 = 销售归来反思"本次拜访对不对"的标准载体，是整套闭环入口；上线后其他 CRM 接入改造即可复用同一 AI 质检标准（平台化）。
- 目标：将 方法论 + 用户业务闭环注入 CRM-ai-native，使智能体输出的每一步销售行为都经"质检 → 仲裁 → 计划"闭环，且阶段推进受前置动作合格线约束。

## §2 结合对象现状（evidence-driven）

CRM-ai-native 已具备完整 AI 原生底座，可直接挂接，无需从零建设：

| 现有模块 | 路径 | 挂点 |
|---|---|---|
| AI 属性评估器 | `src/aiAttributes/evaluator.js` | 新增 行为合规 AI 属性键 |
| Action 执行器（多闸链） | `src/action/executor.js` | 新增 标准校验闸 |
| 上下文注入（L1–L4） | `src/context/injector.js` | 五层作 L1 知识源 |
| 校准旋钮 | `src/calibration/knobs/*` | 达成度作校准维度 |
| 方法论 skill | `skills/method-bant/` | 扩 BANT → BANTCC |
| 粒子/商机模型 | `src/aiAttributes/evaluator.js` (`CRM_DEAL`/`CRM_ACCOUNT`/`CRM_CONTACT`) | 大漏斗分层作粒子属性 |
| 拜访记录/回写 | `docs/2026-08-27-拜访归来回写操作卡.md`、`2026-08-27-新客户拜访备战包.md` | 拜访质检入口数据基础（在建） |
| 拜访质检闭环 | evaluator + decision + 活动计划 | 闭环驱动引擎（本设计 §5.0） |

关键代码锚点（verbatim 引用）：
- `executor.js:19-26` 第 0 闸 `decision_id`（无决策不写）；`executor.js:72-76` 写白名单闸；`executor.js:80-83` HITL 审批闸。闸应位于写白名单闸之后、实际 `def.handler`（`:96`）之前（建议**第 2.8 闸**）。
- `evaluator.js:5-24` `AI_ATTR_DEFS` 按粒子类型定义 AI 属性；`evaluator.js:105` `evaluateAiAttributesForAsync` 支持 LLM 批量求值 + 确定性兜底——属性复用同一 `payload.ai.*` 落点。
- `injector.js:11-13` L1 知识层已支持"相关知识(title)"注入——文档挂此层。

## §3 五层 → CRM 模块映射

| 层 | 转译目标 | 挂接点 | 落点 |
|---|---|---|---|
| L1 七大底层逻辑 | 领域知识底座 | `context/injector.js` L1 | 智能体 system context |
| L2 七类行为习惯 | Agent persona / 行为导航 | `context/roleProfiles.js` | 角色 profile |
| L3 21 条行为标准 | 执行质量闸门 | `action/executor.js` + `aiAttributes/evaluator.js` | 写 Action 前校验 / `payload.ai.*` |
| L4 底层逻辑详解 | 决策 why-narrative | `decision/provenance.js` | 推理溯源 |
| L5 规范项目 | 经理自检看板 | `http/*Router` / portal | 看板指标 |
| 大漏斗 / BANTCC | 粒子模型与属性 | `evaluator.js` `CRM_ACCOUNT`/`CRM_CONTACT` | 客户分层 + 商机资质 |
| 拜访质检闭环 | 行为反思引擎 | `evaluator` + `decision` + 活动计划 | 闭环驱动（§5.0） |

## §4 三方案对比

| 维度 | A 轻量知识注入 | B 中度行为闸门（推荐） | C 深度本体融合 |
|---|---|---|---|
| 改动范围 | 仅 L1 注入 | evaluator + executor 加闸 + 拜访质检入口 | 粒子模型 + 记忆重构 |
| 是否约束行为 | 否 | 是（双层闸 + 闭环） | 是（全面） |
| 见效周期 | 当天 | 1–2 迭代 | 长 |
| 风险 | 低 | 中（需防闸误杀） | 高 |
| 复用现有 | context 层 | context + evaluator + executor + 拜访记录 | 全部重构 |

## §5 推荐方案 B 详细设计

### §5.0 拜访质检闭环（P0 入口，用户业务闭环）

四环节（用户口述转译，附 溯源）：

1. **入口 · 拜访记录填写**：销售归来填写"本次拜访对不对"的标准载体 → BH-07-02 及时总结反省 / BN-07 行为标准化与定期反思。
2. **AI 质检**：销售陈述"拜访回来想告诉我什么" → AI 按标准判定 ①本次拜访有无价值 ②缺什么、该补什么 → BH-03-03 不做无效拜访 / BH-03-02 关注客户需求。
3. **一致性仲裁**：AI 认为的"下次该做什么" vs 销售自认"下次该做什么" → 一致放行；不一致 → 问改不改 → 销售决定并提交（下一步动作 + 时间）→ 抓取"拜访活动计划"。
4. **抓手**：活动计划可追踪、可执行、可优化；闭环回到下一拜访。

该闭环是 行为标准在 CRM 中的**运行化载体**，也是 evaluator `sales_*` 属性的数据来源。

### §5.1 行为属性（挂 `evaluator.js`）

在 `AI_ATTR_DEFS` 新增（复用现有 `payload.ai.*` 落点约定，`evaluator.js:67-83` `assembleAi`）：

```js
CRM_ACCOUNT: {
  sales_visit_frequency_adherence: { axis: 'A_Alert', source: '规则+AI确认', confidence: 0.85 }, // 目标客户月拜访 >= 1 次
  sales_bantcc_completeness:       { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.8 },  // BANTCC 五维齐全度
}
CRM_CONTACT: {
  sales_visit_value:  { axis: 'J_Judge', source: '规则+AI确认', confidence: 0.82 }, // 最近拜访是否被质检判为有价值
  sales_visit_gaps:   { axis: 'B_Brief', source: 'AI生成',       confidence: 0.8 },  // 质检判定缺失项列表
}
```

确定性兜底（`deterministicEval` 扩展）：`visit_frequency` 由最近拜访记录天数推导；`bantcc` 由粒子字段齐全度推导；`visit_value`/`visit_gaps` 由拜访质检记录状态推导（无 LLM 时 `degraded=true`，可复现）。

### §5.2 双层阶段推进闸（挂 `executor.js`，第 2.8 闸）

位于写白名单闸（`:72-76`）之后、实际写 `def.handler`（`:96`）之前，对 `crm-deal-advance` 校验：

- **(a) 资质门控（复用 `method-bant`）**：BANTCC 五维任一 `< 0.6` → **硬拦截**，返回 `gate:'sales_bantcc'`，提示补缺口（扩 C 维）。
- **(b) 动作完成度门控（用户"两关"）**：推进到报价/Proposal 阶段前，必须存在被判"有价值"的：
  - 关一 · 客户参与确认拜访记录（客户允许你参与，商量过）→ BH-04 关系管理 / 第二层"充满信心"；
  - 关二 · 方案验证拜访记录（方案已证能解决客户问题）→ BH-03-02 关注客户需求。
  两关缺失 → **硬拦截**，返回 `gate:'sales_action_prereq'`，提示"先补做对应拜访（参与确认 / 方案验证）"。
- **soft gate**：`crm-visit-plan-create` 目标客户本月拜访已 `>= 1` → 软提示（不阻断），emit `trace:'sales_visit_freq_ok'`。

### §5.3 数据流

拜访记录填写 → 质检判定（value / gaps）→ 落 `payload.ai.sales_*` → 阶段推进 Action 经第 2.8 闸（资质 BANTCC + 动作两关）→ 通过 → `def.handler` 写粒子 / 活动计划 → 注入 L1 / 经理看板 / 驱动下一拜访。

### §5.4 商机探测与待办生成（上级未报分支，用户框架）

触发：销售提交拜访记录 → AI 解析发现"存在未纳入管理视野的关键实体"（如提及"上级/决策人"但未建联系人/商机，或浮现明确需求但无商机项目）。

- **判定**：与现有粒子对比（`CRM_ACCOUNT`/`CRM_CONTACT`/`CRM_DEAL`），缺失 → 触发 `detected:opportunity_lead`。
- **动作**：生成**待办（todo）**提醒销售"建立上级/商机项目"，待办进入活动计划闭环（§5.0 第 3 环节），开始追踪执行。
- **溯源**：客户分层完整（大漏斗 BN-05）、决策人/关系管理 BH-04；核心理念=原 CRM 是"数据记录仪 + 上下文定义器"（用户原话）。
- **落点**：复用 §5.0 活动计划 + 现有 todo 机制；`detected` 事件写 events 总线（与 SSE 5 事件域 task/particle/approval 对齐）。

### §5.5 上下文完备性闸门 + 经理介入升级闭环（用户框架）

定义：原 CRM 核心是"把事情看清楚必须知道哪些信息"——即**上下文完备性**。信息不齐 → 让销售去搞清楚并汇报；弄不来 → 升级经理培训；弄来 → AI 判下一步。

- **context schema**：每个关键实体/动作定义"必需上下文字段清单"。
- **提交校验**：缺字段 → 返回 `gate:'context_incomplete'` + 缺项列表 + 指令"去搞清楚并汇报"。
- **升级**：连续 N 次无法补齐 → emit `escalate:manager_coach`，经理介入培训（闭环升级）。
- **补齐**：AI 判下一步动作（回 §5.0 仲裁）。
- **与 §5.2 三层递进**：`context_incomplete`（信息闸门）→ `sales_bantcc`（资质闸门）→ `sales_action_prereq`（行为闸门）→ 才放行 `crm-deal-advance`。信息齐 → 资质够 → 动作够 → 放行。
- **溯源**：及时总结反省 BH-07-02；行为规范 BN-07。

## §6 与 `method-bant` 的关系（避免重复/冲突）

- `skills/method-bant` 已实现 BANT 四维门控（`SKILL.md:26-38`），与 的 BANTCC 重叠 B/A/N/T 四维。
- "两关"动作完成度可视为 `method-bant`（BANT 资质）之上的**动作前置维度**，或独立为 `method-visit-quality` skill；待评审确定落点（均在 CRM 域内）。
- 边界：`method-bant` / `method-visit-quality` 是 CRM 域 skill（允许）；知识库是外部方法论来源。两者关系在 CRM 域内解决，**不污染 `~/.workbuddy/skills/ai-*`（通用方法论基线，10 大能力不可变动）**。

## §7 落地里程碑

- **P0（试点）**：① 拜访记录填写/质检工具上线（用户进行中）；② `evaluator.js` 加 `sales_*` 四属性（`visit_frequency_adherence` / `bantcc_completeness` / `visit_value` / `visit_gaps`）；③ `executor.js` 加第 2.8 闸双层（仅 `crm-deal-advance` 硬闸）。验收：推进到报价前"两关"缺失被拦。
- **P1（扩面）**：`crm-visit-plan-create` soft gate；L1 注入 L1–L3 知识；经理看板 BN-01~BN-07 覆盖度。
- **P2（深化）**：达成度接入 `calibration/knobs` 校准；why-narrative 溯源 `decision/provenance.js`；与 `method-bant` BANTCC 统一。

## §8 风险与边界

- **不污染通用 ai-* SKILL**：实例化内容只落 CRM 域（`docs/` + `skills/` 下 `crm-*` / `method-*`），禁止写入 `~/.workbuddy/skills/ai-*`。
- **闸误杀风险**：第 2.8 闸默认 soft（提示不阻断），硬闸仅限 `crm-deal-advance` 且可配置豁免；质检误判导致 advance 误杀时，以豁免开关兜底。
- **知识库边界**：`sales-knowledge-free` 仅前五层（54 条），BS（第六层）不在此；结合范围限于前五层。
- **提示词 vs 闸门**：知识注入（L1）不替代行为闸门（B）；试点期两者并行，以闸为准。

## §9 验收标准

1. **evidence**：文档所有模块引用均有 `file:line` 锚点，可回溯至 `src/` 真实代码。
2. **P0 验收（闭环）**：拜访记录填写后，AI 质检输出 `value` / `gaps`，且 `payload.ai.sales_visit_value` 在无 LLM 时由确定性兜底算出（`degraded=true`）。
3. **P0 验收（双层闸）**：`crm-deal-advance` 在 BANTCC 任一维 `< 0.6` 被拦（`gate:'sales_bantcc'`）；报价推进前"两关"拜访记录缺失被拦（`gate:'sales_action_prereq'`）。
4. **不污染**：`grep -r "\|BANTCC\|sales_" ~/.workbuddy/skills/ai-*` 应为空（实例化不进通用 SKILL）。
5. **文档自查**：无占位符、无前后矛盾、范围限定 CRM-ai-native。

---

## §10 用户框架与 设计的关系（互补 · 融合 · 本体先行 · 数字身份）

- **互补不冲突**：用户框架聚焦"销售过程行为训练 + 上下文记录仪 + 商机探测/经理升级"（关注"销售过程中的问题"）；本设计（）聚焦"方法论合格线 + 阶段推进闸 + 平台底座挂接"（关注"统一可追溯标准"）。两者不冲突，可融合。
- **融合方式（用户口述）**：客户做平台时，先把 习惯 / 线索-拜访关系植入，同步、互相引用；用户框架作 CRM 域"行为教练层"，作"方法论底座"。互相使用、互相引用。
- **本体先行但业务驱动**：用户想把"整个本体"弄好以省返工；但本体也在业务跑起来中迭代（提前全定难）。建议：先以最小可用粒子（客户/联系人/商机/拜访/待办）+ 属性键打底，业务跑起来再扩，避免匆匆上线后大量返工。
- **数字身份（愚道字典）**：用户开放知识库的根本目的 = 在 AI 世界建立并维护"正确数字形象"，使其他智能体/系统检索"愚道至简是做什么的"返回正确答案。知识库即数字身份的权威源——"建立了数字形象，别人才能找到你，要保证形象是对的"。

### 附录：知识编号（引用溯源用）

- 大漏斗频度：潜力客户每季 1 次 / 目标客户每月 1 次（规范项目 BN-05）
- BANTCC：`B` 预算 / `A` 权限 / `N` 需求 / `T` 时间线 / `C` 接触人 + `C` 竞争或变化（BH-03-01）
- 不做无效拜访：BH-03-03；访前准备/了解客户：BH-03-01 / 03-04；关注需求：BH-03-02
- 关系管理（客户参与）：BH-04 / 第二层"充满信心"
- 及时总结反省：BH-07-02；行为标准化与定期反思：BN-07
- 21 条行为标准：BH-01 ~ BH-07（含 34 子条）
- 七类习惯：第二层；七大底层逻辑：LG-01 ~ LG-07
