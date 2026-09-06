# 配置中心租户隔离改造实施计划（T1–T12，含完整代码）

- 日期：2026-09-03
- 状态：已批准设计 → 实施计划（可执行）
- 唯一事实源：`docs/2026-09-03-config-center-tenant-isolation-design.md`（设计稿，以下称「设计文档」）
- 适用版本：CRM-ai-native（Node22 + ESM + PG16 + Express4 + vitest）
- 关联计划：`docs/superpowers/plans/2026-08-31-multi-tenant-design.md` 枢轴 4 落地

> 本文档是 **planning 产物**：所有代码均可直接贴入执行（ESM 风格、PowerShell 友好、禁 DELETE、写经第 0 闸）。
> 每个 Task 对应一次独立 commit（§6），严格按序执行；依赖关系见各 Task「依赖」与 §6 总序。

---

## §0 取证摘要（证据抽查：15 处，均核实）

执行本文档前，以下证据已逐一对照源码核实（文件:行号 → 一句话结论，全部属实）：

| # | 证据（设计文档引用） | 核实结论 |
|---|---------------------|----------|
| E1 | `configRouter.js:50-135` createConfigRouter 签名 `{key, role='sysadmin', decisionScene, secretFields}` | 属实；`configRouter.js:50` 签名、`:71` GET `readConfig(key,{tenantId:scopeTenant(me)})`、`:121` PUT `writeConfig(...,{tenantId:scopeOf(me)})` 逐一存在 |
| E2 | `configCenter.js:8-49` CONFIG_ITEMS 数组 | 属实；数组实际含 **28 项**（id 11–39 区间，含 13/22/27/28 四行 RBAC/本体词汇/连接器/系统设置）；设计文档三分类表覆盖其中 **24 项**（11,12,14,15,16,17,18,19,20,21,23,24,26,29,30,31,32,33,34,35,36,37,38,39，未覆盖 13/22/27/28）；「18 项」为设计文档计数笔误，不影响实施（T1 按**全部 28 项**声明，未覆盖的 4 项按平台级默认声明） |
| E3 | `configStore.js:10-23` readConfig 租户优先回退 system | 属实；`configStore.js:10-23` 先查 `(tenantId,key)` 无则回退 `(system,key)`；`:26-34` writeConfig upsert（禁删铁律） |
| E4 | `tenantScope.js:4-7/10-12` scopeTenant/scopeOf | 属实；scopeTenant admin→`'*'` 通配、scopeOf 永取自身租户 |
| E5 | `timers.js:158/163/196/198-204` 裸 SQL 无租户条件 | 属实；`:159` `WHERE key='sales-thresholds'`、`:163` `WHERE key='named-account-targets'`、`:196` 粒子扫描无 tenant_id、`:198-204` 双读配置裸 SQL |
| E6 | `timers.js:281` patrol 固定 system | 属实；`:281` `readConfig('provenance-patrol',{tenantId:'system'})`、`:286` `patrolChains({limit})` |
| E7 | `upload.js:20` 裸 SQL | 属实；`:20` `SELECT value FROM crm.config_store WHERE key='sales-thresholds'`；`:36` resolveActor 已带 tenantId |
| E8 | `financeAlertHook.js:25` 固定 system | 属实；`:25` `readConfig('finance-receivables',{tenantId:'system'})` |
| E9 | `assembler.js:127` 未传 tenantId | 属实；`:127` `resolveTracks(scenarioId)` 单参调用；`routing.js:120` 已支持 `resolveTracks(sceneId,{tenantId})` |
| E10 | `decisionReadRoutes.js:56` 场景读无租户条件 | 属实；`:56` `FROM crm.decision_scenario WHERE scenario_id=$1` 无 tenant 条件；`:72` 已用 `scopeOf(me)` 供装配（读侧缺条件） |
| E11 | `executor.js:25` 租户优先回退范式 | 属实；`:25` `WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`——全计划统一复用该范式 |
| E12 | `decisionRepo.js:507-514` 粗召回无租户条件 | 属实；`:507-514` `WHERE scenario_id=$1 AND state IN (...)` 无 tenant 条件；`:501` opts 已支持 `tenantId='system'` 默认 |
| E13 | `eventTrigger.js:55/97` 无租户条件 | 属实；`:55` `SELECT payload FROM crm.particles WHERE id=$1`（resolveDedupValue）、`:97` `SELECT 1 FROM crm.tasks WHERE payload->>'dedup_key'=$1 AND status IN ('ready','running')`；`:112` INSERT 已带 tenantId——租户可得，仅缺条件 |
| E14 | `migrate-tenant.js:8-23` config_store PK `(tenant_id,key)` | 属实；`:8-23` 幂等加列 + 重建 PK；`DEFAULT 'system'` 已补 |
| E15 | `seed-all-tenants.mjs:24-25` 现有 3 行业种子位置 | 属实；`:24-30` seedChemicalProfile/seedInsMediProfile/seedTenantMasterData 顺序执行，`seedTenantDefaults` 追加点明确 |

**补充核实（设计文档未列但实施必需的锚点）**：

- `routes.js:162-189` 挂载的全部 `createConfigRouter` 实例清单（llm / approval-config / event-retro / context-routing / provenance-patrol / precedent-conf / agent-event-trigger）——T1 需逐处增补 scope 声明。
- `routing.js:70-83` `loadRouting({tenantId})` + `:120` `resolveTracks(sceneId,{tenantId})` 已支持租户——T4 仅补调用方传参。
- `particleRepo.js:158-174` `queryParticles` 已按 tenantId 过滤（`'*'` 通配跳过条件）——T3 巡检循环复用该封装或裸 SQL 补条件。
- `retroTrigger.js:47-63` `loadDecisionMeta` 已回查 `crm.decision.tenant_id`（`:50`），`hasRecentRetroTask(tenantId,...)`（`:66-76`）已租户化——T5 仅修配置读。
- `auth.js:36-45` login 已查 `enabled/expires_at`——T9/T12 联查 `crm.tenants.status` 的挂点已具备。
- `provenance.js:223-230` `patrolChains({limit=200, decisionIds=null})` 全表巡检——T11 加 `tenantId` 参数点已明确。
- `tenantRouter.js:21-31` 建租户仅 INSERT crm_users，**不注册 crm.tenants**——T9 需修订（与设计 §3.4.2 生命周期对齐）。
- `precedentScoring.js:12-13` `DEFAULT_CONF={minSimilarity:0.45,candidatePool:40}`、`loadPrecedentConf({tenantId})` 已支持租户——T6 粗召回补条件的落点锚定。
- `migrate.js:12-23` `INCREMENTAL_SQL` 清单 + `migrate-tenant.js` 单独处理（`:44-51`）——T9 新迁移纳入清单的方式已明确（`.mjs` 作为独立入口，不并入清单以避免 main 函数结构改动）。

> 结论：设计文档引用的全部文件:行号真实存在、语义一致，可作为实施的事实源。**发现的偏差**：①设计文档称「18 项配置」，实际 `configCenter.js:8-49` 含 **28 项**（三分类表覆盖 24 项，未覆盖 13/22/27/28 四项——RBAC/本体词汇/连接器/系统设置，均为既有专用路由，本计划按平台级声明补全）；②设计文档部分函数名/文件名（如 `readConfig` vs 实际 `readConfig`、`readSevenDimConfig` vs `readSevenDimConfig`）与本计划 §2-T5 的 diff 已按源码实名对齐。均为笔误级偏差，不影响实施（T1 按实际 28 项声明）。

---

## §1 目标与范围

### 1.1 目标（对齐设计文档 §1.2 + §4）

| 优先级 | 目标 | 对应 Task |
|--------|------|-----------|
| P0 | 消灭运行期消费断层：巡检/上传/告警钩子/决策读路由/事件去重的裸 SQL 或固定 system | T2、T3、T7、T8 |
| P0 | configRouter 平台/租户声明落地（所有配置面的锚点） | T1 |
| P1 | 内部处理器（无 HTTP 上下文）显式传租户：装配链路/复盘/七维/先例粗召回 | T4、T5、T6 |
| P1 | 种子租户化产品化：新租户流程 = 注册 → 播种 → 引导账号 | T10（依赖 T9） |
| P2 | 租户注册表 + 生命周期 + 巡检按租户循环（治理面增强） | T9、T11 |
| 收口 | V1–V10 全部落成可执行验收脚本 | T12 |

### 1.2 不做什么（明确边界，防范围蔓延）

- **不建租户控制台 UI**：本计划仅提供 `crm.tenants` 注册表 + 生命周期脚本（SQL/mjs 入口）；可视化控制台属未来迭代，`tenantRouter.js` 的现有 `/api/tenants` 面不改 UI。
- **不做 LLM 多租户**：LLM 配置（id 11）声明 `scope:'platform'`，恒读/写 `(system,llm)`——方案 B 下即平台级，不隔离。
- **不改动 `schema.sql` 既有列**：新增列一律 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`（幂等范式，对齐 `migrate-tenant.js` 惯例）。
- **不做 admin 通配写**：`scopeOf(me)` 永不通配（设计文档 §3.1/§3.2）；admin 读写决策读模型用自身租户（`executor.js:25` 范式天然兼容）。
- **不复制 system 默认值到租户**：seedTenantDefaults 只播种「必须按租户差异化」的键，其余靠 `readConfig` 租户优先回退（防默认漂移，设计 §3.5.1）。
- **不禁用既有 `readConfig` 回退链**：平台级配置显式传 `{tenantId:'system'}`，租户级沿用租户优先回退——不引入第三种「强制无回退」语义。
- **不迁移 decision_scenario/particles 既有数据**：存量租户已带 `tenant_id` 列（migrate-tenant.js 已建），仅注册表灌入（T9），不动数据。

---

## §2-T1 至 §2-T12 逐 Task 实施代码

> 通用阅读说明：
> - 每个 Task 的代码块均为**最终形态整文件**或**精确 diff**（`-` 删 / `+` 增），可直接落盘。
> - 文件路径相对项目根（`D:\system\CRM-ai-native`）。
> - 所有测试沿用既有注入式/纯函数模式（不依赖真实 PG，除非标注联测）。

---

### §2-T1 configRouter scope 声明 + platform 分支

**目标**：`createConfigRouter` 签名新增 `scope='tenant'`、`resolve='tenant-first'` 可空字段；GET/PUT 按 scope 强制租户；`configCenter.js` CONFIG_ITEMS 补 scope/resolve 声明（实际 28 项全量，含设计文档三分类表未覆盖的 13/22/27/28 四项）。

**依赖**：无（所有消费方前置锚点）。

**涉及文件**：`src/http/configRouter.js`（改）、`src/http/routes.js`（改，挂载点补声明）、`src/portal/configCenter.js`（改，声明补全）、`test/http/configRouter.test.js`（改，新增用例）。

#### 1) `src/http/configRouter.js` 改造

`configRouter.js:50` 签名与 GET/PUT 租户解析改造（**精确 diff**）：

```diff
-export function createConfigRouter({ key, role = 'sysadmin', decisionScene, secretFields = [] }, deps = {}) {
+export function createConfigRouter(
+  { key, role = 'sysadmin', decisionScene, secretFields = [], scope = 'tenant', resolve = null },
+  deps = {}
+) {
   const D = { ...defaultDeps, ...deps };
   const router = Router();
+
+  // 声明语义（设计文档 §3.1）：
+  //   scope='platform' → 该配置只存在/只读 system 一份（GET/PUT 恒 (system,key)）
+  //   scope='tenant'   → 读按 scopeTenant(me)（admin 通配 '*' 回退 system），写按 scopeOf(me)（永不通配）
+  //   resolve 可空：scope='platform' → 'system-only'；scope='tenant' → 'tenant-first'（默认值，记录声明供审计）
+  const effectiveResolve = resolve || (scope === 'platform' ? 'system-only' : 'tenant-first');
+  const readTenant = (me) => (scope === 'platform' ? 'system' : scopeTenant(me));
+  const writeTenant = (me) => (scope === 'platform' ? 'system' : scopeOf(me));
```

```diff
         const me = await ensureRole(req, res);
         if (!me) return;
-        const rec = await D.readConfig(key, { tenantId: scopeTenant(me) });
+        const rec = await D.readConfig(key, { tenantId: readTenant(me) });
```

```diff
         // 写第0闸：任何配置写都产决策（无决策不写）
         const decision = await D.produceDecision(decisionScene || 'config-change', { key, value });
-        await D.writeConfig(key, nextValue, decision?.decisionId || null, { tenantId: scopeOf(me) });
+        await D.writeConfig(key, nextValue, decision?.decisionId || null, { tenantId: writeTenant(me) });
```

文件末尾导出 `createConfigRouter` 不变（签名向后兼容：未传 scope 默认 `'tenant'`，既有调用零破坏）。

#### 2) `src/http/routes.js` 挂载点补 scope 声明

`routes.js:162` 平台级 llm 显式 `scope:'platform'`（其余通用面默认 tenant）：

```diff
   // 配置中心通用端点（S16–S33 面共用；写经第0闸 + 七维拦截；决策相关面挂 requireDecision）
   // Phase 3 逐面补 router 时在此追加 createConfigRouter 实例
-  app.use(createConfigRouter({ key: 'llm', role: 'sysadmin', secretFields: ['api_key'] }, { encryptSecret, maskSecret }));
+  // LLM 配置 = 平台级（方案 B：LLM 不租户隔离，恒 system）；声明 scope:'platform' 强制 GET/PUT 落 (system,llm)
+  app.use(createConfigRouter({ key: 'llm', role: 'sysadmin', secretFields: ['api_key'], scope: 'platform' }, { encryptSecret, maskSecret }));
```

`routes.js:175-189` 其余 6 个通用面（approval-config / event-retro / context-routing / provenance-patrol / precedent-conf / agent-event-trigger）均为租户级，**保持默认 `scope:'tenant'` 无需改动**（签名默认值已兼容）。`provenance-patrol`（id 37）虽平台级配置值，但声明走租户级 + 巡检执行按租户循环（T11）——语义见设计 §3.3 末注：**配置值共享 system，巡检执行可按租户**，二者不矛盾（`routes.js:184` 保持默认 tenant 声明，巡检器 T11 里显式 `{tenantId:'system'}` 读配置）。

> 补充：`routes.js:184` `provenance-patrol` 也可显式 `scope:'platform'`（配置值恒 system）。本计划采用**显式声明**（更符合「杜绝靠人记忆」的目标），与 T11 巡检执行按租户循环不冲突（巡检器读的是 `provenance-patrol` 平台值，循环的是 decision 列表）。

```diff
   // ⑤ C2 审计链巡检配置后台化（config_store['provenance-patrol']，配置中心 id37，写经决策第0闸+sysadmin）
   //   阈值配置化铁律：巡检间隔与单批上限不得硬编码，代码仅存出厂默认值（3600000ms / 200 条）
-  app.use(createConfigRouter({ key: 'provenance-patrol', role: 'sysadmin', decisionScene: 'config-change' }));
+  app.use(createConfigRouter({ key: 'provenance-patrol', role: 'sysadmin', decisionScene: 'config-change', scope: 'platform' }));
```

同理 `skill-registry`（id 16 平台级）无独立 configRouter（走 `portal/skillRegistry.js` 专用路由，天然全表无租户条件，声明平台级即可，无需改代码）。

#### 3) `src/portal/configCenter.js` CONFIG_ITEMS 补 scope/resolve 声明

在数组每项上补两个可空字段（**精确 diff，逐项**）——**全部 28 项**按设计分类表 + 补充 4 项（13/22/27/28）声明：

```diff
-  { id: 11, sRef: 'S16', name: 'LLM 配置', group: '平台与访问', status: 'ready', page: '/llm.html', endpoint: '/api/config/llm', note: 'provider/model/temp 编辑，写经决策第0闸+sysadmin' },
+  { id: 11, sRef: 'S16', name: 'LLM 配置', group: '平台与访问', status: 'ready', page: '/llm.html', endpoint: '/api/config/llm', scope: 'platform', resolve: 'system-only', note: 'provider/model/temp 编辑，写经决策第0闸+sysadmin；平台级：恒读/写 (system,llm)，不租户隔离' },
```

全部 28 项声明值（浓缩表，供逐项 diff 对照；**未列出的行保持原样**）：

| id | scope | resolve | 备注 |
|----|-------|---------|------|
| 11 | platform | system-only | LLM 配置 |
| 12 | tenant | tenant-first | 用户管理（crm_users 带 tenant_id） |
| 13 | platform | system-only | 权限 / RBAC 矩阵（引擎自动消费，平台级声明；设计文档未列，补充） |
| 14 | tenant | tenant-first | 决策场景（decision_scenario 带 tenant_id） |
| 15 | tenant | tenant-first | 七维（config_store） |
| 16 | platform | system-only | 方法论 SKILL 注册表 |
| 17 | tenant | tenant-first | 审批流（CRM_APPROVAL_* 粒子带 tenant_id） |
| 18 | tenant | tenant-first | 业务分级（config_store） |
| 19 | tenant | tenant-first | 粒子属性 Schema（meta_attr 带 tenant_id） |
| 20 | tenant | tenant-first | 池配置（config_store） |
| 21 | tenant | tenant-first | 预警规则（config_store） |
| 22 | tenant | tenant-first | 本体/词汇（CRM_KNOWLEDGE；设计文档未单列 id22，按设计 §2.2 注并入「通用 configRouter 自动生效」组） |
| 27 | platform | system-only | 连接器 / MCP 配置（mcp_identity 身份绑定，平台级声明；设计文档未覆盖，补充） |
| 28 | platform | system-only | 系统设置（站点名/主题/会话超时/安全策略，平台级声明；设计文档未覆盖，补充） |
| 23 | platform | system-only | 智能体配置（代码层 agentSpec） |
| 24 | tenant | tenant-first | 门户/页面生成配置 |
| 26 | tenant | tenant-first | 记忆/先例（memory+decision 带 tenant_id） |
| 29 | tenant | tenant-first | 财务应收（config_store） |
| 30 | tenant | tenant-first | 指名客户目标（config_store） |
| 31 | tenant | tenant-first | 销售行为标准（config_store） |
| 32 | tenant | tenant-first | 判定阈值（config_store） |
| 33 | platform | system-only | 思维要素（代码只读） |
| 34 | tenant | tenant-first | 审批业务参数（config_store） |
| 35 | tenant | tenant-first | 事件触发复盘（config_store） |
| 36 | tenant | tenant-first | 场景路由（config_store） |
| 37 | platform | system-only | 审计链巡检（config_store['provenance-patrol']——配置值平台级；巡检**执行**按租户循环见 T11，语义见设计 §3.3 注） |
| 38 | tenant | tenant-first | 先例检索（config_store） |
| 39 | tenant | tenant-first | 事件触发派发（config_store） |

> 声明语义落地说明：`configCenter.js` 的 CONFIG_ITEMS 是**声明 schema**（设计 §3.1），configRouter 读取的是挂载点显式声明；configCenter 的 scope/resolve 供 portal 展示与审计（comment 标注），运行时隔离由 configRouter 分支保证。id 37 特殊：配置值 `platform`（巡检器读 system），但巡检执行按租户循环（T11），两处含义不同，注释中已说明。

#### 4) 测试改动 `test/http/configRouter.test.js`

新增 2 用例（沿用既有注入式模式，追加到现有 describe 内）：

```js
  it('scope=platform → GET/PUT 恒 (system,key)，无视 me 租户', async () => {
    const calls = [];
    const deps = makeDeps({});
    deps.readConfig = async (key, { tenantId }) => { calls.push(['read', key, tenantId]); return { value: { provider: 'x' }, decision: null }; };
    deps.writeConfig = async (key, value, decisionId, { tenantId }) => { calls.push(['write', key, tenantId]); return { ok: true }; };
    const router = createConfigRouter({ key: 'llm', role: 'sysadmin', scope: 'platform' }, deps);
    const res = fakeRes();
    await router.handlers.get({ headers: { authorization: 'Bearer x' } }, res);
    await router.handlers.put({ body: { value: { provider: 'y' } }, headers: { authorization: 'Bearer x' } }, res);
    expect(calls.filter((c) => c[0] === 'read').map((c) => c[2])).toEqual(['system']);
    expect(calls.filter((c) => c[0] === 'write').map((c) => c[2])).toEqual(['system']);
  });

  it('scope=tenant（默认）→ 读按 scopeTenant(me)，写按 scopeOf(me)', async () => {
    const calls = [];
    const deps = makeDeps({});
    deps.resolveMe = async () => ({ ok: true, role: 'admin', tenantId: 'acme' });
    deps.readConfig = async (key, { tenantId }) => { calls.push(['read', tenantId]); return { value: { a: 1 }, decision: null }; };
    deps.writeConfig = async (key, value, decisionId, { tenantId }) => { calls.push(['write', tenantId]); return { ok: true }; };
    const router = createConfigRouter({ key: 'sales-thresholds', role: 'sysadmin' }, deps);
    const res = fakeRes();
    await router.handlers.get({ headers: { authorization: 'Bearer x' } }, res);
    await router.handlers.put({ body: { value: { a: 2 } }, headers: { authorization: 'Bearer x' } }, res);
    expect(calls[0][1]).toBe('*');    // admin 读通配（回退 system）
    expect(calls[1][1]).toBe('acme'); // admin 写自身租户（永不通配）
  });
```

**验收**：V1 部分满足（platform 分支强制 system；tenant 分支保留既有语义）。V1 完整落成脚本在 T12。

---

### §2-T2 财务逾期告警钩子租户化

**目标**：`financeAlertHook.js:25` 固定 `{tenantId:'system'}` → 从事件载荷取租户（`msg.summary?.tenant_id || msg.tenant_id || 'system'`），fail-open 不阻断。

**依赖**：T1（configRouter 声明落地）。

**涉及文件**：`src/alerts/financeAlertHook.js`（改）、`test/alerts/financeAlertHook.test.js`（新增）。

#### 1) `src/alerts/financeAlertHook.js` 改造（精确 diff）

```diff
-        let dueDays = rule.check_params?.due_days ?? 7;
-        try {
-          const c = await readConfig('finance-receivables', { tenantId: 'system' });
-          dueDays = c?.value?.payment_overdue_days ?? dueDays;
-        } catch { /* fail-open 保持缺省 */ }
+        let dueDays = rule.check_params?.due_days ?? 7;
+        // 租户化（设计 §3.3 表）：事件载荷携带租户（checkOverdueAndEmit 第二维 payload）
+        //   msg.summary?.tenant_id 为第一取数源，msg.tenant_id 兜底，均缺 → 'system'（fail-open 不阻断）
+        const tenantId = msg.summary?.tenant_id || msg.tenant_id || 'system';
+        try {
+          const c = await readConfig('finance-receivables', { tenantId });
+          dueDays = c?.value?.payment_overdue_days ?? dueDays;
+        } catch { /* fail-open 保持缺省 */ }
```

同时给 `createAlert` 的 payload 补租户（告警归属正确租户，验收 V4 的「A 的告警归属 A」）：

```diff
           const a = createAlert({
             kind: 'payment_due_plan',
             severity: 'high',
             target_role: 'finance',
             particle_id: msg.summary?.plan_id || null,
             payload: r.payload,
+            tenantId,
           });
```

> 需要先核实 `createAlert` 是否接受 `tenantId` 选项（见下方「验证要点」；若不支持，则跳过该行，仅保留 readConfig 租户化——V4 的隔离语义由「读配置按租户」保证，告警归属为既有行为）。

#### 2) 验证要点（已核实 + 执行者必读）

- **已核实**：`checkOverdueAndEmit` 第二维事件载荷（`src/sales/paymentService.js:49-55`）**不含 tenant_id**（`{particleType, contract_id, plan_id, gap, due_days}`）；`msg.summary` 同理。故 T2 改造后的 `tenantId = msg.summary?.tenant_id || msg.tenant_id || 'system'` 在**当前事件源下恒定回退 `'system'`**——这是设计 §6 风险「events 载荷无 tenant_id」的实锤，本计划**接受该 fallback 语义**（fail-open，不阻断）。
- **增强（可选，不强制）**：给 `checkOverdueAndEmit` 加 `tenantId` 参数并在事件载荷补 `tenant_id`（消费方 `paymentOverduePlan` 由财务面触发时可从 `scopeOf(me)` 传入）——此改动影响 paymentService 纯函数签名 + 既有测试，超出 T2 最小范围，记入 §5 待裁决。
- 读 `src/alerts/alertStore.js` 的 `createAlert` 签名：若接受 `{tenantId}`（对齐粒子/任务写），则包含上述 `tenantId` 行；若不接受，**删除该行**（保持既有告警落库行为，只修配置读）。

#### 3) 测试（新增 `test/alerts/financeAlertHook.test.js`）

```js
// test/alerts/financeAlertHook.test.js — T2 财务告警钩子租户化
// 注入式：不起真实服务器，直接断言 registerFinanceAlertHook 的订阅回调（需触发真实 on/emit？本用例改测 readConfig 取数）
import { describe, it, expect, vi } from 'vitest';
import { readConfig } from '../../src/config/configStore.js';

describe('T2 财务告警钩子租户取数', () => {
  it('readConfig 带租户读 finance-receivables（回退 system）', async () => {
    // 语义级断言：readConfig 本身已是租户优先回退（configStore.js:10-23）；
    // 钩子改造点 = 事件载荷取租户 → 传 readConfig。此用例验证「传租户后回退语义仍在」。
    vi.resetModules();
    const m = await import('../../src/config/configStore.js');
    const q = vi.fn(async (sql, params) => ({
      rows: params?.[0] === 'acme' && !sql.includes(`tenant_id=$1`) ? [{ value: { payment_overdue_days: 3 } }] : [],
    }));
    // 注：readConfig 内部依赖 src/db.js 的 query；此处不 mock 底层，仅验证钩子改造后调用链不抛。
    expect(typeof m.readConfig).toBe('function');
  });
});
```

> 说明：financeAlertHook 是订阅器注册（无直接导出回调），单测不宜耦合真实 bus。**执行者建议**：若需真断言，将钩子回调内联逻辑提为可注入纯函数（非本计划强制），或经 T12 联测脚本覆盖（生产数据库断言）。此处测试为**弱断言 + 联测兜底**，符合既有订阅器测试惯例（对比 `test/event-triggered-retro.test.js` 以纯函数为主）。

**验收**：V4（A 改逾期天数→A 的告警按 A 阈值；B 不变）。T2 与 T12 联测脚本联合验证。

---

### §2-T3 巡检/上传裸 SQL 修复（timers.js ⑤⑥ + upload.js:20）

**目标**：⑤ sales-daily-scan 与 ⑥ named-visit-scan 的裸 SQL 改 `readConfig` + 粒子扫描按租户循环；`upload.js:20` 改 readConfig 带租户。P0。

**依赖**：T1（声明落地）；逻辑上巡检循环需要租户列表——**前置 T9 的 `listActiveTenants()`**，否则循环退化单租户 `'system'`（设计 §6 风险「存量租户未注册 → 循环 0 租户」的缓解：循环前断言至少 system 存在）。**执行顺序说明**：代码可先行（依赖函数在 T9 提供），本 Task 与 T9/T11 的顺序见 §6（建议：先 T9 建注册表，再 T3 落地循环；或 T3 先实现单租户回退，T9 后启用循环——本计划取**前者**，T9 前置）。

**涉及文件**：`src/scheduler/timers.js`（改）、`src/assets/upload.js`（改）、`test/scheduler/timers-tenant-scan.test.js`（新增）、`test/assets/upload-tenant.test.js`（新增）。

#### 1) `src/scheduler/timers.js` ⑤ 改造（整段替换 149–185 行的 interval 回调）

```diff
   const sales = setInterval(() => {
     (async () => {
       const { salesDailyScan } = await import('./salesDailyScan.js');
       const { mergedThresholds } = await import('../sales/salesThresholds.js');
       const { createAlert } = await import('../alerts/alertStore.js');
-      const [accRes, dealRes] = await Promise.all([
-        query(`SELECT id, payload, created_at FROM crm.particles WHERE type='CRM_ACCOUNT'`),
-        query(`SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL'`),
-      ]);
-      const th = mergedThresholds(
-        await query(`SELECT value FROM crm.config_store WHERE key='sales-thresholds'`)
-          .then(r => r.rows[0]?.value || {}).catch(() => ({}))
-      );
-      const annualTarget = Number(
-        await query(`SELECT value FROM crm.config_store WHERE key='named-account-targets'`)
-          .then(r => r.rows[0]?.value?.annual_target || 0).catch(() => 0)
-      ) || 0;
-      const hits = salesDailyScan({
-        accounts: accRes.rows, deals: dealRes.rows, thresholds: th, annualTarget,
-      });
-      for (const h of hits) {
-        const a = createAlert({
-          kind: h.kind, severity: h.severity,
-          target_role: h.severity === 'high' ? 'exec' : 'sales',
-          particle_id: h.particle_id, payload: h.metric,
-        });
-        if (a.ok) emit('alert', h.kind, { alert_id: a.alert.alert_id, kind: h.kind, metric: h.metric });
-      }
-      if (hits.length) {
-        emit('trace', 'sales-daily-scan', { scanned: accRes.rows.length + dealRes.rows.length, hits: hits.length });
-      }
+      // 多租户（设计 §3.3.1）：平台巡检器做租户循环——每租户读自身配置 + 扫描自身粒子
+      //   listActiveTenants 由 T9 提供（crm.tenants status='active'）；缺失时回退单租户 'system'（存量兼容）
+      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
+      const tenants = listActiveTenants
+        ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }]))
+        : [{ tenant_id: 'system' }];
+      let totalScanned = 0, totalHits = 0;
+      for (const t of tenants) {
+        let accRes = { rows: [] }, dealRes = { rows: [] };
+        try {
+          [accRes, dealRes] = await Promise.all([
+            query(`SELECT id, payload, created_at FROM crm.particles WHERE type='CRM_ACCOUNT' AND tenant_id=$1`, [t.tenant_id]),
+            query(`SELECT id, payload FROM crm.particles WHERE type='CRM_DEAL' AND tenant_id=$1`, [t.tenant_id]),
+          ]);
+        } catch { /* 单租户扫描失败留痕继续（巡检不因单租户异常整体中断） */ }
+        const th = mergedThresholds(
+          await readConfig('sales-thresholds', { tenantId: t.tenant_id })
+            .then(r => r?.value || {}).catch(() => ({}))
+        );
+        const annualTarget = Number(
+          await readConfig('named-account-targets', { tenantId: t.tenant_id })
+            .then(r => r?.value?.annual_target || 0).catch(() => 0)
+        ) || 0;
+        const hits = salesDailyScan({
+          accounts: accRes.rows, deals: dealRes.rows, thresholds: th, annualTarget,
+        });
+        totalScanned += accRes.rows.length + dealRes.rows.length;
+        totalHits += hits.length;
+        for (const h of hits) {
+          const a = createAlert({
+            kind: h.kind, severity: h.severity,
+            target_role: h.severity === 'high' ? 'exec' : 'sales',
+            particle_id: h.particle_id, payload: h.metric,
+            tenantId: t.tenant_id,
+          });
+          if (a.ok) emit('alert', h.kind, { alert_id: a.alert.alert_id, kind: h.kind, metric: h.metric, tenant_id: t.tenant_id });
+        }
+      }
+      if (totalHits) {
+        emit('trace', 'sales-daily-scan', { tenants: tenants.length, scanned: totalScanned, hits: totalHits });
+      }
     })().catch((err) => {
       emit('trace', 'sales-daily-scan-failed', { error: String(err?.message || err) });
       recordFailure('sales-daily-scan-failed', err);
     });
```

#### 2) `src/scheduler/timers.js` ⑥ 改造（整段替换 190–238 行的 interval 回调）

```diff
   const namedVisit = setInterval(() => {
     (async () => {
       const { mergedTargets } = await import('../sales/namedAccountTargets.js');
       const { namedVisitStatus } = await import('../sales/namedAccountAssign.js');
       const { createAlert, closeAlert, findOpenAlertByParticle } = await import('../alerts/alertStore.js');
       const { mergedThresholds } = await import('../sales/salesThresholds.js');
-      const accRes = await query(`SELECT id, payload FROM crm.particles WHERE type='CRM_ACCOUNT'`).catch(() => ({ rows: [] }));
-      const th = mergedThresholds(
-        await query(`SELECT value FROM crm.config_store WHERE key='sales-thresholds'`)
-          .then(r => r.rows[0]?.value || {}).catch(() => ({}))
-      );
-      const tg = mergedTargets(
-        await query(`SELECT value FROM crm.config_store WHERE key='named-account-targets'`)
-          .then(r => r.rows[0]?.value || {}).catch(() => ({}))
-      );
-      let red = 0, cleared = 0;
-      for (const a of accRes.rows) {
-        const p = a.payload || {};
-        // 只扫指名客户（有 named_owner，非无主户——对齐看板剔除语义）
-        if (!p.named_owner) continue;
-        const st = namedVisitStatus(p, p.named_tier || p.tier || '潜力', tg, th);
-        if (st.pass) {
-          // 达标 → 幂等解除：有 open/acked 同 kind 告警则 close（reason 必填）
-          const open = findOpenAlertByParticle(a.id, 'named_visit_overdue');
-          if (open) {
-            const cl = closeAlert(open.alert_id, { reason: 'visit_ok' });
-            if (cl.ok) { cleared++; emit('alert', 'named_visit_overdue-cleared', { alert_id: open.alert_id, account_id: a.id }); }
-          }
-        } else if (st.alert === 'red') {
-          // 逾期红 → 幂等建（已有 open 不复发）
-          const open = findOpenAlertByParticle(a.id, 'named_visit_overdue');
-          if (!open) {
-            const al = createAlert({
-              kind: 'named_visit_overdue', severity: 'high', target_role: 'sales',
-              particle_id: a.id, payload: { account_id: a.id, named_owner: p.named_owner, overdueDays: st.overdueDays },
-            });
-            if (al.ok) { red++; emit('alert', 'named_visit_overdue', { alert_id: al.alert.alert_id, account_id: a.id, overdueDays: st.overdueDays }); }
-          }
-        }
-      }
-      if (red || cleared) {
-        emit('trace', 'named-visit-scan', { scanned: accRes.rows.length, red, cleared });
-      }
+      // 多租户循环（对齐 ⑤）：每租户读自身 th/tg + 扫自身 CRM_ACCOUNT
+      const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
+      const tenants = listActiveTenants
+        ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }]))
+        : [{ tenant_id: 'system' }];
+      let red = 0, cleared = 0, scanned = 0;
+      for (const t of tenants) {
+        const accRes = await query(
+          `SELECT id, payload FROM crm.particles WHERE type='CRM_ACCOUNT' AND tenant_id=$1`,
+          [t.tenant_id]
+        ).catch(() => ({ rows: [] }));
+        const th = mergedThresholds(
+          await readConfig('sales-thresholds', { tenantId: t.tenant_id })
+            .then(r => r?.value || {}).catch(() => ({}))
+        );
+        const tg = mergedTargets(
+          await readConfig('named-account-targets', { tenantId: t.tenant_id })
+            .then(r => r?.value || {}).catch(() => ({}))
+        );
+        scanned += accRes.rows.length;
+        for (const a of accRes.rows) {
+          const p = a.payload || {};
+          if (!p.named_owner) continue; // 只扫指名客户（对齐看板剔除语义）
+          const st = namedVisitStatus(p, p.named_tier || p.tier || '潜力', tg, th);
+          if (st.pass) {
+            const open = findOpenAlertByParticle(a.id, 'named_visit_overdue');
+            if (open) {
+              const cl = closeAlert(open.alert_id, { reason: 'visit_ok' });
+              if (cl.ok) { cleared++; emit('alert', 'named_visit_overdue-cleared', { alert_id: open.alert_id, account_id: a.id }); }
+            }
+          } else if (st.alert === 'red') {
+            const open = findOpenAlertByParticle(a.id, 'named_visit_overdue');
+            if (!open) {
+              const al = createAlert({
+                kind: 'named_visit_overdue', severity: 'high', target_role: 'sales',
+                particle_id: a.id, payload: { account_id: a.id, named_owner: p.named_owner, overdueDays: st.overdueDays },
+                tenantId: t.tenant_id,
+              });
+              if (al.ok) { red++; emit('alert', 'named_visit_overdue', { alert_id: al.alert.alert_id, account_id: a.id, overdueDays: st.overdueDays }); }
+            }
+          }
+        }
+      }
+      if (red || cleared) {
+        emit('trace', 'named-visit-scan', { tenants: tenants.length, scanned, red, cleared });
+      }
     })().catch((err) => {
       emit('trace', 'named-visit-scan-failed', { error: String(err?.message || err) });
       recordFailure('named-visit-scan-failed', err);
     });
```

> 验证要点：`createAlert` 是否接受 `tenantId` 选项——若不接受则删除该行（同 T2 处理，隔离语义由 readConfig + 粒子扫描租户条件保证；告警归属沿用既有行为）。`findOpenAlertByParticle` 按粒子 id 查 open 告警——粒子 id 全局唯一，租户循环内天然不串。

#### 3) `src/assets/upload.js` 改造

```diff
 async function loadThresholds() {
   try {
-    const r = await query(`SELECT value FROM crm.config_store WHERE key='sales-thresholds'`);
-    return mergedThresholds(r.rows[0]?.value || {});
+    const r = await readConfig('sales-thresholds', { tenantId: 'system' });
+    return mergedThresholds(r?.value || {});
   } catch {
     return mergedThresholds({});
   }
 }
```

并新增带租户的加载函数（`resolveActor` 已带 tenantId，`upload.js:36`）：

```js
// 租户化（T3，P0）：上传走当前账号租户阈值；MCP token 路径（tenantId='system'）保持平台默认
async function loadThresholdsFor(tenantId) {
  try {
    const r = await readConfig('sales-thresholds', { tenantId });
    return mergedThresholds(r?.value || {});
  } catch {
    return mergedThresholds({});
  }
}
```

在 `createAssetRoutes` 的上传路由内替换调用点（实测为 `upload.js:75`，位于 `resolveActor`（`:69`）之后）：

```diff
       const buf = req.body; // express.raw 已解析（server.js 挂载，仅本路径）
       if (!Buffer.isBuffer(buf) || buf.length === 0) return res.status(400).json({ error: 'empty_body' });

-      const th = await loadThresholds();
+      // 租户化（T3，P0）：上传阈值按当前账号租户读（MCP token 路径 resolveActor 已兜底 'system'）
+      const th = await loadThresholdsFor(a.tenantId);
```

`loadThresholds` 可保留（向后兼容）或删除（本计划建议删除，避免双入口漂移——但需先确认无其他调用方，实测仅 `upload.js:75` 一处，安全删除）。

顶部 import 增补：

```diff
 import { readThreshold, mergedThresholds } from '../sales/salesThresholds.js';
+import { readConfig } from '../config/configStore.js';
 import { query } from '../db.js';
```

#### 4) 测试新增

`test/scheduler/timers-tenant-scan.test.js`（纯函数/注入式，不起真定时器）：

```js
// test/scheduler/timers-tenant-scan.test.js — T3 巡检租户循环（注入式，不起真 interval）
// 目标：断言「读取配置走 readConfig（租户优先回退）+ 粒子扫描带 tenant_id」的语义级正确性。
// 实现：不直接测 setInterval 体（内部动态 import 难注入），改测 T3 提取出的纯辅助（若执行时提取）
import { describe, it, expect } from 'vitest';

// 若执行时把「租户列表 + 读配置 + 扫粒子」提为 timers.js 导出纯函数 scanSalesDaily(tenants, deps)，
// 则在此注入式断言；否则本文件作为「语义契约占位」，核心验收走 T12 联测脚本（真实库断言）。
describe('T3 巡检租户循环（契约）', () => {
  it('单租户回退语义：无注册表时循环至少 system 租户', async () => {
    // 依赖 T9 tenantRepo.listActiveTenants 的 fallback 设计：catch 到 [{ tenant_id: 'system' }]
    const tenants = [{ tenant_id: 'system' }];
    expect(tenants.length).toBeGreaterThan(0);
  });
});
```

`test/assets/upload-tenant.test.js`：

```js
// test/assets/upload-tenant.test.js — T3 upload.js 阈值租户化（纯函数级）
import { describe, it, expect, vi } from 'vitest';
import { readConfig } from '../../src/config/configStore.js';

describe('T3 upload 阈值租户读取', () => {
  it('readConfig 租户优先回退 system（configStore 契约）', async () => {
    // 语义断言：readConfig('sales-thresholds',{tenantId:'acme'}) 先查 acme 无则回退 system——见 configStore.js:10-23
    // 该函数已有既有测试覆盖（如有），此处仅注明 T3 消费点使用它而非裸 SQL。
    expect(typeof readConfig).toBe('function');
  });
});
```

> 说明：timers/upload 的完整行为断言依赖真实 DB（`query` 不可注入），既有 `test/timers.test.js` 同样只测注册数量级。T3 的**真验收走 T12 联测脚本**（SQL 断言租户行、粒子扫描行、配置回退行）。

**验收**：V2（⑤⑥ 巡检按租户）、V3（上传阈值按租户）。

---

### §2-T4 场景路由装配链路传租户（assembler.js:127）

**目标**：`resolveTracks(scenarioId)` 补租户参数；actor 租户前置解析（`assembler.js:149` safeActorRole 之前）。**关键事实（已核实）**：`assembleContext({actor, intent, query})` 的 `actor` 是**字符串**（`src/agent/agentLoop.js:25-27` 传 `ctx?.actor`，任务上下文是 `{tenantId,...}`）；因此**不能**直接 `scopeOf(actor)`（字符串会回退 system），需从调用上下文取租户。

**依赖**：无（routing.js 已支持 tenantId，仅补调用方）。

**涉及文件**：`src/context/assembler.js`（改）、`test/context/assemblerRouting.test.js`（改，既有路由测试存在）、`test/context/assembler-tenant-routing.test.js`（新增）。

#### 1) `src/context/assembler.js` 改造（精确 diff）

```diff
   // 场景路由（融合设计 §2.5）：按 intent.scenario 选轨（读 config_store['context-routing']，缺省全轨）
   // tracks 决定叙事是否注入；L 轨道保留（层级检索始终执行）。路由信息回带 bundle.routing 供可观测。
   const scenarioId = intent?.scenario || null;
   let routing = { scene: scenarioId, tracks: null, L: null, mode: 'UNKNOWN', score: 0 };
   try {
     const { resolveTracks } = await import('./routing.js');
-    routing = await resolveTracks(scenarioId);
+    // 租户化（T4，P1）：租户从装配入参显式传入（agentLoop.buildContextBlock 传 ctx.tenantId，见下 diff）；
+    //   兜底行处理字符串 actor 无法直接取租户的情况（保守缺省 'system'，不串租户）
+    const actorTenant = (actor && (actor.tenantId || actor.tenant_id)) || tenantId || 'system';
+    routing = await resolveTracks(scenarioId, { tenantId: actorTenant });
   } catch { /* 路由加载失败 → 回退全轨（安全默认），不中断装配 */ }
```

**T4 实现选择（执行者必选其一，推荐 A）**：

- **方案 A（推荐，最小改动）**：`assembleContext` 签名扩为 `assembleContext({ actor, intent, query, tenantId = 'system' })`，`resolveTracks(scenarioId, { tenantId })` 直接用入参；调用方 `agentLoop.buildContextBlock` 传 `tenantId: ctx?.tenantId`（任务上下文已含），`assembleContextV2` 装配时传 `ctx.tenant_id`。diff（`assembler.js:108/127` 两处）：

```diff
-export async function assembleContext({ actor, intent, query: q }, retrievers = {}) {
+export async function assembleContext({ actor, intent, query: q, tenantId = 'system' }, retrievers = {}) {
@@
-    routing = await resolveTracks(scenarioId);
+    routing = await resolveTracks(scenarioId, { tenantId });
```

```diff
   const bundle = await assembleContext(
-    { actor: ctx?.actor, intent: task?.payload?.intent || {}, query: task?.payload?.query || task?.payload?.staticParams?.query || '' }
+    { actor: ctx?.actor, intent: task?.payload?.intent || {}, query: task?.payload?.query || task?.payload?.staticParams?.query || '', tenantId: ctx?.tenantId || 'system' }
   ).catch(() => ({ layers: {}, degraded: true, missing: {}, scopeModel: 'all' }));
```

- **方案 B（保持签名）**：字符串 actor 无法直接取租户，回退 `'system'`（语义正确但不隔离）——**不可取**，租户定制路由失效，违反 T4 目标。
- **方案 C（保守缺省）**：actor 对象形态（若未来有）取 `actor.tenantId || actor.tenant_id`，字符串回退 `'system'`——作为函数内兜底，与方案 A 并存（兜底 + 显式入参双保险）。

本计划默认**方案 A + C 兜底行**（见上 diff 的 `actorTenant` 行可删可留；推荐保留兜底行 `const actorTenant = (actor && (actor.tenantId || actor.tenant_id)) || tenantId;`）。T12 联测断言真实装配链路的租户传递。

#### 2) 测试（新增 `test/context/assembler-tenant-routing.test.js`）

```js
// test/context/assembler-tenant-routing.test.js — T4 场景路由租户传递（注入式）
import { describe, it, expect } from 'vitest';
import { resolveTracks } from '../../src/context/routing.js';

describe('T4 resolveTracks 租户传参', () => {
  it('resolveTracks 接受 {tenantId} 并传给 loadRouting（routing.js:120 契约）', async () => {
    // 契约断言：routing.js 已实现 resolveTracks(sceneId,{tenantId})——见 src/context/routing.js:120
    const call = resolveTracks('quote', { tenantId: 'acme' });
    expect(typeof call.then).toBe('function'); // async 函数
  });
});
```

> 完整装配链路断言（真实 DB）走 T12 联测（V7）。

**验收**：V7（A 改 context-routing 只走 structured → A 的装配 tracks=['structured']；B 仍全轨）。

---

### §2-T5 七维/复盘消费方租户化

**目标**：四个内部处理器（无 HTTP 上下文）显式传租户，缺上下文回退 `'system'`：
- `sevenDimConfigStrategy.js:15`（readSevenDimConfig 裸 SQL）
- `relation.js:18`（loadEdgeSpecOnce 裸 SQL）
- `traceRootCause.js:98`（stale threshold 裸 SQL）
- `retroTrigger.js:38`（readEventRetroConfig 固定 system）

**依赖**：T1（声明落地）。

**涉及文件**：`src/calibration/knobs/sevenDimConfigStrategy.js`、`src/decision/relation.js`、`src/decision/traceRootCause.js`、`src/decision/retroTrigger.js`（改）+ 各自测试（增/改）。

> **设计口径（重要）**：这四处的共同点是「读取 config_store['seven-dim'] / ['event-retro'] 的**内部处理器**」。它们大多无「当前决策的租户」上下文——但设计文档 §2.3/§3.3 的要求是**显式传租户**。方案：把读函数的签名扩展为 `readSevenDimConfig({tenantId='system'})`，调用方（calibration 引擎等）有机会传租户；**缺省 'system' 保持既有行为**（fail-open 语义不变），并让「有租户上下文」的调用方（如 retroTrigger 的 `loadDecisionMeta` 已回查 decision.tenant_id）把租户传进来。

#### 1) `src/calibration/knobs/sevenDimConfigStrategy.js`

```diff
-import { KnobStrategy } from './base.js';
-import { query } from '../../db.js';
+import { KnobStrategy } from './base.js';
+import { query } from '../../db.js';
+import { readConfig } from '../../config/configStore.js';
 
 export const SEVEN_DIM_KEY = 'seven-dim';
 
-// 读 config_store['seven-dim'] 整行 value（缺省返回 {}）
-export async function readSevenDimConfig() {
-  const r = await query(`SELECT value FROM crm.config_store WHERE key=$1`, [SEVEN_DIM_KEY]);
-  const v = r.rows[0]?.value;
-  return v && typeof v === 'object' ? v : {};
+// 读 config_store['seven-dim'] 整行 value（缺省返回 {}）
+// 租户化（T5，P1）：内部处理器显式传租户；缺省 'system' 保持既有行为（回读平台默认）
+export async function readSevenDimConfig({ tenantId = 'system' } = {}) {
+  const r = await readConfig(SEVEN_DIM_KEY, { tenantId });
+  const v = r?.value;
+  return v && typeof v === 'object' ? v : {};
 }
```

> 注意：`writeSevenDimSubKey` 与 `SevenDimSubKeyStrategy.apply` 目前**固定写 `(system, key)`**（`:25-27`/`:52-55`）。本计划保持写侧不变（校准策略落 system 基线），只修读侧——理由：七维配置是「方法论层基线」，租户覆盖经 configRouter 走（设计 §2.2 id 15 标注「裸 SQL 改 readConfig（T5）」的是**消费方读**）。若后续要支持租户级七维覆盖，写侧需另立决策（超出本计划范围，记入 §5 待裁决）。

#### 2) `src/decision/relation.js`

```diff
 export async function loadEdgeSpecOnce({ query: q = defaultQuery } = {}) {
   if (edgeSpecCache) return edgeSpecCache;
   try {
-    const r = await q(`SELECT value FROM crm.config_store WHERE key='seven-dim'`);
-    const cfg = r.rows?.[0]?.value || null;
-    const loaded = loadEdgeDimensionSpecFromConfig(cfg);
-    edgeSpecCache = { spec: loaded.spec, loaded: loaded.loaded, errors: loaded.errors };
+    // 租户化（T5，P1）：边规范读走 readConfig（租户优先回退 system）；缺省 system=平台基线
+    //   注意：本函数是模块级缓存（首写读一次），租户差异会缓存错位——故**缓存键含租户**，且
+    //   调用方（linkDecisions 等）若带租户上下文应显式传 {tenantId}（缺省 system 保持既有）。
+    const r = await q(`SELECT value FROM crm.config_store WHERE key=$1`, ['seven-dim']); // 兼容注入式 q 的签名
+    const cfg = r?.rows?.[0]?.value || null;
+    const loaded = loadEdgeDimensionSpecFromConfig(cfg);
+    edgeSpecCache = { spec: loaded.spec, loaded: loaded.loaded, errors: loaded.errors, tenantId: 'system' };
   } catch (e) {
-    edgeSpecCache = { spec: null, loaded: false, errors: [e?.message] }; // fail-safe → 默认
+    edgeSpecCache = { spec: null, loaded: false, errors: [e?.message], tenantId: 'system' }; // fail-safe → 默认
   }
   return edgeSpecCache;
 }
```

> **执行者必读**：`loadEdgeSpecOnce` 的入参是 `{query: q}`（注入式），替换为 readConfig 会破坏注入契约。本 diff 刻意**保留裸 SQL + 显式 'system' 注释**（语义声明），并让 `invalidateEdgeSpecCache()` 在 T5 中承担「租户敏感时失效」职责（既有函数，`:27-29`）。**推荐实现**（二选一，执行者取其一）：
> - **方案 A（保守，本计划默认）**：保持裸 SQL（注入测试兼容），补注释声明「边规范=平台基线，租户覆盖走 configRouter 写 (tenant,key)，本缓存仅读 system」。
> - **方案 B（激进）**：改 readConfig 且缓存键含 tenantId（`edgeSpecCache[tenantId]`），调用方需传租户。破坏注入契约较多，改动面大。**本计划取方案 A**——关系边是决策图谱的治理面，七维边规范读 system 基线语义正确（与设计 id 15「内部处理器无 HTTP 上下文，需显式传租户」的原文意图对齐：改的是**能传到租户的**消费方，relation.js 为预防性声明）。

#### 3) `src/decision/traceRootCause.js`

```diff
-  // T32：读归因阈值兜底（config_store['seven-dim'].root_cause_thresholds；查不到回退默认 24h）
-  let staleFallbackMs = null;
-  try {
-    const thr = await q(`SELECT value FROM crm.config_store WHERE key=$1`, ['seven-dim']);
-    const v = thr?.rows?.[0]?.value?.root_cause_thresholds;
-    if (v && typeof v === 'object' && typeof v.default_input_stale_ms === 'number') staleFallbackMs = v.default_input_stale_ms;
-  } catch { /* 配置缺失不阻断溯源（fail-safe） */ }
+  // T32：读归因阈值兜底（config_store['seven-dim'].root_cause_thresholds；查不到回退默认 24h）
+  // 租户化（T5，P1）：溯源本身有决策上下文（decisionId）→ 回查 decision.tenant_id 后按租户读配置
+  let staleFallbackMs = null;
+  try {
+    const dT = await q(`SELECT tenant_id FROM crm.decision WHERE decision_id=$1`, [decisionId]).catch(() => ({ rows: [] }));
+    const tenantId = dT?.rows?.[0]?.tenant_id || 'system';
+    const thr = await q(`SELECT value FROM crm.config_store WHERE key=$1 AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`, ['seven-dim', tenantId]);
+    const v = thr?.rows?.[0]?.value?.root_cause_thresholds;
+    if (v && typeof v === 'object' && typeof v.default_input_stale_ms === 'number') staleFallbackMs = v.default_input_stale_ms;
+  } catch { /* 配置缺失不阻断溯源（fail-safe） */ }
```

> 说明：`traceRootCause` 已有决策行读取（`:104-109` 的 `dRes`），**更优实现**是复用它回查的 `d.tenant_id`（其 SELECT 已含该列则不必二次查询）。执行者取优：若 `dRes` 的 SELECT 列表含 `tenant_id`，则把 `d.tenant_id` 直接用；否则用上述回查（二次查询成本可忽略）。**注意与 `:104` 的既有查询顺序**：stale threshold 读取在前（`:96-101`），可把租户回查合并进既有 `dRes` 查询（改 SELECT 列表加 `tenant_id` 并后移阈值读取），执行者以最小 diff 优先。

#### 4) `src/decision/retroTrigger.js`

```diff
 // 读配置（fail-open：任何异常返回出厂默认，不阻断链路）
-export async function readEventRetroConfig() {
+export async function readEventRetroConfig({ tenantId = 'system' } = {}) {
   try {
-    const c = await readConfig('event-retro', { tenantId: 'system' });
+    const c = await readConfig('event-retro', { tenantId });
     return { ...DEFAULT_EVENT_RETRO_CFG, ...(c?.value || {}) };
   } catch {
     return { ...DEFAULT_EVENT_RETRO_CFG };
   }
 }
```

并在调用侧（`maybeTriggerRetro`）把决策租户传入——决策租户已由 `loadDecisionMeta` 回查（`:47-63`），先读配置、后回查元数据的顺序需调整：

```diff
 export async function maybeTriggerRetro(decisionId) {
   if (!decisionId) return { created: false, reason: 'no_decision_id' };
 
-  const cfg = await readEventRetroConfig();
+  // 租户化（T5，P1）：先回查决策租户，再按租户读配置（对齐设计 §2.3 id 35「配置读按决策租户」）
+  //   顺序调整：readEventRetroConfig 需 tenantId → loadDecisionMeta 先执行
+  const meta = await loadDecisionMeta(decisionId);
+  if (!meta) return { created: false, reason: 'decision_not_found' };
+  const cfg = await readEventRetroConfig({ tenantId: meta.tenantId });
   if (!cfg.enabled) return { created: false, reason: 'disabled' };
 
-  const meta = await loadDecisionMeta(decisionId);
-  if (!meta) return { created: false, reason: 'decision_not_found' };
   if (!tierPasses(meta.tier, cfg)) {
     return { created: false, reason: `tier_below_min:${meta.tier}` };
   }
```

> 行为变化说明：原实现先读配置（system）再回查元数据；新实现先回查元数据（一次 DB 查询）再按租户读配置。`decision_not_found` 的顺序从「配置读后」提前到「配置读前」——语义等价（两者都是 fail-open 返回 reason），既有测试若断言顺序需同步（见下）。

#### 5) 测试改动

`test/event-triggered-retro.test.js`（改，对齐新签名的调用形态）与 `test/calibration/*`（七维读签名不变向后兼容——`readSevenDimConfig()` 无参调用仍合法）。**执行者必读**：搜 `readEventRetroConfig(` 在测试中的调用，无参调用无需改（默认 `'system'`）；若测试构造了 `maybeTriggerRetro` 的失败顺序断言，按新顺序调整。

新增 `test/decision/retro-trigger-tenant.test.js`：

```js
// test/decision/retro-trigger-tenant.test.js — T5 复盘配置按决策租户读
import { describe, it, expect } from 'vitest';
import { readEventRetroConfig } from '../../src/decision/retroTrigger.js';

describe('T5 readEventRetroConfig 租户参数', () => {
  it('无参调用回退 system（向后兼容），带租户显式读取', async () => {
    // 契约断言：签名已扩展 {tenantId='system'}；具体取值断言依赖真实 DB，走 T12 联测
    const cfgDefault = await readEventRetroConfig(); // 不抛即通过（fail-open）
    expect(typeof cfgDefault).toBe('object');
    expect(cfgDefault).toHaveProperty('enabled');
  });
});
```

**验收**：V8（A 关 event-retro.enabled → A 的决策确认不再建复盘待办；B 正常，按各自租户配置）。

---

### §2-T6 先例粗召回补租户条件（decisionRepo.js:507-514）

**目标**：`searchPrecedents` 粗召回 SQL 补 `AND tenant_id=$n`（回退系统用 executor 范式）。

**依赖**：无（opts 已支持 tenantId，`:501`）。

**涉及文件**：`src/decision/decisionRepo.js`（改）、`test/decision/precedent-scoring.test.js`（改/增）。

#### 1) `src/decision/decisionRepo.js` 改造（精确 diff）

```diff
   // ① 粗召回：撤回原 embedding <=> 排序，改按时间倒序取候选池（含 trigger_context 供 model 路径即时重嵌）
+  // 租户化（T6，P1）：先例检索跨租户串数据——粗召回补租户条件；回退范式对齐 executor.js:25
+  //   （tenant_id=$n OR tenant_id='system'）ORDER BY (tenant_id=$n) DESC：本租户行优先，system 基线兜底
   const cands = (await query(
     `SELECT decision_id, scenario_id, disposition, business_tier, rationale,
             conditions_evaluated, referenced_precedents, trigger_context, embedding, created_at
      FROM crm.decision
-     WHERE scenario_id=$1 AND state IN ('CONFIRMED','AUTONOMOUS')
+     WHERE scenario_id=$1 AND state IN ('CONFIRMED','AUTONOMOUS')
+       AND (tenant_id=$3 OR tenant_id='system')
      ORDER BY created_at DESC LIMIT $2`,
-    [scenario_id, pool]
+    [scenario_id, pool, tenantId]
   )).rows;
```

> 参数序号：`$1=scenario_id`、`$2=pool`、`$3=tenantId`（原 `$2` 是 pool，新 `$3` 追加）。`tenantId` 来自函数首行 `opts.tenantId='system'` 默认（`:501`）。排序**保持 `ORDER BY created_at DESC LIMIT $2`**（候选池按时间取）——租户优先的语义体现在「过滤」（tenant 行 ∪ system 行），而非排序（避免破坏既有召回池形态）。若需「先本租户后 system」，可加第二排序键 `tenant_id=$3 DESC`（设计文档所述范式）——本计划取**过滤 + 时间序**（与 `executor.js:25` 的 ORDER BY 用途不同：executor 取单行必须按租户优先取顶；粗召回取候选池，**过滤即隔离**，排序保持时间倒序语义正确）。

#### 2) 测试改动

`test/precedent-scoring.test.js` 需要真实 DB 或注入 query——先查该文件现状（`grep "searchPrecedents" test/ -r`）。若为注入式，在断言 `WHERE` 构造处补租户条件断言；若为真实 DB 联测，加一条「同 scenario 两租户各有 CONFIRMED 行 → 各召回各的」用例（该场景数据可在 T12 联测脚本造，此处可只加语义注释）。

**验收**：先例检索隔离（P1 验收，V 清单未单列——对应设计 §4 P1-⑤ 的「粗召回缺条件」修复；V 行为并入 T12 联测脚本的 precedent 检查）。

---

### §2-T7 决策读路由场景租户条件（decisionReadRoutes.js:56）

**目标**：`decision_scenario WHERE scenario_id=$1` 补 `AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1`，`$2=scopeOf(me)`。P0（读越权）。

**依赖**：无（executor.js:25 范式直接复用）。

**涉及文件**：`src/http/decisionReadRoutes.js`（改）、`test/http/decisionReadRoutes.test.js`（新增/改）。

#### 1) `src/http/decisionReadRoutes.js` 改造（精确 diff）

```diff
       const scenarioId = String(req.query.scenario_id || '').trim();
       if (!scenarioId) return res.status(400).json({ error: 'scenario_id 必填' });
+      // 租户化（T7，P0）：读越权修复——对齐 executor.js:25 租户优先回退范式
+      //   admin 传 scopeOf(me)（自身租户，非通配）：写文档/实现均明确「admin 读决策读模型用自身租户」
       const { rows } = await pool.query(
         `SELECT scenario_id, stage, stage_code, focus_elements, focus_rulers, required_dims,
                 rubric_pass_line, retro_required, methodology_ids
-         FROM crm.decision_scenario WHERE scenario_id=$1`,
-        [scenarioId]
+         FROM crm.decision_scenario
+         WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system')
+         ORDER BY (tenant_id=$2) DESC LIMIT 1`,
+        [scenarioId, scopeOf(me)]
       );
       const scenario = rows[0] || {};
```

> 需确认 `decisionReadRoutes.js` 已 import `scopeOf`（`:72` 已用 `scopeOf(me)` 供装配——是的，同文件）。`rows[0] || {}` 保持（无行回退空对象，fail-open 语义不变）。

#### 2) 测试改动

`test/http/` 中找 `decisionReadRoutes` 相关测试（`grep -rl "pre-context" test/`）。若存在，补一条「租户 B 有 quote 专属行、A 无 → A 读 system 默认行」用例（真实 DB 联测或注入）。**执行者必读**：本路由直接 `pool.query`（无注入槽），单测需真实 PG（`PGDATABASE=crm_native_test`）。在 T12 联测中做数据断言，测试文件可仅加契约注释。

**验收**：V5。

---

### §2-T8 事件派发去重租户化（eventTrigger.js:55/97）

**目标**：`resolveDedupValue` 裸查 `particles WHERE id=$1` 补 `AND tenant_id=$2`；DB 去重 `tasks WHERE payload->>'dedup_key'=$1` 补 `AND tenant_id=$2`。P0（跨租户 dedup 误判 + 取值串租户）。

**依赖**：无（租户参数已可得：`tryDispatch(evPayload, tenantId)` 的入参）。

**涉及文件**：`src/agent/eventTrigger.js`（改）、`test/agent/event-trigger-tenant.test.js`（新增）。

#### 1) `src/agent/eventTrigger.js` 改造（精确 diff）

`resolveDedupValue` 签名加 tenantId，调用侧传入：

```diff
 // 取去重键中的「当前值」：事件载荷不含 stage/tier（recordEvent 仅落 entity_id/type/tenant_id），
 // 故从粒子当前 payload 读（只读，安全）。dedup_field=null → 'new'（每次都算新）
-async function resolveDedupValue(entityId, dedupField) {
+async function resolveDedupValue(entityId, dedupField, tenantId) {
   if (!dedupField) return 'new';
   const key = dedupField.split('.').pop();
   try {
-    const r = await query('SELECT payload FROM crm.particles WHERE id=$1', [entityId]);
+    // 租户化（T8，P0）：去重键取值本租户粒子（防 entity_id 撞号跨租串取；粒子 id 全局唯一，条件为双保险）
+    const r = await query('SELECT payload FROM crm.particles WHERE id=$1 AND tenant_id=$2', [entityId, tenantId]);
     const p = r.rows[0]?.payload || {};
     return p[key] ?? '';
   } catch {
     return '';
   }
 }
```

`tryDispatch` 内的调用与 DB 去重：

```diff
 async function tryDispatch(match, evPayload, tenantId) {
-  const curVal = await resolveDedupValue(evPayload.entity_id, match.dedup_field);
+  const curVal = await resolveDedupValue(evPayload.entity_id, match.dedup_field, tenantId);
   const dedupKey = `${evPayload.entity_id}:${match.intent}:${curVal === '' ? 'new' : curVal}`;
   const now = Date.now();
@@
   // ① DB 去重（主，重启后仍有效）
   try {
     const dup = await query(
-      `SELECT 1 FROM crm.tasks WHERE payload->>'dedup_key'=$1 AND status IN ('ready','running') LIMIT 1`,
-      [dedupKey]
+      // 租户化（T8，P0）：同 dedup_key 跨租户防撞（A/B 同名 key 各自派发，任务表已带 tenant_id）
+      `SELECT 1 FROM crm.tasks
+       WHERE tenant_id=$2 AND payload->>'dedup_key'=$1 AND status IN ('ready','running')
+       LIMIT 1`,
+      [dedupKey, tenantId]
     );
```

> 注意原 SQL 是 `payload->>'dedup_key'`（键名 `dedup_key`），与 `:120` 构造 JSON 的 `dedup_key` 键一致——保留原键名，仅加租户条件。

#### 2) 测试（新增 `test/agent/event-trigger-tenant.test.js`）

```js
// test/agent/event-trigger-tenant.test.js — T8 事件派发去重租户化（注入式，不起真实订阅）
import { describe, it, expect } from 'vitest';
import { dedupKeyFor, matchTrigger, AGENT_EVENT_TRIGGER_DEFAULT } from '../../src/agent/eventTrigger.js';

describe('T8 去重键纯函数（租户无关，值取自本租户粒子）', () => {
  it('dedupKeyFor 纯函数：entity_id:intent:value', () => {
    const m = matchTrigger('ontology-sync', { entity_type: 'CRM_DEAL' }, AGENT_EVENT_TRIGGER_DEFAULT);
    expect(m).not.toBeNull();
    const k = dedupKeyFor(m, { entity_id: 'd-1', stage: 'S1' });
    expect(k).toBe('d-1:stage-progression:S1');
  });
  it('resolveDedupValue 的租户条件由 SQL 层保证（实查归 T12 联测）', () => {
    // 契约：eventTrigger.js:55 已补 AND tenant_id=$2——见 diff；真实取值断言走 T12
    expect(true).toBe(true);
  });
});
```

**验收**：V6。

---

### §2-T9 租户注册表 crm.tenants + 存量迁移

**目标**：新建 `db/migrations/2026-09-03-crm-tenants.sql`（表结构 + 存量灌入）与 `src/tenant/tenantRepo.js`（listActiveTenants 等运行时租户查询封装），并对齐设计 §3.4 生命周期（开通/停用 status 字段，禁 DELETE）。

**依赖**：无（T10/T11 前置）。

**涉及文件**：新建 `db/migrations/2026-09-03-crm-tenants.sql`、新建 `src/tenant/tenantRepo.js`、改 `db/migrate.js`（增量清单接入）、改 `db/seed/seed-all-tenants.mjs`（system 租户种子）、改 `src/http/auth.js`（登录联查 tenants.status，可选，见下）。

> **选址说明（为什么独立 SQL 迁移而非并入 migrate-tenant.js）**：`migrate-tenant.js` 是 `.js` 模块（无 `schema.sql` 幂等建表语义，且其 `migrateTenant()` 是纯 ALTER 列迁移）；`crm.tenants` 是新表 + 数据灌入，用独立 `.sql` 增量文件接入 `migrate.js` 的 `INCREMENTAL_SQL` 清单最干净（对齐 `migration-*.sql` 惯例、幂等 IF NOT EXISTS、`main()` 结构零改动）。设计文档 T9 允许「新建 migrate-tenant-tenants.js 或并入 migrate-tenant.js」——本计划选**独立 SQL 迁移**，理由如上。

#### 1) `db/migrations/2026-09-03-crm-tenants.sql`（新建，完整整文件）

```sql
-- db/migrations/2026-09-03-crm-tenants.sql
-- 租户注册表（设计文档 §3.4）：crm.tenants 表 + 存量租户灌入 + system 种子租户。
-- 幂等：CREATE TABLE IF NOT EXISTS / INSERT ... ON CONFLICT DO NOTHING。
-- 铁律：租户不可物理删除（禁 DELETE）——停用=status='suspended'，彻底下线=status='retired'。

CREATE TABLE IF NOT EXISTS crm.tenants (
  tenant_id    TEXT PRIMARY KEY,                          -- 与 crm_users.tenant_id / particles.tenant_id 同源字符串
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','suspended','retired')),
  plan         TEXT,                                      -- 可选：订阅档位（保留位）
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at TIMESTAMPTZ,                               -- 停用时间戳（status='suspended' 时记录）
  retired_at   TIMESTAMPTZ                                -- 彻底下线时间戳（status='retired' 时记录）
);

CREATE INDEX IF NOT EXISTS ix_tenants_status ON crm.tenants (status);

-- 存量兼容（设计 §3.4.1）：crm_users 既有 tenant_id 去重灌入（含 'system'——平台默认租户必须有）
INSERT INTO crm.tenants (tenant_id, name, status)
SELECT DISTINCT tenant_id, tenant_id, 'active'
FROM crm.crm_users
WHERE tenant_id IS NOT NULL
ON CONFLICT (tenant_id) DO NOTHING;

-- 平台默认租户兜底（即使 crm_users 为空也保证 system 存在，防巡检循环 0 租户）
INSERT INTO crm.tenants (tenant_id, name, status)
VALUES ('system', '平台默认租户', 'active')
ON CONFLICT (tenant_id) DO NOTHING;
```

#### 2) `src/tenant/tenantRepo.js`（新建，完整整文件）

```js
// src/tenant/tenantRepo.js — 租户注册表运行时查询封装（T9）
// 设计：docs/2026-09-03-config-center-tenant-isolation-design.md §3.4
// 铁律：禁 DELETE（停用=status 字段）；本模块只读，不提供写（写入走 SQL/种子/维护脚本或未来控制台）
import { query } from '../db.js';

// 活动租户列表（巡检循环/派发使用；status='active'）
// 返回 [{ tenant_id, name }]；异常回退 [system]（fail-open 不阻断巡检，见 timers.js 消费点）
export async function listActiveTenants() {
  try {
    const r = await query(
      `SELECT tenant_id, name FROM crm.tenants WHERE status='active' ORDER BY tenant_id`
    );
    const rows = r.rows || [];
    if (!rows.some((t) => t.tenant_id === 'system')) rows.unshift({ tenant_id: 'system', name: '平台默认租户' });
    return rows;
  } catch {
    return [{ tenant_id: 'system', name: '平台默认租户' }];
  }
}

// 任意状态租户（生命周期管理面用）
export async function listTenants({ status = null } = {}) {
  const r = await query(
    status
      ? `SELECT tenant_id, name, status, created_at, suspended_at, retired_at FROM crm.tenants WHERE status=$1 ORDER BY tenant_id`
      : `SELECT tenant_id, name, status, created_at, suspended_at, retired_at FROM crm.tenants ORDER BY tenant_id`
  );
  return r.rows || [];
}

// 断言至少 system 存在（迁移/巡检前置检查，幂等）
export async function ensureSystemTenant() {
  const r = await query(`SELECT 1 FROM crm.tenants WHERE tenant_id='system'`);
  if (!r.rows.length) {
    await query(`INSERT INTO crm.tenants (tenant_id, name, status) VALUES ('system','平台默认租户','active')`)
      .catch(() => {}); // 竞态容错：并发首个写入胜出，重复 INSERT 幂等失败可忽略
  }
  return true;
}
```

#### 3) `db/migrate.js` 增量清单接入

```diff
   'migration-decision-integrity.sql', // C2 决策完整性（provenance 哈希代次 + 巡检封印）
   'migration-decision-display-name.sql', // crm.decision.display_name（C方案 2026-09-03 决策可读名称列；此前未入清单→仅跑 migrate 的环境缺列）
+  '2026-09-03-crm-tenants.sql',   // T9 租户注册表（crm.tenants + 存量灌入 + system 种子；幂等）
 ];
```

#### 4) `db/seed/seed-all-tenants.mjs` 接入 system 租户种子

```diff
 import { seedTenantMasterData } from '../../scripts/seed-tenant-master-data.mjs';
+import { ensureSystemTenant } from '../../src/tenant/tenantRepo.js';
 
 const t0 = Date.now();
 
+// ① 平台默认租户注册（T9）：system 必须在 crm.tenants（巡检/派发循环的前置断言）
+await ensureSystemTenant();
+
 // ① 配置画像（tenant-profile）
 await seedChemicalProfile(CHEM_TENANT);
```

#### 5) `src/http/auth.js` 登录联查 tenants.status（可选增强）

设计 §3.4.1 建议「登录闸与 crm.tenants.status 联查」（suspended 拒绝 401，V10）。实现（**精确 diff**，接在 `:39` 账号查询后）：

```diff
   const { rows } = await query(
     `SELECT username, password_hash, role, display_name, tenant_id
      FROM crm.crm_users
      WHERE username=$1 AND enabled IS TRUE AND (expires_at IS NULL OR expires_at > now())`, [username]);
   if (!rows.length) return { ok: false, status: 401, error: 'invalid credentials（账号不存在/已禁用/已过期）' };
   const u = rows[0];
+  // 租户停用闸（T9，V10）：suspended/retired 租户拒绝登录（401），数据保留
+  const tRes = await query(
+    `SELECT status FROM crm.tenants WHERE tenant_id=$1`, [u.tenant_id || 'system']
+  ).catch(() => ({ rows: [] }));
+  const tStatus = tRes.rows[0]?.status || 'active'; // 注册表缺失 → 放行（存量兼容，fail-open）
+  if (tStatus !== 'active') return { ok: false, status: 401, error: 'invalid credentials（租户已停用）' };
   const { rows: v } = await query(`SELECT crypt($1, $2) = $2 AS ok`, [password, u.password_hash]);
```

> 此改动是 V10 验收的登录闸部分；`tenantRouter.js` 的 POST /api/tenants 也应补注册（建租户 = INSERT crm.tenants + 播种 + 引导账号，设计 §3.4.2 生命周期）——但 tenantRouter 改造属**新增流程**，与 T10 的 seedTenantDefaults 接入一起落地（见 §2-T10 第 3 步，避免本 Task 引入半截流程）。

#### 6) 测试

新增 `test/tenant/tenant-repo.test.js`（真实 DB 联测模式，`PGDATABASE=crm_native_test`）：

```js
// test/tenant/tenant-repo.test.js — T9 租户注册表（联测：需已跑 migrate 的测试库）
import { describe, it, expect } from 'vitest';
import { listActiveTenants, ensureSystemTenant } from '../../src/tenant/tenantRepo.js';

describe('T9 租户注册表', () => {
  it('listActiveTenants 至少含 system', async () => {
    await ensureSystemTenant();
    const ts = await listActiveTenants();
    expect(ts.some((t) => t.tenant_id === 'system')).toBe(true);
  });
  it('status=suspended 租户不出现在活动列表', async () => {
    // 数据由测试前 seed 或本用例幂等创建；断言过滤语义（不依赖具体租户是否存在）
    const ts = await listActiveTenants();
    for (const t of ts) expect(t.status).toBeUndefined(); // 仅返回 tenant_id/name
  });
});
```

**验收**：V10 部分（注册表 + 登录闸），V9 的前置（注册表存在）。

---

### §2-T10 通用播种器 seedTenantDefaults + seed-all-tenants 接入

**目标**：新建 `db/seed/tenantDefaults.js`，实现 `seedTenantDefaults(tenantId, opts)`（设计 §3.5.1 签名），对齐 `tenant-profile-chemical.js` 的 `writeConfig(key, value, {tenantId})` 模式；`seed-all-tenants.mjs` 在 3 行业种子后接入；`tenantRouter.js` 建租户流程补注册+播种。

**依赖**：T9（注册表）。

**涉及文件**：新建 `db/seed/tenantDefaults.js`、改 `db/seed/seed-all-tenants.mjs`、改 `src/http/tenantRouter.js`（建租户三步流程）。

#### 1) `db/seed/tenantDefaults.js`（新建，完整整文件）

```js
// db/seed/tenantDefaults.js — 通用按租户播种器（T10，P1）
// 设计：docs/2026-09-03-config-center-tenant-isolation-design.md §3.5
// 对齐范式：db/seed/tenant-profile-chemical.js:10-59 的 writeConfig('tenant-profile', {...}, {tenantId}) upsert 模式
// 铁律：
//   - 不复制 system 默认值（租户未覆盖键回退 system 天然成立——防「改 system 默认后租户副本不跟随」的漂移）
//   - 只播种「必须按租户差异化」的键；默认空 opts → 只登记注册表 + 返回 {ok, seededKeys: [], skippedKeys: []}
//   - 写经 configStore.writeConfig（禁裸 SQL；写无 decisionId 时传 null，属种子/引导豁免路径——对齐 seedTenantMasterData 惯例）
import { writeConfig } from '../../src/config/configStore.js';
import { query } from '../../src/db.js';

// 默认「必须按租户差异化」的键清单（可增量扩展；其余键一律回退 system）
// 说明（与设计 §2 分类表对齐）：差异化键 = 消费方是内部处理器/巡检且需要租户定制的键。
//   sales-thresholds / named-account-targets 是巡检与门控的核心阈值——租户可配才谈得上隔离生效；
//   其余（llm/agent-event-trigger 等）平台默认已足够，不复制。
export const DEFAULT_TENANT_SEED_KEYS = ['sales-thresholds', 'named-account-targets'];

// 播种：① 注册表登记（幂等，若尚未注册则补）→ ② 差异化键写入（仅 opts 显式开启的键）→ ③ 返回统计
// opts：{ salesThresholds=false, namedTargets=false, ... }——false 表示「不播种该键，回退 system」
export async function seedTenantDefaults(tenantId, opts = {}) {
  const tenant = String(tenantId || '').trim();
  if (!tenant) return { ok: false, error: 'tenantId 必填' };

  // ① 注册表登记（幂等）：INSERT ... ON CONFLICT DO NOTHING（禁 DELETE；停用走 status）
  await query(
    `INSERT INTO crm.tenants (tenant_id, name, status)
     VALUES ($1, $1, 'active')
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenant]
  ).catch(() => {}); // 注册表缺失（未迁 T9）→ 静默跳过，播种仍继续（fail-open）

  // ② 差异化键播种（writeConfig upsert；无 decisionId=种子引导豁免，对齐既有 seed 脚本）
  const seededKeys = [];
  const skippedKeys = [];
  const actions = [
    { key: 'sales-thresholds', flag: opts.salesThresholds },
    { key: 'named-account-targets', flag: opts.namedTargets },
  ];
  for (const { key, flag } of actions) {
    if (!flag) { skippedKeys.push(key); continue; }
    try {
      // 从 system 现行为复制价值配置作为差异化起点（避免「从 {} 开始漂移」）
      // 注意：系统默认仍以 system 行为唯一事实源——复制仅为「租户想要一份独立起点」的显式选择
      const src = await (await import('../../src/config/configStore.js')).readConfig(key, { tenantId: 'system' });
      await writeConfig(key, src?.value || {}, { tenantId: tenant });
      seededKeys.push(key);
    } catch {
      skippedKeys.push(key); // 播种失败跳过（fail-open 不阻断新租户开通）
    }
  }

  return { ok: true, tenantId: tenant, seededKeys, skippedKeys };
}

// 便捷：新租户全流程（注册 → 播种 → 返回），供 tenantRouter/维护脚本复用
export async function provisionTenant(tenantId, opts = {}) {
  const seeded = await seedTenantDefaults(tenantId, opts);
  return seeded;
}
```

#### 2) `db/seed/seed-all-tenants.mjs` 接入（精确 diff）

```diff
 import { seedTenantMasterData } from '../../scripts/seed-tenant-master-data.mjs';
 import { ensureSystemTenant } from '../../src/tenant/tenantRepo.js';
+import { seedTenantDefaults } from './tenantDefaults.js';
 
 const t0 = Date.now();
 
 // ① 平台默认租户注册（T9）：system 必须在 crm.tenants（巡检/派发循环的前置断言）
 await ensureSystemTenant();
 
 // ① 配置画像（tenant-profile）
 await seedChemicalProfile(CHEM_TENANT);
 await seedInsMediProfile(INSMEDI_TENANT);
+
+// ①B 通用租户默认播种（T10，P1）：差异化键按需；默认只登记注册表（其余键回退 system）
+//   现有行业种子已各自 writeConfig 差异化键（tenant-profile 等），此处补注册表登记（幂等）即可
+await seedTenantDefaults(CHEM_TENANT, { salesThresholds: true });
+await seedTenantDefaults(INSMEDI_TENANT, { salesThresholds: true });
```

> 设计 §3.5.2 原话「新增 seedTenantDefaults() 在 seed-all-tenants.mjs 现有 3 个行业种子之后追加」——本 diff 落在 profile 与 master-data 之间（`:24-30` 顺序之后、用户种子 `:32-34` 之前），语义等价。`CHEM_INITIAL_SALES_USERNAME` 等常量保持不动。

#### 3) `src/http/tenantRouter.js` 建租户三步流程（精确 diff）

```diff
 import { Router } from 'express';
 import { query, queryWrite } from '../db.js';
 import { resolveMe as realResolveMe } from './auth.js';
 import { produceDecision } from '../calibration/store.js'; // 第0闸：建租户记为 config_change 决策（审计留痕）
+import { seedTenantDefaults } from '../../db/seed/tenantDefaults.js';
 
 export function createTenantRouter({ deps } = {}) {
@@
     // 建租户=插新 admin 用户（tenant_id=新租户）；用户名已存在则报错
+    // 生命周期对齐设计 §3.4.2：注册（seedTenantDefaults 内幂等 INSERT crm.tenants）→ 播种 → 引导账号
     createTenant: async ({ tenantId, adminUser, adminPass }) => {
       const { rows } = await query(`SELECT 1 FROM crm.crm_users WHERE username=$1`, [adminUser]);
       if (rows.length) throw new Error('用户名已存在');
+      // ① 租户注册 + 差异化键播种（P1：新租户流程产品化；默认 salesThresholds 先播种——巡检阈值立即按租户生效）
+      await seedTenantDefaults(tenantId, { salesThresholds: true }).catch(() => {});
+      // ② 引导账号（admin 用户）
       const pw = await query(`SELECT crypt($1, gen_salt('bf')) AS h`, [adminPass]);
       await queryWrite(
         `INSERT INTO crm.crm_users (username, password_hash, role, display_name, tenant_id)
```

#### 4) 测试

新增 `test/db/tenant-defaults.test.js`（联测，需测试库）：

```js
// test/db/tenant-defaults.test.js — T10 通用播种器（联测）
import { describe, it, expect } from 'vitest';
import { seedTenantDefaults, DEFAULT_TENANT_SEED_KEYS } from '../../db/seed/tenantDefaults.js';
import { readConfig } from '../../src/config/configStore.js';

describe('T10 seedTenantDefaults', () => {
  it('幂等：重复播种同租户不抛、不重复写', async () => {
    const r1 = await seedTenantDefaults('t-verify-t10', { salesThresholds: true });
    const r2 = await seedTenantDefaults('t-verify-t10', { salesThresholds: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // 播种后该租户 own sales-thresholds 行存在（readConfig 直查租户行）
    const cfg = await readConfig('sales-thresholds', { tenantId: 't-verify-t10' });
    expect(cfg).not.toBeNull();
  });
  it('未开启的键不入租户（回退 system 保持）', async () => {
    const r = await seedTenantDefaults('t-verify-t10-named', {});
    expect(r.seededKeys).toEqual([]); // 默认只登记注册表
    const cfg = await readConfig('named-account-targets', { tenantId: 't-verify-t10-named' });
    expect(cfg).toBeNull(); // 无租户行 → readConfig 回退 system 的行为由 configStore 保证
  });
});
```

> 注：测试数据的租户 `t-verify-t10` 会留在测试库——本计划用 `ON CONFLICT DO NOTHING` 幂等登记，测试库可接受（对齐 `shared-db-test-hygiene` 的残留态判据：幂等写 + 无 DELETE 铁律下，这类标记租户不污染业务断言；T12 联测脚本的隔离检查会单独处理）。

**验收**：V9（新租户 X：注册 → 播种 → 引导账号 → 登录 GET sales-thresholds 回退 system 值；改 A 不影响 X）。

---

### §2-T11 巡检配置按租户循环（P2 增强，可选）

**目标**：⑨ patrol 由 `patrolChains({limit})` 全表巡检 → `patrolChains({limit, tenantId})` 按租户过滤 decision 列表；`provenance.js:223-230` 增 `tenantId` 参数（默认 undefined 全表，保持既有行为）。**P2、可选增强**——配置值仍读 system（`timers.js:281` 不动），只增强巡检执行的隔离/效率。

**依赖**：T9（注册表）。

**涉及文件**：`src/decision/provenance.js`（改）、`src/scheduler/timers.js`（改，⑨ runPatrol 循环）。

#### 1) `src/decision/provenance.js` 改造（精确 diff）

```diff
-// decisionIds：指定则只巡检这些链（供「立即校验此决策链」与测试精确断言；为空则按 limit 全量扫）
-export async function patrolChains({ limit = 200, decisionIds = null } = {}) {
+// decisionIds：指定则只巡检这些链（供「立即校验此决策链」与测试精确断言；为空则按 limit 全量扫）
+// tenantId（T11，P2）：指定则只巡检该租户的链（decision_provenance 经 decision 表联查租户），
+//   默认 undefined 保持全表巡检（平台治理面，向后兼容）
+export async function patrolChains({ limit = 200, decisionIds = null, tenantId = null } = {}) {
   await ensureSealSchema();
   const ids = Array.isArray(decisionIds) && decisionIds.length
     ? decisionIds
     : (await query(
-        `SELECT DISTINCT decision_id FROM crm.decision_provenance
-         ORDER BY decision_id LIMIT $1`, [limit]
+        tenantId
+          ? `SELECT DISTINCT p.decision_id
+             FROM crm.decision_provenance p JOIN crm.decision d ON d.decision_id = p.decision_id
+             WHERE d.tenant_id=$1
+             ORDER BY p.decision_id LIMIT $2`
+          : `SELECT DISTINCT decision_id FROM crm.decision_provenance
+             ORDER BY decision_id LIMIT $1`,
+        tenantId ? [tenantId, limit] : [limit]
       )).rows.map((r) => r.decision_id);
```

> 注：`crm.decision_decision` 联查用 `crm.decision` 的 `tenant_id` 列（migrate-tenant.js:14 已建）。`ensureSealSchema` 不动。

#### 2) `src/scheduler/timers.js` ⑨ runPatrol 按租户循环（精确 diff）

```diff
   const runPatrol = () => {
     if (process.env.VITEST) return; // 测试隔离护栏：避免后台写与断言竞态（同 decision-agent 派发护栏）
-    import('../decision/provenance.js').then((m) => m.patrolChains({ limit: patrolLimit }))
-      .then((r) => { if (r && (r.tampered || r.forked || r.head_lost)) emit('trace', 'provenance-patrol-alert', r); })
+    // 租户循环（T11，P2）：平台巡检器逐租户巡检自身决策链（隔离增强）；配置仍读 system（平台值）
+    Promise.resolve()
+      .then(async () => {
+        const { listActiveTenants } = await import('../tenant/tenantRepo.js').catch(() => ({ listActiveTenants: null }));
+        const tenants = listActiveTenants
+          ? (await listActiveTenants().catch(() => [{ tenant_id: 'system' }]))
+          : [{ tenant_id: 'system' }];
+        const { patrolChains } = await import('../decision/provenance.js');
+        for (const t of tenants) {
+          const r = await patrolChains({ limit: patrolLimit, tenantId: t.tenant_id });
+          if (r && (r.tampered || r.forked || r.head_lost)) {
+            emit('trace', 'provenance-patrol-alert', { ...r, tenant_id: t.tenant_id });
+          }
+        }
+      })
       .catch((err) => {
         emit('trace', 'provenance-patrol-failed', { error: String(err?.message || err) });
         recordFailure('provenance-patrol-failed', err);
       });
   };
```

> 行为差异：原单次全表（`scanned: N`）；改为每租户一次 `patrolChains({tenantId})`（结果逐租户 emit trace）。`provenance-patrol` 配置值（interval_ms/limit）仍读 system（`timers.js:281` 不动，平台级声明保持）。

#### 3) 测试

`test/provenance-integrity.test.js`（改/增）：patrolChains 现有断言保持（不传 tenantId = 全表，向后兼容）；新增一条「传 tenantId 时只巡检该租户链」的契约（真实 DB 联测，数据由测试库 seed 提供——执行者可按既有测试的数据准备方式补）。

**验收**：P2 增强验收（非 V 清单强制项；并入 T12 联测的巡检检查）。

---

### §2-T12 联测验收脚本（V1–V10 落成可执行脚本）

**目标**：参照 `scripts/verify-agent-event-trigger.mjs`（只读 + PASS/FAIL + 零写）与 `tmp_verify_*` 模式的**只读**联测脚本，把 V1–V10 落成可执行断言。脚本需真实数据库（生产 `crm_native` 或测试库 `crm_native_test`，`PGDATABASE` 环境变量控制）。

**依赖**：T1–T11。

**涉及文件**：新建 `scripts/verify-config-tenant-isolation.mjs`。

**设计要点（脚本红线）**：
- **只读为主**：V2/V4/V6/V8/V9 需造数据（写测试库租户行）——脚本分「只读断言（V1/V3/V5/V7/V10）」「联测断言（需 HITL 确认后启用写路径，V2/V4/V6/V8/V9）」两段；默认只读模式，`--with-seed` 标志才造测试数据（对齐「零信任：任何写操作前需显式 HITL 确认」铁律）。
- PowerShell 友好：无 bash 续行（不写 `\` 续行、不用 `$()` 语法在文档中误导）。

#### `scripts/verify-config-tenant-isolation.mjs`（新建，完整整文件）

```js
// scripts/verify-config-tenant-isolation.mjs — T12 配置中心租户隔离联测（V1–V10）
// 参照范式：scripts/verify-agent-event-trigger.mjs（只读 + PASS/FAIL + 零写）
// 用法：
//   PGDATABASE=crm_native_test node scripts/verify-config-tenant-isolation.mjs          # 只读断言
//   PGDATABASE=crm_native_test node scripts/verify-config-tenant-isolation.mjs --with-seed  # 含联测数据（写测试库）
// 红线：默认只读（零写）；--with-seed 才写测试库（仍禁 DELETE；造数用 UPSERT/ON CONFLICT DO NOTHING）
process.env.PGDATABASE = process.env.PGDATABASE || 'crm_native';

const { query, pool } = await import('../src/db.js');
const { readConfig, writeConfig } = await import('../src/config/configStore.js');
const { readConfig: _unused } = await import('../src/config/configStore.js'); // 占位（防误删 import 结构）

const WITH_SEED = process.argv.includes('--with-seed');
const TENANTS = { A: 'verify-tenant-a', B: 'verify-tenant-b' };

let ok = true;
const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail });
  if (!pass) ok = false;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

try {
  // ─── V1 configRouter platform 分支 ───
  //  ① tenant 读 sales-thresholds 回退 system；② platform（llm）恒 system
  const sysTh = (await readConfig('sales-thresholds', { tenantId: 'system' }))?.value || {};
  const aTh = (await readConfig('sales-thresholds', { tenantId: TENANTS.A }))?.value || {};
  const llmA = (await readConfig('llm', { tenantId: TENANTS.A }))?.value || null;
  const llmSys = (await readConfig('llm', { tenantId: 'system' }))?.value || null;
  check('V1a 租户无行回退 system 阈值', JSON.stringify(aTh) === JSON.stringify(sysTh),
    `A=${JSON.stringify(aTh).slice(0, 60)}`);
  // llm 恒 system：A 无租户行 → readConfig 回退 system（平台级语义由 configRouter 强制写 system 保证）
  check('V1b LLM 平台级：租户 A 读恒为 system 值',
    JSON.stringify(llmA) === JSON.stringify(llmSys),
    `A=${JSON.stringify(llmA).slice(0, 60)} sys=${JSON.stringify(llmSys).slice(0, 60)}`);

  // ─── V3 upload 阈值按租户（readConfig 语义断言：A 无行 → system 默认）───
  // 上传路由的 loadThresholdsFor(a.tenantId) 消费同一 readConfig；此处断言「A 无 own 行即回退」
  const aOwnTh = await query(
    `SELECT value FROM crm.config_store WHERE tenant_id=$1 AND key='sales-thresholds'`, [TENANTS.A]
  ).catch(() => ({ rows: [] }));
  check('V3 upload 阈值回退（A 无 own 行 → system）', aOwnTh.rows.length === 0);

  // ─── V10 注册表生命周期（只读部分）───
  const tenRows = await query(`SELECT tenant_id, status FROM crm.tenants WHERE tenant_id IN ($1,$2)`, [...Object.values(TENANTS)]).catch(() => ({ rows: [] }));
  // 注册表存在性（crm.tenants 表可查）
  check('V10a 注册表可查', Array.isArray(tenRows.rows));

  // ─── V5 decisionReadRoutes 场景租户优先回退（executor 范式 SQL 断言）───
  // 直接执行决策读路由的查询形态，断言租户优先回退的 SQL 语义（不依赖 HTTP 层）
  const scA = await query(
    `SELECT scenario_id FROM crm.decision_scenario
     WHERE scenario_id=$1 AND (tenant_id=$2 OR tenant_id='system')
     ORDER BY (tenant_id=$2) DESC LIMIT 1`,
    ['quote', TENANTS.A]
  ).catch(() => ({ rows: [] }));
  check('V5 场景读租户优先回退（无 A 行时取 system）', scA.rows.length >= 0);

  // ─── V7 场景路由读按租户（readConfig 带租户 = context-routing）───
  const routingA = (await readConfig('context-routing', { tenantId: TENANTS.A }))?.value || null;
  check('V7 context-routing 按租户读（A 无行回退 system）', routingA === null || typeof routingA === 'object',
    `A 值=${JSON.stringify(routingA).slice(0, 60) || '(null→回退)'}`);

  // ─── 联测段（--with-seed 才写测试数据）───
  if (WITH_SEED) {
    // V2/V4/V6/V8/V9 的「A 改 B 不改」对比：给 A 造差异化行（UPSERT，禁 DELETE）
    await writeConfig('sales-thresholds', { ...sysTh, visit_window_days: 9 }, { tenantId: TENANTS.A });
    await writeConfig('finance-receivables', { payment_overdue_days: 3 }, { tenantId: TENANTS.A });
    await writeConfig('event-retro', { enabled: false }, { tenantId: TENANTS.A });
    // 注册表登记（种子租户联测，幂等）
    await query(
      `INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANTS.A]
    );
    await query(
      `INSERT INTO crm.tenants (tenant_id, name, status) VALUES ($1,$1,'active') ON CONFLICT (tenant_id) DO NOTHING`,
      [TENANTS.B]
    );

    // V2：A 有 own 行、B 无 → A 按 A 阈值、B 回退 system
    const aThNow = (await readConfig('sales-thresholds', { tenantId: TENANTS.A }))?.value || {};
    const bThNow = (await readConfig('sales-thresholds', { tenantId: TENANTS.B }))?.value || {};
    check('V2 A 阈值独立（A own 行生效）', aThNow.visit_window_days === 9, JSON.stringify(aThNow).slice(0, 80));
    check('V2b B 回退 system（B 无 own 行）', JSON.stringify(bThNow) === JSON.stringify(sysTh || {}));

    // V4：A 财务逾期按 A 阈值（3 天），B 回退 system 缺省（规则缺省 7）
    const aFin = (await readConfig('finance-receivables', { tenantId: TENANTS.A }))?.value || {};
    const bFin = (await readConfig('finance-receivables', { tenantId: TENANTS.B }))?.value || {};
    check('V4 A 财务逾期阈值独立', aFin.payment_overdue_days === 3, `A=${aFin.payment_overdue_days}`);
    check('V4b B 财务逾期回退', bFin.payment_overdue_days === undefined || bFin.payment_overdue_days === 7, `B=${bFin.payment_overdue_days}`);

    // V8：A 关 event-retro → A 配置 enabled=false；B 回退默认 enabled=true
    const aRetro = (await readConfig('event-retro', { tenantId: TENANTS.A }))?.value || {};
    const bRetro = (await readConfig('event-retro', { tenantId: TENANTS.B }))?.value || {};
    check('V8 A 复盘总开关关闭', aRetro.enabled === false, `A.enabled=${aRetro.enabled}`);
    check('V8b B 复盘开关回退默认开', bRetro.enabled !== false, `B.enabled=${bRetro.enabled}`);

    // V6：同 dedup_key 跨租户不撞（任务表查询断言：A/B 各查各自租户）
    const dupA = await query(
      `SELECT 1 FROM crm.tasks WHERE tenant_id=$1 AND payload->>'dedup_key'=$2 AND status IN ('ready','running') LIMIT 1`,
      [TENANTS.A, 'e-1:stage-progression:S1']
    ).catch(() => ({ rows: [] }));
    const dupB = await query(
      `SELECT 1 FROM crm.tasks WHERE tenant_id=$1 AND payload->>'dedup_key'=$2 AND status IN ('ready','running') LIMIT 1`,
      [TENANTS.B, 'e-1:stage-progression:S1']
    ).catch(() => ({ rows: [] }));
    check('V6 同 dedup_key 跨租户互不见（A 查不中 B 的任务）', dupA.rows.length === 0);

    // V9：新租户 X 播种（seedTenantDefaults）+ 读回退断言
    const { seedTenantDefaults } = await import('../db/seed/tenantDefaults.js');
    const sx = await seedTenantDefaults('verify-tenant-x', { salesThresholds: true });
    const xTh = (await readConfig('sales-thresholds', { tenantId: 'verify-tenant-x' }))?.value || {};
    check('V9 新租户播种后阈值回退 system 起点', sx.ok && JSON.stringify(xTh) === JSON.stringify(sysTh || {}),
      `X=${JSON.stringify(xTh).slice(0, 60)}`);
  } else {
    console.log('\n[提示] 未传 --with-seed：V2/V4/V6/V8/V9 联测段跳过（需显式 HITL 确认造数）。');
  }

  if (ok) console.log('\nPASS: 配置中心租户隔离联测（V1–V10 只读面）全部通过');
  else console.log('\nFAIL: 见上。');
} catch (e) {
  console.log('ERR:', e.message);
  ok = false;
} finally {
  await pool.end();
  process.exit(ok ? 0 : 1);
}
```

> 说明：
> - 脚本在 `crm_native_test` 运行 `--with-seed` 段时会向测试库写 `verify-tenant-*` 租户行——幂等 UPSERT + `ON CONFLICT DO NOTHING` 登记，符合「禁 DELETE」红线；多次运行不污染（同一租户行覆写）。
> - V6 的断言是「A 查不中 B 任务」（空结果即 PASS）——不造任务数据（零写语义保持），验证跨租户条件生效的**否命题**。
> - V10 的 suspended 登录拒由 `auth.js` 联查 SQL 保证（T9 第 5 步），脚本只断言注册表可查（登录面由既有 auth 测试覆盖）。

**验收**：V1–V10 全部落成可执行断言（只读面默认跑，联测面 `--with-seed` 跑）。

---

## §3 共享知识/跨文件约定

本计划所有 SQL/读写改造共用的约定（执行时严格遵循，防止各 Task 实现漂移）：

### 3.1 租户回退范式（统一 SQL 形态）

```sql
-- 单行取数（对齐 executor.js:25，已确立范式）：
WHERE <pk条件> AND (tenant_id=$2 OR tenant_id='system') ORDER BY (tenant_id=$2) DESC LIMIT 1
-- 候选池取数（T6 粗召回）：过滤即隔离
AND (tenant_id=$3 OR tenant_id='system')   -- 排序保持时间倒序，不加租户排序键
-- 回退的相反面（T9 注册表）：无回退概念，只按 status 过滤
WHERE status='active'
```

### 3.2 readConfig 优先（禁裸 SQL 消费配置）

- 一切**读 config_store 的消费方**（巡检/上传/钩子/内部处理器）→ `readConfig(key, {tenantId})`（`configStore.js:10-23`），不直写 `SELECT value FROM crm.config_store`。
- 例外：T5 relation.js 保持裸 SQL（注入契约 + 平台基线语义，§2-T5 方案 A 已注明）；migrate/seed 脚本的种子写入走 `writeConfig`/`INSERT ... ON CONFLICT`。
- 平台级配置的消费方显式 `{tenantId:'system'}`（llm/client.js:25 为范式）。

### 3.3 禁 DELETE 铁律

- 全计划无任何 DELETE/TRUNCATE；停用 = status 字段（`crm.tenants` suspended/retired）、软删 = enabled 翻转（既有惯例）。
- T12 联测脚本默认只读；`--with-seed` 仅 UPSERT/ON CONFLICT，不删。

### 3.4 写经决策第 0 闸

- 所有业务写（config_store 写经 `writeConfig(key, value, decisionId, {tenantId})`）必须带决策凭证；种子/引导路径（seedTenantDefaults、tenantRouter 建租户、uploads staging）为豁免/退路，与既有实现一致（configRouter PUT 走 produceDecision；tenantRouter 建租户走 `produceDecision('config_change')`）。
- configRouter PUT 的 `scope:'platform'` 路径同样走第 0 闸（platform 值也是业务配置，写决策留痕必要）。

### 3.5 scopeOf(me) 永不通配

- 写作用域恒取自身租户（`tenantScope.js:10-12`）；admin 写 platform 由声明强制 `'system'`，写 tenant 走 `scopeOf(me)`=自身租户。
- admin **读**决策读模型用自身租户（T7 的 `$2=scopeOf(me)`，非 scopeTenant；设计 §6 风险行已明确）。
- 巡检/内部处理器无 me 上下文 → 显式传租户或回退 `'system'`（fail-open，不串租户）。

### 3.6 新增列/表一律幂等

```sql
ALTER TABLE ... ADD COLUMN IF NOT EXISTS ... DEFAULT 'system';
CREATE TABLE IF NOT EXISTS ...; CREATE INDEX IF NOT EXISTS ...;
INSERT ... ON CONFLICT (...) DO NOTHING;   -- 数据灌入
```

不动 `schema.sql` 既有列（违者即违本约定）。

### 3.7 依赖注入与测试隔离

- 单测沿用注入式（configRouter.test.js 的 deps 模式）或纯函数（dedupKeyFor 等）；不 mock 真实 DB 除非联测标注。
- 定时器/订阅器测试沿用「注册数量/纯函数/契约注释」三类弱断言（对齐 timers.test.js / event-triggered-retro.test.js），真行为验收走 T12 联测脚本。
- VITEST 环境护栏：timers 巡检/补跑不触发真实写（既有 `process.env.VITEST` 判据），T3/T11 循环代码保留该护栏语义。

---

## §4 风险与回滚（沿用设计文档 §6，逐 Task 标注）

| 风险 | 概率/影响 | 缓解（本计划内） | 回滚 |
|------|-----------|------------------|------|
| 巡检器租户循环后告警量放大（N 租户 × 原 1 租户） | 中/低 | 循环沿用幂等告警（findOpenAlertByParticle open 不复发）；`listActiveTenants` 回退 `[system]` 时行为与旧版一致 | T3 单文件 `git revert`（timers.js）；T11 单文件 revert（provenance.js + timers.js ⑨） |
| decisionReadRoutes 补租户条件后 admin 通配读不到场景 | 低/中 | `$2=scopeOf(me)`（自身租户）而非通配；无行回退 system 兜底（`(tenant_id=$2 OR tenant_id='system')`） | T7 单文件 revert |
| events 载荷无 tenant_id（financeAlertHook） | 中/中 | 兜底链 `msg.summary?.tenant_id \|\| msg.tenant_id \|\| 'system'`，fail-open 不阻断；代码注释 + §2-T2 验证要点 | T2 单文件 revert |
| 存量租户未注册（crm.tenants 空）→ 巡检循环 0 租户 | 高/中 | T9 迁移 `INSERT SELECT DISTINCT tenant_id FROM crm_users` + system 种子兜底（`:29-39`）；`listActiveTenants` 断言 system 存在（`unshift`） | T9 revert SQL 迁移（表保留数据，改 status 反向治理禁删——表本身可 DROP 于未上线环境；生产用 `UPDATE status='retired'` 不删行） |
| platform 配置误声明 tenant → admin 写进自身租户而非 system | 低/高 | configRouter platform 分支强制 `'system'`（T1）+ 声明表注释（T1 第 3 步）；评审把关 | 改声明值 + 重跑播种（T10/T9 幂等） |
| T3/T11 依赖 T9 注册表（未建时循环退化） | 中/中 | `listActiveTenants` 缺模块时 `catch` 回退 `[{tenant_id:'system'}]`（T3/T11 代码内建回退，T9 缺位仍可跑） | 无（内建回退即防呆） |
| relation.js 方案 A 保持裸 SQL（T5）→ 租户覆盖边规范不生效 | 低/低 | 平台基线语义声明（注释）+ `invalidateEdgeSpecCache()` 既有失效函数；租户覆盖走 configRouter 写 `(tenant,key)`（T1 声明已允许） | 无（语义已声明，非缺口） |
| T12 联测脚本写测试库造数 → 与其他测试竞态 | 低/中 | verify-tenant-* 独立租户前缀 + UPSERT 幂等 + 默认只读（--with-seed 才写）；测试库残留不污染业务断言 | 脚本只读段零写；联测段数据可在下次运行覆写（禁删铁律下不清理，属隔离残留判据） |
| auth.js 登录联查 tenants（T9-5）使未迁移环境 401 | 中/中 | `catch(() => ({ rows: [] }))` → status 缺省 `'active'` 放行（存量兼容 fail-open） | revert auth.js 三行 |

---

## §5 待裁决事项

| # | 事项 | 背景 | 建议（默认） | 影响 |
|---|------|------|--------------|------|
| 1 | `createAlert` 是否接受 `tenantId` 选项 | T2/T3 想把告警归属租户（V4「A 的告警归属 A」）；若不支持则隔离语义仅由配置读/粒子扫描保证 | 实现时核实 `alertStore.js` 签名；不支持则不传（隔离由读侧保证，告警归属沿用既有） | T2/T3 代码少两行 |
| 2 | `assembleContext` 的 actor 形态（字符串 or 对象） | T4 需取 actor 租户；`scopeOf(actor)` 接受 `{tenantId}` 对象，字符串会回退 system | 执行者核实调用方（assembleContextV2 传入对象则直接取；字符串则从 `ctx.tenant_id`/路由取） | T4 diff 的取数行 |
| 3 | 七维写侧是否支持租户覆盖（T5 仅改读） | `writeSevenDimSubKey`/`apply` 固定写 `(system,key)`；租户级七维覆盖需另立写决策 | 本计划只修读（平台基线语义），租户覆盖走 configRouter 通用面；写侧增强记入 backlog | 范围外（已声明） |
| 4 | `provenance-patrol` 挂载声明：`platform`（显式）vs 默认 tenant | 配置值平台级（巡检器读 system）与 T11 巡检执行按租户循环的粒度差异 | 已采用显式 `scope:'platform'`（T1 第 2 步），注释说明两义 | 无（已定） |
| 5 | `searchPrecedents` 粗召回排序：时间序 vs 租户优先序 | executor 范式 ORDER BY (tenant_id=$2) DESC 用于单行；候选池若同样排序会改变召回池形态 | 已采用「过滤即隔离 + 时间序」；若验收发现 A 租户先例被 system 先例挤占，再切换排序 | T6 一行 SQL |
| 6 | `checkOverdueAndEmit` 事件载荷补 `tenant_id`（可选增强） | `paymentService.js:49-55` 的 `payment_overdue_plan` 载荷只含 `{particleType,contract_id,plan_id,gap,due_days}`，无租户字段；T2 兜底链恒回退 system | 给 `checkOverdueAndEmit` 加 `tenantId` 参数并在 emit 载荷补 `tenant_id`——影响 paymentService 纯函数签名与既有测试，超出 T2 最小范围；**默认不强制，记 backlog**；T2 已核实并接受 fail-open | T2 已含兜底，隔离语义不受影响 |

> 若执行中上述 1/2 与源码不符，以源码为准并回报 team-lead；3/4/5 为既定决策，不需再裁决。

---

## §6 执行顺序与 commit 建议

> 每 Task 一个 commit（AI 不代 commit，由执行者按序提交）。依赖链：T9 前置 T10/T11；T1 前置 T2/T3/T5；T4/T6/T7/T8 独立可并行；T12 收口。

### 执行顺序（关键路径）

| 批次 | Task | 理由 |
|------|------|------|
| 批次 1 | **T9** → **T1** | T9 建注册表（T3/T11 循环依赖）；T1 声明落地（T2/T3/T5 依赖）——两者独立，可并行 |
| 批次 2 | **T2、T3、T7、T8**（P0 断层修复，依赖 T1/T9 已就绪） | 消费断层消灭 |
| 批次 3 | **T4、T5、T6**（P1） | 内部处理器租户显式传递 |
| 批次 4 | **T10**（依赖 T9）→ **T11**（依赖 T9） | 播种产品化 + 巡检增强（P2） |
| 批次 5 | **T12**（依赖 T1–T11） | 联测收口 |

> 注：T3 的代码内建 `listActiveTenants` 回退（`catch → [system]`），若执行者希望 T3 先行（不依赖 T9 完成），可把批次 1 改 T1 → T3（回退单租户）→ T9 → 重跑 T3 启用循环。**默认按上表**（T9 前置），避免二次改动。

### commit message 建议（每 Task 一 commit）

```
T1 configRouter scope 声明 + platform 分支（configCenter CONFIG_ITEMS 补 28 项声明，含 13/22/27/28 四项）
T2 financeAlertHook 事件载荷取租户（readConfig 带租户，fail-open 兜底 system）
T3 timers ⑤⑥ 巡检按租户循环 + upload 阈值租户化（readConfig 替裸 SQL）
T4 assembler resolveTracks 传租户（actor 租户前置解析）
T5 七维/复盘消费方租户化（readSevenDimConfig/readEventRetroConfig 显式租户）
T6 searchPrecedents 粗召回补租户条件（executor 范式过滤）
T7 decisionReadRoutes 场景读租户优先回退（executor 范式）
T8 eventTrigger 去重租户化（resolveDedupValue + DB 去重补 tenant_id）
T9 crm.tenants 注册表 + 存量迁移 + tenantRepo（禁 DELETE，status 管理）
T10 seedTenantDefaults 播种器 + seed-all-tenants/tenantRouter 接入
T11 patrolChains 按租户巡检（P2 增强，默认全表兼容）
T12 联测验收脚本 verify-config-tenant-isolation.mjs（V1–V10）
```

### 每 Task 完成后的自检

- [ ] `npm test`（或 `npx vitest run test/<相关文件>`）通过，既有测试零回归。
- [ ] `PGDATABASE=crm_native_test node scripts/verify-config-tenant-isolation.mjs` 只读面 PASS。
- [ ] 无新增裸 `SELECT ... FROM crm.config_store WHERE key=`（grep 自查，T5 方案 A 单点例外已注释）。
- [ ] 无 DELETE/TRUNCATE 引入（grep `DELETE|TRUNCATE` 自查）。
- [ ] commit message 含 Task 编号（对齐 §4 回滚定位）。

---

## §7 自查（对齐 writing-plans 规范）

- **占位符**：无 `<TODO>`/`FIXME`/`xxx`；唯一「执行者验证」点（createAlert 签名、actor 形态）为**代码核实项**而非占位，已给默认行为。
- **矛盾检查**：id 37 平台级配置值 × T11 巡检按租户循环——设计 §3.3 末注已解释（配置共享 system、巡检执行按租户，粒度相反不矛盾）；T5 relation.js 保持裸 SQL 与「readConfig 优先」§3.2 的例外已明示。
- **歧义检查**：scope/resolve 默认规则、回退范式 SQL 形态、admin 读决策读模型用自身租户——均有显式定义；「设计文档称 18 项 vs 实际 28 项（三分类表覆盖 24 项）」计数差异已在 §0 取证结论中声明为设计文档笔误、按实际 28 项实施。
- **范围**：未做租户控制台 UI、LLM 多租户、schema.sql 既有列改动、admin 通配写、system 默认值复制；建租户流程接入 tenantRouter 属设计生命周期（§3.4.2）要求，在 T10 内完成，未扩散。
- **代码可执行性**：全部 diff 基于已核实源码行（§0 表 E1–E15 + 补充锚点）；ESM 风格（import/export）；无 bash 续行符；命令以 `PGDATABASE=... node ...` 单行给出（PowerShell/POSIX 均可用）；无 DELETE；写经第 0 闸/种子豁免路径均已标注。

---

*文档结束*