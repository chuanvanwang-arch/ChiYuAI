# 决策事件主轴详细设计（落地实现层 · 数据库 / 7 决策场景 / 方法论存放 / 与粒子知识记忆关系）

- 日期：2026-08-25
- 状态：详细设计稿（承接 `spec-decision-event-spine-2026-08-25.md` 概要，把"决策主轴"落到可建表、可配置、可运行的实现层）
- 方法论依据：本详细设计**不新增** ai-* 能力，仅把决策主轴的概要（Schema/粒子族/四平面职责）深化为数据库 DDL、决策场景配置、方法论实体、引擎算法、与粒子/知识/记忆的数据血缘。10 大能力基线固定不变（用户硬规则）。
- 业务基线：§5quater.2（B2B 7 阶段决策）、§5quater.3（5 类输入）、§5quater.4（6 方法论）、`spec-decision-event-spine-2026-08-25.md`、`2026-08-25-01-ai-particle-system-design.md`（粒子底座风格）、`2026-08-25-05-ai-memory-lifecycle.md`（记忆三构件）。
- 底座约定：单库 PostgreSQL（与 PDM/P2P 同款）+ pgvector + Apache AGE。DECISION 粒子族采用**专业化投影表**（与 `approval_flow`/`memory_log` 同风格，非通用 `particles` JSONB 大表），每张表同时作为 AGE 图顶点。

---

## 0. 核心立场

决策主轴 = 把"为什么这样判"从隐式散落提升为**一等公民、可建表、可检索、可反哺**的对象。

本详细设计回答四件事：
1. **7 个决策点是什么** → 7 个内置 `decision_scenario` 配置（对应 §5quater.2 B2B 七阶段），每个有触发/输入/方法论/输出/分级/自主策略。
2. **决策事件数据库怎么建** → §2 完整 DDL（8 张表 + 索引 + 向量列）。
3. **方法论（BANT/MEDDICC…）怎么存** → §3 结构化实体（模板 + 维度项），非自由文本。
4. **与粒子/知识/记忆什么关系** → §4 数据血缘（事实源 vs 判断源、写时向量=先例、记忆三构件对应）。

---

## 1. 7 个决策点（decision_scenario 详细配置）

### 1.1 决策点是"可配置"的，不是写死 7 个
`decision_scenario` 是配置表，**不限定只能 7 个**。§5quater.2 的 B2B 七阶段给出**第一批 7 个内置决策场景**——这是行业刚需的全集，后续可加（如 `DISCOUNT_OVER_20%`、`CONTRACT_RENEWAL`）。

### 1.2 通用结构（每个 scenario 必须声明）
```
scenario_id         唯一标识
stage               所属 B2B 阶段（一~七）
trigger             检测器：什么业务状态变化→产 decision_required（字段/阈值/事件源）
methodology_ids     绑定的方法论模板（BANT/MEDDICC…）
eval_dimensions     评估维度模板 → 决定 decision.conditions_evaluated 的结构
default_tier        默认风险分级（LEAD/NORMAL/HIGH），可被 business_tier_config 覆盖
autonomous_allowed  是否允许 agent 自主（高风险场景默认 false）
dispositions        允许的处置五态子集
```

### 1.3 七阶段 → 七场景映射（落地配置）

| # | scenario_id | 阶段 | 核心决策 | 触发（detector） | 绑定方法论 | 评估维度（conditions 模板） | 默认 tier | 自主策略 |
|---|---|---|---|---|---|---|---|---|
| 1 | `LEAD_FOLLOW_UP` | 一、线索 | 跟/升级机会/放弃/培育 | 新线索入库；N 天无跟进事件 | BANT、MEDDICC(初筛)、打分模型 | 行业匹配/规模/预算周期/痛点/对接人级别/我方适配 | LEAD | 低分→自动转培育（autonomous）；无预算决策人→不升级（规则） |
| 2 | `OPP_QUALIFY` | 二、机会评估 | 真机会/伪需求/陪标/加资源 | 商机 stage 进入"评估"；赢率<阈值 | MEDDICC、机会矩阵、角色地图 | 痛点来源/预算获批/决策链完整/竞品进展/赢率/毛利 | NORMAL | 伪需求/陪标→agent 建议弃（需 HITL 确认）；加资源→HITL |
| 3 | `SOLUTION_VALUE` | 三、方案价值 | 方案取舍/定制边界/差异化 | 方案产出前；客户提定制需求 | 价值主张对齐、成本毛利权衡 | 刚需覆盖/定制成本>毛利/选型打分/差异化绑定指标 | NORMAL | 过度定制→agent 拒（规则）；其余 HITL |
| 4 | `QUOTE_PRICING` | 四、商务报价 | 三级报价/折扣换条件/让步边界/付款风险/合同风险 | 报价单提交；折扣>授权；条款变更 | 三级报价纪律、折扣换条件、红线校验 | 开盘/目标/底价对比/折扣对等条件/付款比例/维保/验收量化/毛利红线 | HIGH | 折扣≤授权且≥底价→autonomous；超授权→HITL 特批闸 |
| 5 | `SIGN_RISK` | 五、签单前风险 | 风险可控/卡住策略（等/对撞/降价/退出） | 反对者出现/需求变更/交付人力不足/验收模糊 | 风险收益权衡、止损点 | 反对者级别/需求变更量/交付人力/验收标准/预算获批/经营状况 | HIGH | 高风险→agent 出止损建议（HITL 决）；低→autonomous 预警 |
| 6 | `POST_CONTRACT` | 六、签约后 | 需求变更(内外)/回款策略/续约 | 合同外需求；回款逾期；到期前 N 天 | 回款回路、续约价值评估 | 合同范围/实施负荷/逾期原因/续约价值/满意度 | NORMAL | 合同内免费→autonomous；合同外增补足→HITL；回款逾期→autonomous 催收事件 |
| 7 | `LOSS_REVIEW` | 七、丢单复盘 | 放弃/长期孵化 | 商机 stage=丢单 | Coach 情报优先、事实vs话术 | 未来1-2年预算/痛点长期性/内部支持者/战略价值 | LEAD | 长期价值→autonomous 转孵化触达；萎缩→autonomous 减投 |

### 1.4 配置示例行（LEAD_FOLLOW_UP）
```sql
INSERT INTO decision_scenario (scenario_id, stage, description, trigger, methodology_ids, default_tier, autonomous_allowed, eval_dimensions)
VALUES ('LEAD_FOLLOW_UP', '一、线索', '新线索跟不跟/升级/放弃/培育',
  '{"source":"particle_event","entity":"DEAL","cond":{"stage":"lead","event":"created"}}'::jsonb,
  ARRAY['BANT','MEDDICC','LEAD_SCORE'],
  'LEAD', TRUE,
  '[{"cond":"industry_fit","label":"行业匹配","weight":0.2},{"cond":"budget_cycle","label":"预算周期","weight":0.2},{"cond":"pain_clear","label":"痛点清晰","weight":0.2},{"cond":"contact_level","label":"对接人级别","weight":0.2},{"cond":"our_fit","label":"我方适配","weight":0.2}]'::jsonb);
```

---

## 2. 决策事件数据库设计（DDL）

### 2.1 底座约定
- 单 PostgreSQL 库；`pgvector` 扩展提供 `vector` 类型与余弦检索；`age` 扩展提供图（DECISION 顶点 + 受控谓词边）。
- 表命名与现有粒子底座一致（snake_case，专业化投影表，非通用 `particles` 大表）。
- `embedding` 维度与平台 embedding 模型对齐（PDM/P2P 同款；若 `l2Retrieval.ts` 为 1024 则改为 `vector(1024)`，本文按 1536 占位并标注）。

### 2.2 完整 DDL
```sql
-- ============ 结构定义层（L1 knowledge） ============

-- 决策场景配置（可配置，不写死 7 个）
CREATE TABLE decision_scenario (
  scenario_id        TEXT PRIMARY KEY,
  stage              TEXT NOT NULL,
  description        TEXT,
  trigger            JSONB NOT NULL,     -- 检测器：触发 decision_required 的业务状态
  methodology_ids    TEXT[] NOT NULL DEFAULT '{}',
  eval_dimensions    JSONB NOT NULL,     -- conditions_evaluated 模板
  default_tier       TEXT NOT NULL DEFAULT 'NORMAL',  -- LEAD/NORMAL/HIGH
  autonomous_allowed BOOLEAN NOT NULL DEFAULT FALSE,
  dispositions       TEXT[] NOT NULL DEFAULT '{APPROVE,REJECT,ESCALATE,OVERRIDE,EXCEPTION}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 方法论模板（BANT/MEDDICC/机会矩阵/角色地图/风险权衡/止损点/事实vs话术）
CREATE TABLE methodology_template (
  methodology_id     TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT,
  structure         JSONB NOT NULL      -- 框架结构（含维度定义）
);

-- 方法论维度项（可加权、可校验的清单，如 MEDDICC 的 M-E-D-D-I-C-C）
CREATE TABLE methodology_dimension (
  methodology_id    TEXT NOT NULL REFERENCES methodology_template,
  dim_key          TEXT NOT NULL,
  label            TEXT NOT NULL,
  weight           REAL NOT NULL DEFAULT 1.0,
  required         BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (methodology_id, dim_key)
);

-- 政策版本（不可变快照；决策锚定当时版本）
CREATE TABLE policy_version (
  policy_version_id TEXT PRIMARY KEY,    -- e.g. PRICING_POLICY@v3
  policy_id        TEXT NOT NULL,
  version          INT NOT NULL,
  effective_from   TIMESTAMPTZ NOT NULL,
  effective_to     TIMESTAMPTZ,
  snapshot         JSONB NOT NULL,       -- 当时完整政策内容（不可变）
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 判断源主轴（L1 DECISION 粒子族） ============

-- 决策事件本体（7 点全部物化）
CREATE TABLE decision (
  decision_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scenario_id           TEXT NOT NULL REFERENCES decision_scenario,
  trigger_context       JSONB NOT NULL,  -- ① 为什么走到拍板：业务状态快照
  involved_entities     JSONB NOT NULL,  -- ② 涉及谁：[{type,id}]（customer/opportunity/contract/policy/role）
  conditions_evaluated  JSONB NOT NULL,  -- ③ 条件满足/不满足：[{cond,met,value,expected}]
  effective_policy_version TEXT REFERENCES policy_version,  -- ④ 当时生效政策版本（非当前）
  disposition           TEXT NOT NULL,   -- ⑤ APPROVE/REJECT/ESCALATE/OVERRIDE/EXCEPTION
  decider_type          TEXT NOT NULL,   -- AUTONOMOUS_AGENT / HUMAN
  decider_id            TEXT,
  decider_role          TEXT,
  rationale             TEXT NOT NULL,   -- ⑥ 真实理由
  referenced_precedents JSONB,           -- ⑦ 参考先例：[decision_id]
  business_tier         TEXT NOT NULL,   -- LEAD/NORMAL/HIGH（派生或显式）
  outcome               TEXT,            -- REVERSED/UPHELD/CHURNED（闭环喂反馈）
  feedback_link         UUID,
  state                 TEXT NOT NULL DEFAULT 'REQUIRED',  -- REQUIRED/AUTONOMOUS/HUMAN/CONFIRMED/REVERSED
  embedding             vector(1536),    -- 先例向量（context摘要+disposition+conditions 嵌入）
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at            TIMESTAMPTZ
);

-- 先例关系（PG 关系表保证查询性能；同步在 AGE 建 REFERENCED_PRECEDENT 边）
CREATE TABLE decision_precedent_rel (
  decision_id   UUID NOT NULL REFERENCES decision,
  precedent_id  UUID NOT NULL REFERENCES decision,
  similarity    REAL,
  PRIMARY KEY (decision_id, precedent_id)
);

-- ============ 业务分级配置（DEAL = 客户维 × 项目维，配置定义） ============
CREATE TABLE business_tier_config (
  dimension         TEXT NOT NULL,       -- 'customer' / 'project'
  dimension_value   TEXT NOT NULL,
  tier              TEXT NOT NULL,       -- LEAD/NORMAL/HIGH
  PRIMARY KEY (dimension, dimension_value)
);
-- tier 计算：tier = 两维取 "高风险优先"（HIGH>NORMAL>LEAD），引擎只读配置不硬编码

-- ============ L2 事件持久化（decision 事件域） ============
CREATE TABLE decision_event (
  event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type  TEXT NOT NULL,            -- decision_required/autonomous/made/escalated/reversed
  decision_id UUID REFERENCES decision,
  scenario_id TEXT,
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============ 索引 ============
CREATE INDEX idx_decision_scenario   ON decision(scenario_id);
CREATE INDEX idx_decision_tier       ON decision(business_tier);
CREATE INDEX idx_decision_state      ON decision(state);
CREATE INDEX idx_decision_policy     ON decision(effective_policy_version);
CREATE INDEX idx_decision_event_type ON decision_event(event_type, created_at);
CREATE INDEX idx_decision_precedent  ON decision_precedent_rel(precedent_id);
-- 先例语义检索（ivfflat 余弦，需先 INSERT 足量数据后调参）
CREATE INDEX idx_decision_embedding  ON decision USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

### 2.3 AGE 图顶点与边（与业务粒子连接）
```cypher
-- 每个 decision 是 AGE 顶点；业务粒子（DEAL/ACCOUNT/CONTRACT...）已是顶点
CREATE (:Decision {decision_id, scenario_id, disposition, business_tier});
-- 受控谓词边
(decision)-[:DECIDED_ON]->(entity)                       -- 决策作用于哪个业务对象
(decision)-[:REFERENCED_PRECEDENT]->(decision)           -- 参考的过往先例
(decision)-[:GOVERNED_BY]->(policy_version)              -- 锚定当时政策版本
(decision_scenario)-[:TRIGGERS]->(decision)
```

---

## 3. 方法论（BANT/MEDDICC…）如何存放

### 3.1 关键判据：方法论是"结构定义"，不是自由文本、不是业务实例
- 落在 **L1 knowledge** 层（与 §5quater.4、01 文档 §3 知识分层一致：结构定义→L1）。
- 两张表：`methodology_template`（框架）+ `methodology_dimension`（可加权的维度清单）。**不存成一段 prompt 文本**——结构化才能被引擎逐项评估、加权、校验覆盖度。

### 3.2 存放内容与示例（MEDDICC）
```sql
INSERT INTO methodology_template (methodology_id, name, description, structure)
VALUES ('MEDDICC','MEDDICC 机会真实性校验',
  '判断机会真实性、识别决策链','{"dimensions":["M","E","D","D","I","C","C"]}'::jsonb);

INSERT INTO methodology_dimension (methodology_id, dim_key, label, weight, required) VALUES
 ('MEDDICC','M','Metrics 量化收益',1.0,TRUE),
 ('MEDDICC','E','Economic Buyer 经济决策者',1.0,TRUE),
 ('MEDDICC','D1','Decision Criteria 决策标准',0.8,TRUE),
 ('MEDDICC','D2','Decision Process 决策流程',0.8,TRUE),
 ('MEDDICC','I','Identified Pain 明确痛点',1.0,TRUE),
 ('MEDDICC','C1','Champion 内线支持者',1.0,TRUE),
 ('MEDDICC','C2','Competition 竞争格局',0.6,FALSE);
```
> 其余 BANT、机会矩阵、角色地图、风险权衡、止损点、事实vs话术同理建表。事实vs话术 不是评估框架而是**优先级规则**（Coach 真实情报优先于客户口头意向），以 `structure` 中的 `priority_rule` 字段表达。

### 3.3 引擎加载流程（决策时如何消费方法论）
```
decision_required(scenario_id)
  → 查 decision_scenario.methodology_ids
  → 加载每个 methodology_template + 其 dimensions
  → 生成 conditions_evaluated 模板（每个 dimension 一项，met 初始 NULL）
  → 引擎/人逐项评估（调用对应 Action 取业务数据填充 value/expected/met）
  → 加权求 "methodology_score" → 作为自主/升级 + disposition 的依据之一
  → 结果写回 decision.conditions_evaluated
```
**与粒子的关系**：methodology 是 L1 知识实体（无业务实例）；它的"实例应用" = 一次 `decision`（带 conditions_evaluated）。方法论本身不参与 L2C 业务流，只在"需要拍板"时被引擎装载。

---

## 4. 决策与粒子 / 知识 / 记忆的关系（数据血缘）

### 4.1 与业务粒子（事实源 vs 判断源）
| 维度 | 业务粒子（DEAL/ACCOUNT/…） | DECISION 粒子 |
|---|---|---|
| 角色 | 事实源：回答"是什么" | 判断源：回答"为什么这样判、据哪版政策、参考哪些先例" |
| 关系 | — | `decided_on` 边指向业务粒子（一个决策作用于哪些对象） |
| 不变量 | 关键状态变更必须有 decision 指向（写通道第 0 闸） | 每个 decision 是独立不可变记录 |

### 4.2 与知识（写时向量 = 先例）
- `decision.embedding` 在写入时由"context 摘要 + disposition + conditions 嵌入"生成（pgvector）。
- 这是 **先例库**：后续同 scenario 的 `decision_required` → 引擎 `SELECT ... ORDER BY embedding <=> $qvec LIMIT k` 拉高相似先例 → 计算置信度 → 决定是否自主。
- 与 `ai-ontology-vector-build`：决策写时向量与业务粒子写时向量**共用一个 embedding 通道**，但决策向量带 `scenario_id` 过滤（只在同场景先例里检索，避免跨域误匹配）。

### 4.3 与记忆三构件（ai-memory-lifecycle §3.1）
| 记忆构件 | 决策主轴的对应落点 |
|---|---|
| **粒子图**（What+Who+关系） | DECISION 是 AGE 顶点；`decided_on`/`referenced_precedent`/`governed_by` 边构成"判断图谱" |
| **快照**（state 版本化） | `decision` 表本身即不可变快照（无 update 关键字段，或 append-only 风格）；`policy_version` 也是快照——决策锚定当时政策，保证"可复现当时为什么这么判" |
| **事件/推理**（When+Why 时序因果） | `decision_event` 是 L2 事件流；`rationale` + `referenced_precedents` = Why，同时进 `memory_log`（append-only，L-Workspace 层，topic=`decision:<id>`）供跨会话引用 |

> 决策 = 先例 = L2 memory 实例数据（§5 记忆文档 §3 分类）。先例衰减：低频/被推翻（outcome=REVERSED）的先例在 30 天蒸馏时降权（`decision_precedent_rel.similarity` 折扣，非删除）。

### 4.4 数据血缘图
```
            ┌─────────────── 业务粒子（事实源）───────────────┐
            │  DEAL / ACCOUNT / CONTRACT / QUOTE / PAYMENT   │
            └───────────────────┬───────────────────────────┘
                                 │ decided_on（AGE 边）
                                 ▼
        ┌─────────── DECISION 粒子（判断源主轴）───────────┐
        │ decision（7 点全字段 + embedding 先例向量）        │
        │   ├─ governed_by ──► policy_version（不可变快照）  │
        │   └─ referenced_precedent ──► decision（先例链）   │
        └───────┬───────────────────────┬───────────────────┘
                │ 写时向量               │ 事件
                ▼                        ▼
        ┌─ 先例知识库(pgvector) ─┐   ┌─ decision_event(L2) + memory_log(append-only) ─┐
        │ 语义检索供自主引擎      │   │ Why(rationle+precedents) 进记忆三构件          │
        └───────────┬───────────┘   └──────────────────┬───────────────────────────┘
                    │                                    │
                    └──────────► 自主决策引擎(检索先例+置信度) ◄── business_tier_config(DEAL=c×p)
                                          │
                                          ▼
                              决策质量监控(§3.10) + 反馈回路(outcome→per-tier 指标)
```

---

## 5. 自主决策引擎运行细节（算法级）

### 5.1 输入/输出
- 输入：`decision_required(scenario_id, trigger_context, involved_entities)`
- 输出：`decision_autonomous`（带 referenced_precedents + rationale）或 `decision_escalated`（HITL）

### 5.2 步骤
```
1. scenario = 查 decision_scenario(scenario_id)
2. tier = 计算 business_tier（查 business_tier_config 两维取高风险优先；无配置用 scenario.default_tier）
3. IF tier == HIGH AND NOT scenario.autonomous_allowed:
       → decision_escalated（HITL，不检索先例）
4. ELSE:
       a. 加载方法论 → 生成 conditions 模板 → 填充（调用 Action 取业务数据）
       b. 先例检索：embedding <=> $qvec（同 scenario_id 过滤）LIMIT k
       c. 置信度 = f(先例相似度均值, 先例覆盖度, methodology_score, 条件全满足)
       d. IF 置信度 ≥ 阈值(如 0.8) AND tier ∈ {LEAD,NORMAL}:
            → decision_autonomous（agent 拍板，强制填 referenced_precedents + rationale）
          ELSE:
            → decision_escalated（HITL，附"引擎建议 disposition + 依据先例"供人参考）
5. 物化 decision + 写时向量 + decision_event + memory_log；outcome 后续由反馈回路回填
```

### 5.3 置信度公式（建议，可配置）
```
confidence = 0.4 * avg_similarity(top_k_precedents)
           + 0.3 * coverage_ratio(matched_precedents / total)
           + 0.2 * methodology_score
           + 0.1 * all_conditions_met_flag
```
> 阈值、权重均在配置（不硬编码）。`EXCEPTION`（例外放行）无论置信度如何**强制 HITL + 上级 role 背书 + 审计高亮**。

---

## 6. 与概要 spec 的衔接（细化了哪些落地点）
| 概要 spec 节 | 本详细设计细化 |
|---|---|
| §1 Schema 13 字段 | §1 七场景 + §2.2 `decision` DDL 落地字段 |
| §2 DECISION 粒子族 | §2.2 4 张实现表（decision/scenario/policy_version/precedent_rel） |
| §3.3 自主引擎 | §5 算法步骤 + 置信度公式 |
| §3.5 第 0 闸 | §4.1 不变量 + §5 step1 入口 |
| §2.3 决策=先例 | §4.2 写时向量 + 语义检索；§4.3 记忆三构件对应 |
| §5 文档影响 | 本详细设计是 01/05/07/08/09/10 修订时的**实现基线** |

---

## 7. 验收判据（可代码验证）
- [ ] `decision_scenario` 表至少 7 行（对应 §1.3 七阶段），每行有 trigger/methodology_ids/eval_dimensions。
- [ ] `decision` 表 DDL 含 §2.2 全部字段；`effective_policy_version` FK 指向不可变 `policy_version`（插入时快照，禁止 UPDATE snapshot）。
- [ ] `methodology_template` + `methodology_dimension` 至少 7 行（BANT/MEDDICC/机会矩阵/角色地图/风险权衡/止损点/事实vs话术），MEDDICC 7 维齐备。
- [ ] 一切业务写（含 HITL 审批通过）关联 `decision_id`，无 decision_id 被第 0 闸拒绝。
- [ ] 先例检索走 pgvector `embedding <=> $qvec`，同 scenario 过滤；置信度公式可配置。
- [ ] 自主决策强制带 referenced_precedents + rationale，否则降级 HITL；EXCEPTION 强制 HITL+上级背书+审计高亮。
- [ ] 决策进 `memory_log`（append-only，topic=decision:<id>）；30 天蒸馏降权被推翻先例。
- [ ] 10 大 ai-* 能力基线未变，本设计仅为其增实现级挂点。

---

## 8. 不做的事（YAGNI）
- **不把方法论存成自由文本 prompt**：必须结构化（template+dimension）才能逐项评估。
- **不引入图/语义推理引擎（Semantica 类）**：先例检索走既有 pgvector + AGE，零额外依赖。
- **不硬编码业务分级与阈值**：DEAL=c×p 分级、置信度阈值、权重全在配置表。
- **不新增第 11 个 ai-* 能力**：决策主轴是既有能力 + DECISION 粒子族/事件域的深化实现。
