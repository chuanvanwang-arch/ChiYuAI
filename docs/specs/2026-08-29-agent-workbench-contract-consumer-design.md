# 监控台契约消费计划 · 设计文档

> 项目：CRM-ai-native ｜ 日期：2026-08-29 ｜ 状态：**已批准（brainstorming P5 HARD-GATE 通过）**
> 上游：docs/specs/2026-08-29-brainstorming-redesign-design.md（§8 开放项「监控台消费契约」收口）、docs/superpowers/plans/2026-08-29-brainstorming-redesign-plan.md（契约写法惯例）
> 下游：docs/superpowers/plans/2026-08-29-agent-workbench-contract-consumer-plan.md（writing-plans 生成的实施计划）

---

## §0 目标与范围

让 `/agents` 智能体运行监控台**真正消费** living contract（活性契约）：解析 `docs/**/*.md` 中的 `contract-yaml` 块，对每个 task 做：

1. **静态契约校验**——声明的 `skills` / `memory` 是否 ⊆ 该 agent 在 `agentSpec.js` 注册表的 `skillCalls` / `memory.read`；
2. **success 探针**——可选结构化 `probe` 字段，命中则自动运行并写 feedback；
3. **人工裁定缺口**——经 UI 写 PG `contract_feedback`，形成「设计埋点 → 运行校验 → 回写 → 下次 P0 吸收」闭环。

**不在本计划范围**：agent 运行时遥测（skill 实际调用轨迹发射）、第 4 个 agent 引入、自动改写设计文档 `.md` 正文。均为后续升级路径（见 §5）。

**本计划价值**：当前 `validate-contract.mjs` + `aggregate-feedback.mjs` + `agentSpec.js` + `agents.js` 装配断言已就位，但 `/agents` 监控台（`src/web/agents.html`）只渲染**静态装配状态**，完全不解析 `contract-yaml`、不跟踪 skills/memory 调用、不写 feedback——即「契约被设计出来，监控台没有消费它」。本计划补上这块最后拼图。

---

## §1 架构总览（数据流）

```
docs/**/*.md (含 contract-yaml)
      │  glob + 解析 (复用 validate-contract 解析内核 → 抽到 src/contract/contractParser.js)
      ▼
GET /api/contracts ──► 静态校验 skills/memory ⊆ agentSpec 注册表
      │              ──► 关联 contract_feedback 表（当前缺口态）
      ▼
前端 /agents 「契约监测」区 (contractsPage.js 纯渲染，零服务端 import)
      │  · skills/memory chip 着色（绿=对齐，红=设计缺陷）
      │  · success：有 probe →「运行探针」按钮；无 → 按 feedback 表显状态
      │  ·「记录缺口」表单 → POST /api/contracts/feedback
      ▼
POST /api/contracts/feedback (幂等 upsert → PG contract_feedback，绝对禁删)
POST /api/contracts/probe    (运行探针 → 写 gap_type=success 反馈)
      ▼
下次 brainstorming P0：
scripts/export-contract-feedback.mjs → aggregate-feedback.mjs → 改进提案（仅提案，需批准）
```

**双轨契约（dual-track contract）**：
- **轨一 · 代码契约（as-code，权威源）**：设计/计划文档内的 `contract-yaml` 块，由 `/api/contracts` 实时 glob 解析。设计即契约，版本随 git。
- **轨二 · 运行态（observed state）**：PG `crm.contract_feedback` 表，记录每个 `(doc_path, task, gap_type)` 的观测结果、严重度、处置状态。可查询/聚合/跨文档比对。

两轨通过 `(doc_path, task)` 关联；前端「闭环回写」区即时 JOIN 两轨生成人读视图（见 §闭环回写），**不修改 .md 正文**。

---

## §2 已确认决策（复述）+ 推论

| # | 决策 | 落点 |
|---|------|------|
| D1 | 消费深度 = 混合渐进 | skills/memory 静态校验；success 走可选 `probe` 字段；缺口人工裁定 |
| D2 | 文档定位 = 全量 glob | `docs/**/*.md` 抽取含 `contract-yaml` 者（零配置） |
| D3 | 回写落点 = PG 表 | `crm.contract_feedback`（可查询/聚合/跨文档） |
| D4 | 页面落点 = `/agents` | 监控台装配卡片下新增「契约监测」区 |
| 推论1 | 解析内核复用 | 抽取 `src/contract/contractParser.js`；`scripts/validate-contract.mjs` 改为 re-export（CLI/测试不变） |
| 推论2 | 契约 agent 沿用惯例 | 本计划 tasks 用 `agent: crm-copilot` + `skills: [data-particle-read]` + `memory: [crm-copilot]`（与已批准 redesign plan 一致；当前为符号化映射，待遥测层升级为真实核验） |

**与注册表交叉校验的确定性依据**：`validate-contract.mjs:7` 定义 `REQUIRED=['task','agent','skills','memory','success']`；`agentSpec.js:8` 中 `crm-copilot.skillCalls=['data-particle-read','data-particle-create']`、`agentSpec.js:12` 中 `crm-copilot.memory.read=['crm-copilot']`。故本计划全部契约块（`agent:crm-copilot / skills:[data-particle-read] / memory:[crm-copilot]`）在 `--registry src/agent/agentSpec.js` 下 **valid:true**，契约自检可过。

---

## §3 实现切口（6 任务，各带 living contract）

**T1 解析器抽取**

```contract-yaml
- task: "抽取契约解析器到 src/contract/contractParser.js"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "node scripts/validate-contract.mjs test/fixtures/doc-ok.md 退出码 0 且 parseContractYaml 单测全绿"
```

**T2 建表迁移**

```contract-yaml
- task: "schema.sql 增加 crm.contract_feedback 表（幂等）"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "PG 存在 crm.contract_feedback 且 UNIQUE(doc_path,task,gap_type) 约束生效"
```

**T3 GET /api/contracts（消费主入口）**

```contract-yaml
- task: "实现 GET /api/contracts 契约消费端点"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "GET /api/contracts 返回 docs[] 且每 task 含 static_skills/static_memory/feedback，对 redesign 设计文档非空"
```

**T4 反馈/探针写回端点**

```contract-yaml
- task: "实现 POST /api/contracts/feedback 与 /probe（幂等 upsert，绝对禁删）"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "POST gap_type=success 后 GET 显状态；重复 POST 不新增行（UNIQUE 命中）"
```

**T5 前端契约监测区**

```contract-yaml
- task: "在 /agents 新增契约监测区（contractsPage.js 纯渲染 + html 挂载）"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "打开 /agents 可见契约监测区，skills/memory chip 着色正确，记录缺口后入库即时刷新"
```

**T6 P0 吸收导出器**

```contract-yaml
- task: "新增 scripts/export-contract-feedback.mjs 对接通用 aggregate-feedback.mjs"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  success: "导出 JSON 被 aggregate-feedback.mjs 消费且对复现≥2 缺口产出 requiresApproval 提案"
```

---

## §4 契约 schema 扩展（可选 `probe`）

在 `contract-yaml` 中新增**可选**字段 `probe`，供 success 结构化验证（混合渐进的核心）：

```contract-yaml
- task: "示例：带探针的契约"
  agent: crm-copilot
  skills: [data-particle-read]
  memory: [crm-copilot]
  probe: { type: http_get, path: /api/page/agent-workbench, expect_status: 200, expect_contains: "装配" }
  success: "GET /api/page/agent-workbench 返回装配态"
```

- 解析内核已支持内联映射（`parseInlineMap`，`validate-contract.mjs:22`）；`probe` 不在 `REQUIRED`（`:7`），故为可选、不阻断结构校验。
- **探针运行器 v1 仅支持 `type: http_get`**；`path` 限同源 `/api/**`（防任意外发，严守零信任）。命中后比对 `expect_status`（HTTP 状态码）与 `expect_contains`（响应体子串）；任一不符即写 `gap_type=success, status='fail'`，否则 `status='pass'`。
- `probe` 字段不参与 skills/memory 静态校验；仅 `success` 维度激活探针路径。

---

## §5 偏离与开放项

- **偏离 redesign 设计 §4.2**：原设计写 `<doc>.feedback.json` 并把镜像写回 `.md` 的「闭环回写」段。本计划改 PG 为权威存储；`.md` 镜像改为**按需渲染**（读 `.md` 契约块 + `contract_feedback` 表，前端「闭环回写」区即时生成表格），**不自动改写文档**（严守「未批准不改 / 绝对禁删」）。
- **skills 映射符号化**：当前 crm-copilot 无「构建端点」类真实 skill，`skills:[data-particle-read]` 为惯例占位（与已批准 redesign plan 同）；真实运行时 skill 调用核验待遥测层。
- **升级路径（非本次）**：
  ① agent 运行时发射执行轨迹（skill 调用 / 记忆读取 + SSE `agent` 域）→ workbench 由静态校验升级为运行时核验；
  ② 引入第 4 个 agent `crm-workbench` 承载契约消费能力（闭合 redesign §8 开放项）。

---

## §6 关键实现约定（writing-plans 须遵守）

1. **解析内核抽取**：新建 `src/contract/contractParser.js`，导出 `extractContractBlocks / parseContractYaml / validateContracts / parseValue / parseInlineList / parseInlineMap / stripQuotes`（从 `validate-contract.mjs` 平移，保持纯函数、零副作用）。`scripts/validate-contract.mjs` 改为 `re-export` 这些符号，**CLI 行为与测试不变**。
2. **表结构（幂等）**：`db/schema.sql` 追加
   ```sql
   CREATE TABLE IF NOT EXISTS crm.contract_feedback (
     id          BIGSERIAL PRIMARY KEY,
     doc_path    TEXT NOT NULL,
     task        TEXT NOT NULL,
     gap_type    TEXT NOT NULL,   -- success | skill | memory | knowledge_scope | other
     observed    TEXT,
     expected    TEXT,
     severity    TEXT DEFAULT 'warn',  -- info | warn | error
     status      TEXT DEFAULT 'open',  -- open | resolved | wontfix
     created_at  TIMESTAMPTZ DEFAULT now(),
     updated_at  TIMESTAMPTZ DEFAULT now(),
     UNIQUE (doc_path, task, gap_type)
   );
   ```
   种子/迁移走既有 `db/migrate.js`（幂等）。**绝对禁删**策略：feedback 仅 upsert/状态迁移，无 DELETE 端点。
3. **端点挂载**：新建 `src/http/contractRouter.js`（`createContractRouter()` 工厂，返回 express Router），在 `src/http/routes.js` 的 `createRoutes(app, hub)` 内追加 `app.use(createContractRouter())`（与 `createCalibrationRouter()` 同位）。
4. **前端**：新建 `src/portal/contractsPage.js`（纯渲染，零服务端 import，遵循 `sevenDimRender.js` 浏览器 ESM 范式）+ 在 `src/web/agents.html` 装配卡片下挂载容器。复用 `/agents` 现有数据拉取与着色样式。
5. **第0闸与鉴权**：读写 contract 属诊断/治理面，**sysadmin 闸**（对齐 calibration/seven-dim）。探针仅同源 `/api/**`，不触发外部网络。

---

## §7 验收标准

1. `GET /api/contracts` 对现有 `2026-08-29-brainstorming-redesign-design.md` 解析出非空 contracts，且 skills/memory 静态校验 chip 正确着色；
2. 在 `/agents` 可见「契约监测」区，列出上述 task；点「记录缺口」→ PG 入库 → 即时刷新；
3. 给某 task 加 `probe` 后点「运行探针」→ 写 `gap_type=success` 反馈并显状态；
4. `export-contract-feedback.mjs` 导出 JSON 被 `aggregate-feedback.mjs` 消费，复现≥2 缺口产出提案（`requiresApproval:true`）；
5. `validate-contract.mjs` 对缺字段/键不可解析仍报错（解析内核抽取不影响既有校验）。

---

## §闭环回写

> 本节说明「人读镜像」的**按需渲染**方案（非自动改写 .md）。

监控台「契约监测」区底部「闭环回写」子区，按 `doc_path` 聚合：
- 左列：设计契约（轨一），列出该文档全部 `task` 与声明的 `skills/memory/success/probe`；
- 右列：运行态（轨二），对应该 `(doc_path, task)` 的 `contract_feedback` 行（`gap_type / observed / severity / status`）；
- 着色规则：skills⊆skillCalls → 绿；否则红（设计缺陷）。feedback `status='open'` → 黄点；`resolved` → 绿；`wontfix` → 灰。
- 提供「导出本次反馈（JSON）」按钮 → 调用 `export-contract-feedback.mjs` 等价端点，供下次 brainstorming P0 经 `aggregate-feedback.mjs` 生成改进提案（仅提案，需批准后才落库/落文档）。

**此区为只读渲染**。除用户经「记录缺口」表单显式提交外，无任何写操作触达 `.md` 或反馈表外的存储。严守「绝对禁删」「未批准不改」。
