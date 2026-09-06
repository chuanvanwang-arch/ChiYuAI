# 第 22 项：粒子模型 / 本体 / 词汇配置（S27 `/config/ontology`）

> 设计计划 · 2026-08-27 · 配置中心第 22 项（S27）
> 铁律：设计先行 → 批准 → TDD 实现；每 Task 一 commit；沙箱无凭证，提交由用户本地执行。
> 对齐范式：第 14 项（decision-scenarios）/ 第 12 项（users）已闭环的「configRouter 工厂 + 决策第 0 闸 + web 页 + configCenter 翻转 + nav 入口」。

---

## 1. 定位与目标

**蓝图出处**：`docs/2026-08-26-frontend-config-pages-master-blueprint.md` S27
> 定位：粒子模型 / 本体 / 词汇表维护（写时向量化）。
> 组件：`table`(词汇/本体项) ｜ `attr-field`(term/synonym/embedding_ref) ｜ `select`(粒子类型映射)。
> 数据端点：`GET/PUT /api/config/ontology`（落 ontology 表，复用 `src/ontology/`）。
> 权限：`sysadmin`。备注：对齐 ai-ontology-vector-build「写库即构建」。

**本设计目标**：把「粒子模型（9 真粒子 + 语义标签 + 属性类型集）+ 本体/词汇（CRM_KNOWLEDGE 词汇表）」从**代码事实源**暴露为**可配置面**：
1. **读**：sysadmin 查看 9 真粒子模型定义（PARTICLE_TYPES 快照）与既有词汇（CRM_KNOWLEDGE 粒子，含 term/type/layer）；
2. **写**：维护词汇表（新增/编辑/停用词汇条目），写经决策第 0 闸（config_change）；
3. **模型定义**：粒子模型 JSON 快照落 `config_store`（key=`ontology-model`），可在配置面查看/还原（**不改代码常量**，模型本体在 particleModel.js 仍是唯一事实源，config_store 是运维快照/审计副本）。

## 2. 范围与红线

**范围内**：
- 后端 `createConfigRouter({ key:'ontology', decisionScene: … })` 工厂（沿用 configRouter.js 范式）→ GET / PUT `/api/config/ontology`
- 词汇 CRUD：list（直查 CRM_KNOWLEDGE）/ upsert（写 CRM_KNOWLEDGE 粒子）/ 停用（state='INACTIVE' 软标记，**不物理删除**）
- 粒子模型只读快照端点：GET `/api/config/ontology/model`（config_store key=`ontology-model`；未落则回退读代码常量构建展示）
- 前端 `ontology.html`（S27 table+form：词汇表 + 新增/编辑表单 + 粒子模型只读面板）
- configCenter 第 22 卡 pending→ready、nav.js 入口、page schema `/config/ontology` 已在白名单（schema.js:62，无需改）

**红线**：
- **不建独立 ontology 表**（修正蓝图偏差）：词汇事实源 = CRM_KNOWLEDGE 粒子（vocabulary.js 写时登记同源，避免双写不一致）；粒子模型事实源 = particleModel.js 代码常量（config_store 仅快照副本，不做权威）
- **绝对禁删**：词汇停用=软标记 `state='INACTIVE'`，无 DELETE 路径
- 写经决策第 0 闸：`requireDecision` + `recordDecisionEvent('config_change')`（configRouter 工厂已内置）
- 权限 `sysadmin`：configRouter `role='sysadmin'` 已内置（非 sysadmin 写 403）

## 3. 蓝图偏差修正（设计阶段确认）

| # | 蓝图 S27 描述 | 现状事实 | 本设计修正 |
|---|---|---|---|
| 1 | 落 ontology 表 | 词汇=CRM_KNOWLEDGE 粒子（vocabulary.js:29 写时登记），无独立表 | 词汇直查/写 CRM_KNOWLEDGE；粒子模型快照落 config_store |
| 2 | 组件含 embedding_ref | 词汇写入由 hooks.js ensureEmbedding 自动回填（写库即构建），非人工维护 | 配置面不暴露 embedding_ref 编辑（只读展示），避免手工破坏向量一致性 |
| 3 | 仅 table+form | 粒子模型需只读权威展示（9 真粒子+语义标签+19 类型） | 增加 model 只读面板（GET /model 快照） |

## 4. 后端模块设计

**文件**：`src/portal/ontologyConfig.js`（新增）

```js
// 依赖注入范式（对齐 decisionScenario.js / userManagement.js）
export function createOntologyConfigRouter(deps = {}) {
  const D = {
    query: deps.query || defaultQuery,          // db.js query
    verify: deps.verify || verifySysadmin,       // 角色闸（非 sysadmin 403）
    listKnowledge: deps.listKnowledge || defaultListKnowledge, // 直查 CRM_KNOWLEDGE
    upsertKnowledge: deps.upsertKnowledge || defaultUpsertKnowledge, // 写 CRM_KNOWLEDGE
    modelSnapshot: deps.modelSnapshot || buildModelSnapshot, // 粒子模型快照（回退代码常量）
    produceDecision: deps.produceDecision || defaultProduceDecision, // 决策第 0 闸
    sevenCheck: deps.sevenCheck,                // 七维（决策场景提供时）
  };
  const router = createConfigRouter({ key: 'ontology', role: 'sysadmin', decisionScene: 'config-change' }, D);
  // 词汇列表（直查 CRM_KNOWLEDGE，不分页、按 updated_at 倒序）
  router.get('/api/config/ontology/vocabulary', D.verify, handlerListVocabulary);
  router.put('/api/config/ontology/vocabulary', D.verify, handlerUpsertVocabulary);
  router.get('/api/config/ontology/model', D.verify, handlerModelSnapshot);
  return router;
}
```

**端点**（全挂 `/api/config/ontology*`，与蓝图路径一致）：

| 方法 | 路径 | 说明 | 权限 | 决策闸 |
|---|---|---|---|---|
| GET | `/api/config/ontology` | config_store key=`ontology` 配置（如停用词汇列表/策略） | sysadmin | — |
| PUT | `/api/config/ontology` | 写配置（经第 0 闸） | sysadmin | config_change |
| GET | `/api/config/ontology/vocabulary` | 词汇列表（CRM_KNOWLEDGE 直查，ACTIVE+INACTIVE） | sysadmin/读 | — |
| PUT | `/api/config/ontology/vocabulary` | 词汇新增/编辑/停用（写粒子，第 0 闸） | sysadmin | config_change |
| GET | `/api/config/ontology/model` | 粒子模型只读快照（9 真粒子+语义标签+19 类型） | sysadmin/读 | — |

**词汇写入 payload 校验**（`validateVocabularyPatch` 纯函数）：
- 允许字段：`term`(text 必填)、`type`(text，默认 '业务术语')、`layer`(text，默认 'L1')、`state`(ACTIVE/INACTIVE)
- `term` 非空字符串、长度 ≤ 120；未知字段拒绝；state 枚举校验
- 写路径：`upsertKnowledge` 按 `term` 幂等（存在→UPDATE payload/state，不存在→INSERT 粒子 CRM_KNOWLEDGE）

## 5. 前端页设计

**文件**：`src/web/ontology.html`（新增，对齐 decision-scenarios.html / users.html 形态）

- 顶部：粒子模型只读面板（9 真粒子卡片：slug/title/identity/states/why，语义标签 6 组 chips）
- 中部：词汇表（table：term/type/layer/state/created_at/updated_at + 停用/启用按钮）
- 底部：新增词汇表单（term 必填 + type select[业务术语/ordered-enum] + layer select[L1/L2/L3]）
- 编辑：行内表单（复用 users.html 行内编辑范式）
- 加载：fetch GET 三端点；写操作 PUT 后 reload；setInterval(15s) 自动刷新词汇表；失败降级展示错误

**复用**：`src/web/nav.js` 加 `{ href: '/ontology.html', label: '🧬 本体/词汇' }`；configCenter.js 第 22 卡翻转 ready；routes.js 挂载 + 静态页

## 6. 文件清单与接线

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/portal/ontologyConfig.js` | 新增 | 后端：词汇 CRUD + 模型快照 + configRouter 接线 |
| `test/web/ontologyConfig.test.js` | 新增 | 注入式 handler + 假 deps（对齐 userManagement.test.js 范式） |
| `src/web/ontology.html` | 新增 | 前端页（table+form+model 面板） |
| `src/http/routes.js` | 修改 | import + 挂载 `createOntologyConfigRouter({})` + 静态 `/ontology.html` + `/portal/ontologyConfig.js` |
| `src/portal/configCenter.js` | 修改 | 第 22 卡 pending→ready |
| `src/web/nav.js` | 修改 | 入口 |
| `docs/superpowers/plans/2026-08-27-ontology-config.md` | 新增 | 本设计 |

**不改**：`db/schema.sql`（不建表）、`db/migrate-config.sql`（config_store 已存在）、`src/page/schema.js`（/config/ontology 已在白名单 schema.js:62）

## 7. 测试计划（TDD）

`test/web/ontologyConfig.test.js`（对齐 userManagement 21 例范式）：

1. **validateVocabularyPatch**（纯函数）：
   - 合法：term+type+layer+state → ok
   - term 缺失/空 → 拒绝
   - state 非 ACTIVE/INACTIVE → 拒绝
   - 未知字段 → 拒绝
2. **handlerListVocabulary**：GET → 返回词汇数组（ACTIVE 在前、INACTIVE 带停用标记）
3. **handlerUpsertVocabulary**：PUT 新增（INSERT 落库 + 决策事件）、编辑（UPDATE 幂等按 term）、停用（state=INACTIVE 软标记，无 DELETE）
4. **handlerModelSnapshot**：GET → 9 真粒子 + 6 语义标签 + 19 类型（回退代码常量构建）
5. **权限**：非 sysadmin 写 → 403

**验证**：单测全绿 + `test/web/` 全量回归 + 真实库冒烟（GET 词汇 / PUT 新增落库 / PUT 停用软标记 / GET model 9 粒子 / 非 sysadmin 403 / 决策事件 config_change 计数增长）

## 8. 风险与遗留（如实标注）

- **DB 未启动**（当前 127.0.0.1:5433 连接拒绝）：真实库冒烟需先启动 PG，不影响单测（注入式假 deps）
- **model 快照是回退构建**：若 config_store `ontology-model` 已由运维写入正式快照，GET /model 返回快照而非代码常量（审计副本语义，不反向改代码）
- **词汇双写风险**已消除：词汇写入与 vocabulary.js 写时登记同源（CRM_KNOWLEDGE），配置面是人工补充入口，非第二事实源