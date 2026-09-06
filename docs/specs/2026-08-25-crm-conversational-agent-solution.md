# AI 原生 CRM · 对话式智能体包 · 全面系统解决方案

- 日期：2026-08-25
- 状态：设计评审稿（brainstorming 流程产出，待用户评审后进入 writing-plans）
- 上位文档：
  - `docs/2026-08-25-ai-native-crm-overall-design.md`（总体架构：四平面 + 决策主轴 + §6.13 智能体包设计）
  - `docs/2026-08-25-0X-ai-*.md`（10 大能力实例化，X=01..10）
  - `docs/2026-08-25-cordyscrm-adoption-plan.md`（CordysCRM 组件级借鉴，本方案将其结论收敛进统一框架）
- 借鉴源：`D:\system\CRM-ai-native\CordysCRM-main\CordysCRM-skills-main`（9 引擎晶格 + 5 角色 + Skills-as-a-Service 插件）

---

## 0. 文档定位：本方案在体系中的位置

本方案不是第 11 份能力设计，而是**把既有总体设计 + 10 大能力 + CordysCRM 借鉴，收敛为"对话式人机协作"场景的唯一可执行总装**。

```
                四平面架构（总体设计 §1）
   ┌──────────────────────────────────────────────┐
   │ L4 呈现 · ai-portal-page-generation           │
   │      + ai-context-layering(L4 角色实例)        │
   │      └─ 对话式入口 = crm-* 的自然语言面        │
   ├──────────────────────────────────────────────┤
   │ L3 智能体 · ai-multi-agent-orchestration       │
   │      + ai-native-action-design + 记忆运行侧     │
   │      └─ crm-native 编排 + crm-query/write/risk │
   ├──────────────────────────────────────────────┤
   │ L2 事件 · ai-event-driven-evolution            │
   │      + ai-feedback-loop + ai-capability-audit  │
   │      └─ 写事件→预警/记忆/审计/反馈             │
   ├──────────────────────────────────────────────┤
   │ L1 粒子 · ai-particle-system-design            │
   │      + ai-ontology-vector-build               │
   │      └─ CRM_DEAL 单粒子合并 L2C + 写时构建      │
   └──────────────────────────────────────────────┘
                     ↑ 贯穿：决策事件主轴（§6，第0闸）
```

**一句话定位**：10 大 ai-* 能力 = 引擎室（能力底座）；对话式智能体包 `crm-*` = 引擎室上方的**对话式编排面**——人/外部智能体用自然语言下达意图，crm-* 把意图翻译成对 10 大能力的调用，全程走既有四平面与决策主轴，不另立炉灶。

---

## 1. 范式定位（先正名，避免照抄）

| 维度 | CordysCRM（借鉴源） | 本平台（我们） |
|---|---|---|
| 运行范式 | 人打字 → skill 翻 CLI → 调**外部 CRM** REST（reactive copilot） | agentLoop/kanban 派发，**写必带 `decision_id`**（autonomous）；人仍在环做大量执行 |
| 与 CRM 关系 | **外部包装层**（cordys.sh 连第三方 CRM） | **我们本身就是 CRM 本体** |
| 角色识别 | `ROLE_MAP` 环境变量按岗位关键词匹配 | context-layering **自推断**（L4 角色实例） |
| 预警 | 规则引擎 + 定时任务，人看告警 | 粒子写事件统一驱动，emit `decision_required` 可被自主派发 |
| 审计 | 外挂日志表 | 审计事件流原生内建（写钩子强制落） |

**核心判别（决定一切后续设计）**：
> 我们是 CRM 本体，不是外部包装层。因此 **CordysCRM 的设计资产全部可借，仅 transport 层替换**——砍掉 `curl → 外部 REST` 那一行，换成调我们自己的粒子 API / Action Registry / 决策网络，并经 MCP Server + HTTP API 无头暴露。

**端到端闭环取向**：自主跑完"人不想/不能做"的部分（风险探测 → 决策 → 派发 → 催收/升级）；人仍主导产生数据（跟进、录入、审批），智能体让这部分更快并兜底闭环。

---

## 2. 对话式智能体包在四平面的挂点

| 平面 | 本方案承载 | 调用/数据流向 |
|---|---|---|
| **L4 呈现** | `crm-query`/`crm-write`/`crm-risk` 的自然语言入口 + 角色自适应输出（借 output-engine 第一性原则） | NL → 受控 Schema（门户生成）→ 渲染；结果回显 |
| **L3 智能体** | `crm-native`（编排 agent）+ `crm-query`/`crm-write`/`crm-risk`（执行）+ agentLoop/kanban | 意图→Action；写经三闸；派发经 kanban；SSE 回推 |
| **L2 事件** | `crm-risk` 预警 = 粒子写事件驱动；审计/记忆/反馈挂在写事件上 | 写事件→总线→预警/记忆/审计/反馈 |
| **L1 粒子** | `crm-write` 落 `CRM_DEAL` 单粒子状态机 + 8 支撑粒子；写时三钩子自动构建 | 写通道→粒子写事件 |

**决策主轴贯穿**：所有 crm-write 写操作 + crm-risk 主动预警，一律经第 0 闸强制携带 `decision_id`；无决策不写。

---

## 3. 10 大 ai-* 能力 × 对话式智能体包 实例化矩阵（系统性核心）

> 这一节是"全面系统"的心脏：证明对话式包不是平行系统，而是 10 大能力的**对话式编排面**。每一行给出：能力挂点、对话式包如何调用它、与 CordysCRM 对应项的差异。

| # | 能力（挂点） | 对话式包如何实例化 | 与 CordysCRM 差异（官方 vs 我们） |
|---|---|---|---|
| 1 | **ai-particle-system-design**（L1） | `crm-write` 的"建客户/转商机/写合同/录回款"全部落到 `CRM_DEAL` 单粒子状态机（`lead→opp→quoted→contracted→ordered→paid→lost`）+ 8 支撑粒子；线索/商机/合同/订单/回款/发票是状态/快照，**非独立粒子**；**仅售前技术方案例外：新增 `CRM_TECHNICAL_PROPOSAL` 粒子**（挂 `CRM_DEAL`，受控边 `has_technical_proposal`），售前工作流（出方案/POC/投标）以其为载体 | 官方拆 lead/account/opportunity/contract/order 多张表；我们单粒子+状态机（§01）；官方无售前方案粒子，我们新增一颗粒子支撑售前闭环 |
| 2 | **ai-ontology-vector-build**（L1） | `crm-write` 每次写入自动触发写时三钩子（`ensureEmbedding`/`ensureTsVector`/`ontologySync`）；`crm-query` 的语义检索（"找高流失风险客户"）靠它 | 官方外部 REST 无写时构建；我们写库即构建（§02） |
| 3 | **ai-context-layering**（L4） | crm-* 的"角色自适应"= context-layering 四层累积注入 + **角色七要素**（数据范围/关注/预警/输出/权限）作为 L4 实例；共享上下文总线 = L1–L4 累积包 | 官方 `ROLE_MAP` 关键词匹配；我们**自推断**（§04） |
| 4 | **ai-memory-lifecycle**（L2/L3） | `crm-write` 的"写跟进记录"= 记忆流（`memory_log` append-only），跨会话可召回（"上次他说预算卡在谁那"）；`@提及`触发协作事件注入 | 官方 FollowUpPlan/Record/Comment/Mention 四张表；我们记忆流（§05） |
| 5 | **ai-native-action-design**（L3） | `crm-write` 调既有 `crm-*` Action（11 对象域聚合读/写动词）；写操作机制级过闸；**禁删从 Action 表面移除** | 官方按模块 CRUD；我们按对象域聚合 + 禁删机制化（§06） |
| 6 | **ai-multi-agent-orchestration**（L3） | `crm-native` = 编排 agent，意图路由后派发 `crm-query`/`crm-write`/`crm-risk` 子任务；经 kanban 派发、审计、SSE | 官方单 agent 直连 REST；我们中心化看板 + 状态机 + 环境隔离（§03） |
| 7 | **ai-event-driven-evolution**（L2） | `crm-risk` 链断裂检测 = **粒子写事件触发**的预警（非定时扫描）；emit `decision_required` 进总线→自主派发/反馈 | 官方规则引擎 + 定时任务；我们事件统一源（§07） |
| 8 | **ai-portal-page-generation**（L4） | `crm-query` 的"给我看漏斗页"= NL→受控 Schema→运行时渲染器，**禁止 NL 直出 HTML** | 官方 13 个 views 写死；我们受控 Schema 协议（§08） |
| 9 | **ai-feedback-loop**（L2） | `crm-risk` 的"应收对账"= 计划→记录→对账→动作闭环；预测偏差反哺模型 | 官方查询/报表；我们对账回路（§09） |
| 10 | **ai-capability-audit**（L2） | crm-* 全部写操作（人/智能体/外部）走三闸后**强制落审计事件**进总线；外部 MCP 调用全量进审计 | 官方外挂日志表；我们审计事件流原生内建（§10） |

**结论**：对话式包 = 10 大能力在"自然语言协作"场景的总装配。每一句人话最终都变成对既有能力的确定性调用，无能力外溢。

---

## 4. CordysCRM 组件 → 平台映射总表（借 / 改 / 重写）

### 4.1 九引擎晶格 → 我们模块（借纪律、不建平行框架）

| CordysCRM 引擎 | 借/改/重写 | 我们落点 | 加载方式 |
|---|---|---|---|
| GATE 意图路由 | 借 | `crm-native` 编排层意图识别 | 按需 |
| ROLE 角色透镜 | 借(改机制) | context-layering L4 自推断（薄层） | **唯一常驻薄核心** |
| FMT 输出 | 借 90% | crm-query/crm-write/crm-risk **共享输出模块**（第一性原则/≤5列/Emoji/角色感知） | 按需（写/查时） |
| QUERY | 借+改 | `crm-query` 内部（cli-spec 算子 Schema 借、外部端点换粒子） | 按需 |
| LINK 链路 | 借+改 | `crm-query` 内部（L2C 聚合，字段名换粒子外键） | 按需 |
| FUNNEL 漏斗 | 借+改 | `crm-query` 内部（`viewId` SELF/DEPT/ALL→context-layering scope） | 按需 |
| APPR 审批 | 改 | Action Registry 审批 Action + HITL（非独立 SKILL） | 按需 |
| WRITE 写入 | 借 90% | `crm-write` 内部（两阶段纪律 + 第0闸 + action-confirm） | 按需 |
| RISK 风险 | 借 80% + 升级 | `crm-risk` 内核（链断裂规则借；升级 emit `decision_required`） | **常驻主动** |

> **偏离说明**：CordysCRM 仅 ROLE 常驻；我们 **ROLE + RISK 双常驻**——"先于提问的预警"是平台主动能力，RISK 必须常驻探测，产出 `decision_required` 喂自主派发。

### 4.2 全组件复用判定

| 组件 | 判定 | 具体改造 |
|---|---|---|
| `scripts/cordys.sh` / `cordys.py` | **重写** | `curl→外部 REST` 删除，换调粒子 API / Action Registry / 决策网络（MCP/HTTP handler） |
| `.env.example` + `validate_url` + X-Access-Key | **重写** | 外部 CRM 凭证 → 外部智能体连**本平台**的 MCP 凭证（endpoint+token+scope）；域名白名单→RBAC scope 校验 |
| `references/crm-api.md` | **重写** | 外部 API 文档不可借；自写 `references/engine-api.md`（粒子/Action 表面） |
| `core/cli-spec.md` | **改** | 借命令契约形态 + 14 算子条件 Schema（EQUALS/IN/BETWEEN…）；删模块→外部端点映射，换粒子/Action 表面 |
| `core/cli-reference.md` | **改** | 借字段类型→操作符映射；改 `/lead/add` 端点+必填字段→映射 LEAD/CUSTOMER 粒子 schema |
| `core/intent-engine.md` | **借 90%** | 路由优先级、5 角色意图表、参数默认值——纯逻辑，仅重定目标 |
| `core/linkage-engine.md` | **借+改** | L2C 链路模型、Customer 360 逻辑借；字段名→粒子外键列 |
| `core/funnel-engine.md` | **借+改** | 漏斗/统计逻辑借；`viewId`→context-layering scope |
| `core/output-engine.md` | **借 90%** | 第一性原则/≤5列/Emoji/角色感知/大结果集——纯展示层无外部依赖 |
| `core/risk-engine.md` | **借 80% + 升级** | 链断裂规则（线索→客户>30天/赢单无合同/合同无回款计划/合同未开票/客户无跟进/链路健康汇总）直借；升级 emit `decision_required` |
| `core/write-engine.md` | **借 90%** | 两阶段纪律（取表单→校验→预览→对比→验证）+ 安全约束直借；`/{module}/module/form`→粒子元模型读取 |
| `profiles/*.md`（5 角色） | **借 80%** | 各角色关注点/日周月工作流/KPI 借作配置；删 ROLE_MAP，角色改自推断 |
| `rules/*`（form/field/business） | **重写** | 源为空占位（`# 技术站位，不加载`），只借"加载机制"并实现自有规则 |
| `agents/cordys-crm.md` + `plugin.json` + `SKILL.md` frontmatter | **借形态** | 插件骨架/智能体面孔/YAML frontmatter 借；`requiresSecrets:false` 零信任保留 |

### 4.3 组件 → 我们 SKILL 的关系类型

CordysCRM 的 `core/` 引擎**不是与我们 crm-* SKILL 一一对等，而是被打包进 crm-* SKILL 的内部实现模块**：

- **内核型**：`risk-engine` → `crm-risk` 内核；`write-engine` → `crm-write` 两阶段模块
- **共享模块型**：`output-engine` → crm-query/crm-write/crm-risk **三处共用**输出规范（定义一次，复用）
- **聚合型**：`cli-spec`读部分 + `linkage-engine` + `funnel-engine` → 聚合进 `crm-query`
- **配置型**：`profiles/*` → crm-* 共用角色自适应配置（删 ROLE_MAP）
- **丢弃型**：`scripts/cordys.sh`、`.env` 凭证模型、`references/crm-api.md` → 不进 SKILL

---

## 5. 保留的 4 个 SKILL + 内部结构

> 人仍主导大量 CRM 执行工作，故保留"人做工作"这一层的 SKILL；九引擎是这 4 个 SKILL 的内部骨架，不对外单独成 SKILL。

| # | 保留 SKILL | 服务的人机任务 | 内部引擎模块 |
|---|---|---|---|
| 1 | **crm-query** | 销售"今天该跟谁"/经理"团队漏斗"/高管"经营视图"/财务"应收全景"/**售前"这单技术匹配度与方案就绪度"**——人每天**看** | QUERY + LINK + FUNNEL + **TECH（技术方案检索/技术匹配评估）** + 共享 FMT |
| 2 | **crm-write** | 销售 90% 工作=录入：跟进记录/商机推进/线索转化/报价/合同——人**产生数据**；**售前：生成/更新技术方案** | WRITE 两阶段（含 `crm-tech-proposal-create`）+ 共享 FMT |
| 3 | **crm-risk** | 财务看逾期催收/商务看合同到期/全员看"哪里不对"——人**看到后处置**；**售前：方案超期未出/POC 卡顿预警** | RISK 内核（含售前链断裂：商机→技术方案>30天/赢单前无方案）+ 共享 FMT + emit decision_required |
| 4 | **method-***（BANT/MEDDICC/**method-presales**） | 人做"这单能不能赢"判断时**参考方法论**；售前做"方案能不能支撑报价"时**参考售前方法论** | §6.6 自有，CordysCRM 无对应 |
| — | **6 角色 profiles** | 非独立 SKILL，是 crm-* 的"角色自适应"配置（展示什么/先展示什么/紧迫度）；**presales 已从占位补全为实质内容** | 借 profiles 内容，删 ROLE_MAP |

**内部结构图**：
```
注册于 skill_registry 的 crm-* SKILL
├── crm-native（编排 agent）
│     └── 内含 GATE 意图路由（借 intent-engine）
├── crm-query   → QUERY + LINK + FUNNEL + TECH(技术方案检索/匹配评估) + ★FMT(共享)
├── crm-write   → WRITE 两阶段(含 crm-tech-proposal-create) + ★FMT(共享)
├── crm-risk    → RISK 内核(含售前链断裂) + ★FMT(共享) + 升级 emit decision_required
├── method-*    → 自有（§6.6；含 method-presales 售前方法论）
└── 6 profiles  → 角色配置（销售/经理/高管/财务/售前/商务；商务与售前已拆分，§已批准；presales 已补全实质内容）
              （借内容删 ROLE_MAP；自推断由 context-layering L4）
```

---

## 6. 对内对外统一 + 插件与密钥

### 6.1 对内对外统一（单事实源 + 双适配入口）
- **定义一份**：`skills/crm-*/` 只写一次，注册进 `skill_registry`（`enabled`/`rbac_roles`/`version`）。
- **入口适配**：内部 = agentLoop in-process 加载；外部 = MCP Server 把 `token+scope` **翻译成平台内部身份**（复用同一 RBAC 引擎），再走同一内核。
- **治理同源**：无论内外，都过 第0闸 + 三闸 + action-confirm + HITL + 禁删。外部不开侧门（§6.6 Skills-as-a-Service）。
- **可见性一致**：`skill_registry.enabled=false` → 内外都不装载、市场不暴露。
- **权限硬闸（已批准并落地，2026-08-25）**：角色 RBAC 已 wiring 进执行内核——
  - Action 级：`registerAction(def)` 支持 `rbac_roles: string[]`（允许执行的 role_tag 白名单）；`executor.js` 第 1.5 闸在 Action 显式声明 `rbac_roles` 且已识别角色不在白名单时拦截（`gate: permission_denied`），未声明=默认开放（向后兼容阶段1）。
  - SKILL 级：`registerSkill(def)` 支持 `enabled` + `rbac_roles`；`skills/registry.js` `canExecuteSkill()` 在 `enabled===false` 或角色越权时拒绝。
  - 当前种子 Action/SKILL 均未声明 `rbac_roles`（默认开放），阶段2 的 2a 包将按角色逐项填入白名单（如 `crm-deal-advance`→`[sales,manager]`、`contract_admin` 专属合同 Action、`crm-tech-proposal-create`→`[presales,sales,manager]`、`method-presales`→`[presales]`）。

### 6.2 是否需要插件？
| 场景 | 是否需要插件 | 说明 |
|---|---|---|
| 平台内（自主运行） | **不需要** | crm-* 是原生能力，agentLoop 按需加载 |
| 对外（办公智能体协作） | MCP Server（必需）+ 插件包（可选） | MCP 替换 cordys.sh；插件包仅市场分发壳，内部不存密钥 |

### 6.3 密钥"方向翻转"（AccessKey/SecretKey 如何实现）
CordysCRM 的密钥是"指向外部 CRM 的钥匙"；我们的密钥是"**外部智能体接入本平台的身份凭证**"。

| CordysCRM 原参数 | 我们的对应物 | 方向 |
|---|---|---|
| `CRM_DOMAIN` | `PLATFORM_MCP_ENDPOINT` | 出→进 |
| `CORDYS_ACCESS_KEY` | `AGENT_ACCESS_KEY`（平台颁发） | 平台颁发给调用方 |
| `CORDYS_SECRET_KEY` | `AGENT_SECRET_KEY` / token | 平台颁发给调用方 |

- **流程**：平台后台为某办公智能体创建凭证（生成 access_key/secret_key 或 token）+ 勾选 `scope`（crm-query 只读/crm-write 写/crm-risk 预警/数据范围）→ 调用方填凭证+MCP endpoint → 调用时平台校验 `token→scope→RBAC` 放行。
- **安全红线（借零信任思想、改目标）**：密钥不进 SKILL 文件（`requiresSecrets:false`）；`validate_url` 域名白名单→平台侧 scope/endpoint 校验；继承绝对禁删/写前校验/最小权限降级。

---

## 7. 三平面影响分析

| 平面 | 影响 | 说明 |
|---|---|---|
| **数据面（L1+L2）** | **售前域结构性影响（其余无）** | 主链路（线索/商机/报价/合同/回款）仍复用既有 `CRM_DEAL` 单粒子状态机写同一套 L2C 粒子，无新增；**仅售前域新增 `CRM_TECHNICAL_PROPOSAL` 粒子**（挂 `CRM_DEAL`，受控边 `has_technical_proposal`），作为技术方案/POC/投标载体；NL 写入复用既有 Action + 第0闸；新增触发源仍是"链断裂→`decision_required`" |
| **智能体面（L3）** | **增强，骨架不变** | agentLoop/kanban/Action 不变；新增 NL 交互认知模块（九引擎）+ 角色自推断；能力从"执行计划"扩到"理解语境+NL 读写" |
| **决策面（决策主轴）** | **显著增强，最大受益面** | NL 写入与主动风险都汇入决策主轴（第0闸强制 `decision_id`）；自主决策引擎获更丰富先例；"先于提问"变决策触发燃料 |

---

## 8. 端到端数据流（两个完整例子）

**例 A — 人用 NL 写入（人主导执行）**
```
销售："把 X 客户转商机，预计 100 万"
 → crm-write 解析意图 + 角色自推断(sales)
 → 取 CRM_DEAL 元模型(两阶段:get_form) → 校验 → 预览对比
 → 调 Action crm-deal-transition(stage=opp, amount=100w)
    └─ 第0闸强制注入 decision_id（无决策不写）
    └─ 三闸: 规则层 → action-confirm → (超阈值 HITL)
 → 粒子写通道 → CRM_DEAL 状态机流转 + 写时三钩子(向量/FTS/本体)
 → 粒子写事件 → 事件总线 → 本体构建+记忆流+预警扫描+审计事件+反馈指标
 → SSE 推回前端 → 经理看板实时刷新
```

**例 B — 智能体主动预警（自主闭环）**
```
crm-risk 常驻探测：合同 Y 已 contracted 但 30 天无 PAYMENT_PLAN
 → 命中链断裂规则(借 risk-engine)
 → emit decision_required(严重度/处置建议)
 → 进事件总线 → agentLoop 自主派发催收任务(kanban)
 → HITL 闸点：人确认催收动作（或系统按策略自动升级）
 → 记忆流记录 + 审计事件 + 反馈指标更新
```

---

## 9. 7 场景验收 + 业务指标

| # | 场景 | 角色 | 引擎 | 验收锚点 |
|---|---|---|---|---|
| 1 | 销售晨会速览 | sales | ROLE+QUERY+RISK | 当日待跟进+紧急排序+超期预警 |
| 2 | 经理团队周会看板 | sales-manager | FUNNEL+ROLE | L2C 漏斗各阶数量/金额+成员排名+低转化识别 |
| 3 | 高管经营分析 | executive | FUNNEL+LINK | 区域对比+目标差距+季度管道预测(viewId=ALL) |
| 4 | 财务应收全景 | finance | RISK+LINK | 逾期清单+未回款预警+催收排序 |
| 5 | 商务合同到期预警 | contract_admin | RISK | 到期列表+续约建议+优先级排序 |
| 6 | 客户360全链路 | 全部 | LINK | 正向追溯+反向溯源聚合 |
| 7 | 一句话写入 | 全部(权限内) | WRITE+GATE | 取表单→校验→预览→创建→验证，绝对禁删 |
| 8 | 售前方案就绪度 | presales | ROLE+TECH+RISK | 商机技术匹配度+方案缺口清单+超期预警；出方案走 `crm-tech-proposal-create`（第0闸） |

**业务价值指标（验收口径）**：
- 查询：3–5 分钟 → **3–10 秒**
- 录入：1–2 分钟/条 → **10 秒/条**
- 零学习成本（自然语言）；主动预警先于提问

---

## 10. 安全与治理红线（机制级，非提示词）

1. **绝对禁删**：删除 Action 从 Action 表面移除，无"无声删除"路径。
2. **决策第 0 闸**：一切写操作强制携带 `decision_id`，无决策不写。
3. **写操作三闸**：规则层 → action-confirm → HITL 审批流（超阈值必经 HITL）。
4. **审计事件流**：每次写（人/智能体/外部）走三闸后强制落审计事件进总线，外部 MCP 调用全量进审计（§10）。
5. **零信任 + 最小权限**：SKILL `requiresSecrets:false`；外部凭证 scope 绑定；sales 默认最小写。
6. **写前校验 + 两阶段预览**：取表单→校验→预览对比→执行→验证，禁跳过校验/无预览批量/覆盖式全量更新（借 write-engine 安全约束）。

---

## 11. 阶段 2 落地路径（三包）

| 包 | 内容 | 借用的 CordysCRM 资产 |
|---|---|---|
| **2a 插件骨架 + 角色透镜** | `.workbuddy-plugin/plugin.json` + `agents/crm-native.md` + 5 `profiles/` + role-engine 常驻 + context-layering 自推断 | plugin.json/SKILL.md frontmatter 形态、profiles 内容（删 ROLE_MAP）、ROLE 常驻纪律 |
| **2b 查询 + 写入智能体** | `crm-query`(cli-spec 算子+cli-reference 字段映射+linkage+funnel) + `crm-write`(两阶段+第0闸+action-confirm) + 改写 `references/engine-api.md` | output-engine/intent-engine/linkage/funnel/write-engine 逻辑；cli-spec 算子 Schema |
| **2c 风险 + 方法论 + MCP** | `crm-risk`(全规则+SSE emit decision_required) + `method-*`(§6.6) + MCP Server(替换 cordys.sh) + `rules/` 分层治理 | risk-engine 链断裂规则、九引擎晶格按需加载纪律、.env→MCP 凭证模型（方向翻转） |

每包独立 Task、每 Task 一 commit（遵循项目铁律）。

---

## 12. 与既有文档的关系（防重复、防矛盾）

- 本方案 = 总装；**不重复** §01–§10 各能力的内部设计，只引用其"对话式实例化"落点。
- 总体设计 §6.13.1 旧表述"删除 cli-spec/cli-reference/cordys.sh"——**以本方案 §4 为准修正为"借设计资产、只砍 `curl→外部 REST` 那一行"**（§6.13 降为摘要指针即可）。
- `docs/2026-08-25-cordyscrm-adoption-plan.md` 保留为"组件级机制溯源"附录，被本方案 §4 引用。

---

> 本方案为设计评审稿。请评审后确认，确认后进入 `writing-plans` 拆阶段 2 实施计划（2a/2b/2c 三包 Task 级计划）。
