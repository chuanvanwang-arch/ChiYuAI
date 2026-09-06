# 认知驱动决策子系统 · 统一设计 v3 实施计划（writing-plans 产物）

> 配套设计稿：`docs/2026-09-02-cognitive-decision-unified-design.md`（五文档合并重评版）
> 状态：设计已合并定稿；本计划为其落地分解。
> **HARD-GATE**：P-1(T2/T3) 属修复既有运行时缺陷，按 bug 修复豁免可逐项报批实施；P0–P3 为新增能力，未批准不写实现代码。
> 设计重评关键修正（2026-09-02 复验代码）：S2/S3 零命中是**数据真空**（非代码缺陷），S4 是**确定性代码缺陷**，S7 是**声明缺陷**；F4 双轨已由并行会话闭合。

---

## 0. 落地总原则

1. **先分清病因再动手**：代码缺陷改代码，数据真空灌原料，不可混淆（否则会出现"改了 S2 代码却仍 0 命中"的假修复）。
2. **生产生效 ≠ 回归全绿**：每个 Task 完成必须 `information_schema` 直查生产库确认（阶段 A 教训：2424 全绿但 `memory_log.entity_id` 列不存在）。
3. **测试隔离**：新增/改测试后跑 `npm run audit:isolation`；`crm.decision` 被 9 张表外键引用，按范围删必须"子表→主表"。
4. **每 Task 一 commit**；推进不等提问。

---

## 1. 落地主轴（重排后，依赖关系自下而上）

```
P-1  供给层代码缺陷复通（T2 S4 动作名 / T3 S7 声明）   ← 改代码即有效，可立即做
  │      （仅此两项；S2/S3 移出，因改代码无效）
  ▼
P0   L0 原料层生效（授权跑 migrate + 真实业务流量）     ← 让 S2/S3 有数据可查；S4 修复后治理维已恢复（supplied 5/7），P0 灌原料后到 7/7
  │      （A1 触发 events / A2 跑迁移 / A3 修记忆锚点 / A4 backfill）
  ▼
P1   结构层（D 层 9 列 + 八要素物化 + 九尺子评分器 8 确定性+1 LLM）
  ▼
P2   闭环回流（三通道 + 后见之明 + 偏差校验 + 处方审批 + Q(Skill,T)）
  ▼
P3   知识沉淀与作用域（Knowledge 注入 + Skill 三层作用域 + 可插拔 embedding + 记忆分层）
```

> **唯一顺位死锁**：P0 第一动作 = 授权跑生产迁移 + 产生首批 `events`/`assertions`/`decision_rule`。在此之前 P1 的九尺子、P2 的闭环均无信号源。

---

## 2. P-1 · 供给层代码缺陷复通（bug 修复豁免）

### T2 — 修 S4 动作名错配（确定性缺陷）

**现象**：`assembleContextV2.js:88` S4 retriever 调 `ruleEngine.check('CRM_DEAL','context-assembly', ctx.trigger_context, …)`。
**根因（双重错位）**：
- 装配期语义是"供给治理边界清单"，却调了写闸 `check`（拦截用），且动作名 `'context-assembly'` 与规则集 `match_type='CRM_DEAL.advance'` 不匹配 → 恒不命中；
- `patch` 位传 `ctx.trigger_context`（无 `from/to` 键），即便动作名改对也跑不出 `stage_forward_only` 语义。

**修复方案（已落地 · 实际实现 `evaluateRules`）**：
1. `src/ruleEngine.js` 新增 `evaluateRules(type, action, patch)`：只读遍历适用规则并 `rule.check`，返回 `{applied:[{code,ok,reasons}], ok}`；**不落 `rule_hit`**（与写闸 `check()` 区分，避免重复留痕）。
2. `src/context/assembleContextV2.js` S4 retriever 改为 `evaluateRules('CRM_DEAL','advance', ctx.trigger_context||{})`，`items` 映射为 `{rule:code, result: ok?'ok':'blocked', reasons}`，治理维以"已校验"信号供给。
3. 保留 `check()` 在原写闸链路（createDecision 推进阶段）不动——S4 仅供给、不拦截。

**验收（真实库实证）**：
- 在 `crm.decision_rule` 造 1 条启用规则（如 `stage_forward_only`，`match_type='CRM_DEAL.advance'`）；
- 跑一次装配 → S4 `status='hit'`，`governance` 维 `supplied=true`；
- `rule_hit` 表在"真实推进"时有行（blocked 与否取决于真实 patch）。

### T3 — 修 S7 声明缺陷（校验器被顶包）

**现象**：`supplySpec.js:23` S7 `serves_dims = 全 7 维`，但装配期恒 `{items:[]}`（`assembleContextV2.js:107`）。`computeDimCoverage` 已改"仅 runtime hit 才算 supplied"→ 不污染 `supplied` 判定，但 `validateSupplySpec` 因 S7 顶着全 7 维，**会掩盖其它操作未覆盖的真空洞**（删 S3 仍报 valid）。

**修复方案**：
1. `supplySpec.js:23` S7 `serves_dims` 改为 `[]`（或仅声明它产生的 `PROV-O` 溯源边，不占用语义维）。
2. `validateSupplySpec` 的"7 维全覆盖"校验改为：**7 维须由至少一个实体操作（S1–S6）覆盖**，S7 的溯源边不算维度覆盖。

**验收（真实库实证）**：
- 单测 + 运行校验：删除 S3 后 `validateSupplySpec` 必须报 `semantics 维未被任何操作供给`；
- 快照 `ops[]` 中 S7 不再伪装覆盖语义维。

> **P-1 验收边界（修正）**：T2/T3 后 `supplied_dims` 峰值由 **4/7 → 5/7**——identity / structure / operational_state / time_config / **governance（S4 修复后恢复供给）** 五维可得。
> 剩余 **semantics / decision_history** 两维恒 false（S2/S3 数据真空），需 P0 灌 L0 原料才会到 7/7。
> **Q1 门槛 5/7 现可达**：治理维恢复后常规 CRM_DEAL 决策 `supplied≥5` → Q1 由 warn 转 pass（部分达成）；要 7/7 全维通过仍须 P0。切勿因"semantics/decision_history 仍空"误判 P-1 "失败"。

---

## 3. P0 · L0 原料层生效（需授权：生产写操作）

> 阶段 A 代码已由并行会话实施并通过回归（A1 `recordEvent.js` / A2 `db/migrate.js:72-80` / A3 `timelineSource.js` / A4 `backfill.js`）。

| Task | 内容 | 剩余动作（待授权） | 验收 |
|---|---|---|---|
| A1 | 交互统一落 `events` | 触发真实业务动作（拜访/报价/合同推进） | `events` 连续有行且 `raw_text` 非空 |
| A2 | `memory_log.entity_id` 迁移 | **`PGDATABASE=crm_native node db/migrate.js`（待授权）** | `information_schema` 直查列存在 |
| A3 | 故事线 memory 源锚点改 `entity_id` | 依赖 A2 生效 | memory 源有数据 |
| A4 | `backfillAttribute` | 依赖 A1 有原料 | 选 1–2 属性从 raw 重算验证 |

**授权请求（生产写操作）**：
1. 跑 `PGDATABASE=crm_native node db/migrate.js`（幂等，`ADD COLUMN IF NOT EXISTS`）；
2. 触发首批真实业务动作以产生 `events`（及随之的 `assertions` / `decision_rule` 种子）。

---

## 4. P1–P3 · 结构层 / 闭环 / 知识沉淀

（完整 Task 表见统一设计 §11.3–§11.5。本计划不重复，仅标注依赖与死锁。）

- **P1 B1**：`decision` 9 列迁移（`migrate.js` 独立 ALTER 段，不可进 `CREATE TABLE IF NOT EXISTS`）。
- **P1 B3**：九尺子评分器 `rulerScore.js`，**8 项确定性 + 1 项 LLM 默认关**；无证据计 0 不假填充（反 BG-04）。
- **P2 C4**：处方审批链 = 第 0 闸 + HITL，AI 不直接改生产配置。
- **P3 D1**：Knowledge 注入（`methodology_dimension` 34 行）须在 P-1 双轨闭合后接 Pre 装配。

---

## 5. 待批准事项清单

| # | 事项 | 类型 | 建议 |
|---|---|---|---|
| 1 | 批准本实施计划 + 统一设计 v3 | 设计闸门 | **✔ 已批准（2026-09-02 全批）** |
| 2 | P-1 T2/T3 按 bug 修复豁免逐项实施 | 代码（豁免） | **✔ 已执行**：evaluateRules 新增 + S4/S7 修复，supplySpec/assemble/S4 共 20+6 单测全绿 |
| 3 | 授权跑 `db/migrate.js`（生产迁移） | 生产写操作 | **✔ 已执行**：A2 entity_id / F4 phase 列已落生产库（探针验证通过） |
| 4 | 触发首批真实业务动作产生 `events` | 生产写操作 | 需明确授权 |
| 5 | P0 之后进入 P1（decision 9 列 + 九尺子） | 代码（新增） | 待 P0 验收后批准 |

---

## 6. 执行检查清单（每 Task 收尾）

- [ ] 代码改动 + 对应测试（含真实库实证用例）
- [ ] `npm run audit:isolation`（或 `--strict` 供 CI）通过
- [ ] 定时器注册即预热（若有新增 setInterval）
- [ ] `information_schema` 直查生产库确认列/表/行已动（仅 P0/P1 迁移类）
- [ ] 每 Task 一 commit，commit 署名含 `Co-Authored-By: WorkBuddy <workbuddy@tencent.com>`

---

## 7. 执行记录（2026-09-02 · 用户"全批"后落地）

### 7.1 已落地（P-1 + P0-①）

| 项 | 改动文件 | 内容 | 验证 |
|---|---|---|---|
| P0-① 迁移 | `db/migrate.js`（并行会话已含 A2/F4 ALTER） | 跑 `PGDATABASE=crm_native node db/migrate.js`（幂等，未跑 `--seed`） | 探针确认 `crm.memory_log.entity_id`、`crm.decision_context_snapshot.phase` 列已存在；`events/assertions/decision_rule/rule_hit` 仍 0 行（需 P0-② 真实流量） |
| T2 S4 修复 | `src/ruleEngine.js` + `src/context/assembleContextV2.js` | 新增 `evaluateRules()`（只读评估，不落 `rule_hit`）；S4 retriever 改为 `evaluateRules('CRM_DEAL','advance', trigger_context)` | `test/rule/ruleEngine.test.js` 6/6（含 3 条新增断言：动作名对齐 / 回退检测 / 旧动作名恒空）；`test/context/assembleContextV2.test.js` 17/17 |
| T3 S7 修复 | `src/context/supplySpec.js` | S7 `serves_dims` 由 `全 7 维` 改为 `[]`（溯源是落库后 PROV-O 边，非装配期事实供给；7 维已由 S1–S6 覆盖） | `test/context/supplySpec.test.js` 9/9（validateSupplySpec / dimCoverageFromOps 仍 valid） |

### 7.2 关键修正（与原计划偏差）

- **supplied_dims 峰值 4/7 → 5/7**：原计划误判 S4 修复后治理维仍空；实测 `evaluateRules` 对 CRM_DEAL.advance 恒返回适用规则（builtin `stage_forward_only`），故治理维恢复供给 → Q1 门槛 5/7 现可达（常规决策 Q1 转 pass）。
- **实现名 `evaluateRules` 取代计划的 `applicableRules`**：返回评估结果（含 `ok`/`reasons`）而非仅列规则，治理违规可呈现为 `result:'blocked'`，信息更完整；仍保持只读、无 `rule_hit` 副作用。
- **未触碰并行会话占用的 F4 文件**：`autonomyEngine.js` / `decisionRepo.js` 的 F4 双轨闭合由并行会话负责，P-1 仅改 `assembleContextV2.js` 的 S4 段（与 F4 改动不重叠）。

### 7.2b P1 已落地（B1 + B3 评分器，2026-09-02 12:5x）

| 项 | 改动文件 | 内容 | 验证 |
|---|---|---|---|
| **B1 迁移** | `db/migrate.js` | P1 向后兼容段：`decision` 9 列 `ADD COLUMN IF NOT EXISTS`；`decision_scenario` 5 列（**保留既有 `stage`**，另加 `stage_code`）；`CREATE TABLE decision_rubric_score`；`decision_precedent_rel.negative_precedent`；`config_store` 4 键（rubric-thresholds/weights/llm/retro-config） | 探针 `tmp/_verify_p1.mjs`：21 项全 ✅；`crm.decision` 总列数 **42**（基线 33 + 新增 9）；config_store 4 键已写 |
| **B3 评分器** | `src/decision/rubricScorer.js`（新） | `scoreDecision()`（9 尺子 0–4，8 确定性 + clarity 可 LLM 默认关，config 驱动阈值/权重/焦点/LLM 开关）+ `persistRubric(pool)` + `loadRubricConfig(pool)` | `test/decision/rubricScorer.test.js` **16/16** 全绿 |
| **B3 L3 实证** | `tmp/_verify_p1_l3.mjs` | 真实决策行 → `scoreDecision` → `persistRubric`（事务 BEGIN/ROLLBACK，零残留） | 评分跑通（level=poor）；写入 9 行 `decision_rubric_score` + 更新 `decision.rubric`；回滚后 0 残留 |
| **L3 捕获的缺陷** | `src/decision/rubricScorer.js:236` | 原 `UPDATE crm.decision SET rubric=$1 WHERE id=$2` 误用 `id`（`decision` 表主键是 `decision_id`）→ 对真实库报 `column "id" does not exist`；mock pool 单测不校验 SQL 故漏检，L3 探针捕获并修正为 `WHERE decision_id=$2` | 修正后 L3 重跑全绿 |

**关键修正**：
- **config_store 生产库缺主键**（"CREATE IF NOT EXISTS 不补约束"陷阱）：原 `ON CONFLICT (key) DO NOTHING` 报 `no unique constraint`；改逐行 `WHERE NOT EXISTS` 幂等写入（仅插缺失键）。
- **B3 评分器与 DB 解耦**：`scoreDecision` 为纯函数（任意 ctx 对象），`persistRubric` 单独落库；单测用 mock pool 验 SQL 形，L3 探针验真实 schema 正确性——正是这种分层让 mock 漏检的 `id` 列错误被 L3 捕获。

### 7.2c B2 + B4 已落地（八要素物化 + 场景回填，2026-09-02 13:0x）

| 项 | 改动文件 | 内容 | 验证 |
|---|---|---|---|
| **B2 八要素物化** | `src/decision/decisionRepo.js` | ① `createDecision` 解构新增 8 要素入参；② 新增 `export function materializeEightElements`（fail-open 草稿：intent 未传则从 `rationale`/`trigger_context.query` 生成弱草稿，其余诚实留 null 不假填充 BG-04）；③ INSERT 加 8 列（intent/assumptions/inference/viewpoints/implications/risk_register/stop_loss/concept_refs）；④ 落库即评分联动 `scoreDecision`+`persistRubric`（fail-open，经 `pool`） | `test/decision/materializeEightElements.test.js` **6/6**；`test/decision/` 全量 **183 测试全绿**（含 createDecision 集成）；`tmp/_verify_b2_l3.mjs`（test 库）createDecision 真实落库 intent 非空 + rubric 物化 + decision_rubric_score 9 行 + 清理零残留 ✅ |
| **B4 场景回填** | `tmp/_b4_backfill.mjs`（生产执行） | 12 场景 UPDATE：`required_dims` 按 §7.2 初值表填 `[{dim,on_missing:'warn'}]`；`focus_elements`/`focus_rulers` 按 §7.2（八要素列 key + 九尺子 key，×1.5）；`rubric_pass_line=0.5`（业务）/null（治理）；`retro_required` 业务且 tier∈{HIGH,LEAD}→true | 执行日志：8 业务场景 req=2~4 非空、4 治理场景 []；`required_dims` 非空率 100% |

**关键修正**：
- **`required_dims` 格式（致命细节）**：设计 §7.2 表写简写 `identity, structure,...`，但消费端 `sevenDimensions/engine.js:4`（`required：{dim,on_missing} 数组`）+ `decisionScenario.js:96`（`normalized.push({dim,on_missing})`）单一事实源定为 `[{dim,on_missing}]`。回填脚本严格按此格式；若误填 `[dim]` 则 `toDimMap` 视为非法 → 七维拦截恒空转（验收失败）。
- **B2 与并行会话占用文件的冲突规避**：仅改解构段 + INSERT 段 + 新增 `materializeEightElements` 函数 + rubric 联动块，与并行会话 F4 单轨（pre_context 冻结）改动不重叠；多次 Edit 因并行会话"modified since read"拦截，重读后精确追加成功。

### 7.2d B5 + B6 + B7 已落地（故事三构件 + 监控台真实化 + 自检卡，2026-09-02 13:1x）

| 项 | 改动文件 | 内容 | 验证 |
|---|---|---|---|
| **B7 自检卡读模型** | `src/decision/selfcheck.js`（新） | `buildSelfCheck(decision)` 纯函数：7 问映射八要素+rubric（intent/conditions_evaluated+assumptions/inference.chain/viewpoints/implications/risk_register+stop_loss/rubric.scores），返回 pass/warn/fail + 证据指针；JSONB 列经 asObj/asArr 安全解析（防假防御） | `test/decision/selfcheck.test.js` **6/6** 全绿（含空决策诚实 fail、字符串 JSONB 解析） |
| **B5 故事三构件** | `src/decision/storyBuilder.js`（新） | `buildStory(decision, opts)` 纯函数：输出 characters/dynamics/trajectory，每条带 element_ref（八要素字段）+ dim_ref（7 维）；外部 timeline 注入 trajectory（A3 生效后的真实轨迹） | 同文件单测覆盖（含视角持有方/推论/后果/风险/止损节点） |
| **B6 后端路由** | `src/http/decisionReadRoutes.js`（新） + `src/http/routes.js`（挂载） | 注册 4 真实路由：`/api/decision/:id/selfcheck`、`/api/decision/:id/rubric`（九尺子明细+config）、`/api/decision/:id/thinking`（八要素+story）、`/api/monitor/scenario-chips`（场景真实聚合：决策数+平均 rubric+required_dims）；routes.js 顶部 import + 末尾 `registerDecisionReadRoutes(app)` 两行挂载（最小冲突面） | `node --check` 三模块语法 OK；import 路径修正（resolveMe→auth.js、scopeOf→tenantScope.js、loadRubricConfig 已导出）；L3 实证见下 |
| **B6 前端真实化** | `src/web/sales-decision-monitor.html` | `</body>` 前新增「决策三卡」面板：decision_id 输入 → 并行 fetch 三真实 API，渲染自检卡 7 问（pass/warn/fail 走 `.acc` token 语义色）/评分卡（加权总分+9 尺子明细）/思维卡（八要素+故事三构件计数）；色值全走 token，复用 common.css `.dn-block`/`.acc` 类，零硬编码 | 受控页已链 `/portal/tokens.css`+`/portal/common.css`（铁律达标）；无演示数据死区 |
| **B5/B7 L3 实证** | `tmp/_verify_b5b7_l3.mjs` | test 库事务插入完整八要素决策 → buildSelfCheck + buildStory → ROLLBACK | selfcheck summary `{pass:7,warn:0,fail:0,overall:pass}`；story characters=3/dynamics=5/trajectory=2（含 stop_loss）；回滚 0 残留 ✅ |

**冲突规避**：
- `src/http/routes.js` 被并行会话占用；B6 仅做**两行最小改动**（顶部 1 import + 末尾 1 register 调用），且挂载调用封装在独立新模块 `decisionReadRoutes.js`（零冲突），不触碰并行会话的既有路由块。末尾 Edit 因并行会话"modified since read"拦截一次，重读后精确挂载成功。
- `src/web/sales-decision-monitor.html` **不在**并行会话占用清单（git status 未列 src/web），可安全改。

### 7.2e P0-② 已落地（思维要素拆解 · 真实流量验证方案，2026-09-02 13:2x）

用户批准 P0-② 真实流量验证方案，指定场景「线索是否升级为机会」完成思维要素拆解。

| 项 | 改动文件 | 内容 | 验证 |
|---|---|---|---|
| **思维要素拆解（单一事实源）** | `src/decision/thinkingTemplates.js`（新） | `getThinkingTemplate()` + `buildPreContext()`：把 `LEAD_FOLLOW_UP`（S1 线索发掘的升级判定）拆解到 8 个思维要素（intent/assumptions/inference/viewpoints/implications/risk_register/stop_loss/concept_refs），每个要素含 guiding_question / prompts / expected_fields / source_dims（七维供给源）/ methodology（BANT·MEDDICC·OPP_MATRIX·ROLE_MAP·RISK_TRADEOFF·STOP_LOSS）/ ruler_keys（九尺子）/ example；未注册场景返回通用 8 要素兜底（不静默） | `test/decision/thinkingTemplate.test.js` **6/6**（8 要素序齐 / 字段全 / S1 聚焦与 §7.2 一致 / focus 标注 / 通用兜底 / pre_context 透传） |
| **写前骨架 API** | `src/http/decisionReadRoutes.js` | 新增 `GET /api/decision/pre-context?scenario_id=&entities=&query`（设计 §8.3/§10，此前未实现）：读 `decision_scenario` 配置 + 可选 `assembleContextV2({phase:'pre',persist:false})` 七维供给，返回 8 要素填空骨架 + 焦点/必填维/止损；fail-open（装配失败仅 trace 留痕） | `node --check` OK；挂载点已在 B6 落地（`registerDecisionReadRoutes`） |
| **L3 真实流量实证** | `tmp/_verify_p0_lead_l3.mjs`（test 库） | 以「XX制造」工博会线索升级决策，跑 `buildPreContext` → `createDecision`（八要素物化 + 自动九尺子评分 + 7×7 装配 + events/provenance）→ `buildSelfCheck` + `buildStory` + `scoreDecision`；事务/主键精确清理零残留 | **P0-② L3 PASS**：八要素全物化；`decision_rubric_score` 9 行；story chars/dyn/traj=3/6/2 含 stop_loss 节点；selfcheck 5 pass / 2 warn / 0 fail（warn 为诚实信号：探针读回漏选 `conditions_evaluated`→Q2；反方 stance 文案未命中正则→Q4，模板 prompt 已引导修正） |

**关键判定**：
- 思维要素拆解是 Pre 阶段「写前骨架草稿」的单一事实源，与 `decision_scenario`（focus/required_dims 配置）正交、可独立版本化与单测，不进 schema（与 `rubricSpec.js` 同源模式）。
- 拆解验证证明：八要素物化列 + 自动九尺子评分 + 7 问自检 + 故事三构件 在「真实业务决策内容」驱动下全链路贯通 —— P0-② 真实流量入口（`createDecision`）已可承载「线索升级为机会」类决策，无需造假数据。
- 生产库 `LEAD_FOLLOW_UP` 的 `focus_elements`/`required_dims` 已由 B4 回填（§7.2c 实证），故生产环境 `buildPreContext` 的 `focus` 标注真实生效；test 库未跑 B4 故该探针 `焦点要素` 显示为空（预期，不属缺陷）。

### 7.2f P2 · 闭环回流（C1–C5，本批次落地）

**单一事实源**：`src/decision/closureLoop.js`（新）；HTTP 写/读端点挂在 `src/http/decisionReadRoutes.js`（已 `routes.js:2872` 挂载）；迁移 `db/migrate.js`（P2 段：新建 `decision_skill_quality` + `config_store['hindsight-deviation']`）。

**C1 复盘三通道分流（§9.2）**：`submitRetro(decisionId, payload)` →
- RETRO provenance（append-only，`entry_type='RETRO'`，经 `provenance.trackEntry` 链式校验和）承载 A/B/C/D/G 事实类；
- **C2** falsified 假设 → `decision_precedent_rel` 反面先例（`negative_precedent=true`，self-reference 因 FK 要求合法 decision UUID）；同时留痕 `NEGATIVE_PRECEDENT` provenance；
- **C3′** 记忆影响 → `memory_log` append-only（`kind='RETRO_MEMORY_IMPACT'`，原记忆 payload 不动）；
- **C3** 知识产出 → `calibration_patch` PENDING（按决策 scenario 正确归属；**绝不自动 apply，须经第0闸 + HITL 批准**，由既有 `calibrationRouter` 完成）。越界 knob（如 `focus_rulers`）诚实 `rejected`，不假填充。
- 纯函数 `routeRetroChannels` / `mapKnowledgeUpdateToPatch` 可单测。

**C2 后见之明（§9.3）**：`reinforceMemory` / `rewriteMemory` → `memory_log` 追加 `HINDSIGHT_REINFORCE` / `HINDSIGHT_REWRITE`（原记忆行不覆盖、不加 tag_history 列——`memory_log` 无该列，改用 payload.tag 标注）。

**C3 证实性偏差校验（§9.4）**：`recordHindsightBaseline` + `hindsightCheck` → 写 `HINDSIGHT_CHECK` provenance（baseline/review 两阶段），算 `hindsight_delta`；`deviationRate(windowDays)` 统计窗口内 `|delta|>threshold` 占比；超阈值（`config_store['hindsight-deviation']`，出厂 0.3/0.3）生成 C3 `strictness` 处方 PENDING。

**C5 复合效应（§9.5）**：`decision_skill_quality` 时间序列表（`sampleQSkillT` 幂等采样）；`qSkillComposite(90d)` 每 (scenario,skill) 取 q0/qN，提升不足 ε=0.05 ⇒ `stagnant`（反假绿判据：90 天无改善=名义存在实际空转）；`registerQSkillSampler` 定时器注册即预热（启动播种一次现有 rubric 序列，6h 周期），失败仅 `recordFailure` 不阻断。

**修复的缺陷**：`qSkillComposite` 原用混合大小写别名 `qN`/`tN`，Postgres 折叠为小写 `qn`/`tn`，`x.qN` 读到 `undefined`→`Number(undefined)=NaN`→JSON 序列化为 `null`（假象）。已统一小写别名，与 `q0` 一致。

**验收（L3 真实库实证 `tmp/_verify_p2_l3.mjs`，test 库事务清理零残留）**：
- C1 RETRO + C2 NEGATIVE_PRECEDENT provenance 落库；`decision_precedent_rel.negative_precedent=true`（1 行）；
- C3′ `RETRO_MEMORY_IMPACT` 落 `memory_log`；C3 `calibration_patch` PENDING（knob=required_dims，按 scenario 归属，AI 未 apply）；
- 后见之明 `HINDSIGHT_REINFORCE`/`HINDSIGHT_REWRITE` 各 1 行；
- 偏差校验 delta=-0.4、rate=1.0、超阈值触发 `strictness` 处方 PENDING；
- Q(Skill,T) 采样落入 `decision_skill_quality`，`qSkillComposite` 返回 `qN=0.82`（修复后正确，非 null）。
- **全部零残留**。

**单测**：`test/decision/closureLoop.test.js`（7 例，纯函数）+ L3 实证；回归 `thinkingTemplate/selfcheck/materializeEightElements/storyBuilder/rubricScorer` 共 **41/41 全绿**。

### 7.2g P3 · 知识沉淀与作用域（D1–D4，全落地）

**设计依据**：v3 §3.5（Knowledge/Skill 分离与三层作用域）/ §11.5-D1–D4。授权：用户「继续完成 P3 知识沉淀」。

**D1 Knowledge 注入（双轨闭合）** — `src/knowledge/methodologyInjection.js`（新）：
- `getConceptChecklist(scenarioId, pool)`：按 `decision_scenario.methodology_ids` 过滤 `methodology_dimension` 34 行 → 概念清单 `{methodology_id,dim_key,label,weight,required}` + 按方法论聚合 summary。这是 Pre 装配的 Knowledge 载体（消除 N4/F2：此前 34 行零消费点）。
- `enrichConceptRefs(conceptRefs, mdIndex, pool)`：落库时回查同一张表补全 canonical `weight/required/label` → Pre 清单与落库 `concept_refs` 同源（D1 的 T4 双轨消除前置条件达成）。
- 接入：`decisionReadRoutes` 的 `GET /api/decision/pre-context` 现返回 `concept_checklist`；`decisionRepo.createDecision` 在物化后调 `enrichConceptRefs`（import 失败仅 emit trace + recordFailure，不阻断主写）。

**D2 Skill 三层作用域** — `src/skill/skillScope.js`（新）+ `db/migrate.js` 建 `crm.skill_scope`：
- `resolveEffectiveSkills(rows, scope)`（纯函数，user>workspace>system 优先级归并，null-owner=全局生效）；
- `effectiveSkillSet(pool, scope)` / `setSkillEnabled(pool, …)` / `promoteSkill(pool, {skill, from:'user', to, by})`（推广路径写 `promoted_from` 溯源 + emit trace）；
- 接入：`GET /api/skill/scope`（生效集合）、`POST /api/skill/scope/promote`（写操作，登录 + trace，HITL 风格）。

**D3 可插拔 embedding** — `src/knowledge/embed.js`（新）：
- `embedText(text, {provider})`：`hash` 默认（确定性，复用 `ontology/embedding.js`）；`siliconflow` 未配置 → 降级 `hash` + `degraded:true` + emit trace + recordFailure（反假绿，不静默、不假填充语义）；
- `conceptVector(methodologyId, dimKey, label)`（V3 概念向量，维度 384）；`compareRecall(a,b)`（A/B 召回 Jaccard 对比，切换 provider 前必跑）；
- 接入：`GET /api/knowledge/concept-vectors?scenario_id=`（只读暴露，便于 A/B）。

**D4 记忆分层 + 30 天蒸馏** — `src/memory/distillScheduler.js`（新）：
- 蒸馏逻辑 `distillMemory`（memoryLog.js，append-only 标记 distilled/archived，不删）已存在；本模块补**定时触发 + 注册即预热**（`registerDistillationTimer`，30 天周期，`unref` 不阻进程退出，失败 recordFailure）；`memory_log.layer`（L-User/L-Workspace/L-Org）分层列已就绪。
- 接入：`registerDecisionReadRoutes` 末尾注册（与 P2 `registerQSkillSampler` 并列）。

**验收（L3 真实库实证 `tmp/_verify_p3_l3.mjs`，test 库精确子表→主表清理零残留）**：
- D1：`getConceptChecklist('OPP_QUALIFY')` 返回 14 行（来自 methodology_dimension）；`createDecision` 落库 `concept_refs` 被 enrich 为 `weight=1, required=true`（双轨闭合实证）；
- D2：system 启用 + user→workspace 推广后 `effectiveSkillSet` 返回 `scope_level=workspace, promoted_from=user`；
- D3：hash 确定性非降级、siliconflow 降级留痕、conceptVector 384 维、compareRecall Jaccard=1/3；
- D4：定时器注册成功；事务内 `distillMemory` 标记老行、ROLLBACK 后 `distilled=false` 计数不变（零残留）。
- **全部零残留**（已二次核验 test 库无探针 orphan）。

**单测**：`methodologyInjection.test.js`(4) / `skillScope.test.js`(6) / `embed.test.js`(8) / `distillScheduler.test.js`(3) = 21 例纯函数 + L3 实证；回归既有 decision 测试 **62/62 全绿**。

### 7.3 仍未解（唯一遗留：P0-② 真实流量）

- **P0-② 真实业务流量**：`events`/`assertions`/`decision_rule` 仍 0 行。治理原则下**不造假数据**；需真实拜访/报价/合同推进动作经系统产生。schema 已就绪，捕获路径待真实流量验证。这也正是 B5 故事 `trajectory` 真实时间线、B6 场景 chip「平均 rubric」从空变实的唯一钥匙。
- **P-1 + P0-① + P1(B1–B7) + P2(C1–C5) + P3(D1–D4) 至此全部落地**（认知决策子系统 v3 闭环完整）。

### 7.4 提交说明（沙箱无私有库凭证）

本会话改动了 `src/ruleEngine.js` / `src/context/assembleContextV2.js` / `src/context/supplySpec.js` / `src/decision/rubricScorer.js`（新）/ `test/rule/ruleEngine.test.js` / `test/decision/rubricScorer.test.js`（新）/ `db/migrate.js` / 文档；探针 `tmp/_verify_p1.mjs` / `tmp/_verify_p1_l3.mjs` / `tmp/_verify_migrate.mjs`。
**AI 不 commit**；请用户在本地按功能线拆分提交（每 Task 一 commit），署名含 `Co-Authored-By: WorkBuddy <workbuddy@tencent.com>`。
