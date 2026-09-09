# 审批失效根治 + 写入侧两缺陷修复（设计文档）

- 日期：2026-09-09
- 触发：用户报「起单即通过，presales 和 manager 没有任何人签批。这不是审批通过，是审批失效」
- 状态：**待批准**（未动 `src/` 任何实现代码）
- 审批失效修复路径：**方案 B · 代码根治 + approvers 透传**（用户 2026-09-09 拍板）

---

## §0 结论与红线声明

**结论**：审批失效成立，且根因链比初报深一层——不只是引擎判定顺序，而是「流定义 `auto_allowed` 开关 → 50 条规则落 `AUTO_PASS` → 引擎把 `AUTO_PASS` 排在 ROLE 之前 → 起单 Action 恒传空审批人」四环叠加。**出厂默认全是对的**（`ASSIGN_ADMIN`），是运行期开关把语义翻掉了。

**先行红线声明（先于任何修改）**：

1. ⛔ **绝对禁 DELETE**：失效期产生的 3 个脏实例只能标记/作废，**不得删除**。
2. ⛔ **生产库写操作需用户显式 HITL 授权**：本设计在方案 B 下**零生产数据迁移**（这是选 B 而非 A 的关键收益）；脏实例处置属独立决策，需你单独拍板。
3. ⛔ 不改 `src/context/routing.js`（context-routing 红线）。本设计**不触碰**该文件。
4. 🟡 **1 条既有测试的前提已过期**（`test/approval-engine.test.js:81-91`），需连同固件改写——详见 §1.6，属正当修改但需你确认。

---

## §1 缺陷一：审批失效（P0）

### 1.1 根因链（代码级 + 生产数据）

| # | 位置 | 事实 | 性质 |
|---|---|---|---|
| ① | `src/approval/engine.js:77-78` | `const action = …; if (action === 'AUTO_PASS') return { auto_pass: true };` 排在 ROLE(`:80`)/SPECIFIC_PERSON(`:83`) **之前** | 🔴 判定顺序错 |
| ② | `src/action/seed-actions.js:1277` | `startInstance(flow_id, …, { submitter, tenantId })` —— **`approvers` 不透传**，缺省 `[]` | 🔴 恒进空审批人分支 |
| ③ | `src/approval/engine.js:125` | `resolveNodeApprover` 末尾 `resolveApprovers(approverRule, { submitter, approvers: [] })` —— `approvers` 硬编码空 | 🔴 `resolveApprovers` 的 `approvers` 实参**恒为空**（死参数） |
| ④ | `src/approval/flow.js:143` | `empty_approver_action: s.auto_allowed ? 'AUTO_PASS' : 'ASSIGN_ADMIN'` | 🔴 50 条 AUTO_PASS 的来源 |
| ⑤ | 生产数据 | 63 条 `CRM_APPROVAL_APPROVER` 中 **50 条 AUTO_PASS**（sales 18 / manager 13 / presales 6 / contract_admin 6 / finance 6 / admin 1），13 条 ASSIGN_ADMIN | 🔴 实测坐实 |
| ⑥ | 生产数据 | 3 个实例带 `auto_pass_reason` 直接 APPROVED：`bf454b96`(submitter=alice)、`49e73998`(admin)、`6ad02eed`(admin)，**均为 CRM_QUOTATION** | 🔴 失效产物 |

**关键反差（决定为何选 B 而非 A）**：

| 事实源 | 默认值 |
|---|---|
| `src/approval/flow.js:31` `empty_approver_action` 形参默认 | `ASSIGN_ADMIN` |
| `db/seed.sql:385-426` 全部 12 条种子规则 | `ASSIGN_ADMIN` |
| `src/approval/approvalConfig.js:41` 全局 `defaultEmptyApproverAction` | `ASSIGN_ADMIN` |

→ **出厂语义正确**，是运行期 `auto_allowed` 开关把 50 条翻成 `AUTO_PASS`。**只改数据不改代码，债必然再生**——这是选 B 的核心依据。

### 1.2 语义还原判定表（`resolveApprovers` 修复前 → 修复后）

| 规则配置 | 调用方 approvers | 修复前 | 修复后 |
|---|---|---|---|
| 任意 | 非空 | 原样返回 | 不变 |
| `AUTO_PASS` + `ROLE:manager` | `[]` | `{auto_pass:true}` ❌ 架空 | `['role:manager']` ✅ |
| `AUTO_PASS` + `SPECIFIC_PERSON` | `[]` | `{auto_pass:true}` ❌ 架空 | `[assigned_to]` ✅ |
| `AUTO_PASS` + **无 type / role 为空** | `[]` | `{auto_pass:true}` | `{auto_pass:true}` 不变（字段本意） |
| `ASSIGN_ADMIN` + `ROLE:manager` | `[]` | `['role:manager']` | 不变 |
| `ASSIGN_ADMIN` 且无 ROLE | `[]` | `['role:admin']` | 不变 |
| `ASSIGN_SPECIFIC` | `[]` | `[assigned_to]` 或 admin | 不变 |

**语义还原**：`empty_approver_action` 回归「**规则解析不出审批人时**怎么办」。配了 ROLE 就是有审批人，`AUTO_PASS` 不该介入。

### 1.3 逐行改造

**改动 1 —— `src/approval/engine.js:73-91`（核心，约 12 行重排）**

```js
// 审批人解析：显式 approvers → 节点规则（ROLE/SPECIFIC_PERSON）→ 才轮到 empty_approver_action
// 顺序铁律（2026-09-09 审批失效根治）：empty_approver_action 的语义是「审批人为空时怎么办」，
//   只有当节点规则确实解析不出审批人时才生效。旧实现把 AUTO_PASS 排在 ROLE 之前，
//   导致配置了 role:presales/role:manager 的 50 条规则被整体架空（起单即 APPROVED）。
function resolveApprovers(approverRule, { submitter, approvers = [] }) {
  if (approvers.length) return approvers;
  // ① 节点规则（默认指派）：ROLE / SPECIFIC_PERSON —— 有审批人即返回，AUTO_PASS 不介入
  if (approverRule.payload.approver_type === 'ROLE' && approverRule.payload.role) {
    return [`role:${approverRule.payload.role}`];
  }
  if (approverRule.payload.approver_type === 'SPECIFIC_PERSON' && approverRule.payload.assigned_to) {
    return [approverRule.payload.assigned_to];
  }
  // ② 走到这里 = 审批人确实为空 → 才应用 empty_approver_action 兜底
  const action = approverRule.payload.empty_approver_action || getDefaultEmptyApproverAction();
  if (action === 'AUTO_PASS') return { auto_pass: true };
  if (action === 'ASSIGN_ADMIN') return ['role:admin'];
  if (action === 'ASSIGN_SPECIFIC') {
    return approverRule.payload.assigned_to ? [approverRule.payload.assigned_to] : ['role:admin'];
  }
  return [];
}
```

**改动 2 —— `src/action/seed-actions.js` `crm-approval-start`（约 6 行）**

```js
    schema: { flow_id: 'string', business_type: 'string', business_id: 'string', ctx: 'object', approvers: 'array' },
    parameters: {
      required: ['flow_id', 'business_type', 'business_id'],
      properties: { approvers: { type: 'array', items: { type: 'string' }, description: '显式审批人/审批链（如 ["role:presales","role:manager"]）；省略则按流配置解析' } },
    },
    handler: async ({ flow_id, business_type, business_id, ctx, approvers }, actionCtx) => {
      const { startInstance } = await import('../approval/engine.js');
      const inst = await startInstance(flow_id, business_type, business_id, ctx || {}, {
        submitter: actionCtx.actor, tenantId: actionCtx.tenantId,
        approvers: Array.isArray(approvers) ? approvers : [],
        requireFullChain: Array.isArray(approvers) && approvers.length > 0, // 显式指定 → 拒绝链长不足（fail-closed）
      });
      …
```

> `jsonSchemaToZod`（`src/mcp/tools.js:25`）已支持 `'array'` → `z.array(z.any())`，且 `line_items`/`rows`/`tags` 等数组参数有既有先例，**不会被 strip**。

**改动 3 —— `src/approval/engine.js:150` `startInstance` 签名 + fail-closed 校验（约 8 行）**

```js
export async function startInstance(flow_id, business_type, business_id, ctx,
  { submitter, approvers = [], tenantId = 'system', requireFullChain = false }) {
  …
  // 调用方显式指定审批链但长度不足以覆盖全部 APPROVER 节点 → 拒绝起单。
  // 背景：resolveNodeApprover 在「链已尽」时对剩余节点返回 auto_pass（engine.js:119，
  //   分级审批 T1 单签的既定语义，不可改）。若显式链也走这条路，等于开了一条新的静默跳审通道。
  if (requireFullChain && approvers.length > 0 && approvers.length < totalApprovers) {
    throw new Error(
      `审批链长度 ${approvers.length} 少于审批节点数 ${totalApprovers}（flow=${flow_id}）：` +
      `显式指定审批人时必须覆盖全部节点，否则剩余节点会被静默跳过（fail-closed）`);
  }
```

**改动 4 —— `src/approval/engine.js:109` `resolveNodeApprover` 形参补 `approvers` 透传（可选，1 行）**

`resolveNodeApprover` 末尾（`:125`）当前硬编码 `approvers: []`。为使「节点级显式审批人」语义可用，改为接收并透传；**默认 `[]` 时行为与现在完全一致**，零回归风险。

### 1.4 明确**不改**的三处（避免误伤既定语义）

| 位置 | 现状 | 为何不改 |
|---|---|---|
| `engine.js:119` 链已尽 → `auto_pass` | 分级审批 T1 单签：链只含 manager，总监/总裁节点跳过 | 是**分级审批的既定语义**，改了会越级。改由改动 3 在显式指定路径上 fail-closed 拦截 |
| `engine.js:95-97` `fallbackNoApprover` | 无 approverRule 时读全局默认 | 与本次无关，语义正确 |
| `engine.js:112-124` tier 链路径 | 金额档位分发 | 独立路径，不受 reorder 影响 |

### 1.5 存量脏数据处置（**需你单独拍板**，本设计默认不动）

3 个失效期直接通过的实例（均 `CRM_QUOTATION`）：

| 实例 | submitter | 建议 |
|---|---|---|
| `bf454b96…` | alice | 待定 |
| `49e73998…` | admin | 待定 |
| `6ad02eed…` | admin | 待定 |

可选口径（**均禁删**）：① 打 `invalid=true` 标记保留审计；② 走 `withdrawInstance` 撤回到 `CANCELED`，业务侧重走审批；③ 原样保留仅出报告。
→ 本设计**默认选 ③（不动，先出报告）**，等你定。

### 1.6 测试影响（已逐文件核验）

| 文件 | 断言内容 | 影响 |
|---|---|---|
| 🔴 `test/approval-engine.test.js:81-91` | 固件 `ROLE:contract-admin` + `AUTO_PASS` + `approvers:[]`，**断言 `status === 'APPROVED'`** | **会红**。该固件名为「审批人为空自动通过」，实则配了 `role:contract-admin`（审批人非空）——**它测的正是被扭曲的语义**。需拆成两条：① 真·无审批人（去掉 role/approver_type）→ 仍 `APPROVED`；② `AUTO_PASS` + ROLE → 断言 `APPROVING`（新锚点） |
| 🟢 `test/approval-flow.test.js:47-53` | 只断言 `approver.payload.empty_approver_action === 'AUTO_PASS'`（payload 值，不跑引擎） | 不受影响 |
| 🟢 `test/approval-flow-e2e.test.js:48-49` | 同上，断言 payload 值 | 不受影响 |
| 🟢 `test/approval-flow-wiring.test.js:38,40` | 同上 | 不受影响 |
| 🟢 `test/approval/engine-node-advance.test.js:139` | 断言落在 APPROVER 不 auto_pass | 修复后更稳，不受影响 |
| 🟢 `test/approval-engine.test.js:109` SEQUENTIAL | `approvers:['role:manager','role:director']`，单节点流 | 走 tier 路径（N=1 全链落当前节点），不受影响 |

**新增用例（必写）**：
1. `AUTO_PASS` + `ROLE:presales` → 起单为 `APPROVING`，生成 1 条 `role:presales` TODO 任务（**审批失效的反锚点**）
2. 真·无审批人（`approver_type` 缺省）+ `AUTO_PASS` → `APPROVED`（语义保留）
3. `crm-approval-start` 传 `approvers` → 落库为实例 `tier_approvers` 且生成对应 TODO
4. `requireFullChain` 且链长 < 节点数 → 抛错拒绝起单（fail-closed 锚点）

---

## §2 缺陷二：confirm_token 冻结 phase1 参数，phase2 增补字段被丢弃（P1）

### 2.1 根因

`src/mcp/gateway.js`：

```js
:88  function issueSession(action, kind, params, ctx) { … confirmSessions.set(token, { action, kind, params, … }) }  // phase1 冻结
:193 const confirm_token = issueSession(actionName, 'write', params, ctx);
:251 const ctx = await buildMcpCtx({ token: extractToken(params, headers), … });   // phase2 的 params 只用来取 token
:253 const r = await actionExecutor.dispatch(session.action, session.params, ctx); // ← 执行用的是 phase1 冻结值
```

phase2 传入的 `params` **仅用于 `extractToken`**，执行一律用 `session.params`。用户看到的确认表单基于 phase1 参数，执行阶段补的明细（基础/标准档定价明细）**被静默丢弃**。

**旁证**：`gateway.js:18` 定义了 `hashParams()`，但 `:298` 是 `void hashParams;` —— **死代码**，说明原设计意图做参数一致性校验，从未接线。

### 2.2 方案（推荐：**只允许增补，禁止覆盖**）

三个候选：

| 方案 | 行为 | 评价 |
|---|---|---|
| ① 全量合并 `{...session.params, ...phase2Params}` | phase2 可覆盖已展示字段 | ❌ 削弱确认语义：用户看到 A 执行 B |
| ② 严格：phase2 一律拒绝额外参数 | 必须重走 phase1 | ⚠️ 安全但体验差，且本次场景（补明细）需重来 |
| ③ **只增补，禁止覆盖**（推荐） | phase1 已出现的键不可改（用 `hashParams` 校验，不一致 → 拒绝并提示重走 phase1）；phase1 未出现的键允许补入 | ✅ 兼顾安全与便利；顺带把死代码 `hashParams` 接线 |

**改动（约 15 行，`src/mcp/gateway.js`）**

```js
// phase2 参数合并：只增补、不覆盖（confirm 语义保护）
// 已展示给用户的字段（phase1 params）不允许在执行阶段被改写——否则「用户确认 A、实际执行 B」。
// phase1 未出现的键允许补入（如分段提交的明细行），解决「确认表单只带基础字段、明细丢失」。
function mergePhase2Params(session, phase2 = {}) {
  const p1 = session.params || {};
  const add = {};
  let conflict = null;
  for (const [k, v] of Object.entries(phase2)) {
    if (k === 'confirm_token' || k === 'api_token' || k === 'choice' || k === 'switched_role') continue; // 协议位不参与
    if (Object.prototype.hasOwnProperty.call(p1, k)) {
      if (hashParams(p1[k]) !== hashParams(v)) conflict = k;   // 覆盖已展示字段 → 冲突
    } else add[k] = v;                                        // 新键 → 允许增补
  }
  return { params: { ...p1, ...add }, conflict };
}
```

`mcpConfirmPhase2` 内（`:251` 之后、`:253` 之前）调用；`conflict` 非空 → 返回 `{ ok:false, gate:'confirm_params_conflict', error:\`字段 ${conflict} 与确认时展示的值不一致，请重新发起确认\`（confirm 语义保护）`，**不执行**。

**验收**：MCP E2E —— phase1 带 `{name:'X'}` → phase2 带 `{name:'X', line_items:[…]}` → 落库含 `line_items`；phase2 带 `{name:'Y'}` → 拒绝且 `gate==='confirm_params_conflict'`。

---

## §3 缺陷三：粒子与属性写入不同事务，并发 `meta_attr_pkey` 冲突留孤儿粒子（P1）

### 3.1 根因

`src/particles/particleRepo.js:108` 先 `INSERT INTO particles`（提交），`:122` 才调 `ensureAdaptiveRegistration`；后者在 `src/metaAttr/metaAttrRepo.js:123-131` 是 **check-then-act**：

```js
const exists = await getMetaAttr(particleType, slug, tenantId);   // SELECT
if (exists) continue;
await queryWrite(`INSERT INTO crm.meta_attr … WHERE NOT EXISTS (…)`);  // INSERT（另一条连接）
```

两次查询**无事务包裹**：并发下同 `slug` 双双通过 EXISTS 检查 → 双双 INSERT → 撞 PK 抛错 → **粒子已在 `:108` 落库，成为孤儿**（本次产物：`6b3f6f8f…` 重复报价）。

主键已确认为 `(particle_type, attr_slug, tenant_id)`（`db/migration-meta-attr-tenant-pk.sql:27`），可直接用 `ON CONFLICT`。

### 3.2 方案（推荐：**DB 层消除竞态**为主，非事务包装）

| 方案 | 做法 | 评价 |
|---|---|---|
| ① `withTx` 包住粒子 INSERT + 属性登记 | 需给 `ensureAdaptiveRegistration` 增加 client 透参，改造面中等 | ⚠️ 且 `createParticle` 后续还有 embedding/审计/AGE 图/AI 属性等**故意 fail-open 的非事务副作用**，全包进事务会把它们变成阻塞点 |
| ② **`ON CONFLICT (particle_type, attr_slug, tenant_id) DO NOTHING`**（推荐） | 单条 SQL 改造，DB 层保证幂等 | ✅ 竞态在数据库层消除，冲突不再抛错 → 不再产生孤儿；改动最小、零新增参数 |

**改动（约 6 行，`src/metaAttr/metaAttrRepo.js:118-138`）**

```js
    // 并发安全（2026-09-09）：原实现 SELECT 检查 + INSERT（WHERE NOT EXISTS）是 check-then-act，
    // 两个事务可同时通过检查 → 撞 meta_attr_pkey 抛错 → 而粒子已在 particleRepo.js:108 落库 → 孤儿粒子。
    // 改为 DB 层幂等：主键 (particle_type, attr_slug, tenant_id) 直接 ON CONFLICT DO NOTHING，
    // 竞态在数据库层消解，失败不再抛错上抛。
    await queryWrite(
      `INSERT INTO crm.meta_attr
         (particle_type, attr_slug, title, attr_type, semantic_tag, source, enabled, version, created_by, tenant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (particle_type, attr_slug, tenant_id) DO NOTHING`,
      [rec.particle_type, rec.attr_slug, rec.title, rec.attr_type, rec.semantic_tag,
       rec.source, rec.enabled, rec.version, rec.created_by, tenantId]
    );
```

保留 `getMetaAttr` 预检（用于跳过 `registered.push` 与避免无谓写），但不再依赖它做正确性保证。

**补充（可选，建议同批）**：`ensureAdaptiveRegistration` 外层加 `.catch` 兜底已在调用方 fail-open？——经核 `particleRepo.js:122` 是裸 `await`，**建议改为 `await ensureAdaptiveRegistration(…).catch(() => [])`**，使「属性登记失败」不再阻断主写（与同文件 `ensureAgeSync(…).catch(()=>{})` 的既有风格一致）。

**验收**：并发 20 次同类型同 slug 建档 → 无异常抛出、无孤儿粒子、粒子数 = 请求数、`meta_attr` 仅 1 行。

**存量孤儿**：`6b3f6f8f…` 已按禁删红线打 `invalid=true`，本设计**不新增删除动作**。

---

## §4 不在本轮范围

1. **自审自 P1**（`src/http/workbenchRouter.js:83` `matchApprover` 缺 `submitter ≠ approver`）—— 与审批失效**同源但独立**：修复后审批真正生效，若 `role:sales` 命中提交人本人会出现「自己提交自己审」。建议紧随本轮另立一轮。
2. `auto_allowed` 开关的 UI 侧警示（勾选「自动通过」时二次确认）—— 建议后续产品侧收敛。
3. 50 条 `AUTO_PASS` 数据的清洗 —— 方案 B 下**不需要**（代码层已还原语义）；若你希望数据层也回归 `ASSIGN_ADMIN` 以消除运维误解，可另立数据迁移。

---

## §5 验收标准

| # | 项 | 判据 |
|---|---|---|
| 1 | 审批失效反锚点 | `AUTO_PASS` + `ROLE:presales` 起单 → `APPROVING` + 1 条 `role:presales` TODO |
| 2 | 语义保留 | 真·无审批人 + `AUTO_PASS` → `APPROVED` |
| 3 | 透传 | MCP `crm-approval-start` 带 `approvers` → 实例 `tier_approvers` 落库 + 对应 TODO 生成 |
| 4 | fail-closed | 显式链长 < 节点数 → 抛错拒绝起单，不产生实例 |
| 5 | confirm 增补 | phase2 新键落库；覆盖已展示键 → `confirm_params_conflict` 拒绝 |
| 6 | 并发幂等 | 20 并发同 slug 建档无异常、无孤儿、`meta_attr` 1 行 |
| 7 | 回归 | `test/approval*` + `test/mcp` + `test/action` + `test/particles` + `test/metaAttr` 全绿（**严格串行**，共享测试库禁并发） |
| 8 | 真实 E2E | 独立实例（非 3000/3100，如 3111）+ `alice` token，起单 → 断言 presales/manager 待办**真实生成** |

---

## §6 自查

- [x] 无占位符、无矛盾（§1.4 显式列出「不改」清单，与 §1.3 无冲突）
- [x] 范围封闭：三个缺陷各自独立可验收；§4 显式声明不在本轮范围
- [x] 红线：禁 DELETE ✅（`6b3f6f8f` 只标记不删）、生产写需 HITL ✅（方案 B 零生产迁移）、不碰 `routing.js` ✅
- [x] 测试影响已逐文件核验（§1.6），1 条需改写已显式告知
- [x] 所有引用附 `file:line`
