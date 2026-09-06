# AI 原生 CRM · 08 门户页面生成设计（ai-portal-page-generation）

- 日期：2026-08-25
- 方法论依据：`ai-portal-page-generation`（NL → 受控 JSON Schema → 运行时渲染器；门户体系收敛；AI 原生 UI 六铁律）
- 业务基线：`2026-08-24-ai-native-sales-crm-design.md` §5ter（业务全景 19 小节 + §5ter.15 十三场景）+ §5ter-quater Q.19（D9 差异点）/ Q.20（能力×业务设计输入）
- 前置架构：`docs/2026-08-25-ai-native-crm-overall-design.md` §1（四平面：本能力挂 L4 呈现平面·核心）/ §2（门户=阶段 2 启动）

## 0. 核心立场：对话即门户，页面即受控 Schema 的渲染

> **用户用自然语言描述视图需求，系统产出可运行页面；产出物不是自由 HTML，而是受控 JSON Schema —— 渲染器是唯一渲染出口，Schema 是唯一输入。严禁 NL 直出 HTML。**

对 CRM 销售域的关键判别（差异点 D9「界面生成化」+ D12「原生化」）：
- **官方 CordysCRM = 每个功能一个专用界面**（13 个 `views` 模块写死、各自路由、各自表单）；**我们 = 受控 Schema 协议驱动**——人配置界面与 AI 生成的界面**共用同一套运行时渲染器**，页面是门户的子槽位而非独立应用（门户体系收敛铁律）。
- **前端线路收敛**：web = Vue3 + Naive-UI；移动端 = Vant；两者都只消费同一份受控 Schema，页面由门户生成**按需产出**，不人工复刻固定页面（§3 阶段 3 风险缓解：「不一次复刻全部业务域」）。
- **数据绑定只能是粒子**：页面数据源限定为 §01 的 9 个粒子（CRM_DEAL/ACCOUNT/CONTACT/PRODUCT/PRICE_LIST/PERSON/ORGANIZATION/KNOWLEDGE/UNSTRUCTURED_ASSET），禁止生成任意 SQL/自由查询。

## 1. 方法论依据（提炼 SKILL 核心法则 / 铁律 / 判据）

本能力方法论通用、与具体域无关，CRM 仅做实例化替换。核心法则如下：

### 1.1 三段式管道铁律（不可推翻）

```
NL 输入 → [NL 解析层：意图→受控 Schema] → [Schema 层：结构化中间表示] → [渲染器层：运行时渲染]
                                          （禁止产出 HTML）          （可校验/版本化/可审计）   （Schema 是唯一输入）
```
- **判据-1（唯一渲染出口）**：渲染器是唯一渲染出口，Schema 是唯一输入；任何路径不得绕开 Schema 直接吐 HTML。
- **判据-2（禁止 NL 直出 HTML）**：NL 解析层只产出 Schema（含 confidence / needsClarification），**绝不产出 HTML 字符串**。

### 1.2 五条设计原则（不可推翻）

1. **NL → 受控 Schema → 渲染器**（三段式，禁止直出 HTML）。
2. **绑定粒子数据而非自由取数**：数据源必须是已建模粒子（见 §01），禁止生成任意查询。
3. **安全边界**：生成结果不执行任意代码；交互只调平台 Action（见 §action-design），不生成裸脚本。
4. **可回退**：生成页面可预览/编辑/放弃，绝不自动覆盖人工页面。
5. **可解释**：每次生成保留 NL 原文 + Schema + 生成理由，可追溯「页面为何长这样」。

### 1.3 三层护栏（纵深防御）

| 层 | 入口 | 职责 |
|---|---|---|
| 输入层 | `guardNlInput` | 拦截 `<script>`/`javascript:`/`on*`/`eval(`，从源头杜绝 NL 直出 HTML |
| 结构层 | `validatePageSchema` | 拒未知粒子类型、非白名单 Action、非法算子/颜色 |
| 渲染层 | `renderPage` | 渲染前再校验 → 全部动态值转义 → 交互仅 `data-action` 声明式 → 强制不含 `<script>` |

### 1.4 四条粒子校验规则（方法论核心，与域无关）

1. **particleType 值域受控**：仅 §01 的 9 个粒子枚举，旧粒子名（如拆模型前的 LEAD/OPPORTUNITY 独立粒子）**直接拒绝渲染**（非静默映射）。
2. **状态字段仅 eq 不聚合**：如 `CRM_DEAL.stage` 可作过滤（`stage=opportunity`）但**禁止作聚合指标**（状态机枚举不可度量）。
3. **存量快照字段仅 latest**：如金额/数量类聚合仅支持 `latest`，不支持跨记录 sum/avg。
4. **Action 白名单**：页面按钮只映射到注册 Action（crm-* 域动作 / data-particle-* 粒子读写 / aiattr-* AI 属性轴），禁 NL 生成未注册动作。

### 1.5 门户体系收敛（六项判据）

| # | 收敛对象 | 判据（SKILL 模板） |
|---|---|---|
| 1 菜单内容 | Schema `navigation` 字段（group/to/icon），**强制属于权威导航枚举**；菜单只两类：业务视图（本域阶段）+ 治理视图（审批台/资产/配置） |
| 2 统一工作台 | Schema `workbench`：`stage-bar`（顶）+ `chat-pane`（左，绑定主导智能体）+ `output-panel`（右）三区；Tab 落在角色分组内 |
| 3 首页布局 | `dual-view-shell`：顶栏视图切换（localStorage）+ 中心查询框 + 活跃任务卡；切换时 Agent 执行态保持 |
| 4 Agent 核心 | `workspace` 是首要页型；其余 dashboard/table/approval 是其派生视图；每工作台内嵌阶段主导智能体 |
| 5 统分派发 | 显式暴露 `dispatch.badge` ∈ {auto / human_gate / governance-gate} |
| 6 治理决策 | 复用本域治理决策台/审批中心/工作台，禁止另起炉灶实现审批/投票/派发 |

### 1.6 AI 原生 UI 六铁律（表现层，复用判据）

R1 概率内容必带置信度与来源（缺失按 unknown，禁默认 high）；R2 不可逆操作双确认+可预览；R3 Agent 状态常驻可见（blocked 带原因+解阻塞动作）；R4 人的覆盖留痕回流；R5 四态齐备（loading/empty/error/partial）；R6 渲染器每个 class 有样式契约（CI 断言 class 集合 ⊆ 样式表集合）。

## 2. 业务设计输入（取自 Q.20 + §6.2 + §5ter.15）

| 输入项 | 来源 | CRM 实例化 |
|---|---|---|
| 受控 Schema 协议 | Q.20 | 配置界面 = AI 生成界面**共用同一渲染器**；Schema 字段集同时覆盖「人配」与「AI 生成」两种来源 |
| 待办工作台 = 门户默认页 | Q.20 / §5bis G-24 | 四视角：**待我审批 / 我处理的 / 我发起的 / 抄送我的**（按报价/合同/订单/发票业务类型分类） |
| 13 个 NL 场景 = 意图→页面生成 | Q.20 / §5ter.15 | 每条 NL 场景映射到一个受控页型（见 §3.5） |
| 移动端 = Vant 适配 | Q.20 | web（Vue3+Naive-UI）/ 移动端（Vant）双端消费同一 Schema |
| 界面设置层 = 配置界面 | §5bis A | 动态表单配置抽屉 / 用户视图配置 / 数据脱敏 / 容量池配置**四类配置界面走同一渲染器** |
| 五角色上下文 | §5ter.16 | 销售/经理/高管/商务/财务 = context-layering 角色配置，驱动页面数据范围与输出风格 |
| 区域/财报维度 | §6.3quater | 区域 = organization_id 层级中间层注入；月度财报 = 财务聚合 Action 内建（非独立报表技能） |

**13 个 NL 场景清单（§5ter.15）**：①查询线索（复合过滤）②商机统计摘要 ③客户画像（跨模块）④团队业绩排行 ⑤晨会速览 ⑥经理周会看板 ⑦高管经营分析 ⑧财务应收全景 ⑨合同到期预警 ⑩客户 360 链路追踪 ⑪一句话写入 ⑫区域复盘 ⑬月度财报。

## 3. 落地设计

### 3.1 NL → 受控 Schema → 运行时渲染器架构

```
用户 NL（web 中心查询框 / 移动端对话） / 人配置（界面设置层）
   └─[NL 解析层 nlParser]→ { schema, confidence, needsClarification, notes }   // 绝不产出 HTML
        └─[结构层 validatePageSchema]→ 粒子值域/状态 eq/快照 latest/Action 白名单 校验
             └─[渲染层 renderPage]→ 先校验+转义+data-action 声明式 → 页面（Vue3+Naive-UI / Vant）
页面即门户子槽位：绑定本域阶段模型 + 内嵌主导智能体 + 走统分机制 + 治理复用决策台
```

- **解析映射（确定性规则）**：意图→type（看板→dashboard / 表→table / 表单→form / 详情→detail，缺省 dashboard）；实体→粒子（线索/商机/合同→CRM_DEAL+stage 过滤；客户→CRM_ACCOUNT；联系人→CRM_CONTACT；产品→CRM_PRODUCT）；指标（金额→totalAmount sum；赢率→probability avg）；阈值高亮（「低于 X%」→ op lt）；动作→按钮（审批→`crm-contract-approve`；写入→`crm-account-create`）；置信度（实体未识别→0.3+needsClarification；完整→0.9）。
- **低置信处理**：needsClarification=true 前端多轮澄清；极低置信给默认模板骨架，不静默错生成。

### 3.2 受控 Schema 协议字段定义（CRM 实例化）

```json
{
  "version": "0.1",
  "type": "dashboard | table | form | detail | workspace | approval | intake",
  "title": "页面标题（来自 NL 或人配置）",
  "layout": { "columns": 2, "theme": "light" },
  "particleType": "CRM_DEAL | CRM_ACCOUNT | CRM_CONTACT | CRM_PRODUCT | CRM_PRICE_LIST | CRM_PERSON | CRM_ORGANIZATION | CRM_KNOWLEDGE | CRM_UNSTRUCTURED_ASSET",
  "components": [
    {
      "kind": "metric-card | table | form | reasoning-trace | approval-queue | conflict-marker",
      "title": "组件标题",
      "dataBinding": {
        "source": "particle",
        "particleType": "CRM_DEAL",
        "filters": [{ "field": "stage", "op": "eq", "value": "opportunity" }],
        "metrics": [{ "field": "expected_amount", "agg": "sum", "label": "金额" }]
      },
      "style": { "highlight": { "when": { "field": "probability", "op": "lt", "value": 0.3 }, "color": "red" } },
      "actions": [{ "label": "审批", "action": "crm-contract-approve" }]
    }
  ],
  "navigation": { "group": "业务视图", "to": "/crm-deal", "icon": "📋" },
  "workbench": { "stageBar": true, "chatPane": { "partnerAgent": "deal-coach" }, "outputPanel": { "side": "right" } },
  "dispatch": { "badge": "auto | human_gate | governance-gate" }
}
```

**协议边界（YAGNI）**：首版仅开放 `theme / columns / highlight / filters / metrics / actions`；品牌色/布局模板后续进 Schema（建议扩展，非首版必须）。

### 3.3 五大门户构件（CRM 实例化）

1. **菜单（navigation）**：权威导航枚举 = 业务视图（线索/客户/商机/报价/合同/回款/跟进/产品）+ 治理视图（审批中心/资产/配置/智能体监控台）；禁止游离菜单项。
2. **统一工作台（workbench）**：stage-bar（顶，本域阶段）+ chat-pane（左，绑定主导智能体 crm-copilot / deal-coach / lead-miner）+ output-panel（右）三区强制；Tab 落角色分组。
3. **首页（dual-view-shell）**：顶栏视图切换（localStorage 记忆）+ 中心查询框（意图输入置中）+ 活跃任务卡；双入口同壳（业务视图/治理视图），切换时 Agent 执行态保持。
4. **统分机制（dispatch）**：业务分级 → 统一路由 → 统分比例（建议 7:2:1：auto/human_gate/governance-gate），页面显式暴露 badge。
5. **治理决策**：复用本域审批中心/决策台，生成页调既有 Action 而非自实现审批（收敛铁律）。

### 3.4 待办工作台四视角 = 门户默认页

首页默认加载「我的待办」工作台（§5bis G-24 实证），四视角：

| 视角 | 内容 | 数据来源 |
|---|---|---|
| 待我审批 | 按报价/合同/订单/发票分类的待批任务 | 审批流粒子 instance + role 路由 |
| 我处理的 | 我参与审批的进度 | approval instance 参与记录 |
| 我发起的 | 我提交审批的实时节点追踪 | instance 提交人 = 当前人 |
| 抄送我的 | 关键业务动态集中展示 | ccList 包含当前人 |

四视角组件统一 `table` 页型 + 批量操作 Action（一键勾选同意/驳回），走审批 HITL 闸（不翻转录）。

### 3.5 十三场景意图→页面生成映射

| # | NL 场景 | 页型 type | 绑定粒子 / Action | 角色 |
|---|---|---|---|---|
| 1 | 查询线索（复合过滤） | table | CRM_DEAL(stage=lead) + 复合 filter | 销售 |
| 2 | 商机统计摘要 | dashboard | CRM_DEAL 聚合（crm-funnel） | 销售/经理 |
| 3 | 客户画像（跨模块） | detail | CRM_ACCOUNT + 本体边聚合 | 全角色 |
| 4 | 团队业绩排行 | dashboard | CRM_PERSON 聚合 + 组织层级 | 经理 |
| 5 | 晨会速览 | dashboard | CRM_DEAL/CRM_CONTACT 今日行动 | 销售 |
| 6 | 经理周会看板 | dashboard | CRM_DEAL 团队漏斗 | 经理 |
| 7 | 高管经营分析 | decision-canvas | CRM_DEAL 趋势→对比→预测 | 高管 |
| 8 | 财务应收全景 | dashboard | CRM_DEAL financial_state + 逾期 | 财务 |
| 9 | 合同到期预警 | table | CRM_DEAL(stage=contracted) + alert | 商务 |
| 10 | 客户 360 链路追踪 | detail | 跨模块本体边追踪 | 全角色 |
| 11 | 一句话写入 | form/workspace | 写入引擎 + action-confirm + HITL | 全角色 |
| 12 | 区域复盘 | dashboard | CRM_DEAL + organization_id 层级注入 | 区域负责人 |
| 13 | 月度财报 | dashboard/result-card | 财务聚合 Action（NL 直达） | 高管/财务 |

> 域结论：13 场景全部落入「意图→Action + 门户生成 + 事件源」三通道；无一是官方技能专属能力（Q.15 结论）。

### 3.6 界面设置层：配置界面与 AI 生成共用渲染器（D9 实证）

§5bis A 四类配置界面**不单独开发**，复用 3.2 同一套 Schema + 渲染器：

| 官方界面设置层 | 本平台实现（共用渲染器） |
|---|---|
| 动态表单配置抽屉 | form 页型 + 粒子属性元模型驱动，成员权限分栏 |
| 用户视图配置 | table/dashboard 的 `filters` 物化为用户视图（viewId 持久化） |
| 数据脱敏配置 | output guard 字段级脱敏，配置界面即 form 页型 |
| 容量/池配置 | CRM_ORGANIZATION.pool_config 的 form 页型编辑 |

**关键判别**：人「配置」出的界面与 AI「生成」出的界面，落到同一份受控 Schema、同一渲染器、同一校验器——这是 D9「界面生成化」的落地判据，也是与原生专用界面路线的根本分叉。

### 3.7 移动端 Vant 适配

- 同一 Schema 双端渲染：web 走 Vue3 + Naive-UI 组件实现；移动端走 Vant 组件实现（建议扩展：渲染器注册双端组件映射表，`kind` 不变、组件实现按端切换）。
- 约束不变：移动端同样禁止 NL 直出 HTML、同样过三层护栏、同样绑定粒子数据；移动端写入走同一写通道三闸（移动端粒子写逻辑见 §5ter.20 实证）。

### 3.8 接口草图（MVP 六文件职责，沿用 SKILL 结构）

```
src/page/
  schema.js       // 协议常量：页型/组件类型/主题/过滤算子/聚合函数/CRM 粒子枚举/Action 白名单
  nlParser.js     // parseNlToSchema → {schema, confidence, needsClarification, notes}（绝不产出 HTML）
  validator.js    // validatePageSchema：拒未知粒子/非白名单动作/非法算子/颜色；4 粒子校验规则
  guardrails.js   // guardNlInput：拦截脚本注入
  renderer.js     // renderPage：唯一渲染出口（先校验+转义+data-action 声明式+无 <script>）
  pageStore.js    // createPageFromNl / publishPage：护栏→解析→校验→落库 draft→发布
```

### 3.9 智能体工作台详细设计（首要页型展开）

**背景**：§1.5 收敛判据 #4 确立 `workspace` 是首要页型，其余 dashboard / table / approval 是其派生视图；但 §3.3 仅给出 stage-bar / chat-pane / output-panel 三区的扼要定义。本节展开智能体工作台的完整布局、交互与运行状态设计——这是「对话即门户」的核心落地面。

#### 3.9.1 三区布局与职责（精确化）

```
+-------------------------------------------------------------+
| stage-bar: 本域阶段指示 + 主导智能体标识 + dispatch.badge   |
+--------------+----------------------------------------------+
| chat-pane    | output-panel                                 |
| (左, 40%)    | (右, 60%)                                   |
| 对话流 +     | 结构化结果（受控 Schema 子槽位）               |
| 输入框 +     | - 表格/看板/表单/详情                        |
| 澄清卡片 +   | - 写操作 action-confirm 卡片                  |
| Agent 状态条 | - 生成的页面沉淀为可复用持久视图                  |
+--------------+----------------------------------------------+
```

- **stage-bar（顶）**：显示当前业务阶段（线索/商机/合同…），绑定该阶段主导智能体（见 §3.9.2），显式暴露 `dispatch.badge`（auto / human_gate / governance-gate，见 §3.3 统分机制）。
- **chat-pane（左）**：与主导智能体的自然语言对话流；含输入框、多轮澄清卡片、Agent 状态条（R3：blocked 带原因 + 解阻塞动作）。
- **output-panel（右）**：智能体产出的结构化结果统一渲染——以 §3.2 受控 Schema 子槽位呈现；写操作以 action-confirm 卡片呈现；生成页面可沉淀为持久视图（可回退/可解释，R4 / R5）。

#### 3.9.2 主导智能体绑定（角色 × 阶段 → Agent）

工作台内嵌的「主导智能体」由 context-layering 角色七要素（§6.2）+ 本域阶段共同决定：

| 角色（§6.2） | 主导智能体 | 默认数据范围 | 典型工作台页型 |
|---|---|---|---|
| 销售 | crm-copilot（线索/商机教练） | 本人 + 本人 pool | 一句话写入 / 晨会速览 |
| 经理 | deal-coach（团队漏斗） | 团队 org 子树 | 经理周会看板 / 团队业绩排行 |
| 高管 | exec-analyst（趋势→对比→预测） | 全组织聚合 | 高管经营分析 / 月度财报 |
| 商务 | contract-steward（合同/回款） | 本人合同 + 回款 | 合同到期预警 / 财务应收 |
| 财务 | payable-tracker（应收对账） | 财务域粒子 | 财务应收全景 / 发票核销 |

- **绑定机制**：`workbench.chatPane.partnerAgent` 由 L4 角色配置注入，不在页面硬编码；切换角色/阶段时主导智能体随之切换，Agent 执行态保持（dual-view-shell 不变量，§3.3）。
- **单一主导铁律（收敛 #4）**：每工作台只内嵌一个主导智能体，其余能力通过 Action 调用其他 Agent/服务，不另开对话。

#### 3.9.3 chat-pane 交互模型（意图 → Action → 回填）

```
用户输入 NL
  → [nlParser] 意图识别 + 参数抽取 → {intent, actionRef, params, confidence, needsClarification}
       ├─ confidence < 阈值 → 澄清卡片（多轮，不静默错生成）
       └─ 确认/高置信 → [action-design] 解析 Action 参数 Schema
            ├─ 读 Action（默认直连）→ 取数 → output-panel 以 Schema 子槽位渲染
            └─ 写 Action（过闸）→ action-confirm 卡片 → HITL 闸 → 写粒子 → 回填 output-panel
  Agent 状态常驻（R3）：执行中 / blocked(原因+解阻塞) / done / partial（四态 R5）
```

- **置信度与来源（R1）**：所有概率/聚合结果标注置信度与数据来源，缺失按 unknown，禁默认 high。
- **双确认（R2）**：写入/不可逆操作在 chat-pane 以 action-confirm 卡片呈现，预览 + 二次确认后方可执行。
- **人的覆盖留痕（R4）**：用户手动修改/驳回 Agent 建议，留痕回流进审计事件流（见 §4 audit 接口）。

#### 3.9.4 output-panel 渲染与沉淀

- 所有结果以 §3.2 受控 Schema 渲染，复用同一渲染器与三层护栏（§1.3），不例外。
- 生成的视图可「保存为我的视图」（`filters` 物化为 `viewId`，见 §3.6 用户视图配置），沉淀为持久页型，非一次性。
- 写操作结果回填后，相关粒子变更经事件平面（§4 L2）触发 output-panel 定向刷新（SSE 薄信号 + 单连接，禁每页轮询）。

#### 3.9.5 接口草图（工作台专用模块）

在 §3.8 六文件基础上，新增工作台专用模块：

```
src/workbench/
  WorkbenchShell.vue      // stage-bar + chat-pane + output-panel 三区骨架（web / Vue3+Naive-UI）
  ChatPane.vue            // 对话流 + 输入框 + 澄清卡片 + Agent 状态条
  OutputPanel.vue         // 受控 Schema 子槽位渲染 + action-confirm 卡片容器
  usePartnerAgent.js      // 主导智能体绑定：角色/阶段 → partnerAgent（L4 注入）
  useWorkbenchDispatch.js // dispatch.badge 暴露 + 统分路由（auto / human_gate / governance-gate）
```

- **移动端（Vant）**：`WorkbenchShell` 同壳、组件实现按端切换（§3.7）；chat-pane 置顶、output-panel 下滚，保持三区语义不变。

#### 3.9.6 验收补强（并入 §5）

- [ ] 智能体工作台三区齐备（stage-bar / chat-pane / output-panel），chat-pane 内嵌该阶段主导智能体且可由角色切换。
- [ ] 写操作在 chat-pane 以 action-confirm 卡片呈现（预览 + 双确认），执行后经事件平面回填 output-panel。
- [ ] Agent 状态常驻可见（R3），blocked 带原因 + 解阻塞动作；四态齐备（R5）。
- [ ] 工作台生成的视图可沉淀为持久页型（`filters → viewId`），非一次性消失。

### 3.10 治理视图：智能体运行监控台（对应 PDM `/agents` 监控台 · 不重走 Semantica 路线）

**背景与设计铁律**：PDM 平台已有 `/agents` 智能体运行监控台（阶段/情绪/告警三栏），是可复用的监控范式。但 PDM 曾**花了很长时间引入 Semantica（图/语义推理引擎）**来做智能体洞察与告警——这是一条重依赖、长周期的旁路集成路线。**CRM 明确不重走这条路**：本平台的告警**直接从 CRM 业务事件流产生**，由 L2 事件总线的规则驱动，不引入独立的图/语义分析层。监控台本身只是门户的**治理视图页型**（§1.5 收敛 #1：菜单两类 = 业务视图 + 治理视图），复用工作台的渲染器与事件总线。

#### 3.10.1 指标口径（对齐 PDM，复用表结构）

沿用 PDM 监控台同一套三指标，便于复用 `agent_health` / `agent_sla` / `agent_alerts` 表结构与 SLA seed 行：

| 指标 | 含义 | 数据来源 |
|---|---|---|
| 稳定性（stability） | 智能体执行成功率 / 失败率 / blocked 平均时长 | `agent_health` + `agent_sla`（事件总线 task/trace 域） |
| 输出一致性（output consistency） | 同意图多次执行结果稳定性 / action-confirm 触发率 | evaluator 质量闸门（§09 feedback-loop）+ Action 执行日志 |
| 监控可靠性（monitoring reliability） | SSE 信号到达率 / 事件丢失率 / 告警时延 | L2 事件总线埋点（§07 event-driven） |

#### 3.10.2 六个 CRM 主导智能体监控卡

与 §3.9.2 角色绑定表一致，监控台逐 Agent 呈现健康卡：

| 主导智能体 | 职责域 | 主要业务事件源 |
|---|---|---|
| crm-copilot | 线索/商机教练（销售） | lead/opportunity 粒子变更 |
| deal-coach | 团队漏斗（经理） | 团队 CRM_DEAL 阶段流转 |
| exec-analyst | 趋势→对比→预测（高管） | 聚合指标偏差 |
| contract-steward | 合同/回款（商务） | contract/payment 粒子 |
| payable-tracker | 应收对账（财务） | payment 计划→记录 |
| lead-miner | 线索挖掘（销售/线索域） | lead-pool 领取/回收事件 |

#### 3.10.3 告警直接从业务事件流产生（关键差异点，不引 Semantica）

告警**不是**对智能体对话/日志做图推理或语义分析得出，而是由 L2 事件总线上的**业务事件**经规则直接触发，落入 `agent_alerts`。5 类 CRM 业务告警：

| 告警类型 | 触发事件（业务事件流） | 规则来源 |
|---|---|---|
| `deal_stuck` 商机卡顿 | CRM_DEAL 阶段停留超阈（particle 域：stage 变更后无进展 N 天） | §5ter.3 阶段-赢率状态机 |
| `lead_overdue` 线索超期 | lead-pool 领取后超期未跟进（particle 域：领取时间戳对比） | §5ter.1 领取/回收规则（=主动预警源） |
| `forecast_breach` 预测偏差 | 商机预计结束时间已过 / 预测赢率偏差超阈（feedback 域对账） | §5ter.3 预计/实际对比 + §09 回灌 |
| `approval_bottleneck` 审批梗阻 | 审批节点停留超阈（approval 域：instance 节点停留时长） | §5ter.11 审批流 |
| `payment_due` 回款逾期 | 回款计划应回日超期无实回（payment 域：plan vs record） | §5ter.7 计划→记录对账 |

> **与 Semantica 路线的分界**：Semantica 类引擎需要从对话文本/日志抽图、做语义推理才能产出"洞察"。CRM 监控台**不消费对话文本**，只读事件总线上的结构化业务事件 + 规则表——零图依赖、零语义引擎、可随业务事件即时告警。这是 D4（预警事件化）/ D11（连接器化）/ D12（原生化）在监控面的落点。

#### 3.10.4 监控台布局（治理视图页型）

```
+-------------------------------------------------------------+
| 治理视图导航：审批中心 | 资产 | 配置 | 智能体监控台（本页）  |
+-------------------------------------------------------------+
| Agent 健康卡（6 张，§3.10.2）    | 告警流（§3.10.3，5 类）   |
| 稳定性 / 输出一致性 / 监控可靠性  | deal_stuck / lead_overdue |
| 三指标环形 + 状态点（R3）          | forecast_breach / approval|
|                                 | _bottleneck / payment_due |
+-------------------------------------------------------------+
```

- 监控台是门户治理视图，复用 §3.2 渲染器与三层护栏；告警卡 `kind=alert` 组件，点击 drill 到对应业务工作台。
- 实时刷新走 L2 事件总线 SSE 薄信号（单连接），不轮询。

#### 3.10.5 接口草图（监控专用模块）

在 §3.8 / §3.9.5 模块基础上，新增监控专用模块：

```
src/monitor/
  AgentMonitor.vue      // 治理视图页：6 Agent 健康卡 + 告警流（复用渲染器）
  AgentHealthCard.vue   // 单 Agent 三指标卡（稳定性/输出一致性/监控可靠性）
  AlertStream.vue       // 业务事件驱动告警流（kind=alert）
  useAgentHealth.js     // 读 agent_health / agent_sla / agent_alerts 表
  useAgentAlerts.js     // 订阅 L2 事件总线（task/trace/approval/particle/payment 5 域）→ 规则 → agent_alerts
```

- 表结构与 PDM 对齐（`agent_health` / `agent_sla` / `agent_alerts` + 9 SLA seed rows），便于从 PDM/P2P 直接复用实现。
- **禁止引入 Semantica 或任何图/语义推理依赖**（路线禁令，见 §6）。

#### 3.10.6 验收补强（并入 §5）

- [ ] 监控台为门户治理视图页型，复用工作台渲染器与三层护栏，非独立实现。
- [ ] 三指标（稳定性/输出一致性/监控可靠性）实时呈现，数据来自 agent_health/agent_sla/agent_alerts，与 PDM 口径对齐。
- [ ] 6 个 CRM 主导智能体均有健康卡；告警 5 类（deal_stuck/lead_overdue/forecast_breach/approval_bottleneck/payment_due）均由业务事件流规则触发，无图/语义引擎依赖。
- [ ] 实时刷新走 L2 事件总线 SSE 单连接，无每页轮询；告警卡可 drill 到对应业务工作台。

#### 3.10.7 Agent 详情钻取（drill-down 多层监控 · 含 SKILL 运行监控）

**背景**：监控台概览（§3.10.2 健康卡 + §3.10.3 告警流）是「一层」视图；点进任一 Agent 健康卡应钻取到**多层详情**——这与 PDM `/agents` 监控台「概览 → 详情 → 多维度面板」的钻取范式一致。CRM 详情层同样**不引 Semantica**，全部由事件总线结构化事件驱动；其中**SKILL 运行状态**是用户明确点出的关键维度（Agent 加载/执行了哪些 SKILL、各自成功率与成本）。

##### 3.10.7.1 钻取布局（仍是治理视图受控 Schema 子槽位）

点击 §3.10.2 健康卡 → 进入单 Agent 详情页（复用 §3.2 渲染器 + §1.3 三层护栏，非独立实现）：

```
+-------------------------------------------------------------+
| 返回概览 | crm-copilot 详情                                  |
+-------------------------------------------------------------+
| 顶部：三指标（稳定性/输出一致性/监控可靠性）+ 状态点（R3）   |
+----------------------+--------------------------------------+
| 左栏：维度导航        | 右栏：选中维度的面板                   |
| - SKILL 运行监控 *    | （点击左栏切换，右栏渲染对应面板）      |
| - 任务执行时间线      |                                      |
| - 推理/动作 Trace      |                                      |
| - SLA 合规            |                                      |
| - 派发分布            |                                      |
| - 上下文注入快照      |                                      |
| - 告警历史            |                                      |
+----------------------+--------------------------------------+
```

##### 3.10.7.2 SKILL 运行监控（核心新增维度）

每个 Agent 在装配时绑定一组 SKILL（见 §03 编排 spec 六段式 `skills` 字段）；监控台逐 SKILL 呈现运行状态——这是「Agent 是否健康」的底层根因视图：

| SKILL（crm-copilot 例） | 状态 | 调用次数 | 成功率 | 平均时延 | Token 成本 | 最近失败 |
|---|---|---|---|---|---|---|
| crm-deal-analyze | running | 1240 | 98.2% | 1.8s | 0.4M | — |
| crm-lead-score | idle | 860 | 96.5% | 1.2s | 0.2M | 2026-08-24 超时×2 |
| crm-follow-suggest | loaded | 430 | 91.0% | 2.4s | 0.6M | 2026-08-25 降级×1 |

- **SKILL 状态机**：`loaded`（已装配未调用）/ `running`（执行中）/ `idle`（装配但近期无调用）/ `error`（连续失败超阈）→ 状态点按 R3 常驻，error 带最近失败原因 + 解阻塞动作（如「重装配」「降采样」）。
- **指标来源**：调用次数/成功率/时延 来自 trace 域 SKILL 执行事件（`skill_invoked` / `skill_succeeded` / `skill_failed`，建议扩展事件总线新增 `skill` 域，或在 `trace` 域承载）；token 成本来自 LLM 调用埋点。
- **钻取再下钻**：点单 SKILL 可看该 SKILL 的近 N 次执行轨迹（输入→Action→结果→耗时），供定位「为什么这个 Agent 这次表现差」。

##### 3.10.7.3 多维度监控面板（左栏其余维度）

| 维度 | 面板内容 | 数据来源 |
|---|---|---|
| 任务执行时间线 | 近期 task 域事件流（ready→running→done/failed），失败标红 + failure_limit 计数 | `events` task 域 + `task_audit` |
| 推理/动作 Trace | 单次执行的 reasoning-trace（意图→Action→回填），决策可回放（建议 v0.2） | `events` trace 域 |
| SLA 合规 | 对照 `agent_sla` seed 行：成功率/时延阈值达标率、违约次数 | `agent_sla` |
| 派发分布 | auto / human_gate / governance-gate 三类派发占比（与 §3.3 统分机制对照） | dispatch 事件 |
| 上下文注入快照 | 本次/最近一次执行的 L1-L4 注入内容（知识层/历史决策/协同/治理），可审计 | context-layering 注入记录 |
| 告警历史 | 本 Agent 触发的 5 类告警（§3.10.3）时间线 + 处置状态 | `agent_alerts` |

> 所有面板数据均来自 L2 事件总线结构化事件 + `agent_health`/`agent_sla`/`agent_alerts` 三表，**无对话文本分析、无图/语义引擎**——延续 §3.10.3 的不引 Semantica 路线。

##### 3.10.7.4 接口草图（钻取层扩展）

在 §3.10.5 `src/monitor/` 基础上扩展：

```
src/monitor/
  AgentDetail.vue       // 单 Agent 详情页（顶部三指标 + 左栏维度导航 + 右栏面板）
  SkillStatusPanel.vue  // SKILL 运行监控表（状态机 + 成功率/时延/成本）
  TaskTimeline.vue      // 任务执行时间线（task 域）
  TracePanel.vue        // 推理/动作 trace（trace 域）
  SlaPanel.vue          // SLA 合规
  DispatchPanel.vue     // 派发分布
  ContextSnapshot.vue   // 上下文注入快照
  AlertHistory.vue     // 告警历史
  useSkillStatus.js     // 读 SKILL 执行事件（trace/skill 域）→ 状态机 + 指标
  useAgentDetail.js     // 聚合单 Agent 多维面板数据
```

##### 3.10.7.5 验收补强（并入 §5）

- [ ] 监控台支持钻取：点健康卡 → 单 Agent 详情页（复用渲染器/护栏），含左栏维度导航 + 右栏面板切换。
- [ ] **SKILL 运行监控维度齐备**：逐 SKILL 呈现状态机（loaded/running/idle/error）+ 调用次数/成功率/平均时延/token 成本/最近失败；error 带原因 + 解阻塞动作（R3）。
- [ ] 多维度面板（任务时间线/推理 trace/SLA 合规/派发分布/上下文快照/告警历史）均可渲染，数据来自事件总线 + 三表。
- [ ] 所有钻取层数据来自结构化事件与三表，无图/语义引擎依赖（延续 §3.10.3 路线）。

## 4. 与其他能力 / 四平面的接口

本能力挂 **L4 呈现平面（核心）**，与另三平面接线：

| 接口方 | 关系 | 契约 |
|---|---|---|
| L3 智能体平面（orchestration / action-design） | 意图→Action 解析；结果回显 | NL→`crm-*` Action 参数 Schema；渲染器交互仅 `data-action`，Agent 不点击按钮（走 capabilityExposure→MCP dispatch，建议扩展 v0.2） |
| L1 粒子平面（particle / ontology） | 数据绑定源 | 页面 `particleType`/`filters`/`metrics` 直接映射 §01 粒子；AI 属性轴 `payload.ai.attributes+axis` 可引用 |
| L4 上下文分层（context-layering） | 角色/组织/视图注入 | 五角色七要素驱动页面数据范围与输出风格；区域 = organization_id 层级注入；用户视图 = 可配置过滤器物化 |
| L2 事件平面（event / feedback） | 实时面板 | 所有实时刷新走 SSE 薄信号 + 定向重取（单连接），禁每页轮询；预警/反馈指标回显为 dashboard 组件 |
| 治理决策台（audit） | 复用 | 生成页调既有审批 Action，不另起炉灶；页面生成操作进审计事件流 |

**门户子槽位不变量**：生成的每个页面绑定本域阶段模型、内嵌该阶段主导智能体、走本域统分机制、治理面复用本域决策台（收敛铁律 #6）。

## 5. 验收判据（来自 §5ter 覆盖 + D9 差异点，可验证）

- [ ] **三段式铁律未被破坏**：NL 绝不直出 HTML；渲染器是唯一渲染出口，Schema 是唯一输入（判据-1/2）。
- [ ] **三层护栏齐备**：guardNlInput / validatePageSchema / renderPage 三处均生效，渲染结果强制不含 `<script>`。
- [ ] **4 粒子校验生效**：particleType 仅 9 枚举（旧值拒绝渲染非静默）；stage 仅 eq 不聚合；快照仅 latest；Action 在白名单。
- [ ] **待办工作台四视角**：门户默认页 = 待我审批/我处理的/我发起的/抄送我的，按业务类型分类且可批量操作。
- [ ] **D9 差异点达成**：人配置界面与 AI 生成界面共用同一渲染器（界面设置层四类配置 = 同 Schema/同校验/同渲染），非每功能一专用界面。
- [ ] **13 场景覆盖**：§5ter.15 全部 13 个 NL 场景均有意图→页型映射并可生成可运行页面。
- [ ] **移动端适配**：同一 Schema 在 Vant 端可渲染，过同等护栏。
- [ ] **门户收敛 6 项**：navigation/workbench/dual-view-shell/workspace/dispatch.badge/治理复用 全部满足。
- [ ] **智能体工作台详细设计（§3.9）**：三区齐备（stage-bar/chat-pane/output-panel）+ 主导智能体按角色绑定 + 写操作 action-confirm 卡片 + Agent 状态常驻（R3）+ 生成视图沉淀为持久页型（viewId）。
- [ ] **智能体运行监控台（§3.10，治理视图）**：复用工作台渲染器；三指标（稳定性/输出一致性/监控可靠性）对齐 PDM；6 个 CRM 主导智能体健康卡；5 类告警均由业务事件流规则触发，**无 Semantica/图/语义引擎依赖**；SSE 单连接刷新。
- [ ] **监控台钻取层（§3.10.7）**：点健康卡→单 Agent 详情页（复用渲染器/护栏）；**SKILL 运行监控维度齐备**（逐 SKILL 状态机 loaded/running/idle/error + 调用次数/成功率/时延/token 成本/最近失败，error 带原因+解阻塞 R3）；多维度面板（任务时间线/推理 trace/SLA 合规/派发分布/上下文快照/告警历史）均可渲染；数据全部来自结构化事件与三表，无图/语义引擎依赖。
- [ ] **AI 原生 UI 六铁律**：R1-R6 在生成页面覆盖（置信度来源/双确认/状态常驻/覆盖留痕/四态/样式契约）。
- [ ] **可回退可解释**：生成页面可预览/编辑/放弃，保留 NL 原文+Schema+理由可追溯。

## 6. 不做的事（YAGNI + 路线禁令）

- ❌ **不借鉴 CordysCRM「每功能一个专用界面」路线**（D9 反面）：禁止为线索/客户/商机/合同等各写独立 `views` 模块 + 各路由 + 各表单；页面一律由受控 Schema 生成。
- ❌ **严禁 NL 直出 HTML**：任何路径不得绕开 Schema 直接生成 HTML 字符串（铁律）。
- ❌ **不生成任意 SQL / 自由取数**：页面数据源限定为 §01 的 9 粒子，禁裸查询。
- ❌ **不另起炉灶实现审批/投票/派发**：治理面复用本域决策台/审批中心/工作台（收敛铁律）。
- ❌ **不为每个粒子开 CRUD 专用页**：粒子读写复用 `data-particle.*` substrate，门户只生成按需视图。
- ❌ **首版不做**（建议留待后续）：v0.2 双输出（MCP Resources 给 Agent）/ reasoning-trace 决策回放 / 品牌色与布局模板进 Schema / 渲染器双端组件映射表自动注册——均标注为「建议扩展」，不在门户阶段 2 MVP 强制。

---

*（本文档为 ai-portal-page-generation 在 CRM 销售域的实例化设计：L4 呈现平面核心、受控 Schema 协议、待办工作台四视角、13 场景意图→页面生成、配置界面与 AI 生成共用渲染器、移动端 Vant 适配。待用户审查后进入 writing-plans。）*
