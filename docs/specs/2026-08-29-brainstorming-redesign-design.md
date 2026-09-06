# 重新设计 `brainstorming` SKILL — 设计文档

> Status: 设计已批准（2026-08-29）
> Owner: 王川 / AI 搭档
> Scope: 重新设计用户级 `~/.workbuddy/skills/brainstorming/SKILL.md`
> 关联系统: CRM-ai-native `agent-workbench.html` / `/agents` 监控台、`src/agent/agentSpec.js`

---

## 0. 背景与动机

`http://localhost:3000/agent-workbench.html` 智能体中心的目的是**监控 4 个智能体的运行效果**：每次是否调用了 SKILL、是否读取了相关记忆/知识，并持续跟踪调用是否成功，形成**闭环建议**，让智能体工作更有效。

当前 `brainstorming` skill 是一份**通用**的"想法→设计"对话流程（HARD-GATE + writing-plans 交接），它产出设计文档，却**不声明任何"预期调用的 SKILL / 预期读取的记忆 / 成功标准"**。因此运行期的监控台无法区分"智能体按计划执行"与"智能体偏离计划"，闭环无从谈起。

本次 redesign 将 `brainstorming` 升级为 **设计期埋点 + 运行期闭环** 的方法论中枢：它产出的不再是单纯设计文档，而是一份 **living contract（生命契约）**，被 `agent-workbench` / `/agents` 持续校验，并把偏差自动转成 SKILL/设计改进建议。

### 0.1 已确认的设计决策（来自澄清阶段）

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 重设计目标 | **契约 + 内容双改**：既重做 skill 内容结构与术语，又让产出自带可监控契约 |
| D2 | 契约形态 | **双轨**：每个任务附 ```` ```contract-yaml ```` 机器块 + 同义散文 |
| D3 | 闭环形态 | **C — brainstorming 即闭环引擎**：skill 持有 living contract，workbench 持续更新，自动生成 SKILL 改进建议 |
| D4 | 通用性 | **通用 skill + CRM 作参考实例**（见 §1.3），不把 CRM 专有词硬编码进 skill |
| D5 | SKILL 改进建议 | **须经用户批准才落地**（严守"未批准不改 SKILL/不写实现"铁律；绝不自动 DELETE） |

---

## 1. 定位与边界（Skill 身份）

### 1.1 Name
保持 `brainstorming`（用户级 `~/.workbuddy/skills/brainstorming/SKILL.md`）。

### 1.2 新定位
把"想法→可监控设计"的对话，升级为 **设计期埋点 + 运行期闭环** 的方法论中枢。它产出：
1. 经批准的**设计文档**（保留）；
2. 内嵌的 **living contract**（新增）——被智能体工作台持续校验；
3. 由偏差驱动的 **SKILL/设计改进建议**（新增）。

### 1.3 通用性约束（关键取舍）
`brainstorming` 是**用户级通用 skill**，跨项目复用。redesign 后：
- **契约 schema 与流程保持通用**：`agent / skills / memory / success` 四字段可参数化，不绑定任何具体项目。
- **CRM 智能体工作台作为参考实例**：文档与示例中用 `agentSpec.js`（crm-copilot / deal-coach / lead-miner）演示契约如何对齐既有 agent 模型，但 skill 正文不硬编码 CRM 专有名词。

> 理由：用户既要在 CRM 项目立即落地闭环，又要避免污染通用 skill 供其它项目（PDM/P2P 等）复用。参数化契约 + 参考实例是最小耦合方案。

---

## 2. 修订后的流程（P0–P10）

```
P0  回写预检    → 读上一轮的 <doc>.feedback.json 与设计文档「## 闭环回写」，
                 若存在 gap 则列为开放项（新增阶段）
P1  探索上下文  → 文件 / 文档 / agentSpec / 近期 commit（保留）
P2  澄清提问    → 一次一题、多选优先（保留）
P3  提出 2-3 方案 → 含权衡与推荐（保留）
P4  呈现设计    → 含嵌入式 living contract（修订）
P5  批准闸门    → HARD-GATE 不变（保留）
P6  写设计文档  → 内嵌契约（双轨）（修订）
P7  规格自检    → 新增「契约有效性」检查（修订）
P8  用户评审    → 用户审规格（保留）
P9  移交 writing-plans → 任务继承同一份契约（修订）
P10 闭环回写    → workbench 监测 → 回写 feedback → 下次 P0 吸收 → 生成 SKILL 改进建议（新增）
```

HARD-GATE（P5 前不得写代码/脚手架/调用实现类 skill）保持刚性不变。

---

## 3. Living Contract（生命契约）Schema — 双轨

每个设计任务附带一段 **机器块 + 散文**。机器块供 workbench 解析；散文供人审阅与审阅一致性。

### 3.1 机器块（```` ```contract-yaml ````）

```contract-yaml
- task: "实现 agent-workbench 监控卡"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  knowledge_scope: { layers: [L1], max_hops: 2 }
  success: "GET /api/page/agent-workbench 返回 4 agent 装配状态且 SSE 刷新"
```

字段语义：

| 字段 | 必填 | 含义 | 对齐既有模型 |
|------|------|------|--------------|
| `task` | 是 | 任务标题/ID | 与 writing-plans 任务粒度一致 |
| `agent` | 是 | 承接智能体 key | `agentSpecs` 的 key（crm-copilot / deal-coach / lead-miner，可扩展至第 4 个） |
| `skills` | 是 | 预期调用的 SKILL 列表 | 必须是该 agent `capabilities.skillCalls` 的**子集** |
| `memory` | 是 | 预期读取的记忆/知识范围 | 对齐 `memory.read` + `knowledgeScope.layers` |
| `knowledge_scope` | 否 | 知识层与跳数约束 | 对齐 `knowledgeScope` |
| `success` | 是 | 可验证的成功标准（判定式，非模糊描述） | workbench 据其做布尔判定 |

### 3.2 散文（同义重述）
每个机器块后跟一行人读说明，例如：

> **契约说明：** 本任务由 `crm-copilot` 承接，必须调用 `data-particle-read` SKILL、读取 `crm-copilot` 记忆（L1，≤2 跳）；成功标准为接口返回 4 个智能体装配态且 SSE 实时刷新。

### 3.3 契约自检（P7 强制项）
- 每个 task 必须有 `agent + skills + memory + success` 四字段；
- `agent` 键必须能在 `agentSpecs`（或等价 agent 注册表）解析；
- 每个 `skill` 必须属于该 `agent` 的 `skillCalls` 子集；
- 每个 `memory` 项必须属于该 `agent` 的 `memory.read` 或 `knowledgeScope.layers`；
- 任一不通过 → 设计不予批准，回到 P4 修正。

---

## 4. 闭环机制（workbench ↔ brainstorming）

### 4.1 监测（workbench 侧）
`agent-workbench.html` / `/agents` 解析设计文档中的 `contract-yaml` 块，按 task 跟踪三件事：
1. 承接 agent 是否**调用了声明的 `skills`**？
2. 是否**读取了声明的 `memory`/知识**？
3. `success` 判定**是否通过**？

### 4.2 回写（feedback 记录）
任一缺失/失败 → 追加一条 `feedback` 记录：

```json
{
  "task": "实现 agent-workbench 监控卡",
  "agent": "crm-copilot",
  "gap_type": "skill | memory | success",
  "observed": "未调用 data-particle-read",
  "expected": "调用 data-particle-read",
  "ts": "2026-08-29T11:05:00+08:00",
  "severity": "warn | error"
}
```

写入位置（双写）：
- 机器写：`<design-doc>.feedback.json`（追加数组元素，幂等 upsert by task+gap_type）；
- 人读镜像：设计文档 `## 闭环回写` 小节（表格形式）。

### 4.3 吸收与建议（brainstorming 侧 P0）
- 下次 `brainstorming` 会话的 **P0 回写预检** 读取 `*.feedback.json`；
- 若同一 `(task, gap_type)` 复现 ≥ 2 次 → 生成 **SKILL 改进建议**（示例：给 `agentSpec` 补 `skillCalls`、强化某 SKILL 的调用指令、补充 memory 读取约定）；
- 建议以**提案形式呈现**，列明"改哪个 SKILL/哪段、为何、预期收益"，**须经用户明确批准才落地**（D5）。
- 严禁在未经批准时修改 SKILL 文件，严禁任何 DELETE 操作。

---

## 5. 产物落点与验收

### 5.1 设计文档
`D:/system/CRM-ai-native/docs/specs/YYYY-MM-DD-<topic>-design.md`（沿用本项目 spec 存放约定），内嵌契约（双轨）+ `## 闭环回写` 小节。

### 5.2 反馈文件
同目录 `<doc>.feedback.json`（workbench 写，brainstorming 读）。

### 5.3 轻量校验器（给 workbench 一个可运行入口）
新增 `scripts/validate-contract.mjs`（或等价 vitest）：
- 输入：设计文档路径；
- 行为：抽取所有 `contract-yaml` 块 → 解析 → 执行 §3.3 自检 → 输出 `{ valid, errors[] }`；
- 用途：workbench 在解析契约前先跑校验，契约非法则报警而非静默误判。

### 5.4 验收标准
1. 用新 skill 对某个真实 feature 走完整 P0–P9，产出的设计文档含 workbench 可解析的 `contract-yaml` 块（双轨）；
2. 注入一条合法 `feedback` 记录 → 重跑 P0 → 能看到 SKILL 改进建议产出（闭环演示）；
3. `validate-contract.mjs` 对"缺字段/键不可解析"的契约能报错；
4. 通用性校验：契约 schema 不含 CRM 专有硬编码（除参考实例示例外）。

---

## 6. 实施切口（供 writing-plans 细化）

实现 redesign 的最小改动集（非本设计阶段落地，转入 writing-plans）：

1. 重写 `~/.workbuddy/skills/brainstorming/SKILL.md`：
   - 新增 P0 回写预检、§3 契约 schema、§4 闭环机制、§5.3 校验器约定；
   - 保留 HARD-GATE、一次一题、2-3 方案、P6–P9 既有结构；
   - 用 CRM 作为参考实例（不硬编码）。
2. 新增 `scripts/validate-contract.mjs`。
3. 在 CRM `agent-workbench.html` / `/agents` 增加契约解析 + feedback 回写（属 workbench 侧实现，可单列计划）。
4. 用一次真实 feature 跑通 P0–P10 做端到端验收（本设计 §5.4）。

---

## 7. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 契约写错导致 workbench 误判 | §3.3 自检 + §5.3 校验器双重把关 |
| 通用 skill 被 CRM 专有词污染 | §1.3 参数化契约；skill 正文仅以 CRM 作参考实例 |
| 闭环建议未经批准自动改 SKILL | D5 铁律：建议仅提案，落地需用户批准 |
| 用户嫌流程变重 | P0 预检在无私反馈时零开销；契约可随任务粒度伸缩 |

---

## 8. 开放项（P0 将吸收的内容留白）
- 第 4 个智能体身份待确认（当前 `agentSpec.js` 为 3 个；契约 `agent` 字段参数化，新增即生效，无需改 skill）。
- workbench 侧契约解析与 feedback 回写的具体接口，留待 workbench 实现计划细化（不在本 skill redesign 内强耦合）。
