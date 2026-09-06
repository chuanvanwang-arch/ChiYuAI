# 参数传播中枢（Param Propagation Hub）设计文档

> 派生：后台参数三级分类（系统级 / 租户级 / 任务级）+ 夜间复盘调参闭环
> 状态：设计稿（待 writing-plans → 实现）
> 铁律约束：所有写操作经决策第 0 闸（produceDecision）+ HITL 零信任；绝对禁 DELETE（写用 upsert）；per-tenant 隔离优先。

---

## §1 背景与目标

用户诉求：三级分类不应只是静态标签，而要能**双向流动**——

1. **下行（下发）**：系统级 / 租户级参数能否成批影响下级（如 system 一键覆盖所有租户某旋钮）。
2. **上行（推广）**：
   - 某 SKILL 在 A 租户运行得不错 → 借鉴给其它租户 / 提升为系统默认。
   - 某客户记忆（任务级）产生的经验 → 推广为整个租户的可复用先例。

目标：在既有 `config_store` 两层存储与复盘 `draft_patches` 之上，构建**统一传播中枢**，三通道（继承 / 下发 / 推广）全部经决策第 0 闸落库、可审计、可回退。

---

## §2 现状证据（已实现 vs 缺口）

| 能力 | 现状 | 证据 | 结论 |
|---|---|---|---|
| 下行继承 | ✅ 已有 | `configStore.js:10-23` `readConfig` 先 `(tenantId,key)` 后 `(system,key)` 回退 | 租户未定制自动继承系统 |
| SKILL 作用域归并 | ✅ 已有 | `skillScope.js:35` 按 `user>workspace>system` 优先级归并 | 上级默认被下级覆盖 |
| SKILL 推广(user→ws/sys) | △ 部分 | `skillScope.js:98` `promoteSkill`（`from` 仅支持 `'user'`）；UI `config.html:143`；API `decisionReadRoutes.js:378` | 无 tenant 轴 |
| 记忆蒸馏 | △ 部分 | `memoryLog.js:120` `distillMemory` + `timers.js:73` 夜间 30 天 + `routes.js:2080` `/api/memory/distill` | 自动降权退役，非"显式提升为租户先例" |
| 复盘候选(config_store 旋钮) | ⛔ 待落地 | `retro.js:54` `knob` 枚举**未含** `config_store`（前次 P4② 设计项，未实现） | 需扩展 |
| 强制批量下发 | ⛔ 缺失 | `writeConfig`（`configStore.js:26-34`）仅单 `(tenantId,key)`；无租户枚举 + 批量 upsert | 需新增 |

---

## §3 三向传播模型

### 3.1 继承 inherit（复用，不改）
- 机制：`readConfig` fallback。system 设默认值 → 所有未定制租户自动"下发"。
- 风险：低（下级可覆盖）。**本设计不改动**，仅作为中枢的"自动通道"。

### 3.2 强制下发 broadcast（新增）
- 语义：管理员将某 `config_store` 旋钮从 system 层**成批覆盖**到一组租户。
- 两种模式（默认安全）：
  - `fill-only`（默认）：仅 upsert **未定制**该键的租户（仍继承 system 者），不破坏既有定制。
  - `override`：覆盖全部目标租户；**仅对低风险 `config_store` 旋钮开放**，每次需 `decision_id` + 人工确认。
- 依赖：需租户枚举源（见 §4.1）。
- 写路径：`broadcastConfig(key,value,{mode,targets,by})` → 对每个目标 `writeConfig(tenantId,key,value,{decisionId})`（upsert，禁删）→ `emit('trace','config-broadcast',{...})`。

### 3.3 上行推广 promote（新增，两轴）
- **轴 A：task→tenant（客户经验→租户先例）**
  - 限**本租户内**（客户数据不可跨租户泄漏）。
  - `promoteMemoryToTenant(memoryId,{tenantId,by})`：在租户先例网络新增一条"经验模板"，`promoted_from` 溯源到原 `memory_log` 条目；原记忆行保留（蒸馏标记，非删除）。
  - 防污染：走"新增先例 + 蒸馏降权"而非删，符合 `memoryConfig.js` 红线。
- **轴 B：tenant→system / tenant→tenant（SKILL 借鉴）**
  - 扩展 `promoteSkill` 支持 `from='tenant'`（当前仅 `'user'`，`skillScope.js:99`）。
  - `tenant→system`：方法论成为平台默认，**闸门升级**（影响所有租户，需 sysadmin + decision_id + 人工复核）。
  - `tenant→tenant`（指定目标）：复制 SKILL 启用/配置到另一租户作用域。
  - 红线：仅推广**能力配置（方法论）**，绝不推广租户 PII / 客户数据。

---

## §4 架构与数据模型

### 4.1 租户枚举（broadcast/promote 依赖）
- 候选源：`SELECT DISTINCT tenant_id FROM crm.crm_users WHERE tenant_id<>'system'`（待确认是否为权威租户注册表；若无独立租户表，本设计建议补 `crm.tenants` 注册表以支撑枚举 + 广播目标选择）。

### 4.2 存储（复用 `config_store`，不新增主表）
- `crm.config_store(tenant_id,key,value,decision_id,updated_by,updated_at)` 已具备 `(tenant_id,key)` upsert 主键（`configStore.js:28-32`）。
- broadcast / promote 落库均走 `writeConfig`，**不改存储范式**。

### 4.3 新增/扩展模块
| 模块 | 文件（建议） | 职责 |
|---|---|---|
| 广播 | `src/config/broadcast.js` | `broadcastConfig(key,value,{mode,targets,by})`；枚举租户 + 批量 upsert + trace |
| 推广-记忆 | `src/memory/promote.js` | `promoteMemoryToTenant`；写租户先例 + 溯源 |
| 推广-SKILL | 扩展 `src/skill/skillScope.js` | `promoteSkill` 增加 `from='tenant'` 分支 + 跨租户/跨系统闸 |
| 复盘接管 | 扩展 `src/decision/retro.js:54` | `knob` 枚举补 `config_store`；`draft_patch` 增 `tenant_id`+`target` |
| 中枢 API | `src/http/propagationRoutes.js` | 见 §6 |

### 4.4 retro draft_patches 接管（打通前次例子）
- `retro.js:54` `knob` 增补 `config_store`；`draft_patch` 形态升级为**带定量处方的结构**（详见 §12.5）：
  `{knob:'config_store', target:'precedent-conf.minSimilarity', from:0.45, to:0.40, step:-0.05, risk:'LOW', tenant_id:<非空>, prescription:{action,reason,predicted_impact,sensitivity,bounds}, evidence:{...}}`。
- 处方由 §12 的**定量计算引擎**生成——不仅给"调到多少"，还给出"为什么是这个值、调完预计改善多少、敏感度边界"，补上闭环最后一公里。
- retro 按 `decision.tenant_id` 聚类感知租户（当前 `retro.js:68` 全量无租户过滤 → 需补 `WHERE tenant_id=$1` 或落 patch 时回填 `tenant_id`）。
- 由此前次用户例子（minSimilarity 0.45→0.40）即可自动产出为"推广候选"，汇入中枢。

---

## §5 决策第 0 闸与零信任保证

- **所有传播 = 写操作 = config_change 决策**：accept / broadcast / promote 内部统一 `produceDecision('config-change',{key,value,from,to})` 取得 `decision_id`，连同 `writeConfig`。
- **HITL 不可绕过**：`override` 模式、tenant→system 推广、retro 候选采纳，均须人工在 UI 点"采纳/确认"，绝不自动 apply（守 `retro.js` 铁律②"绝不自批自方"）。
- **可回退**：`config_store` 保留 `decision_id` 溯源 + `updated_at`；回退 = 再次 `writeConfig` 写回旧值（新决策），无物理删除。
- **可审计**：`emit('trace', type, {...})` 全链路留痕（broadcast / promote / retro-suggestion / accept）。

---

## §6 UI 落点（合并"调参台"→"传播中枢"）

页面 `propagation-hub.html`（合并前次 `retro-tuning.html`）四 Tab：

1. **继承视图**：展示某旋钮 system 默认 vs 各租户覆盖状态（谁继承/谁定制）。
2. **下发草稿**：broadcast 操作区（选键 + 模式 + 目标租户 + 预览影响面）。
3. **推广候选**：汇聚 ①retro `draft_patches(open)` ②task→tenant 记忆提升候选 ③tenant→system SKILL 借鉴候选；按 `risk` 分组，每条「采纳 / 驳回」。
4. **已落地**：近期经决策第 0 闸落地的传播记录（含 decision_id、操作人、时间）。

API（`src/http/propagationRoutes.js`）：
- `GET /api/propagation/suggestions?status=open` — 汇聚三类候选
- `POST /api/propagation/:id/accept` — 经 `produceDecision`+`writeConfig`/`promote` 落地
- `POST /api/propagation/:id/reject` — 标记驳回（留痕）
- `POST /api/config/broadcast` — 仅 sysadmin；`fill-only` 默认，`override` 需二次确认

---

## §7 与既有机制关系（非重复建设）

- **复用**：`configStore.readConfig/writeConfig`、决策第 0 闸 `produceDecision`、SSE `calibration/retro-suggestions`、`skillScope` 作用域、`memoryLog` 蒸馏。
- **扩展而非新建**：retro `knob` 增补、promoteSkill 分支、新增广播/推广模块；不另立主表、不改存储范式。
- **闭环贯通**：夜间复盘(run) → 聚类归因 → `draft_patches(config_store)` → 中枢"推广候选" → 人工采纳 → 决策第 0 闸 → `writeConfig` → 次日决策即时生效（如 `precedentScoring.js:94` `loadPrecedentConf` 回读 0.4）。

---

## §8 实施分期（writing-plans 预览）

| 期 | 内容 | 关键文件 |
|---|---|---|
| **P0** | **指标测量** `measureClusterMetrics` + 报告补 `config_snapshot`/`tenant_id` 列 | `retro.js` + `db/schema.sql` |
| P1 | retro `knob` 补 `config_store` + `draft_patch` 租户感知 | `retro.js:54,68` |
| **P7** | **处方定量引擎** `prescription.js`（§12.3）+ `retro-knob-map`/`prescription-engine` 配置键 + `draft_patch` 注入 `prescription` 子对象 | 新模块 + `retro.js:161` |
| P2 | `broadcast.js` + 租户枚举（补 `crm.tenants` 或复用 crm_users） | 新模块 + `configStore.js` |
| P3 | `promoteMemoryToTenant`（task→tenant，限本租户） | `src/memory/promote.js` |
| P4 | `promoteSkill` 扩 `from='tenant'`（tenant→system/tenant） | `skillScope.js:98` |
| P5 | 中枢 API + 页面 `propagation-hub.html` 四 Tab（含处方 `prescription` 展示 + 采纳前预览"调多少/为什么"） | `propagationRoutes.js` + `web/` |
| P6 | 测试：继承回退 / broadcast fill-only vs override / promote 溯源 / retro 候选 accept 落库回读 / 处方 step 边界与 floor 夹回 | `test/decision/retro.test.js` + `test/decision/prescription.test.js` |

---

## §9 风险与回退

- **覆盖风险**：`override` 误伤租户定制 → 默认 `fill-only` + 影响面预览 + 决策留痕；回退走新决策写旧值。
- **跨租户污染**：tenant→tenant 推广误带 PII → 仅推广方法论配置（SKILL），客户数据禁止；记忆推广限本租户。
- **中枢失控**：自动 apply → 坚拒，所有传播 HITL。
- **租户枚举失效**：依赖源未确认 → P2 先定权威租户注册表。
- **复盘误判阈值**：retro 建议本身可能错 → 仍须人工采纳闸，不自动落地。

---

## §10 待确认子决策（writing-plans 前）

1. 租户枚举权威源：`crm.tenants` 新建 vs `crm.crm_users.tenant_id DISTINCT`？
2. 调参台独立页 `propagation-hub.html` vs 并入 `sales-decision-monitor`？
3. tenant→system SKILL 推广是否需 sysadmin 双签（更高闸）？
4. 记忆推广落点为"租户先例网络"具体表（`decision_precedent_rel` 还是新增 `crm.tenant_precedent`）？
5. 处方引擎的"健康基线 / 敏感度系数"默认值放 `config_store['prescription-engine']` 还是 reference 表？（建议前者，确认即纳入阈值配置化铁律，禁硬编码）
   → **【已确认】** 放 `config_store['prescription-engine']`；先以 `precedent-conf` 一组做试点，跑 2~3 窗口后用真实数据回填基线（见 §14.7）。
6. LLM 降级（degraded）时，确定性处方引擎是否仍产出 `config_store` 类候选？（建议**是**——处方是纯数学，不依赖 LLM，可补当前 `heuristicAnalyze` 恒出空 `draft_patches` 的缺口）
   → **【已确认】** 是。degraded 模式仍产出 `config_store` 候选，但 `draft_patch` 标 `degraded:true`、风险不高于配置允许档（§12.6）。

---

## §11 决策参数逐参数穿透分析（5 层落位 + 效用矩阵）

> 目的：回答"每个参与决策的配置参数在哪里用、作为 7×7 输入还是 8 要素、对最终决策可能造成什么影响、偏离后调参有没有用、多大用"。
> 关键认知纠偏：决策参数不止「7×7 / 8 要素」两层，真实代码里它落在 **5 层**，绝大多数调参旋钮住在 **C 层（九尺子评分）与 D 层（业务闸门）**，既不进 7×7、也不进 8 要素。

### 11.1 五层落位模型

| 层 | 承载配置 | 真实落点（file:line） |
|---|---|---|
| **A. 7×7 输入层**（上下文完备性矩阵 L1–L7 × E1–E7） | `seven-dim`（`edge_bindings` / `required_dims` / `dim_order` / `outcome_threshold` / `confidence` / `default_strictness` / `precedent_distill` / `meta_attr_map` / `particle_attr_add` / `k_edge_add` / `source_refresh`） | `edgeDimensionSpec.js`、`sevenDimConfigStrategy.js` |
| **B. 8 要素骨架层**（决策思维骨架） | `decision_scenario.focus_elements` / `focus_rulers` / `rubric_pass_line` | `decisionReadRoutes.js:54`（**表列，非 config_store 键**） |
| **C. 九尺子评分层**（置信度 → 自主/升级） | `autonomy-conf`（`threshold` + 5 权重）、`precedent-conf`（`minSimilarity` + 维度权重） | `autonomyEngine.js:26-42`、`precedentScoring.js:95` |
| **D. 业务闸门层**（分级/审批/行为/财务） | `sales-thresholds` / `approval-config` / `behavior-standard` / `named-account-targets` / `finance-receivables` / `tenant-profile` | 各路由/引擎 |
| **E. 闭环测量层** | `hindsight-deviation` | `closureLoop.js:22-31` |

**结论**：配置参数**不"成为"8 要素**，而是**塑造**它的骨架（经 `rubric_pass_line` 等）；8 要素是场景级**表配置**，不是 config_store 旋钮。调参旋钮的主战场是 C、D 两层。

### 11.2 逐参数穿透表（参与决策的全部配置键）

| 配置键 | 落层 | 使用点（file:line） | 对最终决策的影响 | 偏离时调整效用 |
|---|---|---|---|---|
| `autonomy-conf.threshold` | C | `autonomyEngine.js:35,259` | 置信度≥阈值→自主放行，否则升级。全局主闸 | **高**（最直接杠杆，但全局影响所有场景，风险高） |
| `autonomy-conf.weights` | C | `:28,40`（similarity0.4/coverage0.3/method0.1/evidence0.1/allMet0.1） | 决定 5 因子如何合成置信度 | **中高**（须保持权重和=1.0，`parity.test.js` 锁死） |
| `precedent-conf.minSimilarity` | C | `precedentScoring.js:95` | 先例召回门槛 → `similarity` 因子 → 置信度 | **中高**（即用户例 0.45→0.4；专治"先例命中低→误升级"） |
| `precedent-conf` 维度权重 | C | 同文件 | jaccard/graphDepth/vector 如何合成相似度 | **中** |
| `sales-thresholds` | D | `autonomyEngine.js:187,352`、`seed-actions.js:364+` | 业务分级 → 自主边界；漏斗加权 | **高**（治"大客户被当小客户误放行"） |
| `seven-dim.edge_bindings` | A | `edgeDimensionSpec.js:47` | 7×7 巡检"边↔维"结构定义 | **中**（重塑整张上下文矩阵，风险中） |
| `seven-dim.required_dims` | A/B | `decision_scenario.required_dims` | 决策被标"维度缺失"的依据 | **高**（治完整性驱动的拦截） |
| `seven-dim.outcome_threshold`/`confidence`/`default_strictness` | C/A | `sevenDimConfigStrategy.js:72-84` | 评分严格度 | **中** |
| `seven-dim.precedent_distill`/`dim_order`/`meta_attr_map`/`particle_attr_add`/`k_edge_add`/`source_refresh` | A | `:86-102` | 蒸馏/排序/映射等窄面 | **低–中** |
| `approval-config` | D | `approvalConfig.js:59`、`routes.js:180` | 审批流拓扑/角色链 | **中**（流程卡死/越权，不改决策质量） |
| `behavior-standard` | D | `seed-actions.js:318` | 21 条合格线 → 行为评分 | **低–中**（下游质量） |
| `named-account-targets` | D | `seed-actions.js:486`、`timers.js:174` | 指名客户 tier×频率×窗口 | **中**（影响 prior，非最终决策） |
| `finance-receivables` | D | `financeAlertHook.js:28` | 逾期/差额/账龄预警 | **低**（仅告警） |
| `knowledge-injection-map` | A | `assembler.js:129` | 上下文供给层次 | **中**（上下文质量） |
| `context-routing` | A | `routing.js:112` | 场景→轨道映射 | **N/A**（禁改红线） |
| `hindsight-deviation` | E | `closureLoop.js:26` | 定义"什么是偏离"+ 报警率 | **对最终决策无直接影响**，只改偏离告警灵敏度 |
| `decision-retro` | 过程 | `retro.js:22` | 仅控报告生成（超时） | **不影响决策结果** |

### 11.3 偏离症状 → 调参效用矩阵（"调整有没有用、多大用"）

| 最终决策偏离表现 | 根因大概率在 | 调哪个参数 | 效用 | 说明 |
|---|---|---|---|---|
| 应自主却频繁升级 | 阈值过紧 / 先例召回低 | `autonomy-conf.threshold`↓ 或 `precedent-conf.minSimilarity`↓ | **高** | 用户例正属此类 |
| 应升级却自主放行（漏判风险） | 阈值过松 / 权重偏 similarity | `autonomy-conf.threshold`↑ 或 调 `weights` | **高** | 全局风险，须 HITL |
| 大客户被低级别自动处理 | 业务分级错 | `sales-thresholds` | **高** | 直接改分级边界 |
| 决策被标"维度缺失"误拦 | 完备性过严 | `seven-dim.required_dims` 收敛 | **高** | 治误拦截 |
| 先例相关性差（强关系误判） | 相似度合成偏 | `precedent-conf` 维度权重 | **中** | 需 replay 验证 |
| 上下文供给不足/过杂 | 知识注入错 | `knowledge-injection-map` | **中** | |
| 审批流卡死/越权 | 流拓扑错 | `approval-config` | **中** | |
| 偏离告警太多/太少 | 报警灵敏度 | `hindsight-deviation` | **仅告警层** | 不改决策，只改何时报 |

### 11.4 三个必须点出的真实发现（与传播中枢强相关）

1. **`seven-dim` 读写不对称（治理缺口）**：`readSevenDimConfig({tenantId})` 接受租户（`sevenDimConfigStrategy.js:16`），但 `writeSevenDimSubKey` 写死 `tenant_id='system'`（`:27-29`）。即**租户定制读得到、落不回**——直接冲击传播中枢"per-tenant 隔离"前提，须在中枢 Task 1 显式修复（改 write 走 `(tenant_id,key)` upsert）。
2. **`autonomy-conf` 是"全局主杠杆"**：它不经租户（`readConfig('autonomy-conf',{tenantId:'system'})`，`:35`），调一处影响全平台所有场景。传播中枢 broadcast 时它应默认 `fill-only` 且 `override` 需 sysadmin 双闸。
3. **`hindsight-deviation` 是"偏离的度量本身"**：它不参与决策，只定义偏差报警。调它**不改变决策结果**，只改变你"多快发现偏离"——这是闭环里"测量"与"干预"必须分离的铁证；前次 retro `knob` 扩展应把 `hindsight-deviation` 列为"测量类旋钮"，与 `config_store` 类"干预类旋钮"区分处理（见 §12.2）。

---

## §12 处方定量计算引擎（闭环最后一公里：调多少、为什么）

> 问题 2 的真正缺口：当前 retro 若产出 `minSimilarity 0.45→0.4`，只给了目标值，**没说为什么是 0.4（不是 0.35/0.5）、调多少的依据、调完预计改善多少**。本引擎补上"定量处方"——每一条建议必须携带 `prescription` 子对象，机器可执行、人读可审阅。

### 12.1 缺失度量：cluster 需新增指标采集

当前 `clusterByScenario`（`retro.js:77-115`）只采 `category_distribution / missing_dims / missing_edges / feedback_flags`，**没有旋钮相关量化指标**。处方引擎前置条件：在 `analyzeCluster` 前跑 `measureClusterMetrics(cluster)`，按 `retro-knob-map` 所需的 `metric` 槽位产出数值。最小集：

| metric 槽位 | 含义 | 来源 |
|---|---|---|
| `precedent_recall` | 实际召回可用先例的决策占比 | `category_distribution` 中 `precedent_used` vs `precedent_missing`；或 `attribution.similarity >= minSimilarity` 占比 |
| `major_deviation_rate` | 重大偏差率 | `feedback_flags.majorDeviation / count` |
| `unusable_rate` | 业务判定不可用率 | `feedback_flags.unusable / count` |
| `dim_missing_rate` | 维度缺失率 | `sample_missing_dims` 相关计数 |
| `upgrade_rate` | 被自主升级（误升）占比 | decision 走出 autonomy 升级路径的占比 |

### 12.2 旋钮映射表（配置化 `retro-knob-map`，禁硬编码）

翻译层把"七类根因 + 实测指标"映射到"候选 config 旋钮 + 健康基线 + 敏感度"。**必须配置化**（落 `config_store['retro-knob-map']`），绝不硬编码——否则违反"行业差异化 100% 配置化"铁律。示例条目：

```json
{
  "knob_map": [
    {
      "root_cause_class": "DATA_QUALITY_PRECEDENT",
      "metric": "precedent_recall",
      "knob": "config_store",
      "target": "precedent-conf.minSimilarity",
      "direction": "down",            // 降阈值→提召回
      "healthy_baseline": 0.30,      // 健康召回率
      "floor": 0.30,                 // 不低于此（精度下限）
      "ceiling": 0.60,               // 不高于此
      "sensitivity_k": 0.5,          // gap→step 的缩放（0.18*0.5=0.09）
      "sensitivity_slope": 2.0,      // minSimilarity 每降 0.01 → 召回 +0.02
      "max_step": 0.05, "min_step": 0.02
    },
    {
      "root_cause_class": "DIM_MISSING",
      "metric": "dim_missing_rate",
      "knob": "config_store",
      "target": "seven-dim.required_dims",
      "direction": "shrink",          // 收敛必填维度清单
      "healthy_baseline": 0.05,
      "sensitivity_k": 0.3,
      "max_step": 1, "min_step": 0
    }
  ]
}
```

> `hindsight-deviation` / `decision-retro` 标记为 `"class": "measurement"`（测量类，不进干预处方）。

### 12.3 处方算法（确定性，可脱离 LLM 运行）

```
prescribe(cluster, knobSpec, curConfig):
  cur      = readConfig(knobSpec.target, {tenantId: cluster.tenant_id})   # 当前值，如 0.45
  measured = cluster.metrics[knobSpec.metric]                            # 实测，如 0.12
  gap      = knobSpec.healthy_baseline - measured                        # 0.30 - 0.12 = 0.18
  # 方向校验：指标已健康则不产处方
  if sign(gap) != directionSign(knobSpec.direction): return null
  rawStep  = gap * knobSpec.sensitivity_k                                # 0.18 * 0.5 = 0.09
  step     = clamp(rawStep, knobSpec.min_step, knobSpec.max_step)         # → 0.05
  target   = (direction=='down'||'shrink') ? cur - step : cur + step     # 0.45 - 0.05 = 0.40
  # 边界与安全闸：越界则夹回并升 risk
  if target < knobSpec.floor || target > knobSpec.ceiling:
      target = clamp(target, floor, ceiling); risk = 'MEDIUM'
  # 线性敏感度预测改善量
  predicted = clamp(measured + step * knobSpec.sensitivity_slope, 0, 1)   # 0.12 + 0.05*2.0 = 0.22
  risk     = chooseRisk(step, cur, floor, ceiling)                        # step 小、未触底 → LOW
  return { target, from: cur, to: target, step: ±step, predicted, risk, ... }
```

**为什么"调多少"有依据**：step 不是拍脑袋，而是 `gap(实测-基线) × 敏感度系数 k`，并受 `max_step` 封顶（防一次跳太大）——0.45→0.40 是"缺口 18pp、k=0.5 → 理论 9pp，但封顶 5pp"的结果。再加 `floor=0.30` 防精度崩塌。

### 12.4 端到端示例（用户的 minSimilarity 场景，闭环打通）

输入：T1 租户 `precedent-conf.minSimilarity=0.45`，窗口内 `precedent_recall=0.12`、健康线 0.30。

```
读配置    : cur = 0.45
读实测    : measured = 0.12
算缺口    : gap = 0.30 - 0.12 = 0.18 (召回不足 → 需降阈值)
算步长    : rawStep = 0.18 * 0.5 = 0.09 → clamp(max 0.05) = 0.05
定方向    : down → target = 0.45 - 0.05 = 0.40
查边界    : 0.40 > floor(0.30) → 安全
预改善    : predicted = 0.12 + 0.05*2.0 = 0.22 (预计命中率回升至≈22%，仍低于30%目标但安全逼近)
风险      : LOW（步长小、未触底）
```

产出的 `draft_patch`（注意 `prescription` 子对象，人读即懂"调多少、为什么"）：

```json
{
  "knob": "config_store",
  "target": "precedent-conf.minSimilarity",
  "from": 0.45, "to": 0.40, "step": -0.05,
  "risk": "LOW",
  "tenant_id": "T1",
  "label": "先例召回偏低，下调 minSimilarity 至 0.40 提升命中",
  "prescription": {
    "action": "下调",
    "reason": "当前先例召回率=12%，健康线=30%（缺口18pp）；minSimilarity 每降 0.01 预计召回 +2pp；下调 0.05 后预计召回≈22%，且不突破精度下限 0.30",
    "predicted_impact": { "metric": "precedent_recall", "from": 0.12, "to_est": 0.22, "target": 0.30 },
    "sensitivity": { "floor": 0.30, "ceiling": 0.60, "current": 0.45,
                     "further_down_risk": "低于 0.35 时预计精度（specificity）< 下限，误召回风险陡升 → 不建议一步到位，本轮仅调至 0.40" },
    "bounds": { "do_not_below": 0.30, "do_not_above": 0.60 }
  },
  "evidence": { "precedent_recall": 0.12, "precedent_recall_target": 0.30,
                "sample_n": 142, "major_deviation_rate": 0.09 }
}
```

**闭环接驳**：调参台标黄(LOW) → 管理员点"采纳" → `produceDecision('config-change',{key,value,from,to,source_report_id})` + `writeConfig('precedent-conf',{minSimilarity:0.40},{tenantId:'T1',decisionId})` → 次日 `precedentScoring.js:94` `loadPrecedentConf` 即时读到 0.40 → 实测召回从 12% 爬向 22%，下一份复盘报告携带 `config_snapshot`（见 §12.5）可回溯"是谁、因哪份报告、调到多少"。

### 12.5 draft_patch 新形态（覆盖 §3.4）

`retro.js:54` `knob` 增补 `config_store`；每条 `draft_patch` 须含：`target`（点路径）、`tenant_id`、`step`、`risk`、`prescription`（§12.4 子对象）、`evidence`。报告落库同时写入 `config_snapshot JSONB`（运行时各旋钮值副本）与 `tenant_id`（`decision_retro_report` 表补列，见 §8 P0）——使"配置变更↔报告"双向可溯源。

### 12.6 与中枢、零信任的关系

- 处方引擎是**确定性纯函数**，LLM 降级时仍可运行（补 `heuristicAnalyze` 恒空 `draft_patches` 缺口，见 §10.6）——建议项。
- 所有 `config_store` 处方仍须**人工在调参台点"采纳"**经决策第 0 闸落地，引擎绝不自动 apply（守 `retro.js` 铁律②）。
- `risk` 由 step 幅度 + 边界距离自动定级，LOW/MEDIUM/HIGH 决定 UI 高亮与二次确认强度。

---

## §13 实施计划修订（对应 writing-plans）

在 `docs/2026-09-04-param-propagation-hub-plan.md` 的 8 Task 基础上增补：

| 增补 | 内容 | 落点 |
|---|---|---|
| **P0 指标测量** | `measureClusterMetrics(cluster)` 产出 §12.1 指标槽位 | `retro.js` 新增，接在 `clusterByScenario` 后 |
| **P7 处方定量引擎** | `src/decision/prescription.js` 实现 §12.3 算法 + `retro-knob-map` / `prescription-engine` 配置键 + `draft_patch` 注入 `prescription` 子对象 | 新模块 + `retro.js:161 analyzeCluster` 内接 |
| **P0' 报告补列** | `decision_retro_report` 增 `config_snapshot JSONB` + `tenant_id` | `db/schema.sql` + 迁移 |
| **P8 权限重分组** | 配置中心导航拆系统级/租户级两组 + `requireRole`/`requireAnyRole` 闸门 + broadcast/上下贯通强制 ADMIN（§15） | `src/http/middleware/rbac.js` + 配置中心路由 + `propagationRoutes.js` |

其余 P1–P6 维持原计划（retro knob 扩展 / broadcast / promote / 中枢 API / 页面 / 测试）。

---

## §14 待确认子决策（补充）

7. `prescription-engine` 默认值（`healthy_baseline` / `sensitivity_k` / `slope` / `max_step`）的出厂值如何定？建议先以 `precedent-conf` 一组做试点，跑 2~3 个窗口后用真实数据回填基线，避免初始拍脑袋。
   → **【已确认】** 试点先行 + 真实数据回填基线（与 §10.5 一致）。
8. 处方是否带"自动回滚触发"：若采纳后下个窗口指标更差，是否自动生成一条反向 draft_patch？（建议**生成反向候选但绝不自动回滚**，仍走 HITL）
   → **【已确认】** 生成反向候选（建议反向目标值 = 原 `from`），但**绝不自动回滚**，仍须经决策第 0 闸人工采纳。

---

## §15 后台参数按权限重分组（系统级 / 租户级 + 角色闸门）

> 用户决议：后台设置按**系统级 / 租户级**重新分组，并施加基于角色的访问控制。本设计据此重构配置中心导航与 API 闸门。

### 15.1 角色与权限矩阵

| 角色 | 系统级（查看/变更） | 租户级（查看/变更） | 上下贯通（broadcast） |
|---|---|---|---|
| **ADMIN** | ✅ 仅 ADMIN | ✅ | ✅ **必须 ADMIN** |
| **sysadmin** | ❌ | ✅ | ❌ |
| **tan_admin**（租户管理员） | ❌ | ✅（限本租户） | ❌ |

**要点**：
- **系统级**：仅 ADMIN 可进入查看或变更——包括 LLM 配置、用户/RBAC、MCP 连接器、系统设置、场景路由(禁改红线)、审计链巡检、事件复盘总开关、门户页生成、智能体配置(只读)、本体/词汇、方法论 SKILL 注册、决策思维要素(只读)。
- **租户级**：tan_admin / ADMIN / sysadmin 均可查看或变更，但 tan_admin **仅限本租户**作用域（per-tenant 隔离）；sysadmin 与 ADMIN 跨租户可见。
- **上下贯通（下发/推广 / broadcast / tenant→system）**：强制 ADMIN 权限——这是穿透层级的"高权限操作"，sysadmin / tan_admin 即使能改租户级参数，也**无权**发起跨层级传播。

### 15.2 后台导航重分组（系统级组 / 租户级组）

配置中心导航按权限拆为两个一级分组，每组下挂既有 24 项（id 11–39）：

- **【系统级组】仅 ADMIN**（`requireRole('ADMIN')`）：
  - 11 LLM配置 · 12 用户管理 · 13 权限/RBAC · 16 方法论SKILL注册 · 22 本体/词汇 · 23 智能体配置(只读) · 24 门户页生成 · 27 MCP连接器 · 28 系统设置 · 33 决策思维要素(只读) · 35 事件复盘总开关 · 36 场景路由(禁改红线) · 37 审计链巡检 · 39 事件派发
- **【租户级组】tan_admin+sysadmin+ADMIN**（`requireAnyRole(['tan_admin','sysadmin','ADMIN'])` + 租户作用域过滤）：
  - 14 决策场景 · 15 七维设计 · 17 审批流 · 18 业务分级 · 19 粒子Schema · 20 池配置 · 21 预警规则 · 26 记忆/先例 · 29 财务应收 · 30 指名客户目标 · 31 行为标准 · 32 判定阈值 · 34 审批业务参数 · 38 先例检索
- **【运行/闭环组】（任务级，归系统级治理，仅 ADMIN）**：事件复盘运行参数(`window_hours`/`llm_timeout_ms`/跑批时点) + 复盘 `draft_patches` 候选。候选"采纳"动作继承**目标参数层级**的权限（目标=租户级则 tan_admin 可采纳本租户候选；目标=系统级则须 ADMIN）。

> 注：原"任务级"在本权限模型下不单列导航组——运行期参数属系统级治理、复盘候选的采纳权随目标层级走。分层语义见 §11（5 层落位）与 §3（三向传播），**权限分组只取系统级/租户级二维**。

### 15.3 路由/API 层闸门（实施落点）

- 配置中心读/写路由统一经 `requireRole` / `requireAnyRole` 中间件（`src/http/middleware/rbac.js`，复用既有 `crm.rbac` 角色×`data_scope`）：
  - `GET/PUT /api/config/system/*` → `requireRole('ADMIN')`
  - `GET/PUT /api/config/tenant/*` → `requireAnyRole(['tan_admin','sysadmin','ADMIN'])` + `tenantId` 强制等于会话租户（tan_admin）或可选（sysadmin/ADMIN）
  - `POST /api/config/broadcast`（上下贯通）→ `requireRole('ADMIN')`（见 §6，原 `fill-only`/`override` 模式保留，但权限闸上提为 ADMIN 强制）
- 传播中枢所有写操作（broadcast/promote/accept retro 候选）在既有的**决策第 0 闸之上**，再叠加本角色闸——双闸串行：先过角色闸，再过决策闸。

### 15.4 与既有 RBAC 的映射

- 角色名归一：`ADMIN`/`sysadmin`/`ten_admin` 映射到 `crm.rbac` 的 `role` 枚举（若历史枚举为旧拼写，则在 `rbac` 表做别名映射，不改传播中枢逻辑）。
- `data_scope`：`tan_admin` = 单租户；`sysadmin` = `*`(全租户只读/写)；`ADMIN` = `*`(含系统级)。
- 场景路由 `context-routing`（id 36）属系统级禁改红线，天然仅 ADMIN 可见，与既有"禁改红线"一致，无新增冲突。

### 15.5 对传播中枢的影响小结

| 操作 | 所需角色 | 说明 |
|---|---|---|
| 看/改系统级参数 | ADMIN | §15.1 |
| 看/改租户级参数 | tan_admin / sysadmin / ADMIN | tan_admin 限本租户 |
| 系统→租户 下发(broadcast) | **ADMIN** | 上下贯通强制 |
| 租户→系统 推广(SKILL) | **ADMIN**（+ sysadmin 双签建议保留，见 §10.3） | 穿透层级 |
| 采纳 retro 候选(目标=租户级) | tan_admin / sysadmin / ADMIN | 随目标层级 |
| 采纳 retro 候选(目标=系统级) | ADMIN | 随目标层级 |

---

## §16 夜间复盘整改报告 + ADMIN 待办闭环（本需求）

> 用户需求（原文）：「每日晚上复盘智能体运行完成必须产出整改报告，报告里需详细描述：本日任务执行情况、存在问题、详细建议（处方定量计算引擎），并自动推送到 ADMIN 的待办里面。待办批准后立即生效！」

### 16.1 需求 → 既有机制映射（关键：复用，不新建待办系统）

| 用户原话 | 落到平台既有机制 | 证据 |
|---|---|---|
| 每日复盘跑批产出报告 | `retro.js` 已每日 02:00 跑批（`timers.js:130`），落 `decision_retro_report` | `src/decision/retro.js:254-264` |
| 报告含「本日任务执行情况 / 存在问题 / 详细建议」 | 给报告补结构化区块 `rectification JSONB`（三段落） | `decision_retro_report` 现仅有 `clusters/draft_patches/summary`（`schema.sql:573`） |
| 详细建议 = 处方定量引擎 | 直接消费 §12 `prescribe()` 输出（含 before/after/why/敏感度边界） | `src/decision/prescription.js`（Task 9） |
| 自动推送到 ADMIN 待办 | **复用 `crm.calibration_patch`**（其本质就是"配置变更草稿待批准"= 待办）；补 `assignee` 列定向 ADMIN + SSE 推送 | `db/schema.sql:514`、`src/calibration/store.js:73` |
| 待办批准后立即生效 | `approvePatch` 已：`produceDecision` 第 0 闸 + 事务原子 apply + 状态置 `APPLIED`——**批准即生效已具备** | `src/calibration/store.js:135-156` |

> **核心结论**：待办载体与"批准即生效"**均已存在**，本需求只需三处适配即可打通——① `calibration_patch.knob` 枚举 + JS `KNOBS` 扩充 `config_store`；② 表增 `assignee` 列；③ 新增 `ConfigStoreStrategy`（经传播中枢 `writeConfig` 落库，禁 DELETE、upsert）。**不新建待办表、不复刻审批流**。

### 16.2 整改报告结构（`decision_retro_report` 增 `rectification JSONB`）

```jsonc
rectification: {
  "daily_ops": {                       // 本日任务执行情况
    "window": "2026-09-04 02:00~02:30",
    "decisions": { "total": 142, "autonomous": 98, "escalated": 44, "avg_confidence": 0.81 },
    "agent_tasks": { "scheduled": 30, "completed": 28, "timeout": 1, "failed": 1 },  // 来自 crm.tasks (schema.sql:58)
    "agent_sla": { "auditability_pct": 98.2, "tampered": 0, "q1_pass": 120 },        // 来自 agent_sla (migrate.js:121)
    "verdict": "执行平稳，1 条 agent 任务超时待关注"
  },
  "problems": [                        // 存在问题
    { "cluster": "C-MED-DEAL", "root_cause": "DATA_QUALITY_PRECEDENT",
      "evidence": "先例命中率 12% vs 健康线 30%", "severity": "MEDIUM" }
  ],
  "prescriptions": [                   // 详细建议（§12 处方引擎量化输出）
    { "target": "precedent-conf.minSimilarity", "from": 0.45, "to": 0.40,
      "why": "缺口 18pp；minSimilarity 每降 0.01 预计召回 +2pp",
      "predicted_after": "22%（不突破精度下限 0.30）", "risk": "LOW",
      "evidence": { "hit_rate_measured": 0.12, "healthy_baseline": 0.30, "slope": 2.0 } }
  ]
}
```

- **daily_ops 数据源**：`crm.decision`（当日决策，retro 已扫）、`crm.tasks`（kanban 调度执行，`schema.sql:58`）、`agent_sla`（智能体健康度，`migrate.js:121`）。聚合逻辑放新函数 `summarizeDailyOps(pool, window)`，在 `retro.js` 跑批末段调用。
- **problems**：来自 `analyzeCluster`（`retro.js:161`）弱簇 + 七类根因（`retro.js:28-36`），引用证据而非空话。
- **prescriptions**：来自 §12 `prescribe()`，与 `draft_patches` 同源（一条处方 = 一个待办草稿）。

### 16.3 待办推送与批准生效（闭环）

```
retro 跑批末段
  └─ 对每条 knob='config_store' 的 draft_patch
       └─ createPatch({ knob:'config_store', target:'precedent-conf.minSimilarity',
                         from_value, to_value, evidence, expected_impact,
                         risk, assignee:'ADMIN', decision_id })   // → 落入 calibration_patch（=ADMIN 待办）
  └─ emit('calibration','todo-created',{ patch_id, target, risk, assignee:'ADMIN' })  // SSE 推送角标
ADMIN 待办面板 (GET /api/admin/todos?status=PENDING&assignee=ADMIN)
  └─ 展示 rectification.prescriptions 明细
ADMIN 点「批准」(POST /api/calibration/patches/:id/approve 已存在)
  └─ approvePatch → produceDecision(第0闸) + 事务 writeConfig(经 ConfigStoreStrategy) → 状态 APPLIED
  └─ 次日 loadPrecedentConf 即时读到 0.40（立即生效，无需重启）
```

- **须先扩展（Task 12 落）**：
  1. `calibration_patch.knob` CHECK 由 `('threshold','weight','required_dims')` 扩为含 `'config_store'`（`schema.sql:517` + 迁移）；
  2. JS `KNOBS` 常量（`store.js:74` 引用）同步增 `'config_store'`；
  3. 表增 `assignee TEXT NOT NULL DEFAULT 'ADMIN'`（迁移 `ALTER TABLE`）；
  4. 新增 `src/calibration/knobs/configStoreStrategy.js`（参照 `sevenDimConfigStrategy.js:49 apply`）：`apply(client,toValue,{target,decisionId,tenantId})` → `writeConfig(target.split('.')[0], toValue, {tenantId, decisionId})`，**upsert 禁 DELETE**，与传播中枢 `writeConfig` 同范式。
- **推送通道**：复用既有 SSE `bus.emit`（`autoSuggest.js:128` 同域 `calibration`），前端 ADMIN 待办角标订阅 `todo-created` 事件，零新增传输协议。

### 16.4 权限（与 §15 一致）

- `assignee` 默认 `'ADMIN'`；租户级候选（`target` 形如 `tenant_id` 维度）→ `assignee='tan_admin'` 并限本租户（随目标层级，见 §15.5）。
- 待办批准属"配置变更"，须满足 §15 角色闸：**系统级候选须 ADMIN；租户级候选 tan_admin/sysadmin/ADMIN 可批**。
- 待办本身只读可见性：ADMIN 可见全部；tan_admin 仅见本租户 assignee 行。

### 16.5 与实时 autoSuggest 的分工

- `autoSuggest.js`（T21 J3）是**实时**偏差浮卡（偏差即出建议，无 LLM、确定性），同样落 `calibration_patch` → 同一待办源。
- `retro.js` 是**夜间批量**整改报告（含 daily_ops + 三段落）。
- 二者通过 `calibration_patch` 统一为"ADMIN 待办中心"，避免双套待办。

### 16.6 风险与护栏

- **绝不自动 apply**：retro 只 `createPatch`（PENDING），批准动作在 ADMIN 侧（`store.js:218`），符合 retro.js 铁律②「绝不自批自方」。
- **幂等**：`savePatches`（`store.js:90`）已按 `scenario_id+knob+target+to_value+PENDING` 去重，重复跑批不刷屏待办。
- **可回退**：`rollbackPatch`（`store.js:167`）恢复 `from_value`，仍经第 0 闸；ADMIN 可一键回滚。
