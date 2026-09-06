# 安全加固四项落地设计：上下文对象级权限裁剪 / 敏感字段脱敏 / 审计字段历史视图 / 对象级 ACL

> 整理时间：2026-09-05 ｜ 性质：**设计文档**（P6，供用户评审；批准后移交 writing-plans，实施前硬闸）
> 设计输入：`docs/2026-09-05-attio-lightfield-security-study.md` §6 差距清单（P0①/P0②/P1③/P1④）
> 落地范围：四项全部基于**已有资产接线**（判定闸/审计链/导出/过滤谓词均存在），不引入新表新引擎，中低复杂度。
> 铁律遵守：禁 DELETE（软删除/墓碑）；决策第 0 闸仅套接既有链；阈值配置化禁硬编码；零信任 HITL 不削弱。

---

## §0 结论（先给判断）

**四项均为「已有闸门 → 补接线/视图/中间件」**，无新引擎、无新表、无新认证体系。落地后安全基线将补上：**上下文注入按 data_scope 裁剪（权限即架构最后一公里）、敏感出参脱敏、审计字段历史产品视图、对象级 ACL**——四项直接对标 ATTIO/Lightfield 的核心安全承诺。

| # | 差距项 | 核心改动 | 复杂度 | 依赖 |
|---|---|---|---|---|
| 1 | P0① 上下文注入对象级权限裁剪 | `assembler.js` 注入前按 `data_scope` 过滤检索结果 | 低 | 已有 `scopePredicate`/`enforceScope` |
| 2 | P0② 敏感字段脱敏层 | 出参脱敏中间件（按角色分级） | 中 | 角色体系已有 |
| 3 | P1③ 审计字段历史视图 | `audit_event` 字段级投影 + 前端时间线 tab | 低 | 已有 `auditHook`/`timelineSource` |
| 4 | P1④ 对象级 ACL | 粒子可见范围配置 + 注入/查询过滤 | 中 | 已有 `tenancy`/`scopePredicate` |

**验收口径（L1-L4）**：L1 配置可见 → L2 单测绿 → L3 迁移幂等 → L4 生产有真实命中。

---

## §1 现状证据链（代码级）

### 1.1 判定闸已存在，但上下文注入未接线
- `src/context/scope.js:81` `enforceScope(def, ctx, params, profile)` —— 写通道第 1 闸（executor 调用），按 data_scope 模型判定；
- `src/context/scope.js:113` `scopePredicate(profile, actor, orgSubtreeIds)` —— 列表查询谓词（self/domain/org_subtree 生成 SQL 子句）；
- `src/context/assembler.js:207` `assembleContext` —— L1/L2/L3/L4/LK/叙事 六层检索，**完全无 data_scope 过滤**（`retrieveL1` 直接 `SELECT ... WHERE embedding IS NOT NULL ORDER BY <=>`，不筛 owner/type/tenant）。

**这是「权限即架构」的最后一公里**：写通道有闸，但 Agent 的**上下文（读侧）**能检索到 data_scope 外粒子 → Agent 推理会看到不该看的数据（哪怕不写，也是泄露）。

### 1.2 脱敏雏形在 insightService，但无通用中间件
- `src/account/insightService.js:28` 按 data_scope 过滤关联粒子（仅客户洞察一处，非通用）；
- `src/portal/rbacMatrix.js` 角色 data_scope 配置可见。
- **缺口**：无出参统一脱敏（报价/底价/提成/手机/邮箱等敏感字段按角色分级展示）。

### 1.3 审计链已有，缺产品视图
- `src/action/auditHook.js:38` `recordAudit`（append-only + SHA-256 链 + fail-open）；
- `src/action/auditHook.js:72` `verifyAuditChain`（防篡改校验）；
- `src/http/routes.js:2261` `exportAudit`（审计导出）+ `:2522` `exportTurtle`（W3C PROV-O）。
- **缺口**：无「字段 旧值→新值→谁改→为什么」的单字段时间线视图（前端 account-insight 仅事件序列）。

### 1.4 对象级 ACL
- `crm.role_context_profile.data_scope`（`src/context/roleProfiles.js`）已支撑 self/domain/org_subtree/all 四级；
- `scopePredicate` 能生成 SQL 过滤；
- **缺口**：无「单粒子可见范围」配置（对象级 ACL 颗粒度），且上下文注入未消费。

---

## §2 方案选型（P3，一次一问已定：直接落地四项，均最小改动）

### 2.1 P0① 上下文注入权限裁剪
- **方案 A（推荐）**：`assembleContext` 注入前置裁剪——在 `retrieveL1`/`retrieveL_Knowledge`/`retrieveNarrative` 检索 SQL 末尾追加 `scopePredicate(profile)` 子句（复用既有函数，零新逻辑），并给 `assembleContext` 增 `profile` 参数（由调用方从 ctx 传入，缺省 'all' 保持现有行为）。
- **方案 B**：新增独立过滤层（在装配后对结果二次过滤）——多一次遍历，但可保留「检索全部再裁剪」的语义。**不推荐**（多此一举，且检索了不该有的数据）。
- **权衡**：A 直接在 SQL 层过滤（防泄露更彻底、零额外开销）；B 后过滤多一次内存往返。**A 胜**。

### 2.2 P0② 敏感字段脱敏
- **方案 A（推荐）**：`src/http/middleware/mask.js` 出参脱敏中间件——按角色 data_scope domain 分级：个人隐私字段（手机/邮箱）默认 `***`；商业敏感（底价/提成/报价）仅 高管/财务 可见。挂载于敏感端点（报价/客户详情/合同）。
- **方案 B**：仅在 `insightService` 扩展（沿用现有雏形）。**不推荐**（非通用，覆盖面窄）。
- **权衡**：A 通用一处生效；B 快但只修一处。**A 胜**。

### 2.3 P1③ 审计字段历史视图
- **方案 A（推荐）**：后端 `GET /api/particles/:id/field-history?field=xxx`（查 `audit_event.payload` 投影字段级旧值→新值）；前端 account-insight 详情抽屉加「字段历史」tab，复用 `timelineSource` 渲染 时间/actor/旧值→新值/decision_id 链接。
- **方案 B**：全量事件时间线强化，不加字段级 tab。**不推荐**（不响应「只记新状态不记变化」痛点）。
- **权衡**：A 数据已有（audit payload 全字段），纯渲染层；B 覆盖面大但模糊。**A 胜**。

### 2.4 P1④ 对象级 ACL
- **方案 A（推荐）**：在粒子 `meta` 增 `visible_roles[]`/`confidential` 标记（软配置，禁删），`scopePredicate` 扩展为「role ∩ data_scope ∩ visible_roles」三条件，上下文注入与列表查询一致消费。
- **方案 B**：仅靠 data_scope（现状）。**不推荐**（无单对象粒度，无法表达「这个商机只给经理看」）。
- **权衡**：A 零新表（meta JSONB 增键），一次性打通注入侧+查询侧；B 现状不变。**A 胜**。

---

## §3 设计（P4，分节）

### 3.1 P0① 上下文注入权限裁剪（`src/context/assembler.js` + `scope.js`）

**改动点清单**：
1. `assembleContext({ actor, intent, query, tenantId, profile })` —— 新增 `profile` 参数（由路由从 `resolveMe`/`actorRole` 解析传入；缺省 null = 'all' 保持既有行为）。
2. `retrieveL1(actor, q, profile)` —— SQL 末尾追加 scope 子句：`scopePredicate(profile, actor)`（domain → `AND p.type = ANY($1)`；self → `AND p.payload->>'owner_id' = $1`；org_subtree → 子树人员 IN）。
3. `retrieveL_Knowledge(actor, intent, profile)` —— 追加 `AND tenant_id=$1`（已带）+ `scopePredicate`（domain/self）。
4. `retrieveNarrative(actor, intent, profile)` —— 按 accountId/dealIds 的作用域：先校验目标实体是否在 `data_scope` 内（复用 `enforceScope` 语法），越界则返回空 + `unavailable_reason='scope-excluded'`（可审计，非降级）。
5. **回归保底**：`scopeModel` 为 'all' 时子句为空串（现状行为完全不变）。

**契约**（§A）：
```contract-yaml
- task: "P0① 上下文注入按 data_scope 裁剪"
  agent: decision-agent
  skills: [data-particle-read, method-decision-enrich]
  memory: [decision-agent]
  knowledge_scope: { layers: [L1, L2], max_hops: 5 }
  success: "assembleContext 注入前按 profile.data_scope 过滤；data_scope=all 行为不变；self/domain 命中过滤；越界叙事 unavailable_reason=scope-excluded"
```
**契约说明**：本任务由 `decision-agent` 承接，读取 `decision-agent` 记忆（L1-L2，≤5 跳），成功标准为上下文注入按 data_scope 过滤且 all 模式零回归。

### 3.2 P0② 敏感字段脱敏（`src/http/middleware/mask.js`）

**改动点清单**：
1. 新建 `src/http/middleware/mask.js`：`maskFields(res, { role, dataScope })` —— 敏感字段表配置化（`config_store['mask-fields']`：`personal` / `commercial` 两类，各自字段名 + 可见角色）。
2. 挂载：报价（`/api/quote`）、客户详情（`/api/account`）、合同（`/api/contract`）出参统一过 mask。
3. 规则：`personal`（手机/邮箱/证件）默认 `***`，除非角色含 `finance`/`exec`/`sysadmin`；`commercial`（底价/提成/报价明细）默认 `***`，除非 `exec`/`sysadmin`（销售看自己商机可看报价，但底价/提成不显）。
4. **铁律**：脱敏是展示层（读侧），**不落库**；决策链（审计）仍存真实值（问责优先）。

**契约**：
```contract-yaml
- task: "P0② 敏感字段出参脱敏中间件"
  agent: review-gate
  skills: [method-review-gate, data-particle-read]
  memory: [review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "敏感端点出参按角色分级脱敏；个人字段默认***；商业敏感字段仅 exec/sysadmin 可见；决策链仍存真实值"
```

### 3.3 P1③ 审计字段历史视图（`routes.js` + account-insight）

**改动点清单**：
1. 后端 `GET /api/particles/:id/field-history?field=amount` —— 查 `crm.audit_event` 该粒子相关事件，`payload` 中投影指定字段 `before → after`（`recordAudit` 已存当时全字段 payload，含前后值），按时间倒序；`decision_id`/`actor` 一并返回。
2. 前端 account-insight 详情抽屉加「字段历史」tab：渲染 时间/操作人/旧值→新值/决策链接（复用 `timelineSource` 行形态）。
3. **权限**：仅 data_scope 内可见（同 P0① 谓词），防越权看他人字段史。
4. **审计与展示分离**：后端投影只读，不写新审计事件。

**契约**：
```contract-yaml
- task: "P1③ 审计字段历史产品视图"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "GET /api/particles/:id/field-history 返回字段旧值→新值+actor+decision_id；越权不可见；前端 tab 渲染"
```

### 3.4 P1④ 对象级 ACL（`scope.js` + 粒子 meta）

**改动点清单**：
1. 粒子 `meta` 增两键：`visible_roles[]`（空=不限制，非空=仅列出的角色可见）、`confidential`（bool，隐式仅 exec/sysadmin 可见）。
2. `scopePredicate` 扩展签名 `(profile, actor, orgSubtreeIds, { visibleRoles })`：SQL 追加 `AND (meta->'visible_roles' IS NULL OR meta->'visible_roles' = '[]'::jsonb OR meta->'visible_roles' ?| ARRAY[$role])`。
3. 上下文注入（P0① 链路）与列表查询 **同一谓词** 消费（单一事实源）。
4. **禁删**：`visible_roles` 变更走软更新（写入即新审计事件，`recordAudit` 自动留痕）。
5. 配置化：字段名/角色集走 `roleProfiles.js`（不散点硬编码）。

**契约**：
```contract-yaml
- task: "P1④ 对象级 ACL（visible_roles/confidential）"
  agent: review-gate
  skills: [data-particle-read, method-review-gate]
  memory: [review-gate]
  knowledge_scope: { layers: [L1, L2], max_hops: 4 }
  success: "scopePredicate 支持 visible_roles 过滤；上下文注入与列表查询同谓词；visible_roles 变更触发 audit；confidential 隐式仅 exec/sysadmin"
```

---

## §4 依赖链与实施顺序

| 顺序 | 项 | 依赖 | 理由 |
|---|---|---|---|
| 1 | P0① 上下文权限裁剪 | 无 | 架构级，先打通「权限即架构」 |
| 2 | P1④ 对象级 ACL | P0①（同一谓词链） | 扩展同一条过滤链 |
| 3 | P0② 脱敏中间件 | 角色体系（已有） | 展示层，独立 |
| 4 | P1③ 字段历史视图 | P0①（越权谓词） | 复用过滤链 + timelineSource |

**建议**：四项可分 2 批 commit（①+④ 一批「权限链」，②+③ 一批「展示与脱敏」），每 Task 一 commit（铁律）。

---

## §5 风险与守卫

| 风险 | 守卫 |
|---|---|
| 上下文裁剪过度 → Agent 看不到必要上下文 | fail-open：`scopeModel='all'` 零过滤；裁剪失败留痕 `emit('trace')` 不阻断装配 |
| 脱敏误伤决策链 | 脱敏**只读展示层**，审计/决策始终存真实值；`mask-fields` 配置化可随时调 |
| 字段历史越权 | 后端投影复用 P0① 谓词（同源过滤） |
| visible_roles 误配置锁死数据 | `visible_roles` 空数组=不限制（缺省）；`confidential=false` 不缺省锁定；配置变更走审计可回查 |
| 与既有测试冲突 | 每项配独立 test 文件（L2 单测）；全量回归 flaky 时单次红不直判 |

---

## §6 验收口径（L1-L4）

- **P0①**：L2 单测（self 命中过滤 / domain 命中过滤 / all 零变化 / 越界叙事 scope-excluded）；L4 生产 ≥1 agent 决策上下文里不含 data_scope 外粒子。
- **P1④**：L2（visible_roles 过滤命中 / confidential 隐式限制 / 变更触发 audit）；L4 生产 ≥1 粒子带 visible_roles。
- **P0②**：L2（个人字段默认*** / 商业字段仅 exec 可见 / 配置化字段表）；L4 生产敏感端点出参无明文敏感值。
- **P1③**：L2（字段投影 before/after / 越权空 / 无数据返回空）；L4 生产 ≥1 字段时间线渲染。

---

## §7 下一步

1. 请评审本设计（§3 改动点 + §A 契约）。
2. 批准后移交 **writing-plans**（每项一个 Task，各带契约），再进入实施。
3. 本设计未写任何实现代码（HARD-GATE 遵守）。

---

*设计来源：docs/2026-09-05-attio-lightfield-security-study.md §6 ｜ 2026-09-05*
