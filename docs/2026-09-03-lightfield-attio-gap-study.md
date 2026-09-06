# ATTIO × Lightfield × CRM-ai-native 差距分析（除 product-catalog 外）

> 整理：2026-09-03 ｜ 性质：学习借鉴差距清单（非实施设计；任何落地均需 brainstorming → 设计文档 → 批准）
> 场景：在确认「按租户分开」已由 product-catalog 方案 A/B 承接后，聚焦**其余还有哪些值得学**。
> 方法：14 篇 Lightfield 官方博客一手研读 + ATTIO 抽取实证 + 本平台 src/ 现状证据盘点，逐项给出「差距 / 借鉴点 / 落地建议 / 优先级」。
> **补充轮（2026-09-03 晚，已含 §5 拍板）**：按 §4 计划对 10 项逐一做**代码级证据重验**（含两处"现状已过期"修正）+ **落地细化**（接入点 file:line / 数据形态 / 依赖 / 验收口径），并因 §5「方案 B 租户自有」拍板更新 P0-② 的落地路径。本文档升级为可触发 brainstorming 的输入。

---

## §0 结论（先给判断）

**除 product-catalog（方案 A/B 拍板）外，本平台还有 10 个值得学习借鉴的点，按优先级分三档：**

| 档 | 差距项 | 一句话 |
|---|---|---|
| **P0（架构级、直接影响 AI 原生定位）** | ① 语义记忆层缺 embedding 真向量；② 知识/背景（ICP/竞品/异议）未显式沉淀为租户级 Knowledge；③ 字段历史/变化叙事未形成产品可见层 | 这三项是「World Model 四维度」的直接对应，是最该补的 |
| **P1（能力级、强化决策与动作）** | ④ 洞察→动作闭环（Action test）未打通；⑤ 原始痕迹捕获（邮件/会议/通话）缺失；⑥ 复利式外呼（赢单语言回写）未建设 | 这三项是「Save→Understand→Act」的中间两环 |
| **P2（工程级、巩固基础设施）** | ⑦ 记录合并（merge）与去重的产品化；⑧ 代码执行沙箱；⑨ 多域名/多邮箱语义；⑩ 外部 MCP 拉入方向 | 多为可选增强，成本可控 |

**同时明确一个定位差异**：本平台的护城河是**决策问责 + 零信任 + 行业配置化**（Lightfield 无此）；Lightfield 的护城河是**零录入 + 世界模型**（本平台缺此）。学习方向不是照抄，而是**补齐 Lightfield 的记忆层、保留本平台的问责层**。

**补充轮结论（2026-09-03 晚）**：经代码级证据重验，10 项中的两处"现状缺口"实为**已建资产未接线**（① embedding 向量列/hnsw/ivfflat/embeddingClient 已就绪只差默认切换；② config_store 租户通道已就绪只差 knowledge 命名空间），**P0 三项成本全部下调为中→低**；并新增 依赖链（⑤→⑨、⑥→②、⑦受 §5 约束、⑩→⑤）与 L1-L4 验收口径。**§5 方案 B（全数据按租户自有）已拍板，与 P0-② 同向**。

---

## §1 逐项差距分析

### 1.1 P0-① 语义记忆层缺 embedding 真向量
- **现状（重验 2026-09-03 晚）**：`src/ontology/embedding.js:1-17` 的 `hashVector` 是 SHA-256 字节映射 384 桶的**哈希签名**（同文本同向量、语义近案 cos≈0.11）；**:39-53** `embedText` 已带 **provider 双路**——`EMBEDDING_PROVIDER==='model'` 时调 `src/llm/embeddingClient.js`（**:26-58** 实测可用：SiliconFlow BAAI/bge-large-zh-v1.5 dim1024、480 字符截断、20s 超时、失败降级留痕），**非新建设，只差默认切换**。schema 已备：`db/schema.sql:19` particles.embedding `vector(384)` + `:31` **hnsw 索引**；`:173` decision.embedding `vector(1024)` + `:248` ivfflat 索引。
- **⚠ 修正（原文档低估了已建资产）**：kg 降级 `knowledgeScope.layers=['L1','L2']` 是**降级契约，非缺口**（agentSpec.js:63-65 注释明示阶段 1 无 KG）；「缺向量列」过期——**两表向量列+索引均已就绪**（384/1024 两维并存：384 承 hash 基线、1024 走 model 即时重嵌，embeddingClient.js:3-5 已注释此设计）。
- **差距（真缺口收窄到三处）**：① 默认 provider 仍是 hash（:40 需环境变量才走 model）；② 无「语义检索接口」消费 hnsw/ivfflat（全仓检索仍在哈希签名/jaccard）；③ 向量写入点未接线（particles/decision 插入时未调 embedText 写 embedding 列）。
- **借鉴点**：把「模型 embedding → 写向量列 → hnsw/ivfflat 检索」设为默认链，哈希签名降为 provider 降级兜底。
- **落地建议（细化）**：T1 写迁移把默认 provider 读配置（config_store 键 `embedding.provider`，**继承 §5 方案 B per-tenant 语义**）；T2 在 particles/decision 写入链路补 `embed()` 写列（**复用 `src/llm/embeddingClient.js`，0 新依赖**）；T3 建 `searchVector(text)` 统一检索接口（hnsw/ivfflat 优先、哈希 jaccard 兜底，返回 provider 标识供下游降级——对齐 C4 混合降级既有设计）。DDL 已存在，**本轮无 DDL**。
- **验收口径**：L1 配置生效（provider 切 model）；L2 单测（同义改写 cos>0.7、embeddingClient 超时降级留痕）；L3 迁移幂等；L4 生产有 >0 行非空 embedding（缺 L4 不算完成）。
- **优先级**：P0（架构级）｜ **成本降级：中 → 低**（三件套已建，纯接线）

### 1.2 P0-② 知识/背景未沉淀为租户级 Knowledge
- **现状（重验 2026-09-03 晚）**：`src/config/configStore.js:10-23` `readConfig` **已 per-tenant + system 回退**（先查 `(tenant_id,key)`，无则回退 `(system,key)`，configStore.js:26-34 写走 upsert 禁删）——**租户隔离通道已就绪，只是没有 knowledge 命名空间**。`src/mcp/intent.js`（45 行）无 Knowledge/ICP/竞品/异议概念（仅角色域聚焦，不承载知识）；SKILL 体系偏平台/工程侧。
- **⚠ 更新（§5 拍板直接影响）**：方案 B「全部数据按租户自有」已拍板（2026-09-03 20:43）——**知识是租户最自然的边界**，本项从「新建」改为「在方案 B 通道上补一个命名空间」，且可直接复用 `industry-onboarding` 上线 Runbook 的产品化播种通道（§5 已自陈此关联）。
- **差距**：Lightfield「Knowledge = 结构化上下文层；Skills 运行时消费」；经验法则「同一指令给新员工 3 次 = Skill；反复解释同一背景 = Knowledge」。
- **借鉴点**：新增租户级 Knowledge 对象（config_store `knowledge` 命名空间：ICP / 竞品 / 异议 / 买家语言），供 Agent 决策/复盘/Skill 运行注入。
- **落地建议（细化）**：T1 config_store 增 key 前缀 `knowledge.icp` / `knowledge.competitors` / `knowledge.objections` / `knowledge.buyer_language`（**沿用 readConfig 双租户回退，0 新表**）；T2 建 `src/knowledge/` 只读接口 + 导入/校验（JSON 结构约束：每项含 `content` + `source` + `confidence`，对齐零信任留痕）；T3 Agent 上下文注入前自动加载（对齐 ai-context-layering L3，注入点 `src/context/assembler.js`）；T4 `industry-onboarding` Runbook 增 knowledge 播种步骤（与 §5 方案 B 同通道）。
- **验收口径**：L1 配置可见（per-tenant 覆盖生效）；L2 单测（system 回退 / 租户覆盖 / 非法结构拒绝）；L3 幂等；L4 至少一个租户有非空 knowledge。
- **优先级**：P0（直接支撑 LIGHT 认知架构）｜ **成本：低 → 更低**（通道已就绪，纯补命名空间）

### 1.3 P0-③ 字段历史/变化叙事未形成产品可见层
- **现状（重验 2026-09-03 晚）**：decision provenance 哈希链（`src/decision/provenance.js` v2 分代 + verifyChain）与 audit_event 前后值**已在内部**；`src/context/timelineSource.js:1` 已是事件时间线**单一事实源**（四源合并，决策/客户任务线已接 `crm.events`/`crm.decision_event`）；但**前端无「字段值历史」视图**——account-insight 时间线只展示事件序列，无「某字段 旧值→新值→谁改→为什么」的单字段视角。
- **差距**：Lightfield「Field value history」（2026-07-10）——字段显示历史值，活动日志可回溯变更；这是「只记状态不记变化」的直接回应。
- **借鉴点**：把 decision_event/audit_event 的字段级变更，渲染为**字段级时间线**（谁、何时、旧值→新值、为什么）。
- **落地建议（细化）**：T1 后端只读接口 `GET /api/particles/:id/field-history?field=amount`（查 `crm.decision_event`/`crm.audit_event` 该字段前后值，**投影字段级、零新表**）；T2 前端 account-insight 详情抽屉加「字段历史」tab（**复用 timelineSource 数据形态**，渲染 时间/actor/旧值→新值/decision_id 链接）；T3 变化来源若有缺口（前台手工编辑是否已入 audit_event）**留给 brainstorming 裁决，不在本文档定死**。
- **验收口径**：L1 接口可查指定字段历史；L2 单测（前后值投影、无数据返回空）；L3 幂等；L4 生产至少一个字段有时间线渲染。
- **优先级**：P0（对齐 World Model「Chronology/Causality」）｜ **成本：低**（数据已有，纯渲染层）

### 1.4 P1-④ 洞察→动作闭环（Action test）未打通
- **现状（重验 2026-09-03 晚）**：决策引擎会自动 mint decision + 待办（routes.js:515 升级 403 落地待办）；但「发现洞察 → 自动起草/执行动作」的端到端未成产品（Lightfield 五测试的 Action test）。**已存在半环**：决策第 0 闸→approval 流（`src/approval/stateMachine.js`）→HITL 已有，**缺的是前半个环**（洞察→建议→动作草案）。
- **差距**：Lightfield「Buyer Language 提取 / Find Next Best Action / 会议前准备——从会议创建商机」——**理解后直接产出可动作产物**。
- **借鉴点**：在客户洞察/商机详情页增加「下一步最佳动作」建议（基于 decision provenance + 时间线），一键进入审批流（复用第 0 闸）。
- **落地建议（细化）**：只读接口 `GET /api/insight/:id/next-best-actions`（读决策/时间线 → LLM 建议 top3 → 每条挂 `decision_id` 待办草稿 + 一键入审批）——**不改写通道，只补建议层**；复用现有 `routes.js:515` 的 403 落地通道（建议→待办→审批，同一闸）。
- **验收口径**：L1 接口可返回建议；L2 单测（建议挂 decision_id、无数据返回空）；L3 幂等；L4 生产至少一次「建议→待办→审批」闭环被点击。
- **优先级**：P1（能力级）

### 1.5 P1-⑤ 原始痕迹捕获（邮件/会议/通话）缺失
- **现状（重验）**：`src/memory/capture.js:24-29` `registerCaptureSubscriber` 只订阅内部事件总线 `on('*')`（且 `:27` **裸 catch 静默吞错**——违反禁裸 catch 铁律，实施时须一并修）；无 IMAP/Gmail/Outlook/会议转录接入；visit_notes 依赖手动结构化录入。
- **差距**：Lightfield「零录入」——邮件/日历/通话自动捕获成原始痕迹（raw traces），「Capture test」通过的第一环。
- **借鉴点**：接 IMAP/Gmail 拉邮件 → 自动建档/关联账户 → 生成原始痕迹（不代替手动字段，作为真相源）。
- **落地建议（细化）**：最小闭环 = 「IMAP 拉取 → 解析头+正文 → 按 sender/recipient 邮箱关联粒子（需 1.9 的 `email_addresses[]`）→ 入 `crm.events`（event_type='email_captured'）→ 供 timeline/检索消费」；会议转录后续（依赖转录来源）。**依赖 1.9**（邮箱语义），两件配套做。
- **验收口径**：L1 摄入记录可见；L2 单测（解析/关联/落库、无关联邮箱时标记 unlinked）；L3 幂等；L4 生产有真实邮件事件行。
- **优先级**：P1（能力级，投入较大需排期）

### 1.6 P1-⑥ 复利式外呼（赢单语言回写）未建设
- **现状**：decision provenance + 复盘回路存在，但「赢单语言→下次外呼」闭环未成；无外呼序列。
- **差距**：Lightfield「Designing for outbound that compounds on itself」——**一手上下文**（已赢商机/买家语言/推进特征）驱动外呼，每轮回写 funnel 数据 → 系统复利。
- **借鉴点**：把赢单商机的「买家原话/异议/推进特征」抽为租户级 Knowledge（**与 1.2 同源**），供外呼/邮件起草消费。
- **落地建议（细化）**：**依赖 1.2 落地**后：T1 复盘回路抽「赢单语言」写入 `knowledge.buyer_language`（`src/decision/retro.js` 复盘产出一致，写入走 decision_id）；T2 外呼/邮件起草接口读 `knowledge.buyer_language` 注入 prompt（对齐 ai-context-layering L3）；T3 外呼产物挂 decision_id 走审批（零信任）。
- **验收口径**：L2 单测（赢单语言抽取→knowledge 写、起草读出注入）；L4 生产至少一条 buyer_language 由复盘自动沉淀。
- **优先级**：P1（能力级，与 1.2 强相关）

### 1.7 P2-⑦ 记录合并（merge）与去重的产品化
- **现状（重验）**：`src/particles/dedup.js:31-37` `confirmMerge` 已存在（`UPDATE crm.particles SET meta = COALESCE(meta,'{}') || jsonb_build_object('merged_into',$1::text) WHERE id=$2`）——**软合并能力已在后端**；但**无产品化 merge 操作**（用户 UI 不能合并重复账户/联系人，dedup 仅服务别名归一与确认闭环）。
- **差距**：Lightfield「Record merge」（2026-06-19）——合并重复记录，关系/字段/链接并至保留记录，弃记录内容保全在 activity log；ATTIO 软删除。
- **借鉴点**：把底层 confirmMerge 产品化为「合并」操作（选择保留记录 → 关系/字段合并 → 弃记录保留在 history，`merged_into` 标记不 DELETE）。
- **落地建议（细化）**：T1 后端 `POST /api/particles/:id/merge`（校验双记录同类型 + 冲突字段策略配置化：保留方优先/新值优先/手动选）；T2 账户/联系人详情页加「合并」入口（选择保留方 → 确认 → 调接口）；T3 弃记录 meta.merged_into 指向保留方（禁 DELETE 铁律天然满足）。**§5 方案 B 下合并仅限同租户**（跨租户合并禁止）。
- **验收口径**：L2 单测（同租户合并成功、跨租户拒绝、冲突字段策略生效）；L4 生产至少一次合并操作完成且弃记录仍在（merged_into 标记可查）。
- **优先级**：P2（工程级，价值明确但非紧迫）

### 1.8 P2-⑧ 代码执行沙箱
- **现状（重验）**：`src/calc/formulaEngine.js` 有公式驱动（无沙盒代码执行）；决策/复盘靠 LLM 推理，不能「在沙箱跑 Python/JS 做确定性计算」。
- **差距**：Lightfield「Code execution in Lightfield」（2026-02-13）——agent 用代码执行回答复杂查询、生成 artifact；对标杆「Deal diagnosis」（对已赢/已输交易做模式对比）。
- **借鉴点**：加轻量代码执行沙箱（Node `vm` / 受限 worker），供决策对比/复杂查询跑确定性逻辑（防幻觉）。
- **落地建议（细化）**：T1 `src/calc/sandbox.js`（Node `vm` + 白名单模块 + 超时 + 无网络 + 输出大小上限）；T2 决策对比接口（如「统计近 12 个月赢单率按行业分组」）走沙箱确定性计算，产出挂 decision_id 溯源；T3 前后端入口（复盘/决策域「运行分析」按钮）。**对齐「确定性优先」+ C9 校准**。
- **验收口径**：L2 单测（白名单外 require 拒绝、超时终止、输出超限截断）；L4 生产至少一次沙箱计算入决策链。
- **优先级**：P2（工程级，价值在决策增强）

### 1.9 P2-⑨ 多域名/多邮箱语义
- **现状（重验）**：particles 关联可多对多（edges），但无「账户多域名 / 联系人多邮箱」的语义元模型。
- **差距**：Lightfield「Contact & account data model improvements」（2026-02-27）——联系人多邮箱 + 多账户关联；账户多域名。
- **借鉴点**：在 meta_attr 动态属性中登记 `email_addresses[]` / `domains[]`（多值），供摄入/检索使用。
- **落地建议（细化）**：**零代码（meta_attr 动态扩展）**：T1 摄入/导入写入时登记 `email_addresses[]` / `domains[]`（meta_attr jsonb）；T2 检索接口支持按 email/domain 匹配（**1.5 邮件摄入的关联键**）；T3 账户详情展示多域名、联系人详情展示多邮箱。
- **验收口径**：L2 单测（多值登记、按 email/domain 检索命中）；L4 生产至少一个账户有 `domains[]`（>1 值）。
- **优先级**：P2（低成本，与 1.5 摄入配套）

### 1.10 P2-⑩ 外部 MCP 拉入方向
- **现状**：本平台 MCP 双传输（3001）把平台 action 暴露给外部 Agent（41 个 action）；但**反向**（平台 Agent 调用外部 MCP 服务）未做。
- **差距**：Lightfield「MCP connectors」（2026-02-06）——把 Granola/Notion/Linear 接进 Agent chat 与 workflow，自动拉转录等。
- **借鉴点**：平台 Agent（决策/复盘/摄入）可调用外部 MCP（会议转录、企业库、富化）——方向相反但互补。
- **落地建议（细化）**：**依赖 1.5 摄入**；最小接入 = 「外部转录/邮件 MCP → 事件」适配层（MCP client 调外部服务 → 结果入 `crm.events` → 走同 1.5 关联链）；会议转录为输入源方向。
- **验收口径**：L2 单测（适配层 mock 外部 MCP、事件入链）；L4 生产至少一个外部源接入。
- **优先级**：P2（工程级，方向性，依赖 1.5）

---

## §2 学习借鉴优先级汇总（补充轮更新）

| 优先级 | 项 | 对齐的标杆能力 | 落地形态 | 成本（补充轮修正） | 依赖 |
|---|---|---|---|---|---|
| P0 | ① 真 embedding 默认检索 | Universal Context / 语义检索 | provider 切换 + 接线（DDL 已存在） | 低（原"中"，实测三件套已建） | — |
| P0 | ② 租户级 Knowledge | Knowledge 层 | config_store `knowledge.*` 命名空间 | 低（通道已就绪） | §5 方案 B |
| P0 | ③ 字段级历史时间线 | Field value history | 复用 provenance/事件渲染 | 低 | — |
| P1 | ④ 洞察→动作建议 | Action test / Next Best Action | 建议层接口（不改写通道） | 中 | 既有审批闸 |
| P1 | ⑤ 邮件/会议原始捕获 | 零录入 Capture | IMAP 摄入最小闭环 | 高（需排期） | ⑨ |
| P1 | ⑥ 复利式外呼 | 一手上下文循环 | 与 ② 同源 + 复盘回写 | 低（依赖②） | ② |
| P2 | ⑦ merge 产品化 | Record merge | 复用 confirmMerge + UI | 中 | §5 方案 B（仅同租户） |
| P2 | ⑧ 代码执行沙箱 | Code execution | Node vm 受限沙箱 | 中 | — |
| P2 | ⑨ 多域名/多邮箱语义 | Contact/account model | meta_attr 动态扩展 | 低 | — |
| P2 | ⑩ 外部 MCP 拉入 | MCP connectors | 转录→事件适配层 | 中 | ⑤ |

---

## §3 与既有文档的关系

- `docs/2026-09-03-attio-lightfield-study.md`：深度学习底稿（ATTIO 六准则 / Lightfield 四维度 / 三方映射表）。
- `docs/2026-09-03-lightfield-blog-digest.md`：14 篇博客速览表。
- **本文档**：在前两者基础上，聚焦「除 product-catalog 外还有哪些值得学」，输出 10 项差距 + 优先级 + 落地形态，可直接作为后续 brainstorming 的输入。
- **补充轮（2026-09-03 晚）**：10 项均加证据重验（含两处已建资产修正：① embedding 向量列/索引/embeddingClient 已就绪、② config_store 租户通道已就绪）+ 落地细化（T1-T4 分步）+ 依赖链 + 验收口径（L1-L4），并并入 §5 方案 B 拍板的影响。
- product-catalog 租户方案 A/B 的决策在 `docs/2026-09-03-attio-lightfield-study.md` 第一节（另行拍板）。

---

## §4 下一步建议（补充轮更新）

1. **P0 三项仍是首选，且成本已实测下调**：① 真 embedding（provider 切换 + 接线，DDL/检索接口资产已建）② 租户级 Knowledge（config_store 通道已就绪，且与 §5 方案 B 同向）③ 字段级历史时间线（数据已有，纯渲染层）。三者直接强化「记忆/理解」层，与现有架构无冲突。
2. **补充轮新增的依赖链**：⑤ 邮件摄入依赖 ⑨ 邮箱语义；⑥ 复利外呼依赖 ② 租户 Knowledge；⑦ merge 仅限同租户（§5 方案 B 约束）；⑩ 外部 MCP 依赖 ⑤。**建议序：②→⑥ 打包做（同源），⑨→⑤→⑩ 打包做（摄入链），①③ 独立可随时做**。
3. 若你认为 P0 任一项值得做，请触发对应 brainstorming（一次一问），我按设计先行流程出方案。
4. 不必一次性全做——先 P0 后 P1，P2 按需选做。
5. **⚠ 实施时连带修复**（补充轮发现）：`src/memory/capture.js:27` 裸 `catch(() => {})` 静默吞错，违反禁裸 catch 铁律，邮件摄入接入时须一并改为 emit('trace') + recordFailure()。

---

## §5 已拍板决策（2026-09-03 20:43）

**全部数据走方案 B（每租户自有）**：产品目录等所有基础主数据均按 `tenant_id` 各自隔离，不再共享 `system` 模板。该决策与本文档 P0-②「租户级 Knowledge」、P0-③「字段级历史时间线」同向（租户是数据与知识的天然边界），并可直接复用 `industry-onboarding` 上线 Runbook 的产品化播种通道。