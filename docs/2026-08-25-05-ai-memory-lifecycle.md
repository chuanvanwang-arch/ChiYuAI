# AI 原生 CRM · 05 记忆生命周期设计（ai-memory-lifecycle）

- 日期：2026-08-25
- 方法论依据：`ai-memory-lifecycle`（双轨记忆 / 分层治理 / 生命周期 / 防污染 / 30 天蒸馏 / 四构件 / residue 铁律）
- 业务基线：`docs/2026-08-24-ai-native-sales-crm-design.md` §5ter（跟进域 §5ter.10 / 审批流 §5ter.11 / 导入导出 §5ter.18）+ §5ter-quater（Q.20 能力×业务设计输入 / Q.19 理念差异 D10·D12）
- 前置架构：`docs/2026-08-25-ai-native-crm-overall-design.md` §2（记忆挂点 L2+L3、阶段 2）/ §5（跨平面事件流：记忆由 L2 事件平面触发、落 L1 粒子平面、供 L3 智能体/L4 门户消费）

## 0. 核心立场：跟进即记忆

> **记忆是被治理的资产，不是被堆积的日志——每一层都有自己的生命周期与写入门槛。CRM 域最关键的一条判别：跟进/评论/@提及不是数据表，而是跨会话延续的记忆流。**

对 CRM 销售域的关键判别：
- **跟进/评论 = 记忆流而非数据表**（D10 跟进记忆化）：官方 CordysCRM 把 FollowUpPlan/FollowUpRecord/Comment/CommentMention 拆成四张表；我们把它升级为「记忆流 + 协作事件」——AI 可跨会话引用跟进上下文（"上次他说预算卡在谁那"可直接召回），@提及触发协作事件自动注入被提及人上下文。
- **审批记录 = 审计快照**：每次提交/审批/意见落不可变快照，供审计与智能体引用，而非一张可改写的日志表。
- **凭证附件 = 记忆**：回款凭证/合同附件/发票票据进记忆系统（事件 + 附件快照），被 AI 引用、可追溯，而非普通文件字段。
- **导入导出偏好 = UI 偏好层**：用户上次选择的字段与排序跨会话记住，属 L-User 级跨项目偏好，而非前端 localStorage 临时态。

## 1. 方法论依据（通用法则提炼，保持跨域）

> **记忆 = 分层 + 门槛 + 生命周期。没有分层的记忆是日志，没有门槛的记忆是污染，没有生命周期的记忆是负债。**

从 `ai-memory-lifecycle` 提炼本能力通用方法论核心（不写任何项目专有名词）：

1. **双轨记忆结构**（工作区级核心实践）：
   - `memory_log`（append-only 日志）：只追加不覆盖，追时间线、防篡改、可追溯。
   - `memory_note`（curated 常驻笔记）：定期重写，追主题、防膨胀；**笔记是日志的蒸馏，不是拷贝**。
   - 工程化建议：PG 双表优于文件系统双文件——`memory_log` 不提供 update 接口强制 append-only；`memory_note` 唯一键 `(tenant_id, layer, topic)` upsert 重写。

2. **三层记忆治理**（范围从小到大、治理从弱到强）：
   | 层 | 范围 | 内容类型 | 写入门槛 | 生命周期 |
   |---|---|---|---|---|
   | L-Cloud 云端画像 | 跨会话自动生成 | 用户长期画像/偏好（服务器侧推导） | 隐式学习，只读 | 服务器管理 |
   | L-User 用户级 | 跨项目 | 明确的、跨项目通用的规则与偏好 | 用户明确要求 / 跨项目习惯 | 手动精简维护 |
   | L-Workspace 工作区级 | 当前项目 | 项目事实/决策/约定 | 实质性工作完成后必记 | 双轨 + 30 天蒸馏 |

3. **生命周期五阶段**：写入（门槛最高）→ 组织（双轨）→ 检索（按来源选通道，不全量重读）→ 沉淀（log→curated 是改写不是复制）→ 蒸馏/遗忘。
   - **写入门槛**：这条信息 30 天后还有价值吗？没有 → 不写。禁止记录搜索词/临时路径/工具报错/过程性对话（瞬态噪声，记了就是污染）。
   - **judgeWorthiness 四优先级不可颠倒**：① 敏感凭证硬拒（即便显式也拦）；② 显式意图优先；③ 瞬态噪声正则命中且非显式 → 拒；④ `value_horizon_days < 30` 且非显式 → 拒。
   - **蒸馏标记 `distilled=true`**（非删除）：保留时间线可追溯 + 二次蒸馏幂等。
   - **遗忘 = 归档非删除**：`updated_at` 超 `ttl_days` → `archived=true`，原始行保留，`retrieve` 默认过滤。

4. **记忆四构件 + 知识成熟度**：记忆 = 事实(What)+关系(Who)+理由(Why)+时序(When)；成熟度 Raw→结构化→蒸馏→叙事；向量层仅加速（embeddings 不承载写回）。**能答 Why 才是记忆系统，只答 What 的是数据库**。

5. **residue 铁律（捕获摩擦审计）**：捕获必须嵌入既有工作流事件自动触发（会话结束/任务完成/审批节点），机器提取 → 人验证（candidate→trusted 经待审队列）；任何要求"停下来填记忆/写文档"的通道 = 设计缺陷。

## 2. 业务设计输入（从 Q.20 + §5ter.10/§5ter.11 提取）

| 能力命中点 | 业务事实（§5ter） | AI 原生记忆落点 |
|---|---|---|
| **跟进/评论记忆流**（Q.20 / D10） | §5ter.10：计划→记录两态转化 + 终态保护（已完成已转化不可取消）、评论 `parentId` 树多级回复、@提及跨角色协作；"跟进即记忆" | 评论/@提及 = 粒子的事件/记忆流，可被 AI 检索/总结/跨会话引用 |
| **审批记录审计快照**（Q.20 / §5ter.11） | §5ter.11：每次提交/审批/意见完整记录（数字档案）+ 附件绑定 + 抄送可查 | 审批记录 = 不可变记忆快照，进事件总线供审计/进化闭环引用 |
| **凭证附件记忆**（Q.20 / §5ter 凭证证据） | 报价明细/合同附件/回款凭证/发票票据 = 业务凭证证据 | 凭证 = 记忆系统的证据记忆（事件 + 附件快照），被 AI 引用/可追溯 |
| **导入导出偏好层**（Q.20 / §5ter.18） | §5ter.18：导出记住上次字段与排序偏好（#2270）；导入 upsert 双模式 | 偏好 = L-User 级 UI 偏好记忆，跨会话跨项目复用 |

**分层归属（实例映射）**：
- **L-Workspace 工作区级**（per-tenant / per-deal 项目事实）：跟进记忆流、审批快照、凭证记忆——均"对当前业务项目有用、有跨会话价值"。
- **L-User 用户级**（跨项目通用偏好）：导入导出字段/排序偏好——跨项目有用，属用户稳定偏好。
- **L-Cloud 云端画像**：建议后续阶段由交互行为隐式推导销售习惯（如高频跟进时段），阶段 2 不强制落地。

## 3. 落地设计（具体方案）

### 3.1 记忆三构件（CRM 实例化）

记忆四构件（What/Who/Why/When）在 CRM 落为三层载体：

| 构件 | 承载 | CRM 实例 |
|---|---|---|
| **粒子图**（What+Who+关系） | AGE 图节点与受控谓词边 | DEAL/ACCOUNT/CONTACT + `owned_by`/`belongs_to`/`transitionedBecause`（who 做了什么、why 推进） |
| **快照**（state 版本化） | memory_snapshot 表 | 审批记录数字档案、凭证附件快照、报价明细版本 |
| **事件/推理**（When+Why 时序因果） | memory_log（append-only） | 跟进事件流、@提及协作事件、阶段转换 reasoning 边、human_override 校准信号 |

### 3.2 双轨分层 + 事件化写入

```
记忆写入不独立发生：一切业务写操作 → 粒子写事件（L1）→ 事件平面广播 → memoryLifecycle.capture(event)
  ├─ 跟进/评论/@提及事件 → memory_log(append-only, layer=L-Workspace, topic=follow:<dealId>)
  ├─ 审批提交/审批/驳回事件 → memory_snapshot(不可变, topic=approval:<instanceId>) + memory_log
  ├─ 凭证上传事件 → memory_log(evidence) + UNSTRUCTURED_ASSET 快照引用
  └─ 任务完成/人工改判 → onTaskDone/onHumanOverride 回写 memory_note(layer=L-Workspace, source=execution/human_override)
```

- **append-only 记忆流**：跟进评论树（`parentId`）+ @提及以事件流入 `memory_log`，永不覆盖，保证时间线可追溯；蒸馏进 `memory_note` 时标 `distilled=true`。
- **跨会话引用机制**：会话上下文装配时按 `topic`（如 `follow:DEAL-001`）+ `layer` 选通道召回，AI 可直接说"上次跟进提到预算卡在财务部"——无需用户重复背景；@提及被召回为被提及人的协作上下文（与 `ai-context-layering` 跨角色注入联动）。
- **审批记录 = 审计快照**：每次提交/审批/意见落 `memory_snapshot`（`archived=false` 永久保留，禁覆盖），与 `ai-capability-audit` 事件流同源；快照供审计与智能体引用，不进入可改写路径。
- **凭证附件记忆**：回款凭证/合同附件/发票票据的"存在与关联"作为证据记忆落 `memory_log(evidence)`，二进制本体走 `CRM_UNSTRUCTURED_ASSET`（01 文档 P9），记忆只存引用与 Why（"这张凭证证明 X 笔回款"）。

### 3.3 UI 偏好层（L-User）

- 导入导出字段选择、排序、upsert 模式选择 → `memory_note(tenant_id, layer=L-User, topic=ui:import-export-pref)` upsert 重写。
- 跨项目通用：用户换到另一业务模块导入时，上次偏好自动带出；不落前端临时态，避免"换了端就丢"。

### 3.4 蒸馏与 TTL 策略（30 天周期）

- **周期**：每 30 天跑 `distillMemory`——`memory_log` 按 `topic` 归类取精华；`memory_note` 按主题合并重写、删过时；旧日志 `archived=true`（原始行保留，移出活跃召回区）。
- **校验**：常驻笔记应能在 1 分钟内让智能体重建"该商机该怎么推进/上次卡点在哪"。
- **TTL 与上限**：`memory_note` 有字符预算上限（防膨胀，强制沉淀非堆积）；`value_horizon_days < 30` 且非显式的瞬态噪声不入；低置信 AI 属性（`confidence < 0.6`）不记入长期记忆。
- **状态机记忆蒸馏建议**：高事务量实体（如审批实例）只保留首次+末次/中断点，中间轮询不计入（状态噪声）。

### 3.5 数据 / 接口草图

```sql
-- 双轨：日志强制 append-only（不提供 update/delete 接口）
memory_log(id, tenant_id, layer, topic, actor, event_type,
           payload JSONB, created_at, distilled BOOL, archived BOOL, ttl_days INT)
-- 常驻笔记：唯一键 upsert 重写
memory_note(tenant_id, layer, topic, content, updated_at, ttl_days, archived BOOL)
-- 快照：版本化不可变记忆（审批/凭证）
memory_snapshot(id, tenant_id, topic, ref_id, snapshot JSONB, created_at)
```

```ts
captureMemory(event)        // 事件平面触发，residue 自动捕获
retrieveMemory(layer, topic, channel)  // 按层/主题选通道，不全量重读
distillMemory(ttl_days=30)  // 30 天周期蒸馏 + 归档
onTaskDone(task, result)    // 编排回写执行记忆（L-Workspace, source=execution）
onHumanOverride(skill, pass←→reject)  // 校准信号回写记忆（校准经验）
```

## 4. 与其他能力 / 四平面的接口

| 接口方 | 关系 | 关键契约 |
|---|---|---|
| **L2 事件平面**（ai-event-driven-evolution） | 记忆的**唯一触发源** | 一切业务写 → 粒子写事件 → 广播 → `captureMemory`；无"无声写入"记忆 |
| **L1 粒子平面**（ai-particle-system-design） | 记忆**落点** + 四构件之粒子图 | 跟进/审批/凭证记忆以粒子边 + 快照承载；记忆粒子与业务粒子同库（单库底座） |
| **L3 智能体平面**（ai-multi-agent-orchestration） | 记忆的**消费方 + 回写方** | 智能体执行 → `onTaskDone`/`onHumanOverride` 回写记忆；deal-coach/lead-miner 跨会话引用跟进记忆 |
| **L4 门户平面**（ai-portal-page-generation） | 记忆**回显方** | 门户生成页（如客户 360 / 待办）回显记忆摘要；NL 对话引用历史跟进上下文 |
| **ai-context-layering** | 记忆**注入**边界（本技能管存储治理，它管运行时注入） | 本技能保证"记忆干净、分层、有生命周期"；后者保证"干净记忆被正确注入"（按 `layer+topic` 选通道）；蒸馏质量直接决定注入质量 |
| **ai-ontology-vector-build** | 记忆**可检索化** | 记忆写入同走写时钩子（ensureEmbedding/ensureTsVector），否则 L2 检索召回为空；embeddings 不承载写回（防双层割裂） |
| **ai-capability-audit** | 记忆**审计同源** | 审批快照与审计事件流同源，记忆即审计轨迹的一部分 |

**边界铁律**：本技能管"该不该存、存哪层、怎么蒸馏遗忘"；不覆盖上下文层级语义（L1-L4）、检索排序算法、embedding 模型选型。

## 5. 验收判据（来自 §5ter 覆盖 + D10 差异点）

- [ ] **跟进记忆化（D10）**：评论/@提及进入记忆系统，AI 可在**新会话**中跨会话引用历史跟进上下文（如召回"上次预算卡点"），而非只能查当次表记录。
- [ ] **@提及协作事件**：@某人后，被提及人下次对话自动获得该跟进上下文（与 context-layering 联动验证）。
- [ ] **审批记录快照不可变**：审批提交/审批/驳回落 `memory_snapshot`，无 update/delete 接口，可被审计与智能体引用；与 ai-capability-audit 事件流同源。
- [ ] **凭证进记忆**：回款/合同/发票凭证的"存在与关联 Why"作为证据记忆召回，二进制本体走 UNSTRUCTURED_ASSET。
- [ ] **UI 偏好跨会话**：导入导出字段/排序偏好在 L-User 层持久化，跨项目/跨端复用，非前端临时态。
- [ ] **双轨 + append-only**：`memory_log` 无 update 接口（强制 append-only）；`memory_note` 按 `(tenant_id, layer, topic)` upsert；日志蒸馏标 `distilled=true` 非删除。
- [ ] **防污染**：瞬态噪声（搜索词/临时路径/工具报错/过程对话）不入记忆；`judgeWorthiness` 四优先级顺序正确（敏感凭证硬拒优先）；低置信 AI 属性（<0.6）不记长期。
- [ ] **30 天蒸馏可达**：蒸馏任务跑通，旧日志 `archived=true` 原始行保留、默认过滤；常驻笔记 1 分钟内可重建"商机推进脉络"。
- [ ] **residue 零摩擦**：所有记忆捕获嵌入工作流事件自动触发，无"独立记录动作"反模式；机器提取 → 候选 → 人验证（candidate→trusted）闭环存在。
- [ ] **接口闭合**：记忆由 L2 事件触发、落 L1 粒子、供 L3/L4 消费；retrieveMemory 按层/主题选通道不全量重读。

## 6. 不做的事（YAGNI + 反模式）

- ❌ **不借鉴 CordysCRM「跟进 = 普通数据表」实现**：不把 FollowUpPlan/Record/Comment/CommentMention 拆成四张可改写的表；跟进/评论/@提及从第一天就是记忆流 + 协作事件（D10 总差异 D12 原生化）。
- ❌ **不做"独立记录动作"通道**：禁止任何要求销售"停下来写记忆/填文档"的界面或流程（90 年代 KM 失败根因）；捕获必须是工作副产品。
- ❌ **不为记忆单开 CRUD Action 表面**：记忆是粒子/事件的副产物，复用 `data.particle` substrate 与事件总线，不为 memory 开扁平 CRUD。
- ❌ **不做全量跨会话重读**：retrieve 必须按 `layer+topic` 选通道，不做无脑全扫（避免上下文爆炸）。
- ❌ **不把向量当记忆真相**：embeddings 仅加速检索，不承载写回；记忆事实以 `memory_log/note/snapshot` 结构化行为准（防双层割裂）。
- ❌ **阶段 2 不做 L-Cloud 隐式画像推导**：云端画像由交互行为隐式推导，留待后续阶段；阶段 2 只落地 L-Workspace（跟进/审批/凭证）+ L-User（UI 偏好）。

## 自检清单（对照 SKILL 方法论）

- [x] 双轨结构（memory_log append-only + memory_note curated）明确，笔记是蒸馏非拷贝
- [x] 三层治理（L-Cloud/L-User/L-Workspace）范围与 CRM 实例映射清晰
- [x] 生命周期五阶段（写入门槛 30 天价值判据 → 组织 → 检索选通道 → 沉淀改写 → 蒸馏归档）完整
- [x] judgeWorthiness 四优先级顺序正确（敏感凭证硬拒优先）；瞬态噪声不入
- [x] distilled 标记幂等、遗忘=归档非删除
- [x] 记忆四构件（What/Who/Why/When → 粒子图/快照/事件推理）实例化
- [x] residue 铁律：捕获嵌入工作流事件自动触发，无独立记录动作
- [x] 与 ai-context-layering 边界清晰（治理 vs 注入）；与 ontology 写时钩子联动
- [x] 业务设计输入（Q.20 四落点 + §5ter.10/§5ter.11）全覆盖
- [x] 验收判据可验证（D10 跨会话引用 / 审批快照不可变 / UI 偏好跨端）
- [x] 不做项明确（不借鉴 CordysCRM 跟进=数据表；YAGNI 收敛）
