# method-* 真 SKILL 步骤落地设计（契约回路真实性收口）

- 日期：2026-09-01
- 关联：`docs/2026-09-01-retro-agent-wiring-design.md`（D1–D8 已收口，矩阵 5 行全绿）
- 性质：架构级改动（新增执行步骤 + 2 个专用 action）→ 须 brainstorming 批准后再实现
- 不变量：零 schema 迁移；阈值走配置（禁硬编码）；禁 DELETE；单一事实源

---

## §0 结论表

| 项 | 现状 | 目标 |
|---|---|---|
| quote-engine | 降级单步 `data-particle-read` | 真读取商机 → `crm-quote-create` 出 A/B 报价 → j_judge 复核毛利 |
| review-gate | 降级单步 `data-particle-read` | 读取商机/客户 → `crm-review-gate-evaluate` 四维+双闸（仅 pass 落 review_gate_passed） |
| followup-agent | 降级单步 `data-particle-read` | 读取跟进计划 → `crm-followup-schedule` 生成跟进/超时转人工 |
| intake-router | route_only episode（D7 已闭环） | **不补方法步骤**（路由即其执行，已由 `route_only=true` episode 满足契约） |

核心判定：**矩阵 `skill_ok=true` 当前是"声明已接但方法论未真执行"的假绿**——4 个体确实"跑了"，但只做了粒子读取，方法论本身（报价测算/四维审查/跟进调度）从未执行。`stepsMissing:true` 已如实标记降级，只是看板未呈现该维度。

---

## §1 现象

- 工作台契约矩阵 5 行 `skill_ok=true`，但 `decision-retro` 之外的 4 个体（quote/review/followup/intake）运行期 episode 的 `stepsMissing` 恒为 `true`（`registry.js:95`）。
- 复盘任务（`decision-retrospective`）因 D8 已补 `steps[]`（`seed.js:156-167`）→ 真执行（rule 汇总 + j_judge 处方）。其余 4 体未补 → 恒降级。

## §2 根因（file:line 证据）

1. **`seed.js:26-102` `METHOD_SKILLS` 15 个条目只有 `slug/description/rbac_roles`，无 `steps` 字段** → `registerSkill(skill)`（`seed.js:104`）注入内存 Map 的 def 无 `steps`。
2. `executeSkill`（`registry.js:72-73`）：`hasSteps = Array.isArray(skill.steps) && skill.steps.length>0` → 对 method-* 恒 `false` → 降级步骤 `[{action:'data-particle-read',decision:'rule'}]`，返回 `stepsMissing:!hasSteps`（`registry.js:95`）。
3. **降级不阻断**：`registry.js:73` 用单步粒子读取兜底，保证编排不中断、降级可观测（不伪造合规——调用方据 `stepsMissing` 可区分"已调用"与"已落地"）。
4. 矩阵只按 episode 存在性判 `skill_ok`（`contractMonitor.js`），**不读 `stepsMissing`** → 降级态仍显示绿 → 假绿。

## §3 执行契约（现状能力边界，决定设计约束）

- `executeSkill`（`registry.js:75-92`）：
  - **rule 步**：`actionExecutor.dispatch(step.action, step.params, ctx)`（`registry.js:78`），须为已注册 action；失败即 `throw` 中断。
  - **推理步**（j_judge/o_optimize/f_forecast）：`llmThink(task,{step,prior})`（`registry.js:83`）；`llmThink` 由 `agentLoop.js:72` 自动取 `config_store('llm')`，配置后真实推理，未配置降级为 `[降级推理] LLM 不可用`。
  - **无步骤间条件门控**：步骤严格串行，无"上一步 verdict 决定下一步是否执行"的机制。
- 可用 action（`src/action/seed-actions.js`）：`data-particle-read`(read)、`crm-account-360`(read)、`crm-deal-advance`(write,autoDecision)、`crm-quote-create`(write,autoDecision)、`crm-quote-submit/activate`、`crm-contract-create`、`crm-review-gate-approve`(write,autoDecision,emit `review_gate_passed`)、`crm-asset-attach`(write)、`decision-retrospective`(read)。

## §4 四个 agent 的真实步骤规格（证据自 SKILL.md 决策步骤）

### 4.1 quote-engine（报价测算，B）
SKILL.md 决策步骤：配置读取 → 成本测算 → 毛利测算(A/B) → 复核留痕。
- Step1 `rule` `data-particle-read` `{type:'CRM_DEAL'}` — 配置/需求读取（前置）
- Step2 `rule` `crm-quote-create` `{deal_id, margin_target}` (autoDecision) — 成本×毛利实时测算、生成 A/B 方案、写 decision 事件（第0闸 autoDecision 满足）
- Step3 `j_judge` — 复核 A/B 毛利支撑、标注达标/触红线、输出建议
- **复用现有 action，无需新建**。风险：`crm-quote-create` 是否真算毛利/A-B（其实现未核）→ 见 §8。

### 4.2 review-gate（评审把关，D）
SKILL.md 决策步骤：接收审查 → 加载数据 → 四维审查 → 双闸门判定 → 专家介入 → 决策留痕。
- Step1 `rule` `crm-account-360` `{account_id}` + `data-particle-read` `{type:'CRM_DEAL'}` — 加载商机/合同数据
- Step2 `rule` `crm-review-gate-evaluate` `{deal_id, dims:[功能,架构,安全,合规]}` (write,autoDecision) — **内部**做四维审查+双闸门：pass→emit `review_gate_passed`；block→返回 `{pass:false, findings}`；**始终**写评审 decision 事件（留痕，第0闸）
- **需新建 action `crm-review-gate-evaluate`**（理由：无步骤间条件门控，`registry.js:75-92` 无法表达"不通过不批准"；放入单一 action 内部分支是唯一忠实且可审计路径）。

### 4.3 followup-agent（跟进催办）
SKILL.md 决策步骤：自动跟进 → 节点催办 → 超时转人工。
- Step1 `rule` `data-particle-read` `{type:['CRM_DEAL','CRM_CONTACT']}` — 读取跟进计划/节点
- Step2 `rule` `crm-followup-schedule` `{deal_id, threshold_ref:'behavior-standard'}` (write,autoDecision) — 依据配置阈值生成跟进任务/超时转人工标记、写 decision 事件
- **需新建 action `crm-followup-schedule`**（现有 action 无"生成跟进任务"，`crm-asset-attach` 仅挂附件，语义不符）。

### 4.4 intake-router（维持 route_only，不补方法步骤）
- 路由即其执行，已在 `scheduler.recordIntakeRouteEpisode`（`route_only=true`，D7）闭环；契约 `skill_ok` 由该 episode 满足。
- **不补 `method-intake-routing` 的 `steps[]`**——补了会与 `scheduler.routeThroughIntake` 重复，且 intake 无独立执行语义。设计文档 `docs/specs/...` 中 intake-router 的 `layers:[]` 已如实描述。

## §5 决策点（待批准）

### A. 步骤落点
- **A1（推荐）**：在 `seed.js` `METHOD_SKILLS` 内联 `steps[]`（与 `crm-deal-analyze`(`seed.js:7-16`)/`decision-retrospective`(`seed.js:156-167`) 完全一致，单注册点、零新文件）。steps=执行逻辑，方法论知识仍在 `skills/method-*/SKILL.md`，不违反 §6.6 单一事实源（知识 vs 执行分离）。
- A2：每个 `skills/method-*/` 增 `steps.json` 由 `seed.js` 读取（§6.6 纯正，但需改 `seedSkills` 扫描 + 双源一致性维护成本）。

### B. review-gate 条件门控
- **B1（推荐）**：新建 `crm-review-gate-evaluate`，内部四维+双闸分支（仅 pass 落 `review_gate_passed`），Step2 单 rule 步调用。忠实+可审计。
- B2：j_judge 仅产出 verdict+findings 作留痕、不自动批准（HITL 批准）。但 j_judge 不写 decision 事件 → 留痕弱、违反 SKILL.md"每次把关写 decision"铁律。不推荐。

### C. followup 专属动作
- **C1（推荐）**：新建 `crm-followup-schedule`，真生成跟进任务。
- C2：复用 `crm-asset-attach` 挂跟进备注（降级，非真调度）。仅当求快时采用。

> 推荐组合：**A1 + B1 + C1**（quote 复用 `crm-quote-create`，零新建；review/followup 各新建 1 个专用 action）。

## §6 改动清单（批准后实施）

1. `src/skills/seed.js`：`quote-engine`/`review-gate`/`followup-agent` 三条目加 `steps[]`（A1）。
2. `src/action/seed-actions.js`：新增 `crm-review-gate-evaluate`（write,autoDecision，四维+双闸内部分支，pass→emit `review_gate_passed`）、`crm-followup-schedule`（write,autoDecision，按 `behavior-standard` 阈值生成跟进/超时转人工）。
3. `src/agent/agentSpec.js`：`review-gate`/`followup-agent` 的 `actions` 增对应新 action（授权闭包，D3 纪律：skillCalls⊆actions）。
4. `test/retro-wiring.test.js` 或新建 `test/method-skill-exec.test.js`：断言三体 `stepsMissing=false`、rule 步真实 dispatch 对应 action、review-gate block 时不 emit `review_gate_passed`。
5. 可选增强：`contractMonitor.js` `skill_ok` 判定叠加 `stepsMissing` 维度（假绿可视化，非必需）。

## §7 验收标准

- 派发「测算该配置报价」→ quote-engine `result.stepsMissing=false`，`crm-quote-create` 真被调用，`decision` 事件落库。
- 派发「重大商机复核把关」→ review-gate `crm-review-gate-evaluate` 真被调用；构造四维不通过用例 → 返回 `pass:false` 且 **不** emit `review_gate_passed`；pass 用例 → emit `review_gate_passed`。
- 派发「跟进某商机」→ followup-agent `crm-followup-schedule` 真生成跟进任务。
- 矩阵 5 行 `skill_ok=true` 且 episode `stepsMissing=false`（真绿，非降级绿）。
- 改动面测试全绿；`node --check` 通过。

## §8 风险 / 回滚

- **R1 `crm-quote-create` 是否真算毛利/A-B 未知**：若其实现仅建报价行无测算，Step2 沦为"建空报价"。缓解：实施前先核 `seed-actions.js:484` 实现；若缺测算，拆出 `crm-quote-calc` 动作（扩大 §6.2）。不影响其它体。
- **R2 新 action 写通道第0闸**：`autoDecision:true` 由 action 内部 mint decision（`executor.js` 第0闸豁免），须确认 mint 路径存在（参考 `crm-review-gate-approve` `seed-actions.js:568`）。
- **R3 回滚**：删 `steps[]` / 新 action 即回降级态（非破坏性）；不触 DB schema。
- **R4 LLM 未配置**：j_judge 步降级为 `[降级推理]`，rule 步仍真执行 → 至少"读+写"真实发生，优于当前纯降级读取。

## §9 后续（非本次）

- 矩阵 `skill_ok` 叠加 `stepsMissing`/`degraded` 维度，使"降级绿"可见。
- `method-*` 其余 11 个（bant/meddicc/...）目前仅作方法论知识经 MCP 消费，未由 agent 直接派发 → 是否也需 agent 执行体化，另立任务。
- 事件触发式复盘（原 §7 项③）、gate 阻断式（项②）、skillCalls/actionCalls 拆分（项④）维持待决。
