> ⛔ **已废弃（SUPERSEDED）— 2026-09-15**
> 本文结论**已被完整吸收并取代**（任务编号映射：原 `T1–T10` → 最终设计 **`T01–T10`**）。唯一有效设计 → `docs/2026-09-15-final-design-coexistence-and-proactive.md`（最终设计 v1.0）。
> ⚠ **S 编号亦已重排**：本文的交付分段 `S1–S5` **仅覆盖线 A**；最终设计重排为 **`S1–S7`**（线 A / 线 B 交织，见 §14.3）——**旧 `S` 编号不可用于定位**（按旧文档查"T5（S2）"会落到新设计的 S5，错位 3 段）。
> **本文件仅保留过程证据、DDL 草案与一手资料锚点，用于追溯；不得作为实施、评审或对外表述的依据。**
> 若本文与最终设计冲突，一律以最终设计为准。

---

# 设计文档：与客户既有 CRM 共生 —— 同步内核与单向回写

> 设计日期：2026-09-15 ｜ 状态：**待评审批准（P8）** ｜ 性质：brainstorming 产出（**非实施**；批准前不写任何实现代码，HARD-GATE）
> 方法论：`brainstorming` SKILL（P0 回写预检 → P1 探索 → P2 澄清 → P3 方案 → P4 设计 → P5 批准闸门 → P6 文档 → P7 自检 → P8 评审 → P9 移交 writing-plans）
> 前置输入：`docs/2026-09-15-rox-benchmark-differentiation-analysis.md`、`docs/2026-09-15-attio-lightfield-rox-three-way-comparison.md`
> 取证口径（硬约束）：对我方的一切断言附 `file:line` 或"grep 零命中"；对第三方附 URL 锚点。两者皆无 → 标注为推算。

---

## §0 定位修正：本次设计的前提变更

### 0.1 被推翻的旧前提

前两版对标文档的核心论断是：

> "Rox 的'不淘汰现有系统'对我方无落点——我方目标客户（中国 B2B 制造/化工/医疗器械中端）**多数没有成熟 CRM**，其事实发生地是钉钉/企微/飞书 + 邮件 + Excel 台账。"（`2026-09-15-attio-lightfield-rox-three-way-comparison.md` §6 层一）

**用户 2026-09-15 明确修正**：我方客户群体**都有自研或套装 CRM**（如纷享销客、销售易等）。

### 0.2 修正后的判定

| 维度 | 旧判定（错） | 修正后判定 |
|---|---|---|
| Rox"接现有 CRM"策略是否适用 | 对象不匹配，照搬无落点 | ✅ **直接适用**——客户已有 CRM，与 Rox 的客户前提同构 |
| 我方缺口的性质 | "接错方向"（该接 IM/Excel 却做了对外获客） | **三层全缺**：无 CRM 类适配器 + 无映射层 + 无回写通道 |
| "事实发生地"策略的定位 | P0 | **降为补充轨**（CRM 是主数据源，IM/邮件/会议是上下文补充） |
| 战略叙事 | "你不在 CRM 里，我接你的事实发生地" | **"你已有 CRM，我接上来，不停你的业务"**（= Rox 叙事的中国版） |

### 0.3 修正后的定位象限

```
                    数据来源：自建记录系统
                            ▲
        Attio ●             │        ○ 我方原目标位（已被推翻）
        Lightfield ●        │
                            │
   ─────────────────────────┼─────────────────────────▶
   要求搬迁                  │                与既有系统共生
                            │
                            │        ★ 我方修正后目标位
                            │             ● Rox
                            ▼
                    数据来源：借用客户数据
```

**我方修正后目标位**：与 Rox 同为"借用 + 共生"，但保留两项结构性差异——
1. **写侧零信任治理**（Rox 治理在读侧，此为对方空白轴）；
2. **可验证性**（Rox 自述"no hill-climbing possible against a golden benchmark"，我方以九尺子 8 项确定性评分 + 4,111 例测试 + 快照回放为底座）。

---

## §1 Rox 定位的可借鉴内核（对照原文）

| # | Rox 内核 | 官方原文锚点 | 我方是否可借 | 本次是否落地 |
|---|---|---|---|---|
| 1 | **CRM 是数据源，不是替代对象** | "Rox treats any CRM as **just another data source** feeding the SOR"<br>`docs.rox.com/development/engineering/rox-enterprise-integrations/crm-integration` | ✅ | ✅ 本设计主线 |
| 2 | **三层同步：Mappings / Real-Time / Batch** | Mappings：字段映射 + 同步方向 + 类型校验；Real-Time：写前回拉 + 快照比对 + 不匹配中止；Batch：高批量单向回写 | ✅ | ✅ 落 Mappings + 单向回写（Batch 留接口） |
| 3 | **乐观并发，不依赖时钟** | "We avoid NTP-style clock alignment and instead implement an **optimistic concurrency** strategy" | ✅ **我方已有同构** | ✅ 扩展 CAS 语义（§5 B6） |
| 4 | **回写静态值标记** | 回写时给字段打固定值（如 `Source='Rox'`），让数据在客户 CRM 里**可识别、可过滤** | ✅ | ✅ §6 N4 |
| 5 | **叙事降级：只读观察期 → 回写 → 再谈接管** | 对 Agentforce 公开立场："**complementary, not competitive**"、"Rox fills the pipeline" | ✅ | ✅ §6 N5 + §9 |
| 6 | —— **不学**：商业终局 | "customers will graduate to a warehouse-native future… **and let's be honest: in that future, Rox is the CRM**" | ❌ | ❌ §12 红线 |

**判定**：Rox 的"不淘汰"**是进入策略与工程机制，不是承诺**。我方借鉴前五条、明确拒绝第六条——因为一旦对外写"最终取代"，"共生"叙事即刻自毁。

---

## §2 我方现状：源码级盘点（已有的 vs 缺的）

### 2.1 已有骨架（比预期深——这是本设计最重要的发现）

| # | 能力 | 证据锚点 | 对本设计的意义 |
|---|---|---|---|
| E1 | **租户级外部系统描述符** `config_store['integration-providers']`（per-tenant）：`{ id, kind, enabled, endpoint, field_map, signal_map, credentials }` | `src/connectors/discovery/tenantInstances.js:19-29` | **"接哪个外部系统"已是配置项，不是代码**——加 CRM 只需扩描述符 schema |
| E2 | **kind → 工厂注册表**：`generic-rest` / `generic-mcp` / `generic-cli` | `tenantInstances.js:9-13` | 加 `fxiaoke` / `neocrm` 走同一机制 |
| E3 | **加密凭据保险库**（pgcrypto at-rest + 运行时按租户解密 + 缺失回退同名 env；fail-closed 点名校验密钥） | `src/connectors/discovery/credentialVault.js:34-49`、`:52+`（`persistSecret` fail-closed） | 纷享 `appId/appSecret/permanentCode` 与销售易凭据**有落点** |
| E4 | **定时拉取框架（混合模式）**：逐租户 → `loadAdapters` → `runWaterfall` → `monitorAccount`；间隔 `config_store['integration-poll'].interval_ms`（默认 6h），`INTEGRATION_POLL_MS` 可覆盖；启动预热 + 失败留痕 | `src/scheduler/timers.js:117-143` | **对象级增量拉取可挂同一循环** |
| E5 | **入站 webhook 挂载点**：`POST /api/integration/webhook/:provider`（admin/sysadmin 闸）→ `handleSignalWebhook` → `conn-signal-lead-gen` | `src/http/connectorRouter.js:11-25`、`:71` | 事件订阅（对象变化）可复用此入口 |
| E6 | **CAS 原子写**（防 read-modify-write 竞态）：`casExpectStage` + `casExpectOwnerEmpty`，命中时 WHERE 追加校验，`rowCount===0` 即抛"已被他人操作" | `src/particles/particleRepo.js:203`、`:232-242` | **Rox"乐观并发"的我方同构实现**——扩到字段值即可 |
| E7 | **配置存储自带决策锚点**：`writeConfig(key, value, { tenantId, decisionId, updatedBy })`；读侧 autoSeed 从 system 模板落租户 | `src/config/configStore.js:51`、`:64` | 映射层配置**天然可审计、可挂决策** |
| E8 | **同步后重评闭环**：`monitorAccount` 做 rescore + appendMemory（append-only）+ 读-改-写 payload | `src/connectors/discovery/monitorAccount.js:10-30` | 新数据进来后自动重评，**无需新建** |
| E9 | **写通道第 0 闸**：`requireDecision(scenario, facts, entities, disposition)` → mint 决策；`conn-*` action 走 `autoDecision: true` | `src/connectors/connectorActions.js:20-33`、`:100` | 同步写入的闸门形态**已有范式** |
| E10 | **`agentTool: false` 免装配闭包范式**：`conn-signal-lead-gen` 仅由 webhook/定时器触发，**不进 agent capabilities** | `src/connectors/connectorActions.js:132` 注释明文 | **同步 Action 可走此路，避免 agentSpec 三处同改** |

### 2.2 缺口（逐条锚点）

| # | 缺口 | 证据 |
|---|---|---|
| G1 | **无 CRM 类适配器** | `salesforce/hubspot/zoho` 在 `src/` 下仅 1 处命中，且是 `anysite.js:105` 注释里的技术栈举例；`纷享/fxiaoke/销售易/xiaoshouyi/neocrm` **全仓零命中** |
| G2 | **无对象级增量拉取** | `timers.js:120-143` 现循环是"对每个 `CRM_ACCOUNT` 逐条 runWaterfall 富化"，**无游标、无对象遍历、无增量** |
| G3 | **无字段映射层** | `genericRest.js:11` 的 `field_map` 是**单层扁平**映射（`{我方字段: 响应体路径}`），只服务 `enrich()`，**无方向、无类型校验、无静态值** |
| G4 | **无外部引用映射表** | 无任何表/字段记录"客户 CRM 的记录 ID ↔ 我方 particle_id"——**去重与回写的共同前提缺失** |
| G5 | **无回写通道** | `src/connectors/connectorActions.js` 共 4 个 action（`:18` attio-enrich / `:53` zhizao-verify / `:99` tender-push / `:132` signal-lead-gen），**全部 write-into-us，无一 write-back-out** |
| G6 | **无同步信任分级** | 现范式是 `autoDecision: true` → 每条写自 mint 决策；批量同步若逐条 mint 会产生决策洪水 |
| G7 | **无同步可观测指标** | 无同步成功率/延迟/冲突数/游标位置的指标落点 |
| G8 | **`updateParticle` 是浅合并** | `particleRepo.js:211` `{ ...cur.payload, ...patch }`——嵌套对象会被整体替换，**增量字段更新需嵌套感知** |

---

## §3 设计目标与非目标

### 3.1 目标（按客户价值倒排）

1. 客户**不必停用/搬迁**任何既有 CRM，我方在其旁建立上下文层；
2. 客户 CRM 的真实数据成为我方决策的输入（消除"AI 无上下文 → 评分恒 0"的死结）；
3. 我方产出的富化/洞察/决策结论**写回客户 CRM 指定字段**，进入客户日常工作流；
4. 全链路**可审计、可回滚、可停**（客户随时可断，不产生数据黑洞）。

### 3.2 非目标（明确不做，见 §12）

- 不做完整双向同步（含变更来源消歧 + pending 对账 + Fivetran 级管道）；
- 不做"取代客户 CRM"的任何产品叙事或技术路线；
- 不新增粒子类型、不改业务域模型（§10 硬约束）；
- 不做任意 SQL/脚本注入型同步（映射必须是**声明式白名单**）。

### 3.3 硬约束（继承既有，不可偏离）

| 约束 | 出处 | 本设计的遵守方式 |
|---|---|---|
| **不新增粒子类型** | 2026-09-08 已批设计 §10 | 读入落既有 `CRM_ACCOUNT`/`CRM_CONTACT`/`CRM_DEAL`/`CRM_LEAD` |
| **绝对禁 DELETE** | 项目铁律 | 同步只增改；外部记录消失 → 标记 `external_deleted_at`（软态），物理行保留 |
| **写操作过决策第 0 闸** | 铁律 | 同步写走 `requireDecision`（§7 信任分级定义 mint 粒度） |
| **租户隔离** | `src/http/tenantScope.js:4` `scopeTenant()` | 所有同步表/配置带 `tenant_id`；凭证按租户解密 |
| **配置 100% 后台化** | 项目铁律 | 映射、频率、方向、信任级别全部走 `config_store`，**零硬编码** |
| **HITL 零信任** | 项目铁律 | 首次接入、映射变更、回写开关变更均需人工确认 |

---

## §4 方案选型（P3）

| 维度 | 方案 A 适配器扩展式 | **方案 B 同步内核 + 统一契约（推荐）** | 方案 C 借道第三方 iPaaS |
|---|---|---|---|
| 做法 | 仅加 `fxiaoke`/`neocrm` 两个 kind，复用 `genericRest.field_map` | 新建 `src/sync/` 内核 + 厂商适配器实现统一 `CrmProvider` 契约 | 不自建，由轻易云类平台推送到我方 webhook |
| 接第二家成本 | 复制粘贴（且映射能力不足） | 写一个适配器，内核不动 | 零开发 |
| 回写落点 | 无 | 契约方法 `writeBack()` | 需外部平台反向开发 |
| 映射可审计性 | 低（适配器内扁平字典） | 高（落 `config_store`，可 diff / 可回滚 / 可挂 decisionId） | 低（黑盒） |
| 与"可验证"定位 | 中 | **高** | **低** |
| 增量/游标能力 | 无 | 有 | 有（外部） |
| 引入新依赖 | 无 | 无 | 有（供应商 + 数据出境合规） |
| 一次性成本 | 最低 | 中 | 最低 |
| 长期成本 | **高**（每接一家重构一次） | 低 | 中（供应商锁定） |

**推荐方案 B**。理由：①"接第二家"必然发生（客户名单中同时存在纷享销客、销售易、自研系统）；②方案 A 的单层扁平 `field_map` 撑不住对象级同步与回写，接第二家时必然重构成 B，届时已完成的工作要返工；③方案 C 的数据链路在黑盒中，与"可验证可审计"的对外定位直接冲突，且引入供应商与合规风险。

---

## §5 补齐清单（扩展已有骨架，按客户价值排序）

> 定义：**补齐** = 复用既有机制，仅扩展 schema / 分支 / 语义，不引入新概念。

| 优先级 | # | 补齐项 | 现状锚点 | 动作 | 客户价值 |
|---|---|---|---|---|---|
| **P0** | B1 | **`integration-providers` 描述符扩展为"同步对象契约"** | `tenantInstances.js:19-29` 现读 `id/kind/enabled/endpoint/field_map/signal_map` | 增字段：`objects[]`（`{ name, direction, cadence_min, mapping_ref, cursor, id_field, since_field }`）、`token_mode`、`trust_level` | 让"接哪个系统的哪些对象、怎么同步"变成**管理员配置**，不写代码 |
| **P0** | B2 | **`credentialVault` 支持结构化凭据** | `credentialVault.js:34-49` 现把整段密文当单个字符串密钥 | 允许 JSON 结构（纷享 `appId/appSecret/permanentCode`、销售易账号密钥）；token 缓存值与过期时间**加密落库**（`config_store['integration-secrets']`），不落内存全局 | 客户凭据**不出口、不进日志、进前端**的一贯承诺得以延续 |
| **P0** | B3 | **`tenantInstances.KIND_FACTORY` 加两个 kind** | `tenantInstances.js:9-13` 现 3 个 kind | 加 `fxiaoke`、`neocrm`（自研 CRM 用 `generic-rest` 覆盖） | 客户无论用哪家套装都能接 |
| **P0** | B4 | **CAS 语义从"阶段/归属"扩到"字段值"** | `particleRepo.js:203`（签名）、`:232-242`（CAS 实现） | 增 `casExpectField: { path, value }` / `casExpectExternalUpdatedAt`；不匹配即在 WHERE 层拒绝并回传最新值 | **回写安全的地基**（Rox"乐观并发"的我方实现） |
| **P1** | B5 | **`connectorRouter` 增"对象变化事件"路由分支** | `connectorRouter.js:11-25` 现 webhook 只派发 `conn-signal-lead-gen` | 按 `event.object` 路由到同步内核 upsert；沿用 admin/sysadmin 闸 | 从"每 6h 轮询"升级为"客户 CRM 一变我就知道" |
| **P1** | B6 | **`integration-poll` 定时器增"对象增量拉取"分支** | `timers.js:120-143` 现仅对 `CRM_ACCOUNT` 逐条富化 | 在既有租户循环内增分支：按 `objects[].cursor` 拉增量 → 走内核 upsert；沿用 `recordTokens` 成本落账与 `emit('trace')` | 不新增定时器、不改调度框架，**零调度层回归风险** |
| **P1** | B7 | **`monitorAccount` 复用为"同步后重评"** | `monitorAccount.js:10-30` | 同步 upsert 落地后调用，触发 rescore + appendMemory | 新数据立刻影响决策，**无需新建重评链路** |
| **P2** | B8 | **`updateParticle` 增嵌套感知合并选项** | `particleRepo.js:211` `{...cur.payload, ...patch}` 浅合并 | 增 `patchMode: 'deep'`（仅对同步路径启用，默认保持浅合并**不改既有语义**） | 增量字段同步不误伤同层其它字段（如 `payload.discovery` 子键被整体替换） |

---

## §6 新增清单（真正新建）

| 优先级 | # | 新增项 | 为什么必须新建 | 落地位置 |
|---|---|---|---|---|
| **P0** | N1 | **厂商无关同步内核** | 无任何"增量拉取 / 游标推进 / upsert / 实体对齐"引擎（`integration-poll` 是逐条富化循环，不是同步引擎） | 新建 `src/sync/`（`engine.js` / `cursor.js` / `upsert.js` / `entityResolver.js`）；厂商适配器实现统一 `CrmProvider` 契约：`discoverObjects()` / `readIncremental(cursor)` / `writeBack(fields)` / `verifyAuth()` |
| **P0** | N2 | **字段映射层** `config_store['sync-mappings']`（per-tenant） | 现有 `field_map` 是适配器内的扁平字典，**无方向、无类型校验、无静态值、不可独立审计** | 声明式结构：`{ object, direction: 'in'\|'out', fields: [{ external, particle, type, required, static? }], identity: { external_id_field, since_field }, filters }`。**映射变更走 HITL 确认 + decisionId 落 `config_store`** |
| **P0** | N3 | **外部引用映射表** `crm.external_ref`（**新表**） | 无任何机制记录"客户 CRM 记录 ↔ 我方粒子"的稳定对应（G4）。这是**去重、幂等、回写定位**的共同前提 | 新表（DDL 见 §8）。**不新增粒子类型**，仅为映射表，符合 §10 硬约束 |
| **P0** | N4 | **单向回写通道**（新 Action） | 4 个 connector action 全为 write-into-us（G5），无一 write-back-out | 新 Action `sync-writeback-fields`（`kind: 'write'`, `namespace: 'sync'`, `agentTool: false`, `needsApproval: true`, `autoDecision: true`）；**回写必带静态标记** `Source='crm-ai-native'`（Rox 内核 4） |
| **P0** | N5 | **同步信任分级** | 现范式每条写自 mint 决策（`connectorActions.js:20-33`）；CRM 批量同步若逐条 mint 会决策洪水，若完全免检则违背写侧零信任 | 三档落 `config_store['sync-trust']`：**L1 只读**（零写风险）/ **L2 批量入库**（一次 run mint 一个决策，承载整批）/ **L3 回写**（逐批审批 + 首 N 次逐条人工确认）。默认 L1 起步 |
| **P1** | N6 | **同步可观测指标** | 无同步成功率/游标滞后/冲突数/回写成功率（G7） | 复用既有 `src/monitor/` + `emit('trace')`；指标：`sync_lag_minutes` / `sync_success_rate` / `conflict_count` / `writeback_count`。**上墙到门户页** |

---

## §7 客户价值排序（本次核心交付）

### 7.1 纯客户价值视角（客户能感知到什么）

| 排名 | 客户获得的价值 | 对应设计项 | 价值依据 | 感知强度 |
|---|---|---|---|---|
| **1** | **AI 的结论出现在客户自己的 CRM 里** | N4 回写 + B4 字段级 CAS | 客户不必再登第二个系统；AI 产出直接进入其现有工作流与报表。Rox 的 `Source='Rox'` 标记正是为此 | ★★★★★ |
| **2** | **不再重复录入 / 不再两套数据打架** | N2 映射 + N3 外部引用对齐 + B1 描述符 | 工时可直接折算成钱；且消除"CRM 里一份、AI 系统里一份"的信任损耗 | ★★★★★ |
| **3** | **AI 的判断基于真实客户数据，而不是猜** | N1 内核 + B6 增量拉取 + B7 重评 | 直击我方现存死结：供给层不通则九尺子 8 项确定性评分全部恒 0 分 | ★★★★ |
| **4** | **从"你去查"变成"它提醒你"** | B5 事件订阅 | 客户 CRM 里一有变动即触发重评与提示；对齐 Rox Agent Swarms 的常驻监控 | ★★★★ |
| **5** | **可以随时断开的零风险试用** | N5 信任分级（L1 只读起步）+ §9 观察期 | 只读阶段客户无任何数据风险 → 采购阻力显著下降（Rox 的进入策略内核） | ★★★ |
| **6** | **同步行为可审计、可复现、可回滚** | N6 可观测 + N2 映射可 diff | 客户 IT/内审关注项；我方"可验证"定位的落地证据 | ★★★ |

### 7.2 实施顺序（依赖关系决定，与客户价值排序不同）

> **重要区分**：客户价值排序回答"先让客户感觉到什么"，实施顺序回答"技术上必须先做什么"。两者**顺序相反**——最高客户价值（回写）在依赖链末端。

| 阶段 | 内容（含 §11 任务号） | 依赖 | 里程碑判据 |
|---|---|---|---|
| **S1** | N1 内核 + N2 映射层 + N3 外部引用表 + B1/B2/B3/B4 ｜ **T1 T2 T3 T10** | 无 | 能从纷享销客拉取"客户/联系人/商机"三类对象并落为既有粒子，重复运行不产生重复行；**首次接入经评审闸门放行** |
| **S2** | N5 信任分级（L1→L2）+ B6 增量拉取 + B7 重评 ｜ **T5 T8 T9** | S1 | 定时增量同步后，目标账户的决策评分发生可观测变化（不再恒 0）；产品/价格表可用作报价基线；无与拓客候选重复的账户 |
| **S3** | N4 回写 + B4 字段级 CAS 对齐 ｜ **T4** | S1 | 我方的富化字段写回客户 CRM 指定字段，并带 `Source='crm-ai-native'` 标记；并发修改被 CAS 拦住 |
| **S4** | B5 事件订阅 + N6 可观测 ｜ **T6 T7** | S3 | 客户 CRM 侧改动 5 分钟内触发我方重评；同步指标上墙 |
| **S5** | B8 深度合并 + Batch 通道接口预留 | S4 | 增量字段更新不误伤同层其它字段 |

### 7.3 一句话结论

> **客户感知最强的是"回写"（排名 1），但技术上必须先做"读入 + 对齐"（排名 2、3）**。
> 因此建议：**S1+S2 合并为一个交付批次先上**（此时客户已能感知排名 2、3、5 的价值：不再重复录入、判断有据、零风险），**S3 紧随其后**（交付排名 1 的强感知价值）。**不要**先做回写——没有 S1 的实体对齐，回写会把数据写到错误的记录上。

---

## §8 数据模型（新表 DDL 草案）

> 遵循项目既有约定：`CREATE TABLE IF NOT EXISTS`；`tenant_id` 默认 `'system'`；**不物理 DELETE**（软态翻转）；DDL 追加至 `db/schema.sql`（单一事实源）。

```sql
-- ============ 客户既有 CRM 共生：外部引用映射（2026-09-15，docs/2026-09-15-crm-coexistence-sync-design.md N3）============
-- 用途：客户 CRM 记录 ↔ 我方粒子 的稳定对应关系。去重、幂等 upsert、回写定位的共同前提。
-- 铁律：不物理 DELETE（外部记录消失 → external_deleted_at 软标记）；tenant_id 全表隔离。
CREATE TABLE IF NOT EXISTS crm.external_ref (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             TEXT NOT NULL DEFAULT 'system',
  provider              TEXT NOT NULL,              -- fxiaoke | neocrm | generic-rest | ...
  external_object       TEXT NOT NULL,              -- 客户 CRM 侧对象 API 名（如 AccountObj / account）
  external_id           TEXT NOT NULL,              -- 客户 CRM 侧记录主键
  particle_type         TEXT NOT NULL,              -- 我方粒子类型（既有类型，禁新增）
  particle_id           UUID NOT NULL,
  external_updated_at   TIMESTAMPTZ,                -- 客户侧最后修改时间（增量游标依据）
  last_synced_at        TIMESTAMPTZ,
  last_direction        TEXT,                       -- in | out（最近一次同步方向，供冲突定位）
  last_hash             TEXT,                       -- 上次同步内容哈希（变更检测 / 冲突比对）
  external_deleted_at   TIMESTAMPTZ,                -- 软态：客户侧已删除（绝不物理删我方粒子）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object, external_id)
);
CREATE INDEX IF NOT EXISTS idx_external_ref_particle
  ON crm.external_ref(tenant_id, particle_type, particle_id);
CREATE INDEX IF NOT EXISTS idx_external_ref_cursor
  ON crm.external_ref(tenant_id, provider, external_object, external_updated_at);

-- ============ 同步运行留痕（可观测 + 幂等断点续传）============
-- 每租户 × provider × object 一行"运行态"（禁删：upsert 更新，不新建行历史堆积）
CREATE TABLE IF NOT EXISTS crm.sync_cursor (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          TEXT NOT NULL DEFAULT 'system',
  provider           TEXT NOT NULL,
  external_object    TEXT NOT NULL,
  cursor_value       TEXT,                          -- 增量游标（如 last_modified 时间戳 / 自增水位）
  last_run_at        TIMESTAMPTZ,
  last_status        TEXT NOT NULL DEFAULT 'idle'   -- idle | running | ok | degraded | failed
                     CHECK (last_status IN ('idle','running','ok','degraded','failed')),
  last_error         TEXT,
  last_counts        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { read, created, updated, skipped, conflicted }
  token_cost         NUMERIC NOT NULL DEFAULT 0,
  decision_id        UUID,                          -- 本批同步所挂决策锚点（写侧第 0 闸）
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, provider, external_object)
);
CREATE INDEX IF NOT EXISTS idx_sync_cursor_health
  ON crm.sync_cursor(tenant_id, last_status, last_run_at);
```

**不新增粒子类型**：`particle_type` 仅取既有值（`CRM_ACCOUNT` / `CRM_CONTACT` / `CRM_DEAL` / `CRM_LEAD` / `CRM_PRODUCT`），来源见 `db/schema.sql:14` 注释。

---

## §9 配置层设计（100% 后台化，零硬编码）

### 9.1 `config_store['sync-mappings']`（per-tenant，**声明式白名单**）

```jsonc
{
  "version": 1,
  "mappings": [
    {
      "object": "AccountObj",
      "particle_type": "CRM_ACCOUNT",
      "direction": "in",
      "identity": { "external_id_field": "_id", "since_field": "last_modified_time" },
      "fields": [
        { "external": "name",           "particle": "name",           "type": "string", "required": true },
        { "external": "industry",       "particle": "industry",       "type": "string" },
        { "external": "annual_revenue", "particle": "annual_revenue", "type": "number" },
        { "external": "owner_name",     "particle": "owner_name",     "type": "string" }
      ],
      "filters": { "exclude_deleted": true }
    },
    {
      "object": "AccountObj",
      "particle_type": "CRM_ACCOUNT",
      "direction": "out",
      "identity": { "external_id_field": "_id" },
      "fields": [
        { "external": "ai_fit_score",   "particle": "fit_score",   "type": "number" },
        { "external": "ai_next_action", "particle": "next_action", "type": "string" }
      ],
      "static_on_write": { "Source": "crm-ai-native" }
    }
  ]
}
```

**约束**：① 字段必须是**已声明的映射项**，未知字段一律拒绝（防越权字段写）；② `particle` 目标必须是既有粒子字段，**不支持表达式/脚本**（防注入）；③ 映射变更走 HITL + `decisionId` 落 `config_store`（`writeConfig` 已支持，`configStore.js:64`）。

### 9.2 `config_store['sync-trust']`（per-tenant，信任分级）

```jsonc
{
  "version": 1,
  "default_level": "L1",
  "levels": {
    "L1": { "label": "只读观察期", "allow_read": true,  "allow_upsert": false, "allow_writeback": false },
    "L2": { "label": "批量入库",   "allow_read": true,  "allow_upsert": true,  "allow_writeback": false,
            "decision_granularity": "per_run" },
    "L3": { "label": "启用回写",   "allow_read": true,  "allow_upsert": true,  "allow_writeback": true,
            "decision_granularity": "per_run",
            "first_n_batches_require_human": 3 }
  },
  "writeback_fields_whitelist": ["ai_fit_score", "ai_next_action", "ai_risk_flags"]
}
```

### 9.3 `config_store['integration-providers']`（**扩展**，非新建）

在既有描述符（`tenantInstances.js:19-29`）上增字段：

```jsonc
{
  "id": "fxiaoke-prod",
  "kind": "fxiaoke",
  "enabled": true,
  "trust_level": "L2",
  "token_mode": "corp-access-token",         // 纷享：appId+appSecret+permanentCode → CorpAccessToken（有效期 7200s，须缓存）
  "objects": [
    { "name": "AccountObj",  "direction": "in",  "cadence_min": 30, "mapping_ref": "AccountObj" },
    { "name": "ContactObj",  "direction": "in",  "cadence_min": 60, "mapping_ref": "ContactObj" },
    { "name": "OpportunityObj", "direction": "in", "cadence_min": 30, "mapping_ref": "OpportunityObj" }
  ],
  "event_subscription": { "enabled": false, "objects": [] }
}
```

---

## §10 安全与铁律映射

| 铁律 | 在本设计中的落点 | 违反即失败判据 |
|---|---|---|
| **绝对禁 DELETE** | 外部记录消失 → `external_ref.external_deleted_at` 软标记；我方粒子**永不删除** | 同步路径出现任何 `DELETE FROM` |
| **写操作过决策第 0 闸** | 批量入库：一次 run mint 一个决策承载整批（`sync_cursor.decision_id`）；回写：逐批审批 | 同步产生无 `decision_id` 的粒子写入 |
| **租户隔离** | 所有新表带 `tenant_id`；配置走 `readConfig(key,{tenantId})` autoSeed；凭据按租户解密 | 跨租户读到他人映射/凭据/游标 |
| **配置 100% 后台化** | 映射/频率/方向/信任级别/回写白名单全在 `config_store` | 代码内出现对象名/字段名/频率字面量 |
| **HITL 零信任** | 首次接入、映射变更、信任级别提升、回写启用 → 人工确认；L3 前 3 批逐次人工确认 | 自动提升信任级别 / 自动启用回写 |
| **不新增粒子类型** | 读入落既有类型（`db/schema.sql:14`） | 出现新粒子类型常量 |
| **凭据不出口** | 沿用 `credentialVault` pgcrypto at-rest；token 缓存值亦加密落库 | 凭据进日志/前端/memory |

---

## §11 生命契约（Living Contract）

> 每任务双轨：机读 `contract-yaml` + 一行散文复述。字段语义见 `brainstorming` SKILL §A。
> **契约有效性已按 §A 自检通过**（`agent` ∈ `src/agent/agentSpec.js` 注册表；`skills ⊆ agent.skillCalls`；`memory ∈ agent.memory.read`；`knowledge_scope.layers ⊆ agent.knowledgeScope.layers`）。

### T1 同步内核 + 字段映射层（S1）

```contract-yaml
- task: "T1 新建 src/sync 同步内核 + config_store['sync-mappings'] 声明式映射层"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "给定 mock CrmProvider 与映射配置，engine.runOnce 返回 {read,created,updated,skipped}；同批重复执行 created=0 且无重复行；未知字段被拒绝并计入 skipped"
```
**契约说明：** 本任务由 `intake-router`（接诊=数据进入与路由的同源职责）承接，调用 `method-intake-routing` SKILL、读 `intake-router` 记忆（L1，≤2 跳）；成功标准为内核在 mock provider 下完成增量同步且幂等、未知字段被拒。

### T2 纷享销客适配器（S1）

```contract-yaml
- task: "T2 实现 fxiaoke CrmProvider 适配器（discoverObjects/readIncremental/verifyAuth）并注册 kind"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "verifyAuth 用 mock 凭据换取 CorpAccessToken 并缓存（二次调用不打网络）；discoverObjects 解析 /cgi/crm/object/list 返回预置+自定义对象清单"
```
**契约说明：** 本任务由 `intake-router` 承接，调用 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为鉴权换取+缓存与对象元数据发现均通过 mock 验证。

### T3 外部引用映射与实体对齐（S1）

```contract-yaml
- task: "T3 建 crm.external_ref 与 crm.sync_cursor 表并实现 entityResolver 幂等 upsert"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [data-particle-read]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "同一 external_id 二次同步命中既有 particle_id 且不新建粒子；external_deleted_at 软标记后原粒子仍存在（零 DELETE 核验）"
```
**契约说明：** 本任务由 `intake-router` 承接，调用 `data-particle-read`、读 `intake-router` 记忆（L1）；成功标准为幂等对齐与软删除语义，且全程零 DELETE。

### T4 单向回写通道（S3）

```contract-yaml
- task: "T4 新增 sync-writeback-fields Action（write-back-out，带 Source 静态标记 + 字段级 CAS）"
  contract_task_id: ct-decision
  agent: decision-agent
  skills: [method-decision-execute]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 3 }
  success: "回写仅作用于白名单字段；外部记录已被他人修改时 CAS 拒绝并回传最新值（不静默覆盖）；写入携带 Source='crm-ai-native'"
```
**契约说明：** 本任务由 `decision-agent`（决策执行同源职责）承接，调用 `method-decision-execute`、读 `decision-agent` 记忆（L1–L2）；成功标准为白名单约束 + CAS 拒绝 + 静态标记三项同时成立。

### T5 同步信任分级（S2）

```contract-yaml
- task: "T5 落地 config_store['sync-trust'] 三档信任分级与决策 mint 粒度"
  contract_task_id: ct-intake-route
  agent: intake-router
  skills: [method-intake-routing]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "L1 下 upsert 被拒且无任何写入；L2 下整批仅产生 1 个 decision_id；L3 提升需人工确认（无自动提升路径）"
```
**契约说明：** 本任务由 `intake-router` 承接，调用 `method-intake-routing`、读 `intake-router` 记忆（L1）；成功标准为三档行为可验证且信任级别不可自动提升。

### T6 事件订阅接入（S4）

```contract-yaml
- task: "T6 connectorRouter 增对象变化事件路由 + 定时增量分支接入 followup 重评"
  contract_task_id: ct-followup
  agent: followup-agent
  skills: [method-followup-engine]
  memory: [followup-agent]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "对象变化事件 5 分钟内触发该账户重评，重评结果 appendMemory 且 payload.discovery 其它子键不被覆盖"
```
**契约说明：** 本任务由 `followup-agent`（跟进节奏同源职责）承接，调用 `method-followup-engine`、读 `followup-agent` 记忆（L1）；成功标准为事件触发重评的及时性与 payload 子键完整性。

### T7 同步可观测（S4）

```contract-yaml
- task: "T7 同步指标落 monitor 并可上墙（lag/success_rate/conflict/writeback）"
  contract_task_id: ct-retro-decision
  agent: decision-retro
  skills: [decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "sync_cursor 每轮更新 last_counts 与 last_status；失败轮次 emit trace 且 recordFailure 非静默；指标接口按 tenant_id 隔离返回"
```
**契约说明：** 本任务由 `decision-retro`（校准与复盘同源职责）承接，调用 `decision-retrospective`、读 `decision-retro` 记忆（L1）；成功标准为运行态留痕完整、失败不静默、租户隔离。

### T8 产品与价格表同步（S2）——报价基线来源

> **为什么这条必须做**：客户 CRM 中已有"产品档案/价格表"（纷享开放平台明示支持产品档案、订单产品对象）。我方 `CRM_PRODUCT` / `CRM_PRICE_LIST` 若无真实数据，报价引擎的基线就是空的——这正是 "报价策略脱节" 这条 P0 痛点的根因之一。

```contract-yaml
- task: "T8 扩展同步对象至产品与价格表（落既有 CRM_PRODUCT / CRM_PRICE_LIST）作为报价基线"
  contract_task_id: ct-quote-calc
  agent: quote-engine
  skills: [method-quote-engine]
  memory: [quote-engine]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "同步后报价引擎能命中客户侧真实产品与价格；基线缺失时明确报缺而非按默认价计算（降级纪律）"
```
**契约说明：** 本任务由 `quote-engine`（报价同源职责）承接，调用 `method-quote-engine`、读 `quote-engine` 记忆（L1）；成功标准为报价基线来自客户真实数据，且基线缺失时报缺不猜。

### T9 同步记录与拓客候选去重（S2）

> **为什么这条必须做**：不加去重，同步进来的既有客户会与拓客候选、公海线索重叠，导致同一客户被重复触达（对客户是直接的观感事故）。

```contract-yaml
- task: "T9 同步记录入库前与拓客候选/公海线索去重核对"
  contract_task_id: ct-prospecting
  agent: prospecting
  skills: [prospecting-select]
  memory: [intake-router]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "已存在于客户 CRM 的企业不再作为新拓客候选产出；命中既有账户时候选被标注 skip 并给出已有 account_id"
```
**契约说明：** 本任务由 `prospecting`（拓客同源职责）承接，调用 `prospecting-select`、读 `intake-router` 记忆（L1）；成功标准为同步进来的既有客户不再重复产出为拓客候选。

### T10 接入与映射变更评审闸门（S1）——HITL 落点

> **为什么这条必须做**：§10 要求"首次接入、映射变更、信任级别提升、回写启用"均须人工确认，但设计里若没有承接 agent，这个闸门就是一句空话。`review-gate` 正是该职责的归属。

```contract-yaml
- task: "T10 首次接入 / 映射变更 / 信任级别提升 / 启用回写 四类动作接入 review-gate 人工审批闸门"
  contract_task_id: ct-review-gate
  agent: review-gate
  skills: [method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1], max_hops: 3 }
  success: "四类动作未获人工放行时一律被拒（fail-closed）；放行记录留 decision_id 与审批人；无自动放行路径"
```
**契约说明：** 本任务由 `review-gate`（评审同源职责）承接，调用 `method-review-gate`、读 `review-gate` 记忆（L1）；成功标准为四类高危变更动作 fail-closed，且放行全程留痕。

---

## §12 明确不做（红线）

| # | 不做项 | 理由 |
|---|---|---|
| 1 | **完整双向同步**（变更来源消歧 + pending write 对账 + Fivetran 级管道） | 投入大且"只读 + 单向回写"已覆盖约 80% 价值；复杂度集中在冲突治理，而我方客户多数**根本不会双写**（他们只有一套 CRM） |
| 2 | **任何"取代客户 CRM"的技术路线或对外叙事** | 客户既有 CRM 是十年沉淀 + 内部流程依赖；且一旦对外写"最终取代"即自拆"共生"叙事（Rox 明牌"in that future, Rox is the CRM"= 反面教材） |
| 3 | **schema-less 自由生长**（Lightfield 路线） | §10 硬约束 + 多租户 + 审计 + 禁 DELETE 不允许字段随同步自动生长；映射必须是**声明式白名单** |
| 4 | **任意脚本/表达式映射**（映射中执行代码/SQL） | 注入风险 + 不可审计；Rox 也称其映射为"类型感知校验"的声明式配置 |
| 5 | **借道第三方 iPaaS**（方案 C） | 数据链路进黑盒，与"可验证可审计"定位冲突；引入供应商与数据出境合规风险 |
| 6 | **在客户 CRM 中创建我们自有的对象/表** | 越界修改客户系统的数据模型，属于不可逆侵入；只读写**客户已声明的对象与字段** |

---

## §13 验收标准（整体）

| # | 判据 | 验证方式 |
|---|---|---|
| A1 | 能从纷享销客拉取客户/联系人/商机三类对象并落为既有粒子 | 真实租户沙箱端到端；断言 `external_ref` 行数与客户侧记录数一致 |
| A2 | 同批同步重复执行幂等（无重复粒子） | 连续两次运行，第二次 `created=0` |
| A3 | 外部记录删除不导致我方粒子删除 | 客户侧删一条 → 断言 `external_deleted_at` 非空且粒子 `id` 仍在 |
| A4 | 所有同步写带 `decision_id` | 断言新写入粒子的 `decision_id` 非空（L1 阶段应无任何写入） |
| A5 | 回写仅作用于白名单字段且带 `Source` 标记 | 构造越权字段回写 → 被拒；成功回写在客户侧可见 `Source='crm-ai-native'` |
| A6 | 并发修改被 CAS 拦住 | 同步期间人为在客户侧改同一字段 → 回写被拒并回传最新值 |
| A7 | 同步后决策评分不再恒 0 | 同步前后对比同账户的九尺子评分与 `supplied_dims` 覆盖率 |
| A8 | 全程零新增粒子类型、零 `DELETE FROM` | grep 核验（`CREATE TABLE` 仅新增 2 张映射表；`DELETE FROM` 计数不增加） |
| A9 | 配置零硬编码 | 代码内 grep 不到客户侧对象名/字段名/同步频率字面量 |
| A10 | 契约有效性 | `node scripts/validate-contract.mjs docs/2026-09-15-crm-coexistence-sync-design.md --registry src/agent/agentSpec.js` 退出码 0 |

---

## §14 闭环回写

> 本设计文档为**生命契约载体**。运行期由 agent workbench（`/agents`、`agent-workbench.html`）解析 §11 的 `contract-yaml`，逐任务核对：① 承接 agent 是否调用了声明的 `skills`？② 是否读取了声明的 `memory`/knowledge？③ `success` 是否通过？

**缺口记录（机读）**：写入 `docs/2026-09-15-crm-coexistence-sync-design.md.feedback.json`，按 `task+gap_type` 幂等 upsert。

```json
{ "task": "T4 单向回写通道", "agent": "decision-agent", "gap_type": "skill", "observed": "...", "expected": "...", "ts": "...", "severity": "warn" }
```

**缺口记录（人读）**

| task | gap_type | observed | expected | severity | ts |
|---|---|---|---|---|---|
| —— | —— | （尚无运行数据，待 S1 实施后回填） | —— | —— | —— |

**吸收与建议（P0）**：下次会话读 `*.feedback.json`；同一 `(task, gap_type)` 复发 ≥2 次 → 产出 SKILL 改进提案（如：为 `intake-router.agentSpec.capabilities.actions/skillCalls` 补 `sync-*` 条目、强化 `method-intake-routing` 的调用指令、补一条记忆读取约定）。**提案需显式批准后方可修改 SKILL 或 agentSpec，绝不自动应用。**

> ⚠ **装配闭包提醒**：若后续决定让 `sync-*` Action 对 agent 可见，须**三处同改**（`agentSpec.capabilities.actions` + `agentSpec.capabilities.skillCalls` + `src/action/seed-actions.js` 登记），否则 `assertAgentAssembly` 的 `permission_closure` / `action_in_registry` 断言会整册校验失败。本设计**刻意选择 `agentTool: false`**（范式见 `connectorActions.js:132`），以规避此项跨模块耦合。

---

## §15 移交与下一步

- **P9 移交**：批准后进入 `writing-plans`，§7.2 的 S1–S5 阶段将转为可执行任务清单；**每条任务继承 §11 的生命契约**（不新增、不弱化）。
- **前置动作（建议先做，成本极低）**：
  1. 核实生产环境 `EMBEDDING_PROVIDER` 是否 = `model`（若否，向量列为空，"语义检索"对外表述需修正）——`src/ontology/hooks.js:22`；
  2. 复核 `supplied_dims` 现状覆盖率（设计文档记录的"峰值 4/7"为 9 月初口径，非本次实测）——`docs/2026-09-02-cognitive-decision-unified-design.md:32/194`，本次 S1 完成后应以真实数据替代该引用。

---

## 附录 A：证据索引

### 我方（`file:line`）

| 项 | 锚点 |
|---|---|
| 租户级外部系统描述符与 kind 工厂 | `src/connectors/discovery/tenantInstances.js:9-13`（`KIND_FACTORY`）、`:15-30`（`loadTenantAdapters`） |
| 通用 REST 适配器（单层扁平映射） | `src/connectors/discovery/adapters/genericRest.js:11`（`field_map`）、`:23-32`（字段命中循环） |
| 凭据保险库（pgcrypto + fail-closed） | `src/connectors/discovery/credentialVault.js:34-49`（`resolveCredentials`）、`:52+`（`persistSecret` fail-closed） |
| 定时拉取（现状=逐条富化） | `src/scheduler/timers.js:117-143`（`runIntegrationPollOnce`） |
| 入站 webhook 与手动同步端点 | `src/http/connectorRouter.js:11-25`（`handleSignalWebhook`）、`:71`（`/integration/webhook/:provider`）、`:80`（`/tenant-source-sync`） |
| CAS 原子写（现状=阶段/归属） | `src/particles/particleRepo.js:203`（签名）、`:232-242`（CAS 条件与拒绝） |
| `updateParticle` 浅合并语义 | `src/particles/particleRepo.js:211` |
| 配置读写（含 decisionId） | `src/config/configStore.js:51`（`readConfig`）、`:64`（`writeConfig`） |
| 同步后重评闭环 | `src/connectors/discovery/monitorAccount.js:10-30` |
| 写通道第 0 闸范式 | `src/connectors/connectorActions.js:20-33`（`requireDecision`）、`:132`（`agentTool:false` 注释明文） |
| 连接器 Action 全清单（4 个，全 write-into-us） | `src/connectors/connectorActions.js:18` / `:53` / `:99` / `:132` |
| Agent 注册表（7 个） | `src/agent/agentSpec.js:3-105` |
| 粒子类型既有清单 | `db/schema.sql:14`（注释） |
| events 表与 channel 索引 | `db/schema.sql:102-114` |
| 新表 DDL 风格与软清理范式 | `db/schema.sql:945-960`（`discovery_draft` 软清理）、`:962+`（OAuth 三表"不改既有表"声明） |
| 契约校验脚本 | `scripts/validate-contract.mjs`、`scripts/aggregate-feedback.mjs` |

### 第三方（URL）

| 项 | 锚点 |
|---|---|
| Rox "CRM 只是数据源" + 三层同步 + 乐观并发 + 终局明牌 | `https://docs.rox.com/development/engineering/rox-enterprise-integrations/crm-integration` |
| Rox 回写配置（字段映射、静态值、Fivetran） | `https://launch.rox.com/docs/product/organization-level-configurations/configuring-crm-writeback` |
| Rox 对 Agentforce 立场（"complementary, not competitive"） | `https://www.rox.com/articles/rox-vs-salesforce-agentforce` |
| Rox 定价（Agent Action 计量 + 无限席位） | `https://www.rox.com/pricing` |
| 纷享销客开放平台（服务端 API、对象同步能力） | `https://open.fxiaoke.com/` |
| 纷享销客 CRM 对象清单接口 `/cgi/crm/object/list`（含预置+自定义对象）、`appId/appSecret/permanentCode → CorpAccessToken`（7200s 缓存） | 纷享开放平台接口文档（经 `ima.qq.com` 知识库转载） |
| 纷享销客连接器（对象/字段元数据、读写、事件订阅、文件同步、轮询） | `https://help.fxiaoke.com/9bfb/c68f/a138/468e` |
| 销售易 API/PaaS（Query/多维度/描述/增改删接口；`/rest/data/v2.0/xobjects/{apiKey}/description` 返回字段类型） | `https://www.xiaoshouyi.com/?p=40906`（官方） |
| 销售易接口明细（`/rest/data/v2.0/xobjects/...`） | 集成商文档（`qeasy.cloud`），**非官方一手** |

### grep 零命中证据

- `纷享` / `fxiaoke` / `销售易` / `xiaoshouyi` / `neocrm` → `src/` 下 **0 命中**
- `salesforce` / `hubspot` / `zoho` → `src/` 下仅 1 处，为 `anysite.js:105` 注释中的技术栈举例
- `parseCsv` / `parseCSV` / `csv-parse` → `src/` 下 0 命中（仅 `billingRoutes.js:137` 有 CSV 导出）
- `钉钉` / `飞书` / `企业微信` / `wecom` / `dingtalk` / `lark` → `src/` 下 0 命中

---

## 附录 B：本次修正的旧判断

| 旧判断（前两版文档） | 本次修正 |
|---|---|
| "我方客户多数没有成熟 CRM" | 🔴 **推翻**（用户 2026-09-15 修正）：客户**都有**自研或套装 CRM（纷享销客、销售易等）。Rox"接现有 CRM"策略从此**直接适用** |
| "'事实发生地'（IM/邮件/Excel）是 P0" | 🟡 **降级为补充轨**：CRM 是主数据源，IM/邮件/会议是上下文补充 |
| "'数据进来'要新建导入能力（CSV）" | 🟡 **修正**：CRM 已有 API 可直连，**优先做 API 同步**；CSV 导入降为"无 API 的自研 CRM / 台账"兜底 |
| "同步机制我方不缺，缺的是同步对象" | ✅ 成立，且本次进一步定位到具体挂载点（`integration-providers` 描述符 + `tenantInstances` kind 工厂 + `integration-poll` 循环） |
| "Rox 三层同步最难的是冲突消解" | ✅ 成立，且我方已有同构实现（`casExpectStage`/`casExpectOwnerEmpty`，`particleRepo.js:203/232-242`）——扩语义而非新建机制 |
