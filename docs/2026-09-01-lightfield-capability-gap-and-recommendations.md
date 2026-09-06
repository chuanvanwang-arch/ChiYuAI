# Lightfield 核心能力解构 × CRM-ai-native 差距分析与系统性建议

- 日期：2026-09-01
- 输入材料：4 篇微信文章（发狂的蜗牛 2026-02-27 / 唠点AI 2026-08-20 / 小莴实测 2026-05-26 / 七娘AI 2026-08-25）+ Lightfield 官网 lightfield.app（2026-08 快照）
- 性质：能力差距分析与建议（非实施设计；任何实施均需另行走 brainstorming → 设计文档 → 批准）
- 证据基线：本平台 src/ 真实代码 + docs/ 设计文档 + 运行期事实

---

## §0 结论（先给判断）

**Lightfield 的本质不是"CRM + AI"，而是三件事：①原始交互即真相源（Reality comes first）；②字段降级为派生视图（后验演化本体）；③Agent 基于完整客户记忆替人干活（write-back + HITL 护栏）。**

本平台在这三件事上的现状判定：

| 维度 | Lightfield | CRM-ai-native 现状 | 判定 |
|---|---|---|---|
| 原始交互即真相源 | 邮件/通话/会议自动转录捕获，无损存储 | visit_notes 手动结构化录入；memory capture 只订阅内部事件总线（`src/memory/capture.js:23`） | **最大差距** |
| 记忆的版本化与叙事 | versioned customer memory（chronology/attribution/causality/state） | decision 表 31 列已含 root_cause/confidence/outcome_verified（**问责维度反超**），但账户域无"怎么走到今天"的叙事线 | 部分覆盖 |
| Agent 写回 + HITL | agent 写字段/起草邮件，发送与关键字段更新前人审 | 5 agents + 第 0 闸 + 决策留痕（架构完备），**但 SKILL 接线断裂，全部恒执行 crm-skill-fallback**（`src/agent/agentLoop.js:63`，D4 缺陷） | 架构在、链路断 |
| 语义理解 | 真实 embedding + 故事化时间线 | L1 用确定性哈希向量（`src/ontology/embedding.js:5`，非语义），KG L3 运行期降级 | **明确短板** |
| 管理治理（Lightfield 无） | 无方法论、无决策问责、无可审计治理 | DSM 三套 SKILL + 阈值配置化 + 决策校准 + 398 测试闭环 | **本平台护城河** |

**核心建议一句话：不要照抄 Lightfield（它做的是个人/小团队的"免录入"，本平台做的是销售组织的"管理问责"），而要吸收它的三个机制层——证据层（原始交互捕获）、叙事层（故事化时间线）、写回层（agent 真正接线）——并叠加本平台独有的决策问责护城河，形成"Lightfield 的记忆 × CRM-ai-native 的问责"组合定位。**

---

## §1 Lightfield 核心能力解构（六项能力 + 一条第一性原则）

### 1.0 第一性原则："Reality comes first, everything else is computed from it"

官方博客原话：*"Summaries, fields, and dashboards are derived views—not the source of truth."* 系统存的是原始证据（谁、何时、说了什么、回应了什么），字段、摘要、看板全部是从原始证据**计算出来的派生视图**。这是它一切能力的地基。

### 1.1 零录入捕获（Capture）

连接邮件（Gmail/Outlook）、日历、会议（Zoom/Meet）、通话记录、数据仓库——这就是全部部署。用户实测：10 分钟重建 3 个月客户关系网络，47 个联系人自动建档。CRM 三十年的"人录数据"假设被直接消灭。

### 1.2 版本化客户记忆（Versioned customer memory）

每个客户不只是"当前状态"，而是四元组：
- **chronology**（时序：先发生了什么）
- **attribution**（归因：谁的态度变了）
- **causality**（因果：为什么变）
- **state**（状态演化：现在在哪、怎么到这里的）

关键人换岗、销售离职，关系历史不断裂——组织记忆不依赖任何个人的勤奋。

### 1.3 故事优先于图（Stories over graphs）

官方 2026-02 博客《LLMs also prefer stories to graphs and databases》实验结论：模型在知识图谱上表现不佳，"把关系抓得太紧，缺少对概念为什么相连的理解"；"图真的妨碍了建模人的可塑性"（人的预算和优先级会因对话而改变）。解法：**围绕人/公司维护一条实时更新的故事化时间线**，叙事与结构化数据一起喂给模型。注意：其 API 中的 context graph 是对象关系索引（含 how/when/why 变更史），不是替代叙事的推理图。

### 1.4 后验演化本体（Fields as derived views）

字段不是录入时预定义的，而是 AI 从原始互动**按需提取生成**，需要新维度时自动补字段并回填历史；schema 可整体 remap 重构。Peiris 原话："你不会被第一天、在你几乎还不了解销售流程时做的决定锁死。" 传统 CRM 是先验本体（结构先于事实），Lightfield 是后验演化本体（结构从事实中生长）。

### 1.5 Agent 写回 + HITL 护栏（Agent harness + write-back）

- 每个 CRM 对象属性带自然语言定义；agent 基于时间线上下文推理后**写回**：更新字段、创建记录、起草跟进邮件、总结会议。
- 自然语言 Agent Builder：Skills / Knowledge / Automations 共享积木 + API/MCP 对外连接。
- 幻觉无法消除 → 人审护栏：向客户发送通信、更新关键字段前必须人工批准。

### 1.6 交易诊断与复活（Deal diagnosis & revival）

标志性演示：打开一笔停滞的企业级交易，问"为什么卡住了？"——系统不返回摘要，而是**在沙盒中运行代码，将这笔交易与所有已赢/已输交易做模式对比**，发现"每笔赢单都让 IT 负责人早期介入；每笔输单都没能及早获得 IT 批准；这笔交易根本没有 IT 联系人"→ 直接行动：跑 20 个富化工具、LinkedIn 搜索 CIO、创建联系人、以销售口吻起草介绍邮件。客户实证：Voker.ai 两小时复活 40+ 笔停滞 6 个月的机会，10 笔两天内进入 POC；"杀手级功能是问'谁还没跟进'——大多数交易死于疏忽，而非拒绝"。

### 1.7 代价与边界（必须同时记录）

- 幻觉 → 靠人审兜底，未根治。
- 存放全部对话 → 隐私集中风险。
- schema 自由演化 → 大组织字段级治理难题，**可扩展性与大规模治理能力尚未被证实**（这恰是本平台的强项）。
- 定位局限：为 forward-deployed 公司（早期/中小团队）设计，无销售管理方法论、无管理层视角。

---

## §2 CRM-ai-native 现状基线（证据盘点）

| 能力域 | 已实现 | 证据 |
|---|---|---|
| 粒子数据模型 | particles 14 列 + meta_attr + stable_key 去重软合并 | `src/particles/`，2026-08-31 迁移基线 |
| 记忆生命周期 | 事件总线 residue 捕获 + memoryLog 分层 + 30 天蒸馏 | `src/memory/capture.js:23`（`on('*')` 单汇点）|
| 上下文分层 | L1 知识/L2 历史决策/L3 执行协同/L4 治理 + 降级链 | `src/context/assembler.js:1-4` |
| 决策主轴 | decision 31 列（root_cause/confidence/outcome_verified/confidence_source）+ 第 0 闸 + 校准闭环 | `src/calibration/`、`src/decision/` |
| 销售方法论 | stage-progression / funnel-classification / behavior-standard 三套 SKILL 生效 | `src/skills/seed.js` |
| 阈值配置化 | 21 条合格线/TAORAN/BANTCC 全走 config_store，代码只经 readThreshold() 读 | `src/sales/salesThresholds.js` |
| 业务闭环 | pipeline/named-accounts/behavior-board/合同/发票/回款，398/398 绿 | `src/sales/` 19 模块 |
| 跟进提醒 | follow-reminder sidebar + 提取设计 | docs/2026-08-31-follow-reminder-* |
| 门户受控渲染 | S01-S30 schema + renderPage，零硬编码色 | `src/pages/`、`src/web/tokens.css` |
| Agent 层 | 5 agents（intake-router/quote-engine/followup-agent/review-gate/decision-retro）+ kanban 派发 | `src/agent/` |
| SKILL 即服务 | skill registry + MCP 暴露（crm-native） | `src/skills/`、`src/mcp/` |

**三个关键运行期事实（差距所在）：**

1. **SKILL 接线断裂（D4）**：`src/agent/agentLoop.js:63` `const skillSlug = task.skill_slug || 'crm-skill-fallback'`，而 `createTask` 不含 skill_slug 列 → 6 组真实 episode 全部执行 fallback，名册 SKILL 从未被调用（docs/2026-09-01-retro-agent-wiring-design.md）。
2. **L1 是哈希向量非语义向量**：`src/ontology/embedding.js:5` 注释自证"确定性哈希向量（零外部依赖，可跑全量测试）"，生产可注入真模型但**尚未注入** → "理解"能力实质缺位。
3. **捕获域是内部事件不是外部交互**：capture.js 只订阅系统事件总线；visit_notes 是销售手动填的结构化 JSONB——正是 Lightfield 定义为"真相源"的那一层，本平台恰好没有。

---

## §3 对齐度矩阵（Lightfield 六能力 × 本平台）

| # | Lightfield 能力 | 本平台对应 | 差距 | 优先级 |
|---|---|---|---|---|
| 1 | 零录入捕获（邮件/通话/会议） | visit_notes 手动录入；importService 结构化导入 | **无原始证据层**——最大结构性缺口 | **P0** |
| 2 | Versioned memory（四元组） | decision 域已超集（问责字段）；账户域只有当前态 | 账户/联系人缺"演化叙事" | **P0** |
| 3 | 故事化时间线 > 图 | L2 检索决策先例（stableStringify 哈希匹配）；L3 KG 降级 | 无叙事装配；KG 不可用 | **P0** |
| 4 | Agent 写回 + HITL | 架构全有（第 0 闸/HITL/awaiting_confirm），**链路断** | D1-D4 缺陷未修（设计已备，待批准） | **P0（前置）** |
| 5 | 字段即派生视图 | meta_attr + 阈值配置化 + aiAttributes/evaluator（已有派生评估雏形） | 派生视图无 provenance、无回填 | P1 |
| 6 | 交易诊断与复活 | crm-deal-analyze SKILL 种子存在；follow-reminder 存在 | 无跨交易赢单/输单模式对比；无复活 agent | P1 |
| 7 | 语义理解（embedding） | hashVector 占位 | 换 SiliconFlow embedding 即可（注释已预留） | **P0（低成本）** |
| 8 | 引用溯源（answers with citations） | 无输出守卫 | 回答不带原始对话引用 | P1 |
| — | 管理治理（Lightfield 无此项） | **本平台独有**：方法论 SKILL + 阈值 + 校准 + 审计 | 不是差距，是差异化 | 保持 |

---

## §4 建议 P0：补齐"Lightfield 三层"的缺失底座

### 4.1 先修智能体接线（不做此步，其余全部是空中楼阁）

2026-09-01-retro-agent-wiring-design.md 已给出 D4→D2→D1→D3 修复序列且状态为待评审。**Lightfield 的 agent harness 对应物，本平台架构早已画好，只差把线焊上**。建议按该设计批准执行，验收锚点即其 §0 判定块：真实 episode 的 skill 字段命中各自声明的 method-* slug。

### 4.2 建立原始交互证据层（interaction evidence layer）

**这是本平台与 Lightfield 最大的结构性差距，也是最值得补的一层。**

- 新增交互证据表（粒子上不塞 JSONB，独立表挂 particle 引用）：记录 raw 原文/转录、媒介（wechat/call/meeting/email）、时间、参与人、来源。设计要点必须包含：schema 遵循"新增列走独立 ALTER TABLE 段"铁律（2026-08-30 教训）。
- **不建议**第一步就接 Gmail/Zoom API（中国销售场景不适用，隐私与合规复杂度高）；建议的第一落点：
  - **a. 拜访/通话速记 → 转录文本**：visit_notes 从"结构化结果"升级为"原始记录 + AI 派生结构"双层——销售只需丢进原始文本（甚至语音转写），结构化字段（BANTCC 维度、客户态度、action items）由 agent 按 aiAttributes 评估派生。**这一步就把"人录字段"翻转为"AI 派生字段"，直接兑现 derived views 原则，且完全复用现有 visit_notes/evaluator 链路。**
  - **b. 会议纪要捕获**：跟随 unstructured-asset-attach 设计（docs/2026-08-31），会议转录/纪要作为 KNOWLEDGE 粒子挂账户，进写时向量化。
- 存储原则一句话：**原始证据永不被覆盖，派生结构可随时重算**——与软合并铁律、决策留痕一脉相承。

### 4.3 账户演化叙事线（account storyline）+ 故事化 L2 装配

- **不建语义图**（Lightfield 的实验结论 + 本平台 L3 KG 已降级的运行期事实，双重印证），改为**叙事时间线**：以账户/联系人为轴，把 visit_notes 原文、决策事件（decision 域）、合同/回款事件、跟进提醒装配成带时间序的叙事串。
- 落点在 `src/context/assembler.js` 的 L2：现在 L2 检索的是"决策先例"（哈希精确匹配），增加"当前实体故事线"注入——agent 回答"这个客户聊到哪了"时不再靠向量猜，而是读叙事。
- 四元组映射：chronology=时间线本身；attribution/causality=**复用 decision 表的 root_cause/actor**（这是本平台已有而 Lightfield 公开材料中没有的深度）；state=粒子当前态。**无需新 schema，只需装配逻辑。**

### 4.4 语义向量换真（embedding 生产化）

`src/ontology/embedding.js` 已预留注入位（SiliconFlow embedding，vector(384)）。hashVector 只能做精确指纹匹配，无法支撑"上个月张总提了什么顾虑"式语义查询——这是 Lightfield Type 3"世界模型"与 Type 2"速记员"的分界线。改动小、收益直接，建议随 P0 一起做（须先确认 SiliconFlow embedding 模型维度并同步 schema 基线）。

---

## §5 建议 P1：杀手级场景对齐（Lightfield 已验证的 ROI 场景）

| 场景 | Lightfield 证据 | 本平台落点 | 建议 |
|---|---|---|---|
| 会前 Brief | "我还没开口，AI 已帮我做好功课" | customer-360 insight 已有数据面，缺"推"的动作 | 在账户详情页加"会前简报"：近 3 次交互叙事 + 未闭环承诺 + 决策链变化 + BANTCC 缺口。**纯装配，无新采集** |
| 交易诊断"为什么卡住" | 沙盒跑代码对比赢/输单模式 | crm-deal-analyze SKILL 已注册未被真调用 | 修复 D4 后，给该 SKILL 补"停滞归因"模式：对比同阶段已赢/已输交易的 aiAttributes 差异（如"赢单都有 IT 联系人早期介入"这类模式），输出归因 + 建议动作。**先做只读诊断，写回动作走第 0 闸** |
| 停滞交易复活 | 2 小时复活 40+ 停滞 6 个月机会 | funnel-quality 有停滞监测；缺批量复活 | followup-agent 增加 revival 分支：筛"正信号后沉默"账户 → 逐一生草稿邮件 → HITL 确认后发出 |
| "谁还没跟进" | "大多数交易死于疏忽，而非拒绝" | follow-reminder 已有 | 已对齐，保持；建议在今日优先级页（today-priority）把这个问题的答案置顶 |
| 回答带引用 | answers with citations to original conversations | LLM 回答无溯源 | 输出守卫：回答中涉及事实断言时附 visit_notes/决策 id 引用。与 P2P Output Guard Pipeline 的 CitationGuard 同构，方法论可平移 |

---

## §6 建议 P2：后验本体的渐进引入（谨慎区）

字段按需生成 + schema 自动重构是 Lightfield 最激进的部分，也是其**治理风险最大**的部分。本平台是多租户 + 管理问责定位，不建议全盘照搬，建议三步渐进：

1. **Provenance 先行**：meta_attr/aiAttributes 派生值记录 `derived_from`（源交互 id / 评估器版本 / 计算时间）——派生视图必须可追溯到证据，这也是决策问责铁律的自然延伸。
2. **受控按需字段**：允许 agent 在评估中"提议"新维度（如从拜访记录中反复出现"预算松动"信号 → 提议增加该维度），提议进决策第 0 闸审批，批准后注册 meta_attr 并**回填历史**（evaluator 重算）。**演化本体 + 治理闸门 = Lightfield 敏捷性 × 本平台可审计性的合成。**
3. **不做**自动 schema remap。多租户下 schema 是契约，重构须走变更管理。

---

## §7 定位建议：不追 Lightfield 的赛道，打它的盲区

Lightfield 的盲区恰好是本平台的护城河，组合定位建议：

| 维度 | Lightfield | CRM-ai-native 应取的姿态 |
|---|---|---|
| 目标用户 | forward-deployed 公司（创始人/小团队） | 销售组织（管理者 + 一线），DSM 方法论载体 |
| 核心承诺 | "You sell, agents do the rest"（消灭录入） | "Agent 干活，且每个动作可问责"（消灭录入 **+ 留痕**） |
| 数据哲学 | 后验本体、schema 自由演化 | 证据层后验 + 治理层先验（双层：底层 raw 自由生长，管理层受控派生） |
| 记忆深度 | versioned memory（叙事） | 叙事 + **决策问责**（root_cause/confidence/outcome_verified + 校准闭环）——Lightfield 公开材料中没有等价物 |
| 信任机制 | 人审发送/关键字段 | 第 0 闸 + awaiting_confirm + RBAC + 审计（更细粒度） |

一句话定位：**Lightfield 证明了"记忆比智能更值钱"；CRM-ai-native 的机会是证明"可问责的记忆比自由生长的记忆更值钱"——面向有治理诉求的组织的 AI 原生销售平台。**

---

## §8 风险与注意事项

1. **隐私与合规**：原始交互全文入库 = 隐私集中风险（Lightfield 自己也被诟病）。证据层设计必须前置考虑：租户隔离（已有 multi-tenant 基础）、敏感字段脱敏、保留期策略（与 30 天蒸馏策略对齐时的冲突需设计裁决）。
2. **幻觉治理**：agent 写回扩面（字段更新、邮件草稿）后，人审闸门覆盖率必须同步——第 0 闸是底线，不可为效率豁免。
3. **测试库 vs 生产库双态**：新增证据层表/列后，须按既定铁律用 information_schema 直查生产库确认迁移应用，勿信"测试全绿"。
4. **不要为对齐而做集成**：Gmail/Zoom/LinkedIn 类连接器在中国销售场景 ROI 低，证据层第一落点坚持"速记转写 + 会议纪要"（§4.2）。
5. **本文为分析建议，非实施授权**：任何条目进入实施均需单独走 brainstorming → 设计文档 → 批准流程。

---

## §9 优先级路线图（汇总）

| 优先级 | 事项 | 类型 | 依赖 |
|---|---|---|---|
| P0-1 | 批准并执行 retro-agent-wiring（D4→D2→D1→D3） | 修复既有设计 | 无（设计已备） |
| P0-2 | embedding 换真（SiliconFlow，vector 维度对齐） | 小改动大收益 | 确认模型维度 |
| P0-3 | visit_notes 双层化：原始记录 + AI 派生结构 | 新设计（brainstorming） | 无 |
| P0-4 | 账户故事线 + L2 叙事装配 | 新设计 | P0-3 证据层 |
| P1-1 | 会前 Brief（纯装配） | 新设计 | P0-4 |
| P1-2 | crm-deal-analyze 停滞归因模式（只读） | 增强 | P0-1 |
| P1-3 | followup revival 分支（HITL 发送） | 新设计 | P0-1 |
| P1-4 | 输出引用溯源（CitationGuard 平移） | 新设计 | P0-3 |
| P2-1 | 派生值 provenance（derived_from） | 新设计 | P0-3 |
| P2-2 | 受控按需字段（第 0 闸审批 + 历史回填） | 新设计 | P2-1 |

---

## 附录：材料证据边界声明

- Lightfield 数据口径：官网 2026-08 快照（5000+ 公司、SOC 2 Type II、定价 Pro $849/Growth $1999）；客户案例（Voker.ai、Humble Ops）为创始人自述，未经独立验证（唠点AI 文章已注明）。
- "本体会后验演化""故事优先于图"为 Lightfield 官方博客主张 + 本文分析视角，非行业定论；本平台采纳前应以自身数据做小规模 A/B 验证。
- 本平台现状判定全部基于 src/ 代码与 docs/ 设计文档 file:line 证据，运行期事实引自 2026-09-01 复盘接线设计文档。
