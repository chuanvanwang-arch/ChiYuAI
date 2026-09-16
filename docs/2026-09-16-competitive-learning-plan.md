# 设计：竞品学习清单（Competitive Learning Plan）——ROX / Attio / Lightfield 三家的「值得学 / 不学 / 怎么做」

> 状态：**用户已确认（2026-09-16）**。本清单是对 `docs/2026-09-15-proactive-runtime-design.md`（Proactive Runtime，P8 待批准）的来源对照附录：每一条学习项明确「现状 = 学什么 = 落地到哪一层 = 对应哪个 S 段 / P 优先级」。
> 关联文档：`docs/2026-09-15-proactive-runtime-design.md`（主动运行时设计）、`docs/2026-09-15-external-data-integration-*.md`（外部数据接入，P0/P1/P2）、`docs/2026-09-15-lightfield-attio-rox-*.md`（三方对照）。

---

## §0 结论先行

**竞品分析的本质结论（三方对照，2026-09-15 已核实一手证据）**：

1. **三家全部有 MCP 接入**（ROX 对接 OpenAI Codex/ChatGPT、Attio 官方托管 `mcp.attio.com` 37 工具、Lightfield API/CLI/MCP 全开放）——「三家没有 WorkBuddy 式 MCP」的说法只对一半：它们没有「AI 工作台 ↔ 业务系统」的双向治理通道，但都有「对外被调用」的 MCP server。
2. **真正的差异在方向与治理**：三家是「SaaS 卖数据给 AI 调用」（AI 是访客，MCP 是被调用通道，写权限保守但治理是「审批+审计」级）；我方是「AI 工作台为业务系统提供 Agent 执行」（MCP 双向、协议层直接内置决策第 0 闸 / 审批流 / confirmation_token / 审计 / scopeTenant 隔离）。**「协议层业务治理」是三家没有的差异杠杆。**
3. **学习的落点不是界面**，而是三件事：
   - **出口**：把已有主动产出接到「人一定会看到的地方」（学 Rox Inbox / 投递层）——**先修出口**。
   - **入口**：把「数据进来」做成一等产品能力（学 Lightfield 迁移/同步）——**最长短板**。
   - **细活**：把治理细节抄进协议层（学 Attio 禁删工具、Rox 字段级权限）——**增强型**。

---

## §1 三家事实基线（页面与菜单，2026-09-15/16 抓取）

| 维度 | ROX | Attio | Lightfield |
|---|---|---|---|
| 定位 | Agentic CRM / 收入平台（"revenue agents"），Global 2000 大客户 ABM | 对象化 CRM（"Notion 遇上 Salesforce"），30,000+ 客户 | Agent-native CRM（"版本化客户记忆"），5,000+ 公司，$47M Series A（a16z） |
| 界面/菜单 | **Command**（NL 执行中枢）/ **Inbox**（Priority/Insights/Agent Runs/Meetings 四 Tab 行动中心）/ **Accounts**（每账号一 agent）/ **Outbound Agent**（Prospect→Configure→Execute→Monitor）/ **Agentflows** / **Artifacts** / **Skills** / **Voice Mode** / **Teams**（无席位，按 Agent Actions 计量） | 侧栏六区：**Control** / **Search**(cmd+K) / **Navigation**(Home/Notif/Tasks/Notes/Emails/Reports/Sequences/Workflows) / **Records**(Contacts/Companies/Deals+自定义 Objects) / **Lists**(列表=表格/看板/日历，Pipeline=List 的 Kanban) / **Chats**(Ask Attio) | **Customer Memory**(版本化+引用) / **Accounts**(fit/timing/connection 三因子打分) / **Agent Builder**(NL，由 Skills/Knowledge/Automations 组装) / **Meeting prep&录制** / **Pipeline 批量编辑** / **Revival+外呼序列** / **Cited Q&A** / 治理(SOC2 II/HIPAA) |
| MCP | 有：官方 partner（Codex/ChatGPT），REST API，MCP 为 custom integration | **有：最成熟**，官方托管 `https://mcp.attio.com`，OAuth，37 工具，**无 delete-record**，分工作区限速；10.9M MCP calls/月 | 有：API/CLI/MCP 三通道全开放（docs.lightfield.app），agent harness 可选模型 |
| 治理/写权限 | 审批闸+审计+可逆操作（"guided autonomy"） | MCP OAuth 继承用户权限；agent 写默认需审批；禁删 | agent harness+确定性沙箱+evals；SOC2/HIPAA |

---

## §2 值得学（按优先级与落地层组织）

### P0-A｜出口：信号投递与行动中心（学 ROX Inbox）→ 对应 proactive-runtime S1

| 学什么 | 一手证据 | 我方现状（带锚点） | 落地 |
|---|---|---|---|
| **Inbox 统一行动中心**：Priority（按紧迫度排的聚合流）/ Insights（账号信号）/ Agent Runs（自动化产出的工件，**HITL 先审后发**）/ Meetings（会议行动） | Rox 官方 docs「Run with Rox: Checking your Inbox」 | 感知面在跑（`src/scheduler/timers.js` 11 个定时器），但**投递面断链**：`alertStore.js:6` 落进程内存 Map；`crm.alert` 建表在 `db/schema.sql` 零命中；`alertEndpoints.js` 从未挂载；`registerAlertHook` 未注册（server.js:74 只有 finance）；`src/web/` 下 `api/alerts` 零命中；六视角 workbench 无 alert 视图；无外发推送 | 按 proactive-runtime S1：新增 `crm.signal`（收口内存 Map）+ `crm.signal_delivery`（投递流水，**防假绿核心表**）+ `src/signal/{store,router,digest}` + 四渠道 provider（inbox/email/im/webhook）+ `signal-center.html`；补齐 B1 挂载 8 端点 / B2 注册 alertHook / B4 工作台第 7 视角 / B5 首页信号卡 / B7 抽公共 mailer |
| **Agent Runs 先审后发**（产出邮件/报告/PPT 先 HITL 审阅再外发） | Rox docs（Agent Runs Tab） | 我方 confirm_token 两阶段 HITL 已同构（decision-0 闸 + 审批流） | 显式把「产出→审阅→发送」展示为对外证据；工作流产出进待办视角（B4） |
| **每条输出带引用来源**（验证可点击回源） | Rox docs（Command citations） | 我方 k-m-d 决策链 + decision 溯源已具备 | 扩展到客户 360 洞察 / signal 卡：`evidence_refs` 挂到每条 signal |

### P0-B｜入口：数据进来＝一等能力（学 Lightfield 迁移/同步）→ 对应外部数据接入 P0

| 学什么 | 一手证据 | 我方现状 | 落地 |
|---|---|---|---|
| **自助 CSV 导入 / agentic migration**（Lightfield 已证明「迁移成本=切换成本=增长天花板」） | Lightfield 评测/官方：「agentic CSV import」「replacement agent」 | **我方连 CSV 导入都没有**（最短的板） | 外部数据接入 P0：先做「读入+实体对齐」（B1 同步对象契约 / B3 fxiaoke+neocrm kind / B4 CAS 扩到字段值 / N3 `crm.external_ref` 新表 + `crm.sync_cursor`），再做回写（N4 `sync-writeback-fields` Action，带 `Source='crm-ai-native'` 静态标记）——**价值排序≠实施顺序，必须先读入对齐再回写** |
| **版本化客户记忆**（从会话自动合成客户画像，带引用、保留变更历史） | Lightfield：「versioned customer memory」「temporal context graph」 | 方法论已就位（ai-memory-lifecycle），产品层=客户 360 洞察 | 客户 360 输出带 `evidence_refs` + 字段值历史（对齐 Attio 字段值历史/Rox source traces） |
| **stale deal revival**（积极信号后失联→自动复活） | Lightfield 官方功能 | 我方 lead-pool-recycle / 归档重开已存在雏形 | 把「失联复活」从流程动作升级为产品能力（纳入 S2 时间型信号） |
| **基于实际讨论内容的批量编辑**（非手填字段） | Lightfield 官方 | 建议卡采纳回路尚在设计中 | S3 建议卡一键采纳（T7/T8）已覆盖此语义 |

### P1｜治理细活（学 Attio / ROX）→ 增强型，待批准

| 学什么 | 一手证据 | 落地 |
|---|---|---|
| **MCP 层不暴露 delete 类工具**（Attio 刻意无 delete-record，防 agent 误删；ROX 可逆操作） | Attio MCP 工具清单（37 工具无 delete） | 我方已在 DB 层禁 DELETE（铁律）；在 MCP 工具面再显式声明「无 delete 类工具」作为对外证据；attio 的「agent 不能误删」对外叙事可直接复用 |
| **字段级权限图**（可查某字段授权来源、可模拟移除影响再确认） | Rox release notes 2026-07-29：「field-level permissions in Governance」 | 我方 RBAC/审批流已存在；补充「权限影响预览」（模拟移除某权限看影响面）为增强 |
| **MCP 工具命名规范统一**（Attio Q1 2026 统一为 MCP 命名规范） | Attio craftt guide | 我方 method-* 命名已统一；继续守，不扩不缩 |

### P2｜形态观察（不立项，进观察清单）

- Voice Mode（Rox）：我方暂不学语音，观察。
- Artifacts 生成 deck/docx（Rox）：已有能力接近（报告生成），不单独立项。
- 无席位按用量计量（Rox/Lightfield credits）：我方 5 档 billing-plans 已覆盖，观察校准。
- Lightfield Agent Builder（NL 描述 agent）＝我方 method-* SKILL + Agent Registry 同构，已有。

---

## §3 红线（明确不学，继承 proactive-runtime §14 + 三方对照四红线）

1. ⛔ 不学「取代式进攻」叙事（自伤「可验证可审计」定位）。
2. ⛔ 不学 Lightfield schema-less 无政府主义（§10 硬约束：不新增粒子类型；多租户/审计/禁 DELETE 不允许）。
3. ⛔ 不学「取消人工录入 / 替代 CRM」终局（HITL 铁律；我方客户多无既有 CRM 可替代）。
4. ⛔ 不学「数据随意搬走 / 零 egress 费」表述（我方对应能力=租户隔离，应说「数据不出租户边界」）。
5. ⛔ 不学「投递即骚扰」——必须 rate_limit + quiet_hours + include_low，默认低频高信噪（Rox 自己有 Notifications controls 反证过量投递是真问题）。
6. ⛔ 不学 always-on 全自动；不学「发送即送达」（无投递证据的投递=没投递）。
7. ⛔ 不学「把主动能力当营销词」——**S1 未交付前不得对外宣称「AI 主动值守」**（最忌讳的假绿）。

---

## §4 行动优先级总表

| 优先级 | 学习项 | 现状 | 落地（对应设计） | 状态 |
|---|---|---|---|---|
| **P0-A** | 信号投递+行动中心（出口） | 感知在跑、投递断链 | proactive-runtime **S1**（signal+signal_delivery+四渠道+signal-center+8 挂载修复） | 设计已出，**待用户批准** |
| **P0-B** | 数据进来=一等能力（入口） | 无 CSV/无同步内核 | 外部数据接入 **P0**（读入+实体对齐→再回写） | 设计已出（方案 B 已选），**待用户批准** |
| **P1** | MCP 禁删声明 / 权限影响预览 | DB 已禁删，缺对外声明 | 增强型，小步 | 待批准 |
| **P1** | 输出带证据引用（360/signal） | 决策链已有，未扩展到 360/signal | S3 建议卡（T7/T8）顺带 | 随 S3 |
| **P2** | Voice/Artifacts/计量形态 | — | 观察清单 | 不立项 |

**⚠ 实施顺序（与价值排序相反，务必遵守）**：P0-A（出口）→ P0-B（入口）→ P1 → P2。在链路断裂且无投递观测时放开自动写＝把假绿放大成真错。

---

## §5 与 proactive-runtime 设计的章节映射

| 本清单条款 | 对应 proactive-runtime 章节 |
|---|---|
| §2 P0-A（信号投递/行动中心/先审后发/引用） | §1.1（Rox 一手证据）、§2.3（投递面断链）、§5（补齐清单）、§6（新增清单）、§8.1/§8.2（signal/signal_delivery DDL）、§10（投递 provider 契约）、§13 T1/T3/T4、§17.1 S1 |
| §2 P0-B（数据进来） | 独立于 proactive-runtime，归属外部数据接入设计 P0；衔接 §17.2 前置动作 |
| §2 P1（禁删/权限预览） | §12 铁律映射（禁 DELETE）、§6 新增清单（权限增强） |
| §3 红线清单 | §14（红线六条）+ 三方对照四红线 |
| §4 实施顺序 | §17.1（S1→S5 渐进式）+ §7.1（价值排序≠实施顺序） |

---
