# 设计文档：销售决策监控台 K 页重做（知识原料看板）

- 状态：approved（待 writing-plans 承接）
- 日期：2026-09-10
- 作者：AI 架构助手（brainstorming 流程 P4→P6）
- 关联：前序 `docs/2026-09-10-system-overview-ui-redesign-design.md`（M/D 页重构）；`src/http/render/systemOverviewK.js`（当前偏差实现）

## 0. 背景与概念偏差（evidence-driven）

当前 K 页（`src/http/render/systemOverviewK.js`）三支柱 = **方法 SKILL 装配 / 维度镜像一致 / 本体词表治理**，本质是把"治理子集"当成了知识系统主体。用户实测指出"显示不是知识系统"。

源码核实结论：真实 K = **决策原料库**，由四层事实源构成：

| # | 事实源 | 位置 | 可复用查询 |
|---|---|---|---|
| ① 知识粒子 | `crm.particles WHERE type='CRM_KNOWLEDGE'`，按 `kind`（icp/competitors/objections/buyer_language + 业务术语/有序枚举）| `src/particles/particleModel.js:78-92` | `queryParticles({type:'CRM_KNOWLEDGE',tenantId,excludeStates})` |
| ② 来源边 | `crm.edges` 中 `sourcedFrom` 等（实体→知识 溯源链接）| `src/connectors/connectorActions.js:41,85`、`src/particles/lifecycle.js:36` | 需新增轻量计数 |
| ③ L-Knowledge 注入层 | 决策时按 scenario→kind 注入的知识条目 + `knowledge-injection-map` 配置 | `src/context/assembler.js:195 retrieveL_Knowledge` | `readConfig('knowledge-injection-map')` |
| ④ 历史决策先例图 | `crm.decision_precedent_rel` + REFERENCED_PRECEDENT 边 | `src/decision/ageGraph.js:232-246`、`src/decision/decisionRepo.js:531 searchPrecedents` | 已有查询 |

旧 K 的"方法 SKILL 治理"仅对应治理维度一角，重做后降级为角落小卡。

## 1. 定位与作用域

- 看板范式不变：顶部状态条 → 近30日趋势 → 四源面板 → 点行/块下钻明细（`drillModal.js` 复用 `data-dk`）。
- 作用域：**默认当前租户**（`me.tenantId`）；**admin 加「全租户」开关** → 传 `tenantId:'*'`。
  - 证据：`src/particles/particleRepo.js:177-191` 已原生支持 `tenantId==='*'` 跨租户通配。
  - 趋势读取 `getTrendSamples` 按 `tenant_id` 过滤（`systemOverviewShared.js:25-39`），全租户需采样器额外写 `'*'` 聚合行。

## 2. 顶部状态条

4 个核心指标：`知识粒子总数` / `来源边总数` / `注入命中知识条目` / `被引用先例数` + 闭环状态点（参照 M/D 页 `loop-head` 样式）。

## 3. 近30日趋势（新指标）

- 旧：`k_method_skill`（已偏离语义）→ **新：`k_knowledge_count`**（每日 scope 内 CRM_KNOWLEDGE 粒子数）。
- 采样器 `scripts/sample-system-overview.mjs` 新增该指标；全租户额外写 `tenant_id:'*'` 聚合行。
- 渲染层改读 `getTrendSamples('k_knowledge_count', {tenantId, deps})`。

## 4. 四源面板 + 下钻（data-dk 复用 drillModal）

| 面板 | 数据源（复用） | 下钻内容 |
|---|---|---|
| ① 知识粒子库 | `queryParticles({type:'CRM_KNOWLEDGE',tenantId,excludeStates:['deprecated']})` 按 `payload->>'kind'` 分桶 | 该 kind 粒子列表（term/source/confidence/state）|
| ② 来源边溯源 | 新增轻量计数 `countEdgesToKnowledge(tenantId)`（`edges WHERE target_type='CRM_KNOWLEDGE'`）| 边明细（源实体→知识 id，relation）|
| ③ L-Knowledge 注入覆盖 | `readConfig('knowledge-injection-map')` + 各 scenario 命中计数（`payload->>'kind' = ANY(kinds)`）| 该 scenario 匹配的知识条目（term/kind/confidence）|
| ④ 历史先例图 | `decision_precedent_rel` 按 `precedent_id` 聚合 Top-N + `searchPrecedents` | 先例决策摘要 + 引用它的决策 |

下钻实现：面板块/行加 `data-dk="..."`，服务器渲染隐藏 `.so-detail-hidden[data-dk]` 块，复用既有 `drillModal.js`（已兼容 SVG `<g data-dk>`，但本页面板用 HTML 块即可）。

## 5. 治理角落（降级）

方法 SKILL 装配健康度小卡（total/启用/维度闭环状态）+ 链接 `/skills.html`。仅作治理维度留痕，不再是主体。

## 6. 任务拆分 + 生命契约（§A 双轨）

```contract-yaml
- task: "T1 数据层：四源查询 + '*' 通配"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [data-particle-read]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "queryParticles/edges/precedent 四源查询返回数据，tenantId='*' 正确跨租户"
- task: "T2 趋势采样：k_knowledge_count"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [data-particle-read]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "sample-system-overview.mjs 写入 k_knowledge_count（按租户 + '*' 聚合）"
- task: "T3 渲染层：四源看板重写"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [data-particle-read, decision-retrospective]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "systemOverviewK.js 含 so-k-panels 四块 + data-dk 下钻，本地渲染四源非空"
- task: "T4 路由/开关：admin 全租户"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [data-particle-read]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "admin 切 scope=all 时查询 tenantId='*' 并返回跨租户数据"
- task: "T5 测试：K 四源断言"
  agent: decision-retro
  contract_task_id: ct-retro-decision
  skills: [data-particle-read]
  memory: [decision-retro]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "test/http/system-overview-pages.test.js K 四源结构断言全绿"
```

**契约说明：** 5 个任务均由 `decision-retro` 承接（只读型知识/先例监控，对齐其 `data-particle-read` + `decision-retrospective` skillCalls 与 `L1/L2` 知识层）；成功标准均为可验证判定式（查询返回/采样写入/渲染非空/测试全绿）。

## 7. 成功标准（总）

- K 页呈现真实四源数据（非 SKILL 治理）；与 M（图）、D（阶段卡）形态差异化。
- admin 全租户开关可用；趋势指标改 `k_knowledge_count`。
- 测试全绿；零新增污染层（仅 1 个轻量 edge 计数函数 `countEdgesToKnowledge`）。
- 沙箱无凭证 → 由用户本地按功能线提交 + 走 `git stash -u` 隔离 release（遵循 `pack-local.py` 整树打包不读 git 铁律）。

## 闭环回写（§B）

| 任务 | Agent | gap_type | observed | expected | severity | 状态 |
|---|---|---|---|---|---|---|
| （待 P10 workbench 监控回填）| | | | | | |

> 本设计为新建，暂无 `*.feedback.json`；P10 由 agent-workbench 监控执行并写回反馈，下一轮 P0 吸收。
