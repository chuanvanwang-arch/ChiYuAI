# 实施计划 · 阶段 2 子系统三 Action 写白名单 + 命名空间分层

> 来源设计：`docs/2026-08-25-action-whitelist-design.md`（§A-§F 已批准）
> 纪律：每 Task 一 commit；TDD；纯逻辑本地绿（registry 内存，无 PG 依赖）；DB 集成留阶段 3/PG 环境。
> 执行：Subagent-Driven（每 Task 独立子代理 + 主会话审查补强）

---

## T1 · registry 扩展横切属性 + 命名空间分层
**文件**：`src/action/registry.js`（扩展）、`src/action/seed-actions.js`（补元数据）
**职责**：
1. `registry.js` 的 `registerAction(def)` 接受并保留扩展字段：`namespace` / `agentTool` / `needsApproval` / `force` / `version` / `owner` / `parameters`（含 `required`/`properties` 且 `properties.*.candidateSource`）。`name` 缺省 `namespace` 时自动从 `name` 前缀推导（`name.split('-')[0]`）。
2. 新增 `listNamespaces()` → 去重命名空间数组。
3. `listActions({kind,namespace})` 支持 `namespace` 过滤（按 `def.namespace`）。
4. `seed-actions.js` 给 6 个 Action 补横切属性：
   - `data-particle-create`：namespace='data', agentTool=true, force=false, parameters.required=['type','payload'], properties.type.candidateSource='particle_type_enum', version='1.0.0', owner='crm-native'
   - `data-particle-read`：namespace='data', agentTool=true, kind='read'
   - `data-particle-update`：namespace='data', agentTool=true, **force=true**（R6 状态修改）, parameters.required=['id','patch']
   - `data-particle-edge-create`：namespace='data', agentTool=false（非白名单高危）, force=false
   - `crm-deal-advance`：namespace='crm', agentTool=true, kind='write', autoDecision=true, confirm='critical', parameters.required=['deal_id','to_stage','transitionedBecause'], properties.deal_id.candidateSource='CRM_DEAL'
   - `crm-account-360`：namespace='crm', agentTool=true, kind='read'
**测试**（纯逻辑，`test/action.test.js` T1）：`listNamespaces()` 含 `['crm','data']`；`listActions({namespace:'crm'})` 返回 2 个、`{namespace:'data'}` 返回 4 个；`getAction('crm-deal-advance').force===false`、`data-particle-update.force===true`。
**验收**：命名空间正确归并；横切属性落位。
**commit**：`feat(action-T1): registry 扩展横切属性 + 命名空间分层`

## T2 · whitelist.js 对话式写入白名单
**文件**：`src/action/whitelist.js`（新建）
**职责**：导出 `WRITE_WHITELIST = new Set(['crm-deal-advance','data-particle-create','data-particle-update'])`；`isWriteWhitelisted(name)`；`writeBlastRadius(name)` → `'autonomous'|'human_gate'|'governance'`（白名单内 autonomous，非白名单 human_gate/暂 governance）。
**测试**（纯逻辑 T2）：`isWriteWhitelisted('crm-deal-advance')===true`；`isWriteWhitelisted('data-particle-edge-create')===false`；`writeBlastRadius` 映射正确。
**验收**：白名单命中 3 个、拒非白名单。
**commit**：`feat(action-T2): 对话式写入白名单 + blast-radius 分级`

## T3 · executor 第 2 闸（force + 白名单）
**文件**：`src/action/executor.js`（扩展）
**职责**：在第 1 闸（scope_violation，约 L34）之后、`if (def.kind==='write')` emit 之前插入第 2 闸：
1. force 双闸：`if (def.force && !(params && params.force === true))` → emit trace 'action-force-blocked' → return `{ok:false, gate:'needs_force', error:'第2闸: 高危写操作需 force=true'}`。
2. 白名单闸：`if (def.kind==='write' && !ctx.bootstrap && ctx.channel==='conversational' && !isWriteWhitelisted(name) && !ctx.authorizedWrite)` → emit trace 'action-write-whitelist-blocked' → return `{ok:false, gate:'write_whitelist', error:'第2闸: 写操作不在对话式白名单内'}`。
3. 顶部 import `isWriteWhitelisted` from `./whitelist.js`。
**测试**（纯逻辑 T3）：① `dispatch('data-particle-update',{id,x,patch:{}}, {actor, channel:'conversational'})` 无 force → `gate:'needs_force'`；带 `force:true` 且 bootstrap/白名单 → 过闸（handler 抛错算执行，但非 needs_force）。② `dispatch('data-particle-edge-create',{...},{actor, channel:'conversational'})` → `gate:'write_whitelist'`；带 `authorizedWrite:true` → 过闸。③ 验证不影响既有第 0 闸（decision_id）与第 1 闸（scope）行为。
**验收**：force 双闸 + 白名单闸生效；不破坏既有两闸。
**commit**：`feat(action-T3): executor 第2闸 force双闸 + 写白名单闸`

## T4 · detectCrudExplosion 反爆炸护栏
**文件**：`src/action/registry.js`（扩展）
**职责**：`detectCrudExplosion()` 遍历注册表，检测某 namespace 内是否存在**同动词多 type 爆炸**模式（正则 `/^(data|asset|crm)-(.+)-create$/` 且 type 段为具体粒子类型而非 `particle` 通用）；返回 `{exploded:boolean, offenders:[names]}`。正常 6 Action（data-particle-* 用通用 `particle` 非 per-type）→ `exploded:false`。
**测试**（纯逻辑 T4）：对正常 registry → `exploded:false`；临时 `registerAction({name:'data-deal-create',...})` 注入负向用例 → `exploded:true`、offenders 含该名；清理注入。
**验收**：机检反爆炸，负向用例可捕获。
**commit**：`feat(action-T4): detectCrudExplosion 反爆炸护栏`

## T5 · resolver 能力清单生成
**文件**：`src/action/resolver.js`（新建）
**职责**：`resolveCapabilityManifest()` 聚合 registry → `{ namespaces:string[], actions:[{name,namespace,kind,agentTool,needsApproval,force,version,owner}] }`；`formatManifest()` 输出 agents.md 风格 markdown（按 namespace 分组，标注写/读/force/needsApproval）。
**测试**（纯逻辑 T5）：`resolveCapabilityManifest().namespaces` 含 crm/data；actions 含 6 项且字段完整；`formatManifest()` 返回含 `## Action`/`crm-deal-advance` 字符串。
**验收**：能力清单单一事实源、无手写维护。
**commit**：`feat(action-T5): resolver 能力清单生成(agents.md风格)`

## T6 · 测试聚合 + 审查
**文件**：`test/action.test.js`（新建，T1-T5 describe 块累积）
**职责**：汇总纯逻辑测试；`beforeAll(()=>seedActions())` 确保横切属性就位；跑 `node node_modules/vitest/vitest.mjs run test/action.test.js` 全绿（无 PG 依赖，预期全绿）。
**验收**：纯逻辑全绿。
**commit**：`test(action): 聚合纯逻辑测试 T1-T5`

## T7 · 文档收尾
**文件**：`docs/2026-08-25-action-whitelist-design.md`（状态行回填 commit 区间）、`docs/2026-08-25-ai-native-crm-overall-design.md`（§8.6 第 3 项标注已完成）
**职责**：设计文档顶部状态行补 commit 区间；总体设计 §8.6「Action 写白名单+命名空间分层」改**已完成**附摘要。
**验收**：两文档一致。
**commit**：`docs(action): §8.6 标注子系统三已完成`

---

## 验证命令（用户/CI）
```bash
node node_modules/vitest/vitest.mjs run test/action.test.js   # 纯逻辑全绿（无 PG 依赖）
node -e "import('./src/action/seed-actions.js').then(m=>{m.seedActions();import('./src/action/resolver.js').then(r=>console.log(r.formatManifest()))})"  # 能力清单打印
```
> 本沙箱无 PostgreSQL：本子系统 registry 内存、无 DB 表，**全部测试可本地绿**，无需 PG 环境。
