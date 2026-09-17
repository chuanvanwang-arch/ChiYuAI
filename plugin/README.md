# CRM 阶段 1 · 底座 MVP

## 启动
1. `docker compose up -d`（单库 postgres16+pgvector，端口 5433）
2. `npm run migrate && npm run seed`（幂等建表 + 种子）
3. `npm run dev`（http://127.0.0.1:3000 观测看板；/events SSE）

## 测试
- `npm test`（全量：粒子/钩子/kanban/dispatch/agentLoop/spec/http/e2e）
- `npm run test:e2e`（端到端三链路）

## 验收锚点（总体设计 §5 阶段 1）
- ✅ 粒子 Schema 全集落库（particles/edges）
- ✅ 写时向量管道跑通（embedding/tsvector 双写 + content_hash 幂等）
- ✅ kanban dispatch 派发真实任务（ready→running→done 全链路）
- ✅ SSE 事件总线雏形（5 域广播 + 观测看板实时刷新）
- ✅ 装配校验六条断言可查（/api/agents）

## 下一阶段（阶段 2）
context-layering L1-L4 注入 / memory 三构件 / Action Registry 写白名单 / 门户生成

---

## 对外分发：CRM 智能体包（技能市场）

> 设计输入：`docs/2026-08-25-ai-native-crm-overall-design.md` §6.13（对话式 CRM 智能体包）+ `docs/2026-08-26-mcp-pack-complete-plan.md`（四阶段实施计划）。

本仓库的 CRM 能力已封装为可发布到技能市场 / ClawHub 的插件包。包根结构（`agents/skills/avatars` 与 `.workbuddy-plugin/` **同级**，对齐 `@fit2-zhao/cordys-crm` 已发布格式）：

```
plugin/                      # 包根（上传单元）
  .workbuddy-plugin/
    plugin.json              # 插件清单（name/category/entries）
  agents/crm-native.md       # 对话面孔（角色自适应，5 角色）
  skills/                    # 全量打包：12 个 SKILL
    crm-native/              # 编排入口（意图路由 → 技能分发，惰性编排）
    crm-query/               # 跨模块推理查询（粒子图 + 决策网络 + pgvector）
    crm-write/               # 对话式写入（两阶段 + 决策第 0 闸 + action-confirm）
    crm-risk/                # 链断裂/异常主动探测（SSE 推送）
    method-bant/             # BANT 销售资质方法论
    method-meddicc/          # MEDDICC 决策链方法论
    method-opportunity-matrix/  # 机会矩阵排序
    method-role-map/         # 角色地图（决策链/影响者/使用者）
    method-risk-tradeoff/    # 风险权衡
    method-stop-loss/        # 止损点
    method-fact-vs-script/   # 事实 vs 话术
    method-presales/         # 售前解决方案方法论
    method-behavior-standard/ # 销售行为标准（行为达标自测）
    method-funnel-classification/ # 大漏斗分类（商机/目标/潜在客户）
    method-stage-progression/ # 阶段推进（S1-S6 阶段门禁与推进）
  avatars/crm-native.png
  README.md
```

### 2026-08-31 同步说明（对齐平台当日改动）

> 本包自仓库根 `skills/` 主源重新同步（README 第 71 行：plugin 为分发副本，源侧更新后需重打包）。本次同步覆盖平台当日改动：

- **销售术语统一重命名**：阶段码 `P1-P6` → `S1-S6`、旧英文阶段名（`lead/opportunity/quoted/contracted/ordered/paid/lost/disqualified`）→ `S1-S8` 单一事实源（`src/sales/stageTaxonomy.js`）；`DSM` → `sales`。插件内 `crm-risk`/`method-bant` 等陈旧阶段引用已一并校正。
- **新增 3 个完整方法技能**（含 `registry.json`，已注册可分发）：`method-behavior-standard`（销售行为标准）、`method-funnel-classification`（大漏斗分类）、`method-stage-progression`（阶段推进门禁）。注：`method-followup-engine`/`method-intake-routing`/`method-quote-engine`/`method-review-gate` 仍无 `registry.json`，属 WIP，暂未纳入分发包。
- **平台新增能力端点**（助手路由已可指向）：指名客户看板 `/api/board/named-accounts` 与管理面 `/api/board/named-account-manage`；漏斗质量看板 `/api/page/funnel-quality`；销售阈值配置 `/sales-thresholds-config.html`、审批流配置 `/approval-config.html`；决策可审计性 `/api/decision/:id/audit-4q` 与 `/api/monitor/auditability`。
- 版本号 `1.0.0` → `1.1.0`。

### MCP Server（对外无头暴露）

任意办公智能体经 MCP Server 调用本平台能力（零信任、凭证隔离、绝对禁删）。**首次接入两种渠道任选其一**：① **OAuth 授权（推荐，WorkBuddy 客户端）** —— 连接时自动打开浏览器，用 CRM 业务账号登录并授权；客户端持 `access_token`（8h）与 `refresh_token`（30 天轮转），过期自动静默续期；② **`crm_login(username,password)` 用户名密码验证（CLI/脚本）** —— 一次性换取 8h token，之后所有工具调用携带 `api_token`（或 `Authorization: Bearer`）。两渠道**互不吊销对方 token**。无有效凭证 → `gate='auth_required'` 硬拒绝（08-29 强制登录改造，`requireAuth=true`，不再免登录降级）；`/mcp` 未授权请求返回 `401 + WWW-Authenticate: Bearer resource_metadata=…`（触发客户端 OAuth 发现链）：

```bash
npm run mcp:http     # StreamableHTTP @3001 /mcp（供外部 Agent 无头调用）
npm run mcp:stdio     # stdio（供本地 Agent 子进程调用）
```

- **OAuth 端点**：`/.well-known/oauth-protected-resource`、`/.well-known/oauth-authorization-server`、`/oauth/register`（RFC 7591 动态注册）、`/oauth/authorize`（登录页 + PKCE S256）、`/oauth/token`（授权码交换 / refresh 轮转）。
- **登录（CLI/脚本渠道）**：`crm_login(username,password)`（免 token 调用）→ 返回 `{ok, token, role, display_name}`；仅业务账号可登录（admin 仅限 HTTP 后台）。
- **读工具**：直连 Action Registry 读操作，无需确认。
- **写工具**：两阶段（phase1 取表单 → 返回 `confirm_token`；phase2 携 `confirm_token` 执行），并强制 `decision_id`（决策第 0 闸）。
- **安全红线**：无 delete/remove 工具；凭证格式升级后旧 token 需重新 `crm_login`（结构化 token `crm_<id>_<secret>`）；无凭证一律 `auth_required`。

### 技能市场 / ClawHub 安装

1. 将整个 `plugin/` 包根（含 `.workbuddy-plugin/` + 包根 `agents/ skills/ avatars/` + `README.md`）整体打包为 zip 上传。
2. 在 WorkBuddy「技能市场 → 上传插件」，或 ClawHub（`openclaw skills install @<you>/sales-decision-platform`）提交该 zip（外部发布操作，需用户在对应平台侧完成）。
3. 安装后，办公智能体挂载 `sales-decision-platform` 即获得一句话查询 / 两阶段写入 / 链断裂预警能力。

> 注意：`plugin/skills/` 是分发副本（源事实在仓库根 `skills/`）。源侧更新后需重新执行打包；跨会话维护以仓库根 `skills/` 为准。包结构已对齐 `@fit2-zhao/cordys-crm` 的 ClawHub 发布格式（agents/skills/avatars 与 `.workbuddy-plugin/` 同级）。

---

## API 端点口径（graph=canonical / monitor=deprecated · 2026-08-26 拍板）

> 决策查询（决策因果链/影响地图/PROV-O 溯源）对外暴露**单一 canonical 查询面**，旧 monitor 面保留为 **deprecated 薄转发**（不删、可回滚、带 Deprecation+Link 头）。详见总体设计 `docs/specs/2026-08-25-ai-native-crm-overall-design.md` §9。

| 端点 | 口径 | 说明 |
|---|---|---|
| `GET /api/graph/trace?decisionId=&max_depth=` | **canonical** | 决策因果链（上游=为什么 / 下游=导致了什么，AGE 多跳，降级 ctePrecedents） |
| `GET /api/graph/impact?decisionId=&max_depth=` | **canonical** | 影响地图（下游全节点+深度+边） |
| `GET /api/graph/provenance?decision_id=` | **canonical** | PROV-O 溯源审计（链完整+条目+上下游+先例） |
| `GET /api/monitor/trace/:decisionId` | **deprecated** | 兼容薄转发 → graph/trace（含 Deprecation+Link 头） |
| `GET /api/monitor/impact/:decisionId` | **deprecated** | 兼容薄转发 → graph/impact |
| `GET /api/monitor/audit?decision_id=` | **deprecated** | 兼容薄转发 → graph/provenance |

**纪律**：新代码/新智能体一律接 `/api/graph/*`；monitor 壳仅供旧调用兼容，不得新增引用；未来无流量（可观测确认）后经决策事件主轴批准再删。

---

## 2026-09-08 同步说明：决策建议（8 大决策 × S1-S8）

> 对应平台侧交付：`docs/2026-09-08-dialog-driven-decision-advice-design.md` +
> 实施计划 `docs/plans/2026-09-08-dialog-driven-decision-advice.md`（T0-T9，E2E 15/15 通过）。

**版本 1.5.0 → 1.6.0。**

### 新增能力：销售每次对话都拿到决策建议

销售员的每一句话都是决策输入——不论他是否明确提出决策要求。
新 MCP 工具 **`crm-decision-advise`**（只读、需 `crm_login`）：

- **入参**：`utterance`（销售原话；服务端立即丢弃，**对话原文零落库**）、`stage`（S1-S8，可选）、`deal`（可选）。
- **坐标**：8 大决策场景（线索跟进 / 机会评估 / 客户策略 / 方案价值 / 商务报价 / 签单风险 / 终局决策 / 丢单复盘）× 商机阶段 S1-S8。
- **产出建议卡三档**：
  - **A 明确处置**——条件齐备且证据充分，给推荐 disposition + 依据 + 先例；
  - **B 风险提示**——触碰红线（如毛利低于下限）或 HIGH 级场景（报价/签单类），**必须走审批流**；
  - **C 只补信息**——坐标不明或必填条件缺失，只列缺口与追问话术，不给处置。

### 触发纪律（写进 crm-native 编排路由）

识别出销售诉求（报价/折扣/样品/方案/拜访/预算/竞品/合同/回款/丢单/新线索）时，
**先调 `crm-decision-advise` 取建议卡**，再走查询或两阶段写入；不得跳过建议直接给处置结论。
建议卡为 B 档时禁止直接触发写工具，必须引导发起审批并明确告知「这超出你的权限，需审批」。

### 本包改动清单

| 文件 | 改动 |
|---|---|
| `skills/crm-native/SKILL.md` | 意图路由表增「任何销售诉求 → 先过 crm-decision-advise」+ 新增「决策建议优先」小节；Action 读清单增 `crm-decision-advise` |
| `.workbuddy-plugin/agents/crm-native.md` | 一句话能力映射增决策建议行；能力收尾段补「决策建议」 |
| `.workbuddy-plugin/plugin.json` / `openclaw.plugin.json` / `package.json` | 版本 1.5.0 → 1.6.0 |

### 打包

```bash
python scripts/pack-crm-plugin.py        # 输出 plugin/crm-native-plugin.zip
```

> 权威源是**仓库根 `skills/`**；`plugin/skills/` 为分发副本，已同步。

---

## 2026-09-11 同步说明：线索自主发现（`discovery-*`）

> 对应平台侧交付：`docs/2026-09-10-lead-discovery-design.md` +
> 实施计划 `docs/superpowers/plans/2026-09-10-lead-discovery-engine.md`（Task 1–21）。

**版本 1.7.1 → 1.8.0。**

### 新增能力：三个 MCP 写工具（线索自主发现三段）

| 工具 | 用途 | 闸门 |
|---|---|---|
| `discovery-run` | 一次线索自主发现：按租户 ICP（行业/规模/地域/招聘信号/融资轮次）扫描已启用数据源，输出候选线索池（ICP 适配分 + 信号 + `why_narrative`） | 两阶段 + 第 0 闸（`LEAD_FIT`） |
| `discovery-enrich` | 对指定 account 执行一次字段瀑布富集（缺口字段才走付费源；来源落 `sourcedFrom` 弱边） | 同上 |
| `discovery-research` | Claygent 式自主研究（区块二分抓取 + glass-box 推理链） | 同上 |

**纪律**：① 外部数据只落 payload 事实字段 + `sourcedFrom` 弱边（`auto_weak`，置信度落边 meta）；
② 写主数据走**两阶段**（phase1 取表单 → phase2 `confirm_token` 执行）并带 `decision_id`；
③ `human_gate` —— **不进**对话入口 autonomous 写白名单（跨外联面，绝不自动发信）；
④ 绝对禁删，只增改。

### 本包改动清单

| 文件 | 改动 |
|---|---|
| `skills/crm-native/SKILL.md` | Action 写清单增 `discovery-run` / `discovery-enrich` / `discovery-research` 三行（标注两阶段 + 第 0 闸 + `human_gate`） |
| `.workbuddy-plugin/agents/crm-native.md` | 一句话能力映射增「找新线索 / 候选线索排序 → `discovery-run`」行 |
| `.workbuddy-plugin/plugin.json` / `plugin/openclaw.plugin.json` / `plugin/package.json` | 版本 1.7.1 → 1.8.0 |
| `connector/connector-meta.json` | 连接器版本 1.5.0 → 1.6.0 + 示例增一条（按 ICP 适配分找新线索） |
| `scripts/verify-plugin-zips.py` | `expect_version` 1.7.1 → 1.8.0 + 2 条防漂移内容规则（`discovery-run` / `两阶段`） |

> **副本一致性**：`skills/crm-native/SKILL.md` 共 **4 份** byte-equal 副本
> （`skills/` 权威源 + `.workbuddy-plugin/skills/` + `connector/skills/` + `plugin/skills/`）；
> `.workbuddy-plugin/agents/crm-native.md` 共 **2 份**（+ `plugin/agents/`）。改动须四/两份一起改。

### 打包

```bash
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/verify-plugin-zips.py     # 期望 version = 1.9.0（见下节）
```


---

> 对应平台侧交付：`docs/2026-09-11-lead-public-pool-tenant-design.md` +
> 实施计划 `docs/superpowers/plans/2026-09-11-lead-public-pool-tenant.md`（Task 1–10）。

**版本 1.8.0 → 1.9.0。**

### 新增能力：线索池动作族（4 个 MCP 写工具）

| 工具 | 用途 | 闸门 |
|---|---|---|
| `crm-lead-return` | 线索退回公海（S0P/S1 → `S0`）：**质量判据**（人工判断不合格），不查超期；`reason_code ∈ no_project / no_budget / no_decision_maker / no_timeline / other` 必填 | 两阶段 + 第 0 闸 |
| `crm-deal-archive-to-pool` | 战败归档（仅 S7/S8 → `S0` + `pool_type='lost'`）：留 `last_terminal_stage` 战败事实与 `prev_pool_*` 供重开恢复 | 两阶段 + 第 0 闸 + `LOSS_REVIEW`（`confirm:'critical'`） |
| `crm-lead-reclaim-bulk` | 离职批量回收：非终态置 `S0` 归原 `pool_type` 池；终态仅解绑归 `lost` **不动阶段**（防关闭商机回灌污染漏斗）；单条失败入 `failed[]` 不中断整批 | 两阶段 + 第 0 闸；**拒 `tenantId='system'` 通配** |
| `crm-deal-reopen` | 重开（S7/S8 或 战败公海 `S0+lost` → `S0P`）：重开须**重走 BANT**，出池恢复 `prev_pool_*` | 两阶段 + 第 0 闸 |

**纪律**：① 阶段集合分两套 —— `S1–S8` **冻结**（漏斗口径，`funnelKpi` 前缀膨胀依赖），`S0`（公海）/ `S0P`（私海待校验）仅入状态机与校验；
② 池 = **配置非粒子**，真源 `crm.config_store['lead-pool-config']`（**按租户**隔离，三池 `pool-new` / `pool-nurture` / `pool-lost`），页面可编辑键 = 引擎消费键；
③ 退回 / 回收 / 归档 / 重开**一律 `updateParticle` 字段变更**，**禁 `advanceStage`**（其只进不退，`S0P→S0` 必被拒）；
④ 公海 `S0` 无人跟进 → **不进**待办/跟进列表（`isOpenStage('S0')===true` 会 fail-open 计入，须显式排除）；
⑤ 绝对禁删，只增改。

### 反向漂移订正（本轮实测发现）

`buildMcpTools()` 实测工具面 **63 个**，其中 `crm-lead-pick` / `crm-lead-recycle` 为 `lifecycle=reserved` → **不在** MCP 工具面，但包内写清单此前将其列为可调用动作。本轮已在 SKILL.md 显式标注 `reserved`（推进统一走 `crm-deal-advance`），并把 4 个真暴露的动作补入清单。

### 本包改动清单

| 文件 | 改动 |
|---|---|
| `skills/crm-native/SKILL.md`（4 份副本） | 写清单增「线索池动作族」行 + 标注 pick/recycle 为 `reserved` + 增「线索三档阶段语义（S0/S0P）」说明段 |
| `.workbuddy-plugin/agents/crm-native.md`（2 份） | 一句话能力映射增 2 行（退回/归档、重开/离职回收） |
| `.workbuddy-plugin/plugin.json` / `plugin/openclaw.plugin.json` / `plugin/package.json` | 版本 1.8.0 → 1.9.0 |
| `scripts/verify-plugin-zips.py` | `expect_version` 1.8.0 → 1.9.0 + 3 条锚定 `skills/crm-native/SKILL.md` / `agents/crm-native.md` 的防漂移内容规则 |

> **副本一致性**：`skills/crm-native/SKILL.md` 共 **4 份** byte-equal 副本（`skills/` 权威源 + `.workbuddy-plugin/skills/` + `connector/skills/` + `plugin/skills/`）；`.workbuddy-plugin/agents/crm-native.md` 共 **2 份**（+ `plugin/agents/`）。本轮已 md5 校验一致。

### 平台侧协议订正：**写动作的决策凭证由服务端生成**（`deferDecisionMint`，2026-09-11 方案 H）

E2E 实测发现：`crm-deal-advance` / `crm-deal-reopen` / `crm-lead-return` / `crm-deal-archive-to-pool` / `crm-lead-reclaim-bulk` 这 5 个写动作在 MCP 通道 **phase1 被决策第 0 闸永久拦死**（返 `DECISION_NEEDED`，不发 `confirm_token`）——因为它们的决策在 **handler 内部**生成（携带 executor 无法复现的 `disposition` / `entities`），未声明网关代 mint 所需的决策场景；而 MCP 工具面 **63 个工具里没有任何「生成决策」工具**，客户端**无路径**补 `decision_id` ⇒ **工具暴露了但不可调用**。

修法（不改闸语义）：这 5 个动作声明 `deferDecisionMint` → phase1 **跳过决策拦截、直接签发 `confirm_token`**（仍**不**代 mint，防双 mint）；决策由 handler 在 **phase2 写入前**自行生成，第 0 闸在写入路径上仍被满足。普通写动作行为**完全不变**（仍 `DECISION_NEEDED`）。

对**外部智能体**的影响（本次同时订正 SKILL / agent 文档）：写动作的两阶段流程**不变**，但**不需要**（也拿不到）`decision_id` —— 决策凭证由服务端自动生成并在写入时留痕。

### 打包

```bash
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/verify-plugin-zips.py     # 期望 version = 1.10.0 且 8 条线索池/拓客/写闸规则 ok
```

> ⚠ 遗留观察（本轮未处理）：`plugin/.workbuddy-plugin/plugin.json` 仍停留在 `1.5.0`——历史嵌套副本，不属版本三清单，未被打包与校验引用。

---

## 2026-09-15 同步说明：主动拓客（`prospecting-*`）

> 对应平台侧交付：`docs/2026-09-14-prospecting-module-design.md`（已批准）+ 实施计划
> `docs/superpowers/plans/2026-09-14-prospecting-module-plan.md`（Task 1–8）。本轮 T1–T7 已收口。

**版本 1.9.0 → 1.10.0。**（功能新增：3 个对外 MCP 工具，minor bump；上次 1.9.0 已 commit 入库，非折入未提交版本。）

### 新增能力：主动拓客三段（MCP 对话驱动批量建公海池）

| 工具 | 用途 | 闸门 |
|---|---|---|
| `prospecting-search` | 按租户 ICP（行业/规模/营收/地域）+ 信号权重（hiring/funding/tender/social）批量搜索候选企业，返回候选清单 + `fit_score`（**服务端** `mergedProspectingRules` 信号加权算，**适配器不注入**） | **只读**（无闸） |
| `prospecting-select` | 从候选清单圈选（校验 `selected_ids ⊆ candidates`，防注入） | **只读**（无闸） |
| `prospecting-confirm` | 批量入公海池：每候选建 `CRM_DEAL` S0 + `pool_type:'new'` + `source:'prospecting'`；查重 `existing:true` 跳过；溯源 `DEAL --sourcedFrom--> KNOWLEDGE` 弱边（conf=`fit_score`） | 两阶段 + 第 0 闸（`PROSPECTING_CONFIRM`） |

**纪律**：① 数据源 `qixin` / `xinbang` 默认 `enabled:false`（付费源，需显式授权 + 填 key）；② 适配器 `search()` 无凭据/异常返回 `[]`（fail-open，不抛业务异常）；③ 会话状态机（searching→listing→selecting→pending_confirm→pooled）**内存态不落粒子**；④ 绝对禁删，只增改。

### 本包改动清单

| 文件 | 改动 |
|---|---|
| `skills/crm-native/SKILL.md`（4 份副本） | Action 写清单增 `prospecting-search` / `prospecting-select` / `prospecting-confirm` 三行（标注只读/两阶段 + 第 0 闸 `PROSPECTING_CONFIRM`） |
| `.workbuddy-plugin/agents/crm-native.md`（2 份） | 一句话能力映射增「按 ICP 批量搜企业进公海池 → `prospecting-*`」行 |
| `.workbuddy-plugin/plugin.json` / `plugin/openclaw.plugin.json` / `plugin/package.json` | 版本 1.9.0 → 1.10.0 |
| `scripts/verify-plugin-zips.py` | `expect_version` 1.9.0 → 1.10.0 + 3 条防漂移内容规则（`prospecting-search` 路由 / `PROSPECTING_CONFIRM` 写闸 / agent 拓客能力映射，均锚定 `skills/` 与 `agents/` 防假绿） |

> **副本一致性**：`skills/crm-native/SKILL.md` 共 **4 份** byte-equal 副本（`skills/` 权威源 + `.workbuddy-plugin/skills/` + `connector/skills/` + `plugin/skills/`）；`.workbuddy-plugin/agents/crm-native.md` 共 **2 份**（+ `plugin/agents/`）。本轮已 md5 校验一致（SKILL `7e527cb5` / agents `a99335cb`）。

### 打包

```bash
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/verify-plugin-zips.py     # 期望 version = 1.10.0 且 8 条防漂移规则 ok（已实测 ✅ 两个包全过）
```

---

## 2026-09-16 同步说明：信号日历 + 内部异动派生（`crm-signal-*`）

> 对应平台侧交付：信号日历 Plan A（ICS / 日期规则 12 Task）与 Plan B（内部异动派生，
> `src/signal/activityDerivation.js` + 定时器⑱ `activity-derivation-scan`）。

**版本 1.10.0 → 1.11.0。**

### 新增能力：信号读取与日历导出（2 个 MCP 只读工具）

| 工具 | 用途 | 闸门 |
|---|---|---|
| `crm-signal-list` | 按条件查信号（4 条规则产出的 kind：`contact_change` / `relation_cooling` / `tender_deadline` / `report_due`） | **只读**（无闸） |
| `crm-signal-ics` | 导出 `.ics` 日历（可在任意日历客户端订阅） | **只读**（无闸） |

### 前台可感知性收口（本轮一并订正）

后端跑通**不等于**外部办公智能体知道何时用：本轮把两条读工具补进 SKILL 读清单，
并在标签映射上做单源化（`portal/signalLabels.js` 为唯一映射源，删除页面内联副本），
同时新增 `signal-config.html` 承载 `signal-schedule` / `internal-signal-derivation` 两个配置键。

### 本包改动清单

| 文件 | 改动 |
|---|---|
| `skills/crm-native/SKILL.md`（4 份副本） | 读清单增 `crm-signal-list` / `crm-signal-ics` 两行 + 「内部推断（低置信）」语义提示 |
| `.workbuddy-plugin/plugin.json` + `plugin/openclaw.plugin.json` + `plugin/package.json` | 版本 1.10.0 → 1.11.0 |
| `scripts/verify-plugin-zips.py` | `expect_version` → 1.11.0 + 3 条锚定 `skills/crm-native/SKILL.md` 的防漂移规则 |

> ⚠ 本轮遗留（已在下一节订正）：`plugin/openclaw.plugin.json` 与 `plugin/package.json`
> 当时**未同步** bump，实际停留在 `1.10.0`，与权威源 `.workbuddy-plugin/plugin.json`
> 出现**一个 minor 的版本漂移**；`plugin/.workbuddy-plugin/plugin.json`（历史嵌套副本）
> 更停留在 `1.5.0`。该漂移已于 1.12.0 轮次全部对齐，并新增一致性守卫生效。

### 打包

```bash
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/verify-plugin-zips.py
```

---

## 2026-09-17 同步说明：品牌更名 + 专家名 / 小标题（版本 1.11.0 → 1.12.0）

> 本轮**无新增工具、无协议变更**，属**对外标识（品牌 / 专家名 / 卡片小标题）变更**，
> 故记 minor bump。技术代号 `CRM-AI-Native` 与 npm 包名 `@chuanvanwang-arch/crm-native` **保留不变**。
>
> ⚠ **订正（2026-09-17 晚）**：上句「npm 包名保留不变」已被后续变更推翻 —— 平台上传报
> 「专家名称 `crm-native` 已被占用」，`name` 已更名为 `sales-decision-platform`，npm 包名同步为
> `@chuanvanwang-arch/sales-decision-platform`。详见文末「平台名称占用订正」章节。

### 对外名称变更

| 项 | 旧 | 新 |
|---|---|---|
| 平台对外名 | AI原生销售平台 | **企业AI销售决策平台·ChiYu青羽** |
| 专家主标题（`profession.zh`） | 青羽销售决策助手 | **企业AI销售决策专家** |
| 卡片小标题（`displayName.zh`） | CRM 原生智能体 | **AI原生·可溯可信可进化** |
| 专家简介（`displayDescription.zh`） | — | 角色自适应的企业AI销售决策专家：一句话查询、两阶段对话式写入、链断裂主动预警。（40 字，合规区间内） |

英文同步：`Enterprise AI Sales Decision Expert` / `AI-Native · Traceable, Trustworthy, Evolvable`。

> **字段语义提醒（易错）**：卡片渲染为**三层** —— 大字主标题 = `profession`，
> 灰字小标题 = `displayName`，描述 = `displayDescription`。三者不可互填：
> `displayDescription.zh` 被打包脚本**强制归一**到 40–50 字，误把小标题写进该字段会被静默截断。

### 版本一致性订正（本轮实测发现）

`plugin/openclaw.plugin.json` 与 `plugin/package.json` 在 1.11.0 轮次**漏改**，
与权威源相差一个 minor；`plugin/.workbuddy-plugin/plugin.json`（历史嵌套副本）停留在 `1.5.0`。
本轮**四条清单全部对齐到 1.12.0**，并在校验器新增版本一致性守卫防复发。

### 本包改动清单

| 文件 | 改动 |
|---|---|
| `.workbuddy-plugin/plugin.json` | `version` 1.11.0 → 1.12.0；`profession` / `displayName` / `displayDescription` 换新名 |
| `plugin/openclaw.plugin.json` | `version` 1.10.0 → 1.12.0（**订正漂移**）；`name` 换新小标题 |
| `plugin/package.json` | `version` 1.10.0 → 1.12.0（**订正漂移**） |
| `plugin/.workbuddy-plugin/plugin.json` | `version` 1.5.0 → 1.12.0（历史嵌套副本对齐，仍**不参与分发**） |
| `.workbuddy-plugin/agents/crm-native.md` + `plugin/agents/crm-native.md` | H1 与能力映射换正式名 |
| `plugin/index.js` | 入口 JSDoc 换正式名 |
| `scripts/verify-plugin-zips.py` | `expect_version` → 1.12.0 + **新增 `check_version_consistency()` 版本三清单一致性守卫** |

> **副本一致性**：`skills/crm-native/SKILL.md` 共 **4 份** byte-equal 副本（`skills/` 权威源 +
> `.workbuddy-plugin/skills/` + `connector/skills/` + `plugin/skills/`）；`.workbuddy-plugin/agents/crm-native.md`
> 共 **2 份**（+ `plugin/agents/`）。**版本四清单**（权威源 + openclaw + package.json + 历史嵌套副本）
> 本轮已全部对齐，由校验器强制。

### 打包

```bash
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/verify-plugin-zips.py     # 期望 version = 1.12.0 且版本一致性守卫 ok
```

---

## 2026-09-17 平台名称占用订正：`name` 更名（版本保持 1.12.0）

> **触发**：上传平台报错「专家名称 `crm-native` 已被占用，请修改 plugin.json 中的 name 字段后重新打包上传」。
> 同批上传的平台管理专家亦报「`crm-platform-admin` 已被占用」⇒ 两个包的 `name` 唯一键均更名为新名。
>
> **版本不变**：包内容（技能 / agent / prompt / 工具面）**零变更**，仅改平台可见的技术标识。
> 版本号描述**内容版本**，内容未变则版本不 bump（与「不给 1.1.2 内容的旧包标 1.12.0」同一条纪律）。

### 更名映射

| 包 | 旧 `name` | 新 `name` |
|---|---|---|
| 本包（企业AI销售决策专家） | `crm-native` | **`sales-decision-platform`** |
| 平台管理专家 | `crm-platform-admin` | **`sales-decision-admin`** |

### 改动落点（本包）

| 文件 | 改动 |
|---|---|
| `.workbuddy-plugin/plugin.json` | `name` + `plugin` → 新名（权威源） |
| `plugin/.workbuddy-plugin/plugin.json` | 同上（历史嵌套副本，防漂移） |
| `plugin/openclaw.plugin.json` | `id` → 新名（该文件 `name` 是**小标题**，未动） |
| `plugin/package.json` | npm 包名 → `@chuanvanwang-arch/sales-decision-platform` |
| `scripts/verify-plugin-zips.py` | `expect_name` / 组 label / **打包脚本名提示分支** → 新名 |
| `scripts/install-plugins-to-workbuddy.py` | 市场源名 + 实例识别（**兼容旧名 `crm-native` / `crm-native-agent`**） |

### ⛔ 有意未改（防止打断既有契约）

| 未改项 | 原因 |
|---|---|
| `agentName: crm-native` | 与 `agents/crm-native.md` **文件名绑定**，打包脚本硬编码该路径；平台报错仅指向 `name` |
| 技能名 `skills/crm-native/`（`registry.json` 的 `name` / `skill_id`） | 技能是**独立命名空间**；BUDDY 应用 `industry-config.json` 以技能 ID 引用（74 处），改则断链 |
| `connector/mcp.json` 的 server 名 / `connector-meta.json` 的 `source` | **连接器已上线**，属运行时标识；改则要求用户重新配置连接器 |
| 产物名 `crm-native-plugin.zip` | 构建产物（`.gitignore`），改则牵动脚本路径 |
| 技术代号 `CRM-AI-Native` | 保留 |

### 打包与校验

```bash
python scripts/pack-crm-plugin.py --out plugin/crm-native-plugin.zip
python scripts/verify-plugin-zips.py     # 期望 name = sales-decision-platform，version = 1.12.0
```

> ⚠ **改 `name` 后必须重新导入**：平台把新 `name` 视为**另一个专家**，旧实例不会自动更新。

