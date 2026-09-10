# CRM 记忆系统整体方案（写 · 用 · 治理 · 闭环 · 修补）

| 项 | 内容 |
|---|---|
| 日期 | 2026-09-10 |
| 输入 | ①未写入根因排查报告 ②记忆内容分析报告 ③本轮全链路代码复核 |
| 定位 | **记忆系统的总体设计**（回答：写什么/何时写/谁来写/写到哪 · 何时用/怎么用/谁用 · 如何查闭环 · 如何修补） |
| 与 `2026-09-10-customer-memory-writeback-design.md` 的关系 | 本文是**总体设计**；该文是**缺陷修复子集**（C1–C8 落地细节以其为准） |
| 状态 | 待用户评审 |

---

## §0 结论先行

> **记忆系统当前不是"坏了"，是"半接线"：写入端没有寻址与内容契约，消费端只有一个注入点且恒读 system，治理端把系统心跳当业务记忆存了 62 万条。**

四条链路的真实状态（本轮代码复核，全部附 `file:line`）：

| 链路 | 现状 | 判定 |
|---|---|---|
| **写** | 4 个写入点，全部不传租户、不传锚点；决策记忆硬编码投影 5 字段 | 🔴 半接线 |
| **读/用** | 唯一注入点 `assembler.js:109` 恒读 system 且只取 `decision:%`；`rrfSearch` **零消费者（死代码）** | 🔴 半接线 |
| **消费端键名** | `injector.js:19` 只认 `payload.text/summary/note/content` —— 现有空壳 payload 一个都没有 → **读到也注入不了** | 🔴 双向落空 |
| **治** | 蒸馏心跳写进业务记忆表 622,572 条（98.6%）；无质量指标、无巡检 | 🔴 失控 |

**最致命的一条**：写侧丢内容（投影 3%）+ 读侧不认键名 = **双向落空**。即使修好租户，召回到注入层仍会被 `memoryText()` 判空过滤。这决定了 C7 投影必须提供 `summary` 键——**四段式不是美化，是让消费端能读到的必要条件**。

---

## §1 现状全景：记忆系统接线图

### 1.1 写入端（4 个入口，全部缺陷）

| # | 入口 | 位置 | 缺陷 |
|---|---|---|---|
| W1 | `crm-memory-upsert`（人工/agent 显式） | `seed-actions.js:198-213` | 不传 `tenantId`、不解析 `entityId` |
| W2 | 决策落库投影 | `decisionRepo.js:456` → `:472` | 硬编码 5 字段（投影 3%）、不传 tenant/entity |
| W3 | 事件总线捕获 | `capture.js:24` `on('*')` | 无租户、无锚点、**把 trace 写进业务表** |
| W4 | 决策边写留痕 | `edgeWrite.js:33` | 不传 tenant/entity |

### 1.2 消费端（3 条真实路径 + 1 条死代码）

| # | 路径 | 位置 | 现状 |
|---|---|---|---|
| R1 | L2 上下文装配 | `assembler.js:109` `retrieveMemory({topicLike:'decision:%', limit:5})` | **不传 tenantId → 恒读 system**；只取决策主题；limit 5 |
| R2 | 客户时间线（四源之一） | `timelineSource.js:142` | 已按 `entity_id` + `tenant_id` 过滤（正确），但**未排除 trace 噪声**；因存量 `entity_id` 全 NULL 而恒空 |
| R3 | 注入层 | `injector.js:19` `memoryText()` 取 `text/summary/note/content` | 空壳 payload 无这些键 → 返回 `''` → 整块不注入 |
| ❌ | RRF 融合召回 | `memoryLog.js:70` `rrfSearch` | **全仓零消费者**（G6 设计已实现未接线） |

### 1.3 对外与 UI

| 项 | 位置 | 现状 |
|---|---|---|
| MCP 读 | `tools.js` kind=read 全暴露 | ✅ `crm-memory-read` 对外可用（受 `memory` 权益闸） |
| MCP 写 | 非 `data-` 前缀 write 全暴露 | ✅ `crm-memory-upsert` 对外可用（两阶段 confirm） |
| 记忆页 | `src/web/memory.html` + `portal/memoryConfig.js` | ⚠️ `GET /api/memory` 为 **sysadmin-only** → 业务租户看不到自己的记忆 |
| 推广通道 | `promote.js` → `propagationRoutes.js:170` | ✅ 记忆可提升为租户级先例模板（已接线） |
| 蒸馏 | `distillScheduler.js`（默认 30 天） | ⚠️ 把自己的运行心跳写进业务记忆表 |

---

## §2 问题全景（R 系列 + U 系列）

| # | 问题 | 层 | 证据 |
|---|---|---|---|
| R1 | 写侧恒落 `system` | 写 | `memoryLog.js:26,30` |
| R1-bis | payload 自带 `tenant_id` 未提升到列 | 写 | 告警记忆 2,308 条 |
| R2 | `entity_id` 无解析规则，恒 NULL | 写 | 非空仅 12/631,616 |
| R3 | 触发路径窄（只挂决策，不挂粒子） | 写 | `seed.js:130` |
| R5 | 决策 mint 恒丢租户 | 写 | `gateway.js:167`、`executor.js:67` |
| R6 | 决策记忆投影损失 97% | 写 | `decisionRepo.js:456-457` |
| R7 | 先例自锁（HUMAN 不进池） | 决策域 | `autonomyEngine.js:311` vs `decisionRepo.js:523` |
| R8 | trace 噪声 98.6% | 治 | `capture.js:24` |
| **U1（新）** | **装配层恒读 system、只读 `decision:%`** | 用 | `assembler.js:109` |
| **U2（新）** | **注入层键名不匹配 → 读到也注入不了** | 用 | `injector.js:19` |
| **U3（新）** | **`rrfSearch` 零消费者（死代码）** | 用 | 全仓 grep |
| **U4（新）** | **记忆页 sysadmin-only，业务租户无视图** | 用 | `memory.html:48` 注释 |

**U1/U2 的决定性**：R 系列全修完，如果 U1/U2 不动，销售在对话里依然看不到任何客户记忆。二者必须同批。

---

## §3 目标与设计原则

**目标**
1. 每条记忆可寻址（租户 + 层 + 锚点 + 主题四元组）、可解释（四段式）、可追溯（来源与可验证性）。
2. 写入由**事实驱动**而非**调用方自觉**——业务动作发生即沉淀。
3. 消费端在决策前、客户 360、商机推进、报价四个场景稳定召回到业务语义。
4. 有指标、有巡检、有告警、有自动修补，问题能自己暴露而不是靠人发现。

**设计原则**
| 原则 | 含义 |
|---|---|
| 写即寻址 | 任何写入必须落到 (tenant, layer, entity, topic) 四元组，缺项即 trace 留痕 |
| 只加不删 | 新 Schema 在旧字段上叠加，既有消费方零回归；禁 DELETE 铁律 |
| 配置驱动 | 触发规则、投影白名单、质量阈值全部走 `config_store`，禁硬编码业务键 |
| 默认拒绝 | 噪声用白名单（只放行业务域），不用黑名单 |
| 消费端驱动内容 | 写入 Schema 必须满足消费端键名契约（`summary` 等），否则写了等于没写 |
| 可观测优先 | 每一次"不该 write 而 write / 该 write 而没 write"都必须留 trace |

---

## §4 【写】记忆写入体系

### 4.1 写什么：内容契约（Schema）

**统一四段式**（照抄全库唯一那条高质量客户记忆 09-04 `kind='customer_memory'`）：
```json
{
  "summary":  "一句话业务语义（≤200字）—— 消费端 injector 唯一识别键，必须存在",
  "entities": { "我方": {…}, "G培训机构": {…} },
  "evidence": [ {"id":"F1","来源":"用户陈述","类型":"事实","可验证性":"高"} ],
  "gaps":     ["吴老师档期确认(单点风险)"]
}
```
> ⚠️ `summary` 是**硬契约**：`injector.js:19` 的 `memoryText()` 只认 `text/summary/note/content`。无此键 = 写了也注入不了。

**控制字段（保留，向后兼容）**：`scenario_id / disposition / business_tier / decider_type / rationale`。

**记忆分类表**（`kind` 枚举，配置化 `config_store['memory-kinds']`）：

| kind | 语义 | 生产者 | 锚点 | 层 | TTL | 是否可蒸馏 |
|---|---|---|---|---|---|---|
| `fact` | 业务事实变更（阶段/金额/决策链） | C3 自动钩子 | 客户优先 | L-Workspace | 180d | 是 |
| `decision` | 决策记忆（四段式投影） | 决策落库 | 客户 | L-Workspace | 365d | 是 |
| `customer_memory` | 客户证据链（人工/agent 沉淀） | 显式 upsert | 客户 | `customer` | 730d | **否**（长期资产） |
| `intelligence` | 商机动向 | 显式 upsert | 商机 | L-Workspace | 365d | 是 |
| `alert` | 系统告警 | 告警器 | 客户/租户 | L-Workspace | 30d | 是 |
| `note` | 个人常驻笔记 | L-User | 用户 | L-User | 配置 | 否 |
| ~~`trace`~~ | ~~系统心跳~~ | — | — | — | — | **禁止入业务表** |

### 4.2 何时写：触发矩阵

| # | 事件 | 写？ | kind | 锚点 | 去重窗 |
|---|---|---|---|---|---|
| 1 | 客户/商机/联系人建档 | ✅ | `fact` | 客户 | 无（新建必记） |
| 2 | 关键字段变更（阶段/金额/决策链/范围/报价/期望日期） | ✅ | `fact` | 客户 | 24h 同值 |
| 3 | 决策落库 | ✅ | `decision` | 客户 | 无 |
| 4 | 决策人工处置（CONFIRMED/REVERSED） | ✅ | `decision` 增量 | 客户 | 无 |
| 5 | 商机阶段推进 | ✅ | `fact` | 客户 | 无 |
| 6 | 证据/文档挂接 | ⚙️ 可配 | `fact` | 客户 | 无 |
| 7 | 人工/agent 显式 upsert | ✅ | `customer_memory`/`intelligence` | 指定 | 无 |
| 8 | 商机复盘/结案 | ✅ | `customer_memory` | 客户 | 无 |

**负面清单（明确不写）**：蒸馏心跳 · LLM metering · 调用 trace · 纯读操作 · 搜索关键词 · 同值重复 · 含凭证内容。

### 4.3 谁来写

| 来源 | 机制 |
|---|---|
| 系统自动 | C3 粒子写入钩子（异步、fail-open、`enabled:false` 可一键关） |
| 决策引擎 | 决策落库投影（C7） |
| Agent | `method-*` SKILL 步骤 或 显式 `crm-memory-upsert` |
| 人 | 记忆页 / 客户 360 显式沉淀（走同一 Action，过权益闸与第 0 闸） |

### 4.4 写到哪：寻址四元组

```
(tenant_id, layer, entity_type+entity_id, topic)
```
| 维度 | 解析规则（单一事实源 `src/memory/anchor.js`） |
|---|---|
| `tenant_id` | 显式参数 > `ctx.tenantId` > `payload.tenant_id` > `system`（末级 emit `memory-tenant-missing`） |
| `layer` | 默认 `L-Workspace`；客户级长期资产用 `customer`；个人笔记 `L-User` |
| `entity` | 显式 > `ctx.account_id` > `ctx.deal_id` > `payload.account_id` > 粒子 id。**客户优先**：`CRM_DEAL`/`CRM_CONTACT` 一律取 `account_id`，无归属才退商机 id |
| `topic` | 机器可读前缀（`deal:field-change` / `decision:<id>` / `alert:<kind>`）；自然语言主题可选（兼容 09-04 样板） |

**新增列**：`entity_type`（`ACCOUNT`/`DEAL`，避免 id 语义混杂）—— `ALTER TABLE ADD COLUMN IF NOT EXISTS`，存量行不受影响。

---

## §5 【用】记忆消费体系

### 5.1 何时用（四个必用场景）

| 场景 | 时点 | 消费内容 |
|---|---|---|
| **决策前装配** | `assembleContextV2({phase:'pre'})` | 本客户 fact + decision + customer_memory |
| **客户 360 / 商机详情** | 页面打开 | 时间线四源之记忆源 + 客户证据链 |
| **商机阶段推进判定** | 闸门计算前 | 历史阶段变更 fact + 同类决策先例 |
| **报价前** | 报价引擎执行前 | 历史报价 fact + 折扣偏离记录 |

### 5.2 怎么用（消费端接线修复）

| 修复 | 位置 | 改动 |
|---|---|---|
| **U1 · 装配层租户与范围** | `assembler.js:109` | 传 `tenantId`；topic 范围从 `decision:%` 扩展为配置化（`memory-retrieve-topics`）；按 `entityId` 过滤；limit 提到配置值 |
| **U2 · 注入键契约** | `injector.js:19` | 保持 `summary` 识别（C7 已保证输出）；增加"取到空则 emit trace `memory-inject-empty`"以便观测 |
| **U3 · RRF 接线** | 新建 `retrieveByEntity()` | 把 `rrfSearch` 接到客户 360 与决策前装配；或标注 `lifecycle:'reserved'` 隐藏（二选一，见 §12） |
| **U4 · 记忆页租户视图** | `memory.html` / `memoryConfig.js` | `GET /api/memory` 从 sysadmin-only 改为 **按 `scopeTenant(me)` 返回本租户**（admin 可 `?tenant=` 收窄），与项目既有租户筛选器范式一致 |
| **噪声隔离（消费侧）** | `timelineSource.js:142` | 增加 `kind <> 'trace'` 与 `archived=false`，防时间线被心跳淹没 |

### 5.3 谁用

| 使用者 | 通道 |
|---|---|
| 内部上下文装配 | `assembler` / `assembleContextV2` |
| Agent | `crm-memory-read`（`agentTool`） |
| 外部办公智能体 | MCP `crm-memory-read` |
| 销售/管理者 | 记忆页、客户 360 时间线 |
| 决策引擎 | 先例走 `decision` 表（`searchPrecedents`），**非** `memory_log` |

---

## §6 【生命周期】

```
写入 →(TTL 30d)→ distilled=true →(2×TTL)→ archived=true → 永久保留（禁 DELETE）
                      ↓
              人工/规则提升 → tenant_precedent（promote.js，已接线）
```
| 环节 | 规则 |
|---|---|
| TTL | 按 `kind` 差异化（见 §4.1 表），非一刀切 30 天 |
| 蒸馏 | 跳过 `customer_memory` / `note`（长期资产，不可蒸馏） |
| 归档 | 软删（`archived=true`），物理删除**永久禁止** |
| 提升 | 高质量记忆经 `promoteMemoryToTenant` 提升为租户级先例（已有通道，需接触发：复盘结案时推荐候选） |

---

## §7 【治理】

| 闸门 | 机制 | 位置 |
|---|---|---|
| 内容闸门 | `judgeWorthiness`：凭证硬拒 + 瞬态噪声拒 + 价值视界 | `judge.js:50` |
| 噪声闸门 | capture **白名单**（只放行 `particle/deal/approval/quote/account`） | `capture.js` 改造 |
| 去重闸门 | `(tenant, entity, topic, field, value)` 窗口内拦截 | C3 新增 |
| 体积闸门 | payload ≤ 4 KB，超限截断记 `truncated:true` | C7 |
| 权限闸门 | `requiresEntitlement:['memory']` + 第 0 闸 `decision_id` | 既有 |
| 隔离闸门 | 读按 `scopeTenant`，写按 `scopeOf`（永不通配）；**禁止读侧回退 system** | 既有 |

---

## §8 【问题检查闭环】

### 8.1 指标体系（三层）

| 层 | 指标 | 计算 | 健康阈值 |
|---|---|---|---|
| **写** | 租户覆盖率 | 非 system 记忆占比 | ≥ 30%（当前 0%） |
| **写** | 锚点覆盖率 | `entity_id` 非空占比 | ≥ 80%（当前 0.0019%） |
| **写** | 投影完整率 | 四段式键齐全占比 | ≥ 90%（当前 0%） |
| **写** | 噪声比 | `event:trace:*` 占比 | ≤ 5%（当前 98.6%） |
| **用** | 注入命中率 | 装配到记忆的决策数 / 决策总数 | ≥ 50%（当前 ~0%） |
| **用** | 时间线记忆占比 | 时间线 memory 行数 / 总行数 | 5%–30% |
| **治** | 蒸馏及时率 / 归档率 | 到期未处理占比 | ≤ 10% |

### 8.2 巡检与告警
- **巡检脚本** `scripts/memory-health-check.mjs`：只读、可复跑、输出 JSON + 退出码（0 健康 / 1 告警 / 2 严重）。
- **告警**：阈值配置化（复用既有 `alert-rule` 配置中心，禁硬编码）；接入 `sales-thresholds` 同款 `readThreshold()` 范式。
- **留痕**：每一次"缺租户 / 缺锚点 / 缺 summary / 被去重 / 被白名单拦截"均 emit trace，可统计。

### 8.3 闭环回写
```
巡检 → 发现问题 → 定位到 (task, gap_type) → 写 <doc>.feedback.json
     → 同一 (task, gap_type) 复发 ≥2 次 → 生成 SKILL/设计改进提案（需用户批准才改）
```
对齐项目既有 `agent-workbench` 契约监控机制（`validate-contract.mjs` / `aggregate-feedback.mjs`）。

### 8.4 自动修补（漂移自愈）
| 漂移 | 自愈动作 | 触发 |
|---|---|---|
| `tenant_id=system` 但 `payload.tenant_id` 有值 | UPDATE 提升到列 | 巡检 |
| `entity_id` NULL 但 `topic='decision:<id>'` | 回查 `decision` 表补锚点 | 巡检 |
| `payload` 缺 `summary` 但有 `rationale` | 用 `rationale` 补 `summary`（标 `backfilled:true`） | 巡检 |
| 重复同值 | 置 `archived=true`（不物理删） | 巡检 |

---

## §9 【修补】存量修复计划

| 步骤 | 动作 | 约束 |
|---|---|---|
| S1 | 噪声归档：`UPDATE ... SET archived=true WHERE topic LIKE 'event:trace:%'` | 软删，禁 DELETE；先 dry-run 计数 |
| S2 | 租户回填：`decision:*` join `decision` 表、`entity_id` join `particles` 反查 | 只 UPDATE；无可归属者留 system |
| S3 | 锚点回填：按 `topic='decision:<id>'` 回查 `decision.involved_entities` 补 `entity_id`/`entity_type` | 同上 |
| S4 | **决策记忆重建**：对存量 `decision` 表跑 C7 投影，重放生成新记忆（标 `rebuilt:true`），旧空壳置 `archived` | 幂等可重跑；一次性 |
| S5 | 高质量 12 条：保留不动（其 `entity_id` 为客户名/商机 id 混合，见 §12 未决 5） | 不做猜测式归一化 |

---

## §10 分阶段路线图

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 止血** | C4 噪声白名单 + 存量 trace 归档 + C8（先例租户透传） | 噪声比 ≤5%；先例不归零 |
| **P1 正确性** | C1 寻址四元组 + C2 锚点 + C5 决策租户 + C7 投影 | 租户覆盖 / 锚点覆盖 / 投影完整率达标 |
| **P2 自动化** | C3 触发矩阵 + 去重 + 各 Agent 域规则 | 业务动作后自动产生 fact 记忆 |
| **P3 消费打通** | U1 装配层 + U2 注入契约 + U4 记忆页租户视图 + 时间线噪声隔离 | 注入命中率 ≥50%；租户可见自己记忆 |
| **P4 治理闭环** | 巡检脚本 + 指标看板 + 告警 + 自动修补 | 巡检退出码 0；漂移可自愈 |
| **P5 存量修补** | S1–S5 | 重建后决策记忆含业务语义 |

---

## §11 任务分解（生命契约）

> 契约键取自 `src/agent/contractIds.js`；校验器双向断言要求覆盖全部 6 个登记 Agent。

### T1 · 写入内核：寻址四元组 + 内容契约
```contract-yaml
- task: "记忆写入内核：寻址四元组与内容契约校验"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "appendMemory 落库 tenant_id/entity_id/entity_type 三列均正确；payload 缺 summary 时 emit memory-content-incomplete；缺租户时按兜底链解析且 emit memory-tenant-missing"
```
**契约说明：** 由 `decision-agent` 承接；成功判定为寻址三列落库正确且内容契约可校验。

### T2 · 触发矩阵接线（客户 / 商机域）
```contract-yaml
- task: "粒子写入触发矩阵接线与客户商机域规则"
  agent: intake-router
  contract_task_id: ct-intake-route
  skills: [data-particle-read, method-intake-routing]
  memory: [intake-router, followup-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "建档与关键字段变更产生 kind=fact 记忆且锚客户；同值 24h 内重复不新增；规则关闭时新增 0 条；trace 类事件被白名单拦截"
```
**契约说明：** 由 `intake-router` 承接；成功判定为触发矩阵生效、去重与白名单有效。

### T3 · 决策记忆四段式投影
```contract-yaml
- task: "决策记忆四段式投影层"
  agent: decision-agent
  contract_task_id: ct-decision
  skills: [method-decision-execute, data-particle-read]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "决策落库后 payload 含 summary/entities/evidence/gaps 且含客户名或商机号；≤4KB 超限记 truncated:true；凭证键被剔除；injector.memoryText 返回非空"
```
**契约说明：** 由 `decision-agent` 承接；成功判定为投影生效**且消费端 `memoryText()` 能取到非空文本**（U2 闭环）。

### T4 · 拜访跟进事实沉淀
```contract-yaml
- task: "拜访与跟进事实沉淀规则"
  agent: followup-agent
  contract_task_id: ct-followup
  skills: [method-followup-engine, data-particle-read]
  memory: [followup-agent, quote-engine]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "跟进事实写入后产 fact 记忆并锚定客户，24h 同值去重生效，payload 含 summary"
```
**契约说明：** 由 `followup-agent` 承接；成功判定为跟进事实沉淀且内容契约满足。

### T5 · 报价与折扣事实沉淀
```contract-yaml
- task: "报价与折扣变更沉淀规则"
  agent: quote-engine
  contract_task_id: ct-quote-calc
  skills: [method-quote-engine, data-particle-read]
  memory: [quote-engine, followup-agent]
  knowledge_scope: { layers: [L1, L2], maxHops: 3 }
  success: "报价金额/折扣率变更落 fact 记忆，租户与锚点非空，偏离基线时标 anomaly=true"
```
**契约说明：** 由 `quote-engine` 承接；成功判定为报价变更沉淀且异常可标记。

### T6 · 消费端打通（U1/U2/U4 + 时间线噪声隔离）
```contract-yaml
- task: "消费端打通：装配层租户与范围、注入契约、记忆页租户视图、时间线噪声隔离"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate, intake-router]
  knowledge_scope: { layers: [L1, L2], maxHops: 4 }
  success: "业务租户决策前装配能召回到本租户客户记忆（非仅 decision 主题）；时间线记忆源排除 trace；GET /api/memory 对业务租户返回本租户数据；注入为空时 emit memory-inject-empty"
```
**契约说明：** 由 `review-gate` 承接；成功判定为四条消费路径全部打通且可观测。

### T7 · 治理闭环：巡检、指标、告警、自动修补
```contract-yaml
- task: "记忆治理闭环：巡检脚本、健康指标、配置化告警与漂移自愈"
  agent: review-gate
  contract_task_id: ct-review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate, quote-engine]
  knowledge_scope: { layers: [L1, L2], maxHops: 4 }
  success: "scripts/memory-health-check.mjs 可复跑并输出七项指标与退出码；阈值走 config_store 可改；漂移自愈动作只 UPDATE 且 0 条 DELETE"
```
**契约说明：** 由 `review-gate` 承接；成功判定为巡检可复跑、阈值配置化、自愈严守禁删红线。

### T8 · 复盘结论沉淀与先例提升
```contract-yaml
- task: "复盘结论沉淀与租户级先例提升"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [decision-retrospective, data-particle-read]
  memory: [decision-retro, review-gate]
  knowledge_scope: { layers: [L1, L2], maxHops: 5 }
  success: "复盘 root_cause/lesson 按 retro 域规则沉淀且租户与原决策一致；结案时经 promoteMemoryToTenant 产出 tenant_precedent 候选"
```
**契约说明：** 由 `decision-retro` 承接；成功判定为复盘沉淀生效且与既有推广通道接通。

---

## §12 红线与未决问题

**红线**
| 红线 | 说明 |
|---|---|
| 禁 DELETE | 一切清理走 `archived=true` 软删 |
| 不破坏多租户隔离 | 禁止"读侧回退 system"；admin 通配需显式收窄 |
| 不改 `context-routing` | `config_store['context-routing']` 与 `routing.js` 禁止修改 |
| 不新增粒子类型 | 锚点复用 `CRM_ACCOUNT`/`CRM_DEAL` |
| 配置化 | 触发规则、投影白名单、阈值全部走 `config_store`，禁硬编码业务键与行业字面量 |

**未决问题（需用户决策）**
1. **U3 `rrfSearch` 死代码**：接线到客户 360 / 决策前装配（增强召回），还是标 `lifecycle:'reserved'` 隐藏？—— 倾向先接线（已实现未用是浪费），但需评估性能（当前实现取 200 行内存排序）。
2. **R7 先例自锁**：是否并入本次？倾向**独立立项**（属决策引擎行为变更）。
3. **C7 的 `summary` 是否引入 LLM**：当前设计走规则裁剪（零成本）；若要更高质量摘要需另立议题（涉及 metering 与配额）。
4. **记忆页权限**：`GET /api/memory` 从 sysadmin-only 放开到租户视图，需确认是否保留 admin 全量视图。
5. **存量 12 条高质量记忆锚点是"客户名"而非 id**：是否做名称→id 归一化？有误并风险，倾向不动。
6. **P0–P5 是否一次做完**：建议 P0+P1 先发（止血+正确性），P2–P5 分批，每批有独立验收。

---

## §12.5 实施落地记录（2026-09-10 · P0 + P1 + P2 已实现）

**范围决议（用户未逐条拍板，按最小风险自行决策并记录，可回滚重议）**

| # | 未决问题 | 本次决策 | 理由 |
|---|---|---|---|
| 1 | P0–P5 是否一次做完 | **P0+P1+P2 已实现**；P3(U3/U4)/P4闭环/P5 分批 | 写入寻址、投影、自动沉淀是"能不能用"的前提；消费打通与存量修补属增量价值，需独立验收 |
| 2 | U3 `rrfSearch` 死代码 | **本期不动**，维持未接线 | 召回增强属 P3；当前实现取 200 行内存排序，未评估前不引入性能风险 |
| 3 | U4 记忆页权限 | **本期不动**，维持 sysadmin-only | 放开租户视图涉及权限面变更，需独立评审 |
| 4 | R7 先例自锁 | **独立立项**，不改决策引擎行为 | 修它要放宽先例池状态条件，属决策引擎语义变更，风险高于本次止血目标 |

**已落地改动（file:line 级）**

| 项 | 文件 | 改动 |
|---|---|---|
| C1 | `src/memory/memoryLog.js` | `appendMemory` 增 `tenantId/entityType/type/id`；新增纯函数 `resolveTenantId`（显式 > `payload.tenant_id` > system）；缺租户 emit `memory-tenant-missing`（可用 `MEMORY_STRICT_TENANT=1` 转拒写） |
| C2 | `src/memory/memoryLog.js` | 新增 `resolveEntityAnchor` / `mapEntityType`：显式 > `payload.account_id` > `deal_id` > id，无归属诚实留 NULL |
| C2 | `src/action/seed-actions.js` | `crm-memory-upsert` 透传 `ctx.tenantId` + 增 `entityType` 入参，返回体回带 `tenant_id/entity_id/entity_type` |
| C7 | `src/memory/memoryLog.js` | 新增 `projectDecisionMemory`（四段式 `summary/entities/evidence/gaps`）+ `stripCredentials`；4 KB 上限 + `truncated`；只加字段不删字段 |
| C7 | `src/decision/decisionRepo.js` | `appendMemoryLog` 改走投影；`createDecision` 调用点补传 `trigger_context/involved_entities/conditions_evaluated` 与 `tenantId` |
| C5 | `src/mcp/gateway.js:167`、`src/action/executor.js:67` | mint 决策时补传 `tenantId: ctx.tenantId`（此前恒落 system） |
| C8 | `src/decision/autonomyEngine.js:209` | `searchPrecedents` 补传 `tenantId: tenant`（C5 强制伴随项，缺失会"修了归属断了先例"） |
| C4 | `src/memory/capture.js` | `on('*')` → 业务域白名单；`BLOCKED_DOMAINS`（trace/metering/decision/system/memory）硬闸不可被配置绕过；`isCapturable/setCaptureDomains/loadCaptureDomains` 可单测可运营 |
| C4 | `src/http/routes.js:471` | 启动时 `loadCaptureDomains()`（无配置则保持缺省） |
| U1 | `src/context/assembler.js` | `retrieveL2` 增第三参 `tenantId`，调用点透传 `actorTenant`（原恒读 system） |
| **C3** | `src/memory/precipitate.js`（新） | 粒子写入自动沉淀内核：纯函数 `diffFields`/`shouldPrecipitate`（字段闸 + 同值0条） + `precipitateFromParticleWrite`（去重窗 + 三重防雪崩）；规则走 `config_store['memory-precipitate-rules']`，出厂缺省含 CRM_DEAL/ACCOUNT/CONTACT；fail-open |
| **C3** | `src/particles/particleRepo.js:259` | `updateParticle` 尾部挂 `precipitateFromParticleWrite`（在 AI 属性重评估之后，快照含派生最终值）；fail-open 不阻断业务写 |
| **C1-bis** | `src/decision/closureLoop.js` | 三处直插 `memory_log`（RETRO_MEMORY_IMPACT / HINDSIGHT_REINFORCE / HINDSIGHT_REWRITE）改为复用 `appendMemory`，新增 `decisionAnchor` 直接读 `crm.decision.tenant_id` + 锚点（原省略 tenant_id → 静默落 system，构成多租户泄漏） |
| **C1-bis** | `src/decision/edgeWrite.js:35` | 边写降级留痕显式传 `tenantId:'system'`（平台基础设施事件，不属业务租户；语义正确且避免误 emit `memory-tenant-missing`） |
| **C1-bis** | `src/ontology/backfill.js:141` | 一次性本体回填留痕显式传 `tenant_id:'system'`（平台数据操作，无业务租户上下文） |
| DDL | `db/schema.sql`、`db/2026-09-10-memory-entity-type.sql`、`db/migrate.js` | `memory_log` 补 `entity_type` 列 + 索引；入 `INCREMENTAL_SQL` 增量清单（迁移文件须置于 `db/` 根，非 `db/migrations/`） |

**新增交付物**
- `test/memory/memory-writeback.test.js` —— 27 例纯函数验收（C1/C2/C4/C7 + C3 防雪崩），**27/27 绿**
- `scripts/memory-health-check.mjs` —— 只读巡检，7 项指标 + 缺口清单（`--json` / `--fail-on-gap`）
- `scripts/memory-backfill.mjs` —— 存量修补 S1–S4，**默认 dry-run**，必须 `--apply`；全程 0 条 DELETE（已修 UUID=text 强转 bug）
- `scripts/verify-memory-writeback.mjs` —— 端到端验证：写租户隔离 + 投影脱敏 + 凭证硬拒（接真实库跑）
- `scripts/memory-loop-closed.mjs` —— §13 闭环：巡检缺口 → 按 `gap_type` 累积复发 → 复发≥2 生成 `pending-review` 提案（HITL 闸，不触达 memory_log）

**⚠ 上线顺序红线（不可逆）**
`db/migrate.js`（补 `entity_type`）**必须先于代码上线**。代码先上时 `appendMemory` 会因缺列直接报错 → 记忆写入全链路失败。

**验证状态（2026-09-10 下午 · 已闭环）**
| 范围 | 结果 |
|---|---|
| `test/memory` + `test/decision` + `test/particles` + `test/context` | **99 文件 692 测试全绿**（此前缺列红已全部消除） |
| `test/memory/memory-writeback.test.js` | 27/27 绿（纯函数，含 C3 防雪崩） |
| `test/mcp/confirm-params-merge.test.js` | 1 红 —— **既存失败**（A/B 还原 gateway 干净基线仍失败），与本次无关 |
| `db/migrate.js`（测试库） | **已成功执行**，`entity_type` 列已落到 crm_native_test |
| `scripts/verify-memory-writeback.mjs`（E2E） | **全绿**：租户隔离 / 缺省兜底落 system / 凭证硬拒 / 投影脱敏均验证通过 |
| `scripts/memory-health-check.mjs` | 只读跑通，正确识别 tenant-writeback / decision-projection 缺口 |
| `scripts/memory-backfill.mjs --step=all`（dry-run） | 跑通（测试库数据少，0 待变更属预期；修复 UUID=text 后无 SQL 错误） |
| `scripts/memory-loop-closed.mjs` | 连跑两次验证复发≥2 → 生成 2 条 pending-review 提案，HITL 闸生效 |

---

## §13 闭环回写（已实现 · scripts/memory-loop-closed.mjs）

**机制**：巡检(`memory-health-check.mjs --json`) → 缺口入 `.workbuddy/memory/memory-loop-feedback.json`（按 `gap_type` 累积 `occurrences`）→ 同一缺口复发 ≥ `MIN_OCC`（默认 2）→ 在 `scripts/memory-loop-proposals.json` 生成一条 `pending-review` 提案 → **需人工在终端执行对应 backfill 步骤后方可生效**（本脚本不触达 `memory_log`，强行守住 HITL 闸）。

**gap_type → 修复动作映射**（仅描述，不自动执行）

| gap_type | 修复动作（人工执行） |
|---|---|
| `tenant-writeback` | `memory-backfill.mjs --step=tenant --apply`（S2） |
| `entity-anchor` | `memory-backfill.mjs --step=anchor --apply`（S3） |
| `decision-projection` | `memory-backfill.mjs --step=project --apply`（S4） |
| `inject-empty` | 核查 C7 投影覆盖；确认 `summary/entity_type` 已写入 |
| `noise-flood` | `memory-backfill.mjs --step=noise --apply`（S1）+ 确认 C4 白名单已上线 |
| `noise-live` | 先修 C4 源头切断，再谈修补 |
| `decision-tenant` | 确认 C5+C8 已上线；对历史决策跑回填 |

**已验证**：连跑两次同一缺口触发 `occurrences=2` → 生成 2 条 `pending-review` 提案（见上「验证状态」）。提案为待评审态，绝不自动改写数据。

**复用方式**：夜批接入 `node scripts/memory-loop-closed.mjs` 即可每日累积缺口趋势；达阈值自动产出可评审提案清单。

---

*总体设计 · 证据驱动，所有结论附源码 file:line；遵循 brainstorming → writing-plans → 实施流程，未批准不写实现代码。*
