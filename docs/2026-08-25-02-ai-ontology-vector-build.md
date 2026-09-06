# AI 原生 CRM · 02 本体与向量管道设计（ai-ontology-vector-build）

- 日期：2026-08-25
- 方法论依据：`ai-ontology-vector-build`（写库即构建 / 三层管道 / 写时三钩子 / 覆盖率监控 + backfill）
- 业务基线：`2026-08-24-ai-native-sales-crm-design.md` §5ter（标讯/企查查外部数据源 + 工商抬头校验）+ §6.3ter（九引擎晶格：写时构建）
- 前置：`2026-08-25-01-ai-particle-system-design.md`（9 粒子清单 + 每粒子向量化需求）

## 0. 核心立场：写库即构建

> **写入时完成三件事：向量化（可语义检索）、本体挂接（可图遍历）、词汇索引（可 FTS）。三件事与事务同生命周期，不依赖后续批任务。**

CRM 域落地：线索/客户/交易/跟进/回款任一写入/更新的瞬间，其向量、本体归属、词汇登记同步成型——**没有「先写库、后跑批建索引」的两阶段架构**（规避窗口期 + 静默失配）。

## 1. 三层管道（文档 → 分块 → 向量）

| 层 | 粒度 | CRM 承载 |
|---|---|---|
| 文档 Document | 整篇 | `CRM_UNSTRUCTURED_ASSET`（报价明细快照/合同附件/发票票据/工商证照/跟进记录/会议纪要）+ 资产级元数据（标题/来源/版本），是本体节点 |
| 分块 Chunk | 段落/语义块 | 按语义边界切（标题/段落/表格），块带 `source_ref`（文档 ID + 原文偏移）+ 顺序号（上下文拼接）；**拒绝整篇一个向量** |
| 向量 Vector | 每块一个 | embedding + 分块内 FTS 索引，双通道并存 |

**向量化粒度规划**：
- **L0 整实体向量（默认，P0）**：DEAL/ACCOUNT/CONTACT/PRODUCT/PRICE_LIST/PERSON/ORGANIZATION/KNOWLEDGE/UNSTRUCTURED_ASSET 每粒子 L0 向量，覆盖 80% 检索场景。
- **L1 属性字段向量（P2）**：ACCOUNT.industry/region/size、PRODUCT.category、CONTACT.title 等字段级向量，支持"找行业=金融且规模>500 的客户"。
- **L2 AI 派生属性向量（P1，AI 原生最有价值增量）**：对 `payload.ai.attributes[]` 逐条 embedding + 标 `axis` 码——`revenue_forecast`/`win_probability_adjusted`/`customer_health_score`/`stuck_warning`/`churn_risk` 可语义检索（"找到有高流失风险的客户"），而非只能精确匹配。

## 2. 写时三钩子（ensureEmbedding / ensureTsVector / ontologySync）

```
ensureEmbedding(entity)  → 生成/更新向量（幂等：content_hash 判变，内容没变不重算，省额度稳一致）
ensureTsVector(entity)   → 生成/更新 FTS 索引（中文走 zhparser，需 ADD MAPPING 否则静默空向量）
ontologySync(entity)     → 挂接本体：类型校验、关系边更新、词汇表登记
```

**三钩子规范**：
- **ensureEmbedding 幂等**：以 `content_hash` 判变化（内容没变不重算）；测试用**确定性哈希 mock**（SHA-256 → 归一化向量，同文本同向量），零外部依赖可跑全量测试。
- **ensureTsVector 双写**：向量与 FTS 同时维护（降级链主路 FTS 预过滤 + 池内向量排序）——**只写向量不写 FTS，降级时无路可退**。中文 FTS 必配 zhparser `ADD MAPPING FOR n,v,a,i,e,l,j,o,c,p WITH simple`（幂等片段防空向量）。
- **ontologySync 三件事**：
  1. **类型校验**：实体类型在受控词汇表内（DEAL/ACCOUNT/CONTACT/PRODUCT/PRICE_LIST/PERSON/ORGANIZATION/KNOWLEDGE/UNSTRUCTURED_ASSET），不在 → 拒绝或标记。
  2. **关系边更新**：引用型字段（record-reference/actor-reference）写入 → 自动 UPCREATE 受控谓词边（`belongs_to`/`owned_by`/`has_employee`/`priced_by`…，`edge_source='auto'` 高置信）；弱关联 → `edge_source='auto_weak'`（低置信，≤0.6 默认 needsReview 不自动入图——幻觉边治理）。
  3. **词汇表登记**：枚举型/业务专有名词写入时登记为 `semanticEntities`（中英双写，进 L1 图种子）——"商机/赢率/公海/工商抬头/business-title"等自动成为 L1 检索种子。

**属性类型对 ontologySync 的三种处理模式**：
| 属性类型 | 模式 |
|---|---|
| 引用型（record-reference/actor-reference） | 自动创建/更新受控谓词边（本体图核心建边源） |
| 枚举型（select/multi-select/boolean/rating） | 自动登记词汇表（L1 图种子） |
| 时变型（interaction/timestamp/date） | 不直接建边，触发派生属性更新（lastActivityAt/nextActionAt） |

**评估/指标数据走写时钩子**：AI 派生属性值（revenue_forecast 等）写时 → ensureEmbedding + ensureTsVector（Token-业务对账进 L2）；指标快照（漏斗转化率/回款逾期率）写时 → 同样入钩子（否则评估数据长期"覆盖率 0、纯 FTS"降级态）。

## 3. 覆盖率监控 + backfill + 边界

**监控信号**：
- `embedding 覆盖率 = 有向量的实体 / 应向量化的实体`，**目标 ≥80%**（低于即告警，L2 检索质量硬指标）。覆盖实体集合**包含指标快照/AI 属性值**（否则评估知识进不了 L2）。
- 一致性对账：定期抽查"实体数 vs 向量数 vs 本体边数"三者匹配；**失配 = 写时钩子有漏，修钩子不修数据**。

**backfill 补偿**：历史存量跑 `backfill-embedding` 一次性补齐（**补存量，不是常态路径**）；写时失败 → **落监控标记**（不静默吞掉，供补偿识别），fail-open 不阻断业务写入。

**反模式规避**：① 两阶段架构（先写库后批跑）→ 拒绝；② 只写向量不写 FTS → 拒绝（双写）；③ 记忆写了不向量化 → 拒绝（L2 检索召回为空）；④ 换 embedding 模型维度 → 配迁移清毒（零向量 DELETE + 降维，维度不匹配毒化检索）；⑤ 模型名写死 → 导出为环境变量 + router 对齐。

## 4. 外部数据源写时校验（§5ter.12 落地）

CRM 对外接数据源双向实证，写时钩子扩展：
- **标讯源（大单网）**：订阅推送的招标信息入库 → 写时钩子自动建边 `sourcedFrom`（auto_weak）+ 词汇登记（行业词/区域词）→ 触发线索筛选。写时校验：标讯字段 schema 校验（关键词/区域/匹配度）。
- **企查查/爱企查工商校验**：ACCOUNT.business_title 写库时 → 写时钩子调工商校验（统一信用代码/法人/地址）→ 校验结果写 `business_verified`（C_Compliance AI 属性，规则+AI 确认 0.9）。校验失败 → 落标记（auto_weak 边 `sourcedFrom` 待人工确认），不静默吞。
- 此为 `ai-ontology-vector-build` 在 CRM 的**写时校验实证**（外部数据源联动，非事后批处理）。

## 5. 边界确认

- ✅ 本技能管"写库即构建"（向量/本体/词汇自动成型）；❌ 不覆盖 embedding 模型选型对比、检索排序算法（属 ai-context-layering 通道实现）。
- ✅ 粒子 schema 是本体事实来源（01 文档：9 粒子类型 + 受控谓词）；本技能不重新发明本体。
- ✅ 记忆粒子写入同走写时钩子（ai-memory-lifecycle 管"该不该存"，本技能管"存了怎么自动可检索"）。

## 自检清单（对照 SKILL）

- [x] 写入即构建三钩子齐备；ensureEmbedding 幂等（content_hash）
- [x] 文档走三层管道（文档→分块→向量），块带 source_ref + 顺序号
- [x] 向量与 FTS 双通道并存，FTS 预过滤可用；中文 zhparser ADD MAPPING
- [x] 本体随写而生（类型校验/边更新/词汇登记），无独立后建图
- [x] 去重以身份锚判重（DEAL_ID/ACCOUNT_ID/SKU），重复写 = 更新不新建，保留版本与审计
- [x] embedding 覆盖率 ≥80% 有监控；存量有 backfill；写时失败落监控标记
- [x] L2（AI 属性向量化）已规划（P1，按能力轴可语义检索）
- [x] 边来源区分 auto / auto_weak（弱关联需确认，幻觉边治理）
- [x] 状态机字段（DEAL.stage）不参与语义检索，只做精确过滤
- [x] 外部数据源（标讯/企查查）写时校验已落地（写时钩子扩展）
- [x] 评估数据（AI 派生属性/指标快照）走写时钩子，覆盖率监控覆盖评估域

## 6. 实现状态（阶段 1，2026-08-25 补）

> 与总体架构设计 §8 互证。本文档「写库即构建」核心立场阶段 1 已落地；AGE 未用（§8.3-②），覆盖率监控/backfill 与 RAG 推理为阶段 2 增强。

- [x] **写时三钩子落地**：`src/ontology/hooks.js` — `ensureEmbedding`（幂等，哈希判变）、`ensureTsVector`（FTS 双写）、`ontologySync`（受控边 + 词汇登记）；`src/ontology/embedding.js`、`src/ontology/vocabulary.js`。
- [x] **向量维度 384**：`db/schema.sql:19` `embedding vector(384)`，与选型文档一致。
- [x] **外部数据源写时校验**：写时钩子扩展点已预留（§4 / 自检清单「标讯/企查查写时校验已落地」）。
- [ ] **偏差② AGE 未用**：本体走 `edges` 受控谓词表 + pgvector，非 AGE 图顶点/边（§8.3-②）。
- [ ] **覆盖率监控 + backfill（§3）**：阶段 1 仅写时三钩子，无独立覆盖率看板/backfill 任务；阶段 2 增强。
- [ ] **RAG≥5 / 本体推理规则（§5）**：阶段 2 记忆三构件 + 检索通道落地时充实。