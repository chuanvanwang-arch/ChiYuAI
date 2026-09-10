# 线索自主发现引擎 · 10 大 AI 原生能力系统自检

> 配套文档：`docs/2026-09-10-lead-discovery-design.md`（v5 设计）。
> 目的：用 10 个 `ai_*` SKILL 方法论基线（跨域 AI 原生能力审计基线）对已批准前的 v5 设计做**逐能力系统自检**，回答两件事——① 新方案如何实现该能力；② 跟原功能如何结合；并标记缺口。
> 状态：设计阶段审计（未进 writing-plans、未写实现代码，守 HARD-GATE）。
> 日期：2026-09-10

---

## 0. 总览（原生覆盖度 × 关键缺口）

| # | 能力（ai_* SKILL） | 原生覆盖度 | 关键缺口（首条） |
|---|---|---|---|
| 1 | particle-system-design | ⚠️ 部分 | AI 属性未做 2D（能力轴×来源轴）+ J_Judge；无 why_narrative；缺 L1–L4 标注 |
| 2 | ontology-vector-build | ✅ 基本 | 研究笔记未分块带 source_ref；缺 content_hash 幂等 + 覆盖率≥80% 监控 |
| 3 | context-layering | ⚠️ 部分 | 未对接受保护的 context-routing(id36)；研究结论未规划为 L2 注入契约；缺 64KB 体积闸 |
| 4 | memory-lifecycle | ⚠️ 部分 | 缺 30 天写入门槛 + 低置信(<0.6)不记 + 蒸馏；human_override 回写未接 |
| 5 | native-action-design | ⚠️ 部分 | R3 同形折叠未判（run/enrich/research 应否合并为 op 枚举）；R6 force 高危写未设；needsApproval 未显式 |
| 6 | multi-agent-orchestration | ⚠️ 部分 | §8 仍写 `lead-miner`（已修正）；发现循环缺 kanban 状态机 + 熔断 |
| 7 | portal-page-generation | ⚠️ 部分 | discovery 页未走 NL→受控 Schema→渲染器；缺 4 粒子护栏 + Action 白名单校验 |
| 8 | event-driven-evolution | ⚠️ 部分 | ICP 自进化缺回测(threshold/count/noop) + HITL 草稿审批；`discovery` 事件未 grep 验证 |
| 9 | feedback-loop | ❌ 缺口 | 无指标模板（7 要素）、无 evaluator、无 Token-业务因果对账 |
| 10 | capability-audit | ✅ 本文件即 | 缺 21 维自评表；落地判定须验「引擎存在未接线=假执行」 |

> 判定口径（来自 ai-capability-audit）：✅ 已落地/已接线；⚠️ 部分（有接口无闭环/无调用点/无监控）；❌ 未设计。
> **结论先行**：方案在「架构衔接」（§9）层面扎实，但在「能力闭环的治理细节」（属性 2D、幂等、生命周期门槛、反馈指标模板、门户护栏）上有 9 处 ⚠️、1 处 ❌，**尚不构成进 writing-plans 的充分条件**——须先消解 P0（见 §12）。

---

## 1. ai-particle-system-design（M0 数据底座）

**能力要义**：业务建模为「粒子+状态+关联边」最小完备模型；阶段不炸开（线索→商机→合同合并单粒子+状态机）；10 维属性，AI 属性须 2D（能力轴×来源轴）且 J_Judge 必覆盖；知识资产标 L1–L4；核心粒子带 why_narrative。验收：粒子≤15 过 C0–C4；阶段合并无炸开；AI 属性 1–5 且 J_Judge 覆盖；L1–L4 归属标注；已留注入契约。

**1.1 新方案如何实现**
- 复用 `CRM_ACCOUNT(state='potential')` + `CRM_CONTACT` + `CRM_DEAL(stage='lead')` 三载体（§5），**不新增粒子**——契合「阶段不炸开」铁律。
- 富集字段存 `payload.enrichment`：`{value, provider, confidence, ts}`；评分存 `payload.discovery`：`{icp_fit_score, intent_score, signals[]}`（§5）。

**1.2 跟原功能如何结合**
- 载体即 `crm.particles` 的 `type` 取值（`schema.sql:11-30`）；`sourcedFrom` 已是受控边谓词（`connectorActions.js:41`）；租户隔离靠写时透传 `ctx.tenantId`（`connectorActions.js:45`、`tenderConnector.js:57`）。

**1.3 缺口（P0/P1）**
- 🔴 **P0 — AI 属性未 2D + 无 J_Judge**：`intent_score`/`icp_fit_score` 及 `enrichment.*.confidence` 只有「来源轴」(provider/confidence)，缺「能力轴」(谁判的/基于哪条规则) 与 J_Judge 覆盖声明。须补：评分字段加 `judge:{axis, rule_ref, j_score}`，且 J_Judge 维度显式覆盖。
- 🟠 **P1 — 无 why_narrative**：发现引擎产出的 `potential` 账户，核心是「为何被发现」（哪个信号/哪次决策），但设计只放 `payload.discovery.signals` + `sourcedFrom` 边，未落到 `why_narrative`（SKILL 铁律：只答 What=数据库，能答 Why=记忆系统）。建议把 `discovery.signals` + decision_id 折叠进 `why_narrative`。
- 🟠 **P1 — 缺 L1–L4 归属**：富集/研究结果作为知识资产，未标 L1–L4 层 + source（SKILL 要求知识资产标层）。`payload.enrichment`/`research` 须补 `layer` 与 `source` 字段。
- 🟡 **P2 — 属性集无限**：`industry/headcount/email` 等自由字段名未映射到 19 种有穷属性集，应做取值收敛。

---

## 2. ai-ontology-vector-build（M0 写时构建）

**能力要义**：写库即构建——三钩子 `ensureEmbedding`(content_hash 幂等)/`ensureTsVector`(FTS 双写)/`ontologySync`(类型校验+边更新+词汇登记)；三层管道 文档→分块→向量（块带 source_ref）；embedding 覆盖率≥80% 监控；失败 fail-open 落监控标记。验收：三钩子齐备幂等；非整篇一向量；FTS+向量双通道；覆盖率≥80%；失败落监控。

**2.1 新方案如何实现**
- 写入即富集：`ontologySync`（`src/ontology/hooks.js:48-113`）在粒子写时自动生成受控边 + 登记词表 → `CRM_KNOWLEDGE`（§9.2）。这是「本体优先」反转的底座。

**2.2 跟原功能如何结合**
- 复用既有 `ontologySync`，无需新写钩子；`sourcedFrom` 边经 `meta.edge_source`（`hooks.js:61,88,101`）留痕。

**2.3 缺口（P1/P2）**
- 🟠 **P1 — 研究笔记未分块带 source_ref**：Claygent 输出是长报告（`payload.research.summary`），违反「非整篇一向量」。须将研究报告切分为带 `source_ref` 的块再入向量。
- 🟠 **P1 — 缺 content_hash 幂等**：对同一账户重复 discovery 会重复生成边/向量，可能制造「僵尸边」。须加 content_hash 去重（钩子级）。
- 🟡 **P2 — 缺覆盖率≥80% 监控 + backfill**：框架应监控 embedding 覆盖率并补存量，设计未含。
- 🟡 **P2 — fail-open 监控标记缺失**：provider 失败时应落监控标记而非静默。

---

## 3. ai-context-layering（M1 运行时注入）

**能力要义**：运行时按 L1–L4 累积注入；L3 纯函数无 I/O、L4 禁缓存；`buildKnowledgeNeeds` 编码；体积上限 64KB；供需一致性矩阵；L2 三级降级链 FTS→向量→纯 FTS；检索返回自证。验收：四层通道+降级链；供需矩阵阈值；L4 禁缓存；检索自证；pendingGates=0 才执行。

**3.1 新方案如何实现**
- 发现结论（研究笔记/评分）经记忆层沉淀后，应由 L2（memory）通道注入下游 Agent 上下文（§9.3 提及 capture→memory→L2）。

**3.2 跟原功能如何结合**
- 复用 `capture.js` 事件订阅 + SSE（`sse.js:24`）广播；记忆经 L2 注入既有机制。

**3.3 缺口（P0/P1）**
- 🔴 **P0 — 触碰受保护 context-routing(id36) 风险**：记忆/发现结论要注入上下文，必须经 `src/context/routing.js` 装配。但 id36 于 2026-09-04 起**禁止修改**（见项目内存红线）。设计未说明发现引擎如何在不改 routing 的前提下注入——可能隐性踩红线。须明确：仅消费现有 L2 通道，绝不改 routing 配置。
- 🟠 **P1 — 未规划 L2 注入契约**：`buildKnowledgeNeeds`/`task-assembler` 契约（`KnowledgeProfile.tasks→…→KnowledgeContextPackage`）未被 discovery 引用；研究结论如何成为「可注入知识包」未定义。
- 🟠 **P1 — 缺 64KB 体积闸**：整份研究报告若被整段注入，可能撑爆上下文上限。须设 `truncated` 标记 + `degradedLayers` 处理。

---

## 4. ai-memory-lifecycle（M0 记忆治理）

**能力要义**：三层 L-Cloud/L-User/L-Workspace；生命周期五阶段；双轨 append-only 日志 + curated 笔记（distilled 标记）；蒸馏 30 天；记忆须能答 Why；低置信 AI 属性(<0.6)不记；捕获是工作副产物。

**4.1 新方案如何实现**
- emit `discovery` 领域事件 → `capture.js` 订阅 → 自动入记忆（§9.3）；或直接 `crm-memory-upsert` 写 Claygent 笔记。

**4.2 跟原功能如何结合**
- 复用 `crm.memory_log`/`memory_note` + `capture.js`（`DEFAULT_CAPTURE_DOMAINS:16-19`）+ `precipitate.js:100`；SSE 实时可见。

**4.3 缺口（P1/P2）**
- 🟠 **P1 — 缺 30 天写入门槛**：`discovery` 捕获域未设「30 天后还有价值吗」过滤（如瞬时 funding 信号未必值得长存）。须加捕获域级门槛。
- 🟠 **P1 — 低置信(<0.6)不记**：discovery 评分/AI 字段未设置信门槛即写记忆，违反铁律。须 gate。
- 🟠 **P1 — human_override 回写未接**：ICP 自进化（closed-won/lost 重校准）应回写记忆，但记忆回写路径（`memoryStore.writeNote`）未显式接。
- 🟡 **P2 — 蒸馏未规划**：Claygent 笔记 30 天后应标 distilled，设计未含。

---

## 5. ai-native-action-design（M2 Action 表面）

**能力要义**：R2 业务对象走 `data.particle` type 值不各开 CRUD；R1 能力层按动词定数；R3 同形状折叠为 op 枚举（R3-RED 红线：幂等/needsApproval/审计/Actor 不同禁折）；R4 审批是属性非类；R6 高危写需 force 参数（默认 false→403）。验收：总数可被 R1–R6 解释；无 CRUD 爆炸；关系边未开 Action；高危写带 force；横切属性完整。

**5.1 新方案如何实现**
- 注册 `discovery-run` / `discovery-enrich` / `discovery-research` 三动作，经三处硬闭包（§9.8）；可继承 `autoDecision:true` + `autoWeakEdge:true, weakPredicate:'sourcedFrom'`（§9.8）。

**5.2 跟原功能如何结合**
- 复用 `registerAction`（`registry.js:6-21`）+ 既有 `conn-*` 连接器动作范式（`connectorActions.js:17`）；MCP 由 Registry 派生（`tools.js:41-130`），非 `data-*` 前缀自动暴露。

**5.3 缺口（P1/P2）**
- 🟠 **P1 — R3 同形折叠未判**：`run/enrich/research` 三者是否「同形状」？若都是「对 account 执行一步发现动作」，应折叠为 1 个 `discovery` 动作 + `op` 枚举（run|enrich|research），而非 3 个独立 Action。须按 R3-RED 校验（幂等性/needsApproval/Actor 是否相同）。
- 🟠 **P1 — R6 force 高危写未设**：`discovery-run` 会新建 `CRM_ACCOUNT(potential)` 粒子（写操作），属高危写，须带 `force` 参数（默认 false→403），设计只说「过第 0 闸」未说 force。
- 🟠 **P1 — needsApproval 未显式**：写动作须 `needsApproval` 显式耦合 L4 gate（第 0 闸），设计未声明该属性。
- 🟡 **P2 — 消费/产出粒子属性级映射**：Action 的 input/output 未做粒子属性级映射表（SKILL 验收项）。

---

## 6. ai-multi-agent-orchestration（M2 多智能体编排）

**能力要义**：编排四支柱（切分+状态机+环境隔离+结果回收，落盘 worktree）；状态机含 blocked/zombie，熔断 failure_limit 默认 2；profile 注入=环境隔离；六维推导 Agent；装配校验六条断言。验收：状态机完备+熔断+审计；profile 隔离；worker 走 Agent Loop；每 Agent 六维卡+SD 校验。

**6.1 新方案如何实现**
- 不新增 Agent；`discovery-*` 由既有 Agent（intake-router / decision-agent）经事件矩阵/intake 路由调用，复用 `runWithSkill` 单身份单 SKILL（§9.10）。

**6.2 跟原功能如何结合**
- 复用 `scheduler.routeThroughIntake`（`scheduler.js:38-91`）+ `runWithSkill`（`agentLoop.js:61`）+ 事件矩阵 `eventTrigger.js:22-24`；对齐「knowledge-searcher 不是 Agent、单步推理不走容器」原则。

**6.3 缺口（P0/P1）**
- 🔴 **P0（已修）— §8 仍写 `agent: lead-miner`**：与 §9.10 结论矛盾，已在本轮修正为 `decision-agent` 并加注。
- 🟠 **P1 — 发现循环缺 kanban 状态机 + 熔断**：「发现→研究→评分→复核」是一串任务，应建模为 kanban 状态机（含 blocked/zombie + `failure_limit=2` 熔断），设计未建模任务生命周期。
- 🟠 **P1 — 六维卡 + SD 校验未做**：承载 `lead-discovery` SKILL 的既有 Agent 须带六维能力卡；装配须过六条断言（不只现有两道硬闭包）。
- 🟡 **P2 — profile 环境隔离未显式接**：discovery 在 decision-agent 下运行时，tenant profile 注入作为隔离通道未点明（tenantId 透传已覆盖，但 profile 维度未提）。

---

## 7. ai-portal-page-generation（M2 门户生成）

**能力要义**：NL→受控 JSON Schema→运行时渲染器（禁 NL 直出 HTML）；绑定粒子数据不自由取数；三层护栏；Schema 4 粒子护栏（particleType 受控枚举/stage 仅 eq/qty 仅 latest/Action 白名单）；门户子槽位复用本域治理台；双输出同源 HTML+MCP Resources。验收：三段式边界；4 粒子校验；双输出同源；页面绑定 agent_loop trace。

**7.1 新方案如何实现**
- 胶囊：`buddy-crm-manifest.json` 的 `workModes[].capsules[]` 加一项，`skill`=discovery MCP 工具名（§9.7）；后台 `discovery-rules.html` 经 `configCenter` 暴露。

**7.2 跟原功能如何结合**
- 复用 `buddy-crm-portal.html:54-94` 的 `CAPS` + `postMessage({type:'inject-prompt'})` 调入 MCP；复用 `configCenter.js:11-72` + `configRouter.js:51-161` 配置页范式。

**7.3 缺口（P1/P2）**
- 🟠 **P1 — discovery 页未走 NL→受控 Schema→渲染器**：`discovery-rules.html` 若手写为自由 HTML，违反三段式护栏。须经由门户生成协议（受控 Schema + 运行时渲染器），不直出 HTML。
- 🟠 **P1 — 缺 4 粒子护栏 + Action 白名单**：绑定 `CRM_ACCOUNT(potential)` 的页面须过 4 粒子校验（particleType 枚举、stage 仅 eq、qty 仅 latest），且按钮只映射注册 Action 白名单（含 `discovery-*`）。设计未校验。
- 🟡 **P2 — NL 生成机会未用**：`/api/page/from-nl` 可让用户说「看我发现的线索」即生成页，设计未引用该路径。

---

## 8. ai-event-driven-evolution（M2 自我进化）

**能力要义**：三原则 Accumulation/Reflection/Correction；沉淀五判据；防 churn；修完必回测（threshold/count/noop 三形态）；草稿 HITL 审批才 validated，绝不自动生效。验收：事件与任务分表；回测覆盖核心路径；回写路径明确；删除/重构需用户同意；夜间轨草稿不自动生效；事件发射点 grep 验证存在。

**8.1 新方案如何实现**
- ICP 自进化：closed-won/lost → 重校准 discovery `decision_scenario`（§0.1 step6）；`ontology-sync` 事件 → `decision-enrich`（§9.4）。

**8.2 跟原功能如何结合**
- 复用 `eventTrigger.js:22-24` 矩阵 + self-evolution SKILL；结论回写 KNOWLEDGE 粒子/记忆。

**8.3 缺口（P0/P1）**
- 🔴 **P0 — ICP 自进化缺回测 + HITL 草稿审批**：「重校准 scenario」若自动生效，违反「草稿 HITL 审批才 validated、绝不自动生效」。须设计：重校准先落**草稿** → 回测(threshold/count/noop) → 人工审批 → 才 validated。
- 🟠 **P1 — `discovery` 事件未 grep 验证**：§9.3 的 `discovery` 领域事件是「待加」项，须在实施前 grep `src/events/bus.js` / `capture.js` 确认发射点与订阅链真实存在（防「纸面事件」）。
- 🟠 **P1 — Accumulation 未设计**：discovery SKILL 自身应从多步运行沉淀经验（如「哪类源命中率最高」），设计只提 Reflection（重校准）未提 Accumulation。

---

## 9. ai-feedback-loop（G 反馈闭环）

**能力要义**：LOOP 框架七步；指标模板七要素（direction/formula/target/alert/owner_agent/evaluator_skill/adjust_actions）；人机分工四判据；evaluator 加权 pass_rule+三档阈值；Token-业务因果对账。验收：每条回路≥1 指标模板；evaluator 加权阈值；质量闸门驱动回滚；看板前端化；Token-业务对账。

**9.1 新方案如何实现**
- （仅 §0.1 step6 高层描述）closed-won/lost → 重校准发现决策。

**9.2 跟原功能如何结合**
- 复用 feedback-loop SKILL + event-driven-evolution 回写路径。

**9.3 缺口（P0 — 本能力在设计中基本缺失）**
- 🔴 **P0 — 无指标模板（7 要素）**：discovery 反馈回路只字未提「发现→赢单率」的指标模板。须补：① 指标（如 `discovered_to_won_rate`，含 direction/formula/target/alert/owner_agent=`decision-retro`/evaluator_skill=`method-decision-enrich`/adjust_actions=重校准 scenario）；② evaluator 加权 pass_rule + 三档阈值；③ 质量闸门驱动回滚（非只熔断）。
- 🔴 **P0 — 无 Token-业务因果对账**：provider API 调用成本须对账到赢单业务结果（哪笔 discovery 花费带来哪单成交），设计未含。
- 🟠 **P1 — 人机分工四判据未显式**：哪些环节 Agent 自主（评分）、哪些人（写出 HITL）已大致覆盖，但「不可逆→人」判据未点名（如 ICP 规则变更须人）。

---

## 10. ai-capability-audit（M3 能力审计）

**能力要义**：以代码为准（函数存在≠已落地）；判据动态引用 9 个 ai-*；三查法 grep→Read→交叉引用；缺口三要素（断言+代码证据+影响）；0 数据≠闭环。验收：每缺口有 file:line；已读历史基线；分级 ✅/⚠️/❌ + P0/P1/P2；疑似缺口下钻；报告存 docs/ 含 21 维自评；HARD-GATE 未确认不实施。

**10.1 新方案如何实现 / 10.2 跟原功能结合**
- 本文件即审计载体；§9 衔接已带 file:line 锚点；缺口分级已在 §0 总览 + 各节标注。

**10.3 缺口（P1）**
- 🟠 **P1 — 缺 21 维自评表**：须附知识治理 21 分维度自评（来源 ai-capability-audit SKILL.md:141），作为落地判定基线。
- 🟠 **P1 — 「引擎存在未接线=假执行」须验**：各 §9 锚点须在实施后逐条回查「是否真有调用点 + 真有运行数据」，避免纸面接线。

---

## 11. 重新梳理后的方案骨架（按 10 能力组织）

> 回答「重新梳理」：把 v5 的「功能→原语」映射重排为「能力→实现→结合」三段式，暴露治理细节缺口。

```
[1 particle]    CRM_ACCOUNT(potential)/CONTACT/DEAL(lead) + sourcedFrom
                + AI属性2D(judge)+why_narrative+L1-L4标注        ← 补 P0
[2 ontology]    写时三钩子；研究笔记分块source_ref；content_hash幂等；覆盖率≥80%监控
[3 context]     仅消费现有L2通道(不改id36)；研究结论→KnowledgeContextPackage；64KB闸
[4 memory]      discovery事件→capture；30天门槛；<0.6不记；human_override回写；蒸馏
[5 action]      discovery 动作(R3折叠op枚举；R6 force；needsApproval显式)
[6 orchestration] 既有Agent经routeThroughIntake；发现循环=kanban状态机+熔断
[7 portal]      NL→受控Schema→渲染器；4粒子护栏+Action白名单；胶囊skill=discovery工具
[8 evolution]   ICP自进化=草稿→回测→HITL审批→validated（绝不自动生效）
[9 feedback]    指标模板(7要素)+evaluator+Token-业务对账
[10 audit]      21维自评+逐锚点回查接线
```

---

## 12. 修正清单（进 writing-plans 前的门槛）

**P0（必须消解，否则不得进 writing-plans）**
1. AI 属性补 2D（能力轴×来源轴）+ J_Judge 覆盖（§1 P0）。
2. 发现结论注入上下文**不得改 context-routing(id36)**，仅消费现有 L2 通道（§3 P0）。
3. ICP 自进化须草稿→回测→HITL 审批，绝不自动生效（§8 P0）。
4. feedback-loop 补指标模板(7要素)+evaluator+Token-业务对账（§9 P0）。

**P1（writing-plans 内必须含任务）**
5. research 笔记分块 source_ref + content_hash 幂等 + 覆盖率监控（§2）。
6. why_narrative + L1–L4 标注（§1）。
7. 记忆 30 天门槛 + <0.6 不记 + human_override 回写（§4）。
8. Action R3 折叠判定 + R6 force + needsApproval 显式（§5）。
9. 发现循环 kanban 状态机 + 熔断 + 六维卡 SD 校验（§6）。
10. discovery 页走门户生成协议 + 4 粒子护栏 + Action 白名单（§7）。
11. `discovery` 事件 grep 验证发射点（§8）。
12. 21 维自评表 + 逐锚点接线回查（§10）。

**P2（可后置）**
13. 属性集收敛到 19 种有穷集（§1）。
14. fail-open 监控标记 + backfill（§2）。
15. NL `/api/page/from-nl` 生成发现页（§7）。
16. profile 环境隔离显式接（§6）。

---

## 13. 结论（已收口 v7）

v5 在**架构衔接**（§9 八向 + KMD/智能体）层面成立；按 10 大 `ai_*` 方法论基线逐能力过堂暴露的**治理细节缺口**（1 处 ❌ feedback-loop、9 处 ⚠️、4 处 P0）**已全部消解**——4 个 P0 已补入主设计文档 v7 的 §5/§9.3/§9.4/§9.11/§0.1，D1/D2 已按用户决策拍板，D3/D4 沿用。

**处置结果**：
- P0 #1 AI 属性 2D + J_Judge + why_narrative + L1–L4 → 主文档 §5 已补；
- P0 #2 上下文红线（受保护 context-routing id36）→ 主文档 §9.3 已补硬约束；
- P0 #3 ICP 自进化草稿→回测→HITL→validated → 主文档 §0.1 step6 + §9.4 已补；
- P0 #4 feedback-loop 指标模板(7要素)+evaluator+Token 对账 → 主文档 §9.11 已补。

**结论**：主设计文档已升级为 **v7 设计已批准**，达「✅ 可进实施」门槛；9 处 ⚠️ 的治理细节列入 writing-plans 任务清单逐项消解。下一步移交 writing-plans 拆实施 Task（每 Task 一提交、三处硬闭包同步）。