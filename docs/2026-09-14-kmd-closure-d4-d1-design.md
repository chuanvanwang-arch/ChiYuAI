# KMD 闭环三项 🔴 修复设计（D4 / D1，D6 运营项单列）

> 来源：2026-09-13/14 夜间 KMD 探针复验（🔴 D1/D4/D6 均未解决）。
> 流程：brainstorming（本设计）→ writing-plans → 实现。未批准不写实现代码。
> 范围：仅修复 D4（业务结果回流）、D1（知识真向量）；D6 为治理流程缺口，单走运营审批节奏，不在本代码发布包内。

## 0. 现状与根因（已用源码+库证据钉死）

| 探针 | 现状证据 | 根因 | 性质 |
|---|---|---|---|
| D4 outcome 真实性 | `outcome_total=4` 全 `seed_script`；`real_auto=0` | `crm.outcome_event_map` 仅 1 条启用规则（`decision.contract_sign→won`），绝大多数真实业务结果无映射；`lookupDecisionByDeal` 靠 `involved_entities` 反查，决策未挂 deal_id 则跳过 | 代码接线未激活 |
| D1 知识向量真伪 | 69/69 知识行 `hashVector` 伪向量，`real_vector_pct=0` | `knowledge/embed.js:13` 直接 `import { hashVector }` 默认 hash；`EMBEDDING_PROVIDER` 生产未设 `model`；`llm/embeddingClient.js` 已存在但未启用 | 代码接线未激活 |
| D6 校准积压 | `PENDING=70`，`pending_age_days=8.8` | 补丁产出/审批端点正常，无人消费 | 治理缺口（运营） |

## 1. 设计目标与成功判据

- **D4**：生产出现 `real_auto > 0`（真实业务事件经 `outcome_event_map` 落 `decision_outcome`），且映射覆盖主要业务结果拓扑。
- **D1**：生产知识行 `real_vector_pct > 0`（真模型向量占比显著上升），语义检索不再等于随机。
- **D6**：运营侧建立审批消费节奏，积压不再单调增长（本设计不负责代码，仅交付运营 runbook）。

---

## 2. 任务一：D4 业务结果回流闭环接通

### 2.1 设计

**改动点（file:line 锚定）**
1. `db/migration-*.sql` 或 seed：扩展 `crm.outcome_event_map` 启用规则，覆盖真实业务事件拓扑——
   - `decision.contract_sign` → `won`（已有，保留）
   - `decision.deal-advance` → `stage`（matcher `deal_id_field:'deal_id'`，按目标阶段写结果）
   - `decision.quote-create` → `quoted`
   - `decision.payment-received`（如存在）/ `payment.paid` → `paid`
   - 每条规则带 `outcome_type` + `matcher`（优先 `decision_id_field`，回退 `deal_id_field`）。
2. `src/decision/outcomeIngester.js:26` `lookupDecisionByDeal` 依赖 `decision.involved_entities @> [{id:dealId}]`：
   - 在决策写入路径（`src/decision/decisionRepo.js` / `executor.js`）确保 `involved_entities` 含关联 `CRM_DEAL` 的 id；
   - 或在 ingester 增加按 `deal_id` 反查 `crm_deal`→`decision_id` 的备用通道（不依赖 involved_entities 完整性）。
3. 补一条只读探针（或在 `kmd-closure-probe.mjs` D4 内增加子项）验证：业务事件**确实**经事件总线 emit 到 `decision` 域（防止"规则齐了但事件没发"的二次假绿）。

**方案权衡**
| 选项 | 内容 | 取舍 |
|---|---|---|
| A（推荐） | 扩 `outcome_event_map` 拓扑 + 决策写时挂 `involved_entities(deal_id)` + 事件发射探针 | 闭环真正接通；代价=逐事件核对映射语义，避免误写错误 outcome_type |
| B | 仅扩映射不修关联键 | 部分事件仍 skip（lookup 失败），D4 不净 |

### 2.2 生命契约

```contract-yaml
- task: "D4 业务结果回流闭环接通"
  agent: decision-agent
  skills: [method-decision-enrich, data-particle-read, data-particle-create]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "生产 crm.outcome_event_map 启用规则≥4 条覆盖 contract_sign/deal-advance/quote-create/payment；kmd 探针 D4 real_auto>0；且事件发射子项 PASS（业务事件确经 decision 域总线 emit）"
```

**契约说明**：本任务由 `decision-agent` 承接，调用 `method-decision-enrich`/`data-particle-read`/`data-particle-create`，读取 `decision-agent`+`review-gate` 记忆（L1–L2，≤5 跳）；成功标准为映射≥4 条、探针 D4 `real_auto>0` 且事件发射验证 PASS。

---

## 3. 任务二：D1 知识真向量接入

### 3.1 设计

**改动点（file:line 锚定）**
1. `src/knowledge/embed.js:13`：将 `import { hashVector }` 改为 `import { embedText }`，调用处由 `hashVector(text)` 改为 `await embedText(text)`；当 `EMBEDDING_PROVIDER!=='model'` 时 `embedText` 自动降级 hash（已具备，零行为破坏）。
2. `docker-compose.yml` / `.env`（crm-app）：新增 `EMBEDDING_PROVIDER=model` + `EMBEDDING_API_KEY=...`（SiliconFlow embedding，与 `llm/embeddingClient.js` 对齐）；维度须与 knowledge 表向量列一致（参考 `decisionRepo.js` 已迁 `vector(1024)`——**先核对 knowledge 表 embedding 列维度**，不一致先 ALTER）。
3. 回填脚本 `scripts/backfill-knowledge-embeddings.mjs`：对 `crm` 知识表 69 行重算 `embedText` 真向量并 upsert（幂等，可重跑）；跑前先小批试 3 行验证维度/延迟/成本。
4. 探针 D1 已就绪（`real_vector_pct`），回填后复跑即验证。

**方案权衡**
| 选项 | 内容 | 取舍 |
|---|---|---|
| A（推荐） | embed.js 改调 embedText + compose 设 provider/key + 回填 69 行 | 真语义检索生效；代价=API 成本/延迟 + 须核对维度 |
| B | 仅回填不改写路径 | 新写入仍伪向量，D1 复发（不推荐） |

### 3.2 生命契约

```contract-yaml
- task: "D1 知识真向量接入"
  agent: decision-agent
  skills: [method-decision-enrich, data-particle-read, data-particle-create]
  memory: [decision-agent, review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "生产 crm 知识表 real_vector_pct>50%（真模型向量占比显著上升）；kmd 探针 D1 由 🔴 转 🟢；语义检索 top-k 不再等于随机"
```

**契约说明**：本任务由 `decision-agent` 承接，调用 `method-decision-enrich`/`data-particle-read`/`data-particle-create`，读取 `decision-agent`+`review-gate` 记忆；成功标准为知识表真向量占比>50%、探针 D1 转绿、语义检索非随机。

---

## 4. 任务三（运营项，非代码发布）：D6 校准积压消费

**不写实现代码**，仅交付运营 runbook（HITL 铁律，禁自动 apply）：
- 管理员待办/工作台接入"校准补丁审阅"入口：复用 `POST /api/calibration/patches/<id>/approve` 与 `/api/my-todo/tune-approve`（端点已存在，`src/http/calibrationRouter.js`）。
- 建立每日/每周审批节奏；分批安全上限：每批≤10、高风险 knob（如 `routingStrategy`/`threshold` 类）须二级复核。
- 夜报 `calibration-triage` 清单已分级（HIGH/MEDIUM/LOW），作消项依据。
- **禁止**任何自动 apply 路径。

---

## 5. 实施与发布约束

- 写操作经决策第 0 闸；绝对禁 DELETE；迁移类改动按空库验证流程。
- D4/D1 同包发布（随下次 `deploy-remote.py release`），发布前 `git stash -u` 净化工作树、发布后 `git stash pop`。
- 发布后复跑 `kmd-closure-probe.mjs` 验证 D4/D1 转绿；D6 不在代码发布范围。
- 维度对齐：knowledge 表 embedding 列维度须先核对（参考 `decisionRepo.js` `vector(1024)`），避免回填维度冲突。

## 6. 风险与回滚

- D1 嵌入失败：事件总线 `embedding-provider-degraded` 留痕（已有），`embedText` 自动降级 hash → 永不阻断业务写；回填脚本失败可重跑（幂等）。
- D4 映射错误：误写 outcome_type 会污染决策结果 → 实施前逐事件核对语义；ingester 单规则失败隔离（已具备）。
- 回滚：D4 映射回退 SQL；D1 撤销 `EMBEDDING_PROVIDER` 即回 hash。
