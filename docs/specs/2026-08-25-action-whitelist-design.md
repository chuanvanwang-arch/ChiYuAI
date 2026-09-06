# 阶段 2 子系统三 · Action 写白名单 + 命名空间分层（设计文档）

> 状态：**已批准（2026-08-25）+ 实施完成**（T1–T7 提交 `9f0fd25`→`3f66110`，见文末 commit 区间）
> 方法论：`ai-native-action-design`（R1–R6 / R3-RED / R4 横切属性 / R6 force / 实践心得 3·4）
> 上游：`src/context/`（第 1 闸 scope_violation）、`src/decision/`（第 0 闸 decision_id）
> 下游消费方：门户 NL→Page（页面按钮只映射白名单 Action）、agents.md resolver、MCP/HTTP 暴露面

---

## §0 结论（一句话）

把 Action 表面升级为**可审计治理视图**：registry 扩展横切属性（namespace / agentTool / needsApproval / force / version / owner / parameters+candidateSource），定义**对话式写入白名单**（blast-radius 分级），executor 增加**第 2 闸（写白名单 + force 双闸）**，并提供 `detectCrudExplosion()` 反爆炸护栏与 `resolveCapabilityManifest()` 能力清单生成。

---

## §A 架构与模块划分（扩展 `src/action/`，与 context/decision 同构）

| 模块 | 职责 | 关键导出 |
|---|---|---|
| `registry.js`（扩展） | 注册表 + 横切属性 + 命名空间分层 | `registerAction` / `getAction` / `listActions({kind,namespace})` / `listNamespaces()` / `detectCrudExplosion()` |
| `whitelist.js`（新建） | 对话式写入白名单（blast-radius 分级） | `WRITE_WHITELIST` / `isWriteWhitelisted(name)` / `writeBlastRadius(name)` |
| `executor.js`（扩展） | 第 2 闸：白名单 + force 双闸 | 沿用 `dispatch`，在第 1 闸后插入 |
| `resolver.js`（新建） | 能力清单生成（agents.md 风格） | `resolveCapabilityManifest()` / `formatManifest()` |
| `seed-actions.js`（扩展） | 补横切属性 + 真实 parameters | 沿用 `seedActions()`，def 加元数据 |

> 设计铁律（R5）：每个 Action 是**唯一能力表面**，六面（tool/frontend/http/mcp/a2a/cli）共用，禁 `/api/*` 二次包装；页面按钮/LLM Tools/MCP 全部从 registry 单一事实源加载。

---

## §B 数据模型（无新增 DB 表）

registry 为**内存 Map**（`Map<string, ActionDef>`），单一事实源；DB 持久化（`syncCatalog` upsert actions 表）留待阶段 3（总体设计 §995 标注"阶段 2/3 充实"），本轮不建表、不破坏阶段 1 测试。

### ActionDef 扩展结构（向后兼容）

```js
// 原有：{ name, kind:'read'|'write', permission, handler, schema, confirm? }
// 扩展（横切属性，R4/R6）：
{
  name: 'crm-deal-advance',
  namespace: 'crm',            // R2/R3 命名空间分层（data.* / crm.* / ctx.* …）
  kind: 'write',               // R1 资源/能力二分
  permission: 'auth',
  agentTool: true,             // R4：是否暴露给 LLM/Agent（子 Agent 可见性）
  needsApproval: false,        // R4：是否需 L4 HITL 闸门（本轮声明字段，钩子预留，闸门阶段 3）
  force: false,                // R6：写操作是否需 params.force===true 双闸
  version: '1.0.0',            // R4：契约版本
  owner: 'crm-native',         // R4：责任主体
  parameters: {                // R4 金律：真实参数 schema（非空壳）
    required: ['deal_id','to_stage','transitionedBecause'],
    properties: {
      deal_id: { type:'string', candidateSource:'CRM_DEAL' },
      to_stage: { type:'string', candidateSource:'deal_stage_enum' },
    },
  },
  confirm: 'critical',         // 对话级确认（action-confirm）
  handler,
}
```

---

## §C 关键逻辑

### C1 命名空间分层（R2/R3）
- `namespace` 取自 name 前缀（`crm-deal-advance` → `crm`；`data-particle-create` → `data`）。
- `listActions({namespace})` 按 namespace 过滤；`listNamespaces()` 返回去重命名空间清单。
- 阶段 1 既有 6 个 Action 命名空间归并：`crm`（crm-deal-advance / crm-account-360）、`data`（data-particle-* 4 个）。

### C2 对话式写入白名单（blast-radius 分级）
- 白名单 = 允许经 `action-confirm` 对话入口写入的 Action 集合（参考 P2P 实证：仅收单语义 Action 入白名单，其余首版只补 schema）。
- 本轮白名单（写入风险可控、可自主 mint decision / 自动补 owner）：
  - `crm-deal-advance`（autoDecision：自主引擎 mint decision，满足第 0 闸）
  - `data-particle-create`（写创建自动补 owner_id，见上下文子系统 T4）
  - `data-particle-update`（force 双闸，状态修改需显式 force）
- **非白名单写操作**（`data-particle-edge-create`，以及未来高危写）首版只补 schema、不进白名单 → 对话入口默认拒绝，需显式 `ctx.authorizedWrite=true`（HITL/系统调用）才放行。

### C3 executor 第 2 闸（白名单 + force）
在第 1 闸（scope_violation）之后、实际执行之前插入：
1. **force 双闸（R6）**：`if (def.force && params.force !== true)` → 返回 `{ok:false, gate:'needs_force', error:'第2闸: 高危写操作需 force=true'}`（403 语义，不执行、不改状态）。
2. **白名单闸**：`if (def.kind==='write' && !ctx.bootstrap && ctx.channel==='conversational' && !isWriteWhitelisted(name) && !ctx.authorizedWrite)` → 返回 `{ok:false, gate:'write_whitelist', error:'第2闸: 写操作不在对话式白名单内'}`。
   - 豁免：bootstrap（系统种子）、authorizedWrite（HITL/系统显式授权）、autoDecision（自身 mint decision）。
- emit 对应 `trace` 事件（action-force-blocked / action-write-whitelist-blocked）。

### C4 反爆炸护栏（R3-RED 机检，实践心得 4）
`detectCrudExplosion()`：遍历注册表，检测**每个 namespace 内是否存在 per-type CRUD 爆炸**（如 `data-particle-DEAL-create` / `data-particle-ACCOUNT-create` 等多 type 同动词 → 应折叠为 `data-particle-create({type})`）。返回 `{exploded:boolean, offenders:[...]}`。seedActions 后回归调用，保留负向用例防检测器失效。

### C5 能力清单生成（resolver）
`resolveCapabilityManifest()`：从 registry 聚合 → `{ namespaces, actions:[{name,namespace,kind,agentTool,needsApproval,force,version}] }`；`formatManifest()` 输出 agents.md 风格 markdown（供门户/新 agent L1 注入/MCP 接入）。每次 seedActions 后刷新，无手写维护。

---

## §D 接口边界（不越权）

- 消费方：门户 NL→Page（按钮只映射 `agentTool && isWriteWhitelisted` 的写 Action + 读 Action）、`src/agent/agentLoop.js`（LLM Tools 只加载 `agentTool:true`）、未来 MCP/HTTP 暴露面。
- 触发源：对话入口（`ctx.channel='conversational'`）、系统调用（`ctx.bootstrap`）、HITL（`ctx.authorizedWrite`）。
- 不覆盖：HITL 审批流第三闸（阶段 3 §8.3-③）、needsApproval 耦合 L4 实际闸门（本轮仅声明字段 + executor 预留 `consultGate` 钩子）、skillRegistry 实体（阶段 2 已有 skill_registry 表，本轮不增）、embedding 模型选型。

---

## §E 测试与验收（沿用上下文/记忆子系统策略）

- **纯逻辑（本沙箱无 PG 可本地绿）**：
  - 命名空间分层：`listNamespaces()` / `listActions({namespace:'crm'})` 正确归并。
  - 白名单：`isWriteWhitelisted` 命中 3 个、拒非白名单；executor 第 2 闸对话入口非白名单写 → `gate:'write_whitelist'`；白名单内放行。
  - force 双闸：`def.force` 无 `params.force` → `gate:'needs_force'`；有则执行。
  - 反爆炸：`detectCrudExplosion()` 对正确折叠的 6 Action 返回 `exploded:false`；注入 per-type 爆炸负向用例返回 `exploded:true`。
  - resolver：`resolveCapabilityManifest()` 输出含 namespace 分组 + 横切属性。
- **DB 集成（需 PG 就绪环境）**：无（registry 内存、无 DB 表）。如需验证 seed 后 manifest 正确，可在 Node 直跑 `seedActions(); console.log(resolveCapabilityManifest())`。
- 验收判据对齐 §995 / R1–R6：命名空间可推导、白名单 blast-radius 分级、force 双闸、反爆炸护栏、能力清单单一事实源。

---

## §F 不做（YAGNI）

- ❌ HITL 审批流第三闸（needsApproval 实际 consultGate 调用，阶段 3）。
- ❌ registry DB 持久化（syncCatalog upsert actions 表，阶段 3 §995）。
- ❌ skillRegistry 实体扩展（本轮不增，阶段 2 已有表）。
- ❌ 新增 per-type CRUD Action（反爆炸红线禁止）。

---

## §G 实施 Task 拆分（writing-plans 详）

- T1 registry 扩展横切属性 + listNamespaces/listActions({namespace})（含种子 Action 补元数据）
- T2 whitelist.js 白名单 + blast-radius
- T3 executor 第 2 闸（force + 白名单）
- T4 detectCrudExplosion 反爆炸护栏
- T5 resolver 能力清单生成
- T6 测试（纯逻辑全绿）+ 审查
- T7 设计文档状态行 + 总体设计 §8.6 标注

> 每 Task 一 commit；纯逻辑本地绿（无 PG 依赖）；DB 集成留待阶段 3 或用户 PG 环境。

---

## §H 交付 commit 区间（实施后回填）

`T1..T7` → 见 writing-plans 执行后 git log。纯逻辑测试预期全绿（无 PG 依赖）。
